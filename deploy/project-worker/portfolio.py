"""Broker project Git operations. Only the operator's unprivileged Git process can use their SSH identity."""
import fcntl
import json
import os
import pwd
import re
import subprocess
import sys
import tempfile
from pathlib import Path

OWNER = "wolf-dev"
HOME_DIR = Path("/var/lib/wolf-dev")
STATE = Path("/var/lib/wolf-project-worker")
REGISTRY = Path("/etc/wolf-project-worker/projects.json")
GIT = "/usr/bin/git"
SHA = re.compile(r"[0-9a-f]{40}")
REPO = re.compile(r"[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}")
REQUEST = re.compile(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}")


def owner_run(args, data=None):
    env = ["HOME=" + str(HOME_DIR), "PATH=/usr/bin:/bin", "GIT_CONFIG_NOSYSTEM=1",
           "GIT_CONFIG_GLOBAL=/dev/null", "GIT_TERMINAL_PROMPT=0", "GIT_LFS_SKIP_SMUDGE=1"]
    command = ["/usr/sbin/runuser", "-u", OWNER, "--", "/usr/bin/env", "-i", *env, *map(str, args)]
    result = subprocess.run(command, input=data, capture_output=True, timeout=600, cwd="/var/tmp")
    if result.returncode:
        raise ValueError("Project Git operation failed: " + result.stderr.decode(errors="replace")[-380:])
    return result.stdout.decode().strip()


def owner_git(directory, *args):
    return owner_run([GIT, "-c", "core.hooksPath=/dev/null", "--git-dir", directory, *args])


def record_candidate(directory, index, base, ref, patch, title):
    # This function runs as the operator, on a fresh bare repository, using a private index.
    env = dict(os.environ, GIT_INDEX_FILE=str(index), GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL="/dev/null")
    def git(*args, data=None):
        argv = [GIT, "-c", "core.hooksPath=/dev/null", "-c", "user.name=Wolf",
                "-c", "user.email=wolf@localhost", "--git-dir", str(directory), *args]
        return subprocess.check_output(argv, env=env, input=data, stderr=subprocess.PIPE).decode().strip()
    git("read-tree", base)
    git("apply", "--cached", "--binary", "--whitespace=nowarn", "-", data=patch)
    tree = git("write-tree")
    if tree == git("rev-parse", base + "^{tree}"):
        raise ValueError("The project worker returned an empty change.")
    revision = git("commit-tree", tree, "-p", base, "-m", title)
    git("update-ref", ref, revision, "0" * 40)
    return revision


def authorize_publication(policy, receipt, repository, revision):
    if (policy.get("delivery") != "branch" or receipt["repository"] != repository
            or not receipt.get("changed") or receipt["revision"] != revision):
        raise ValueError("There is no matching candidate authorized for this repository's branch delivery.")


def atomic_json(path, value):
    with tempfile.NamedTemporaryFile(dir=path.parent, mode="w", delete=False) as f:
        json.dump(value, f); f.flush(); os.fsync(f.fileno())
    os.replace(f.name, path)


def handle(payload, run_worker):
    repository, job_id = payload["repository"], payload["id"]
    if not REPO.fullmatch(repository) or not REQUEST.fullmatch(job_id):
        raise ValueError("Invalid project or request ID.")
    policy = json.loads(REGISTRY.read_text()).get(repository)
    if not policy:
        raise ValueError("This repository has not been registered on the project server.")
    branch = policy["branch"]
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/-]{0,180}", branch) or ".." in branch:
        raise ValueError("Invalid registered default branch.")
    remote = "git@github.com:" + repository + ".git"
    ref = "refs/heads/wolf/project-" + job_id
    personal = HOME_DIR / "projects" / repository / ".git"
    STATE.mkdir(mode=0o711, exist_ok=True)
    receipts = STATE / "receipts"
    receipts.mkdir(mode=0o700, exist_ok=True)
    receipt_path = receipts / (job_id + ".json")
    with (receipts / (job_id + ".lock")).open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        receipt = json.loads(receipt_path.read_text()) if receipt_path.is_file() else None
        if receipt and receipt["repository"] != repository:
            raise ValueError("Mismatched project request.")
        if payload["portfolio"] == "publish":
            if not receipt:
                raise ValueError("The candidate is unavailable.")
            authorize_publication(policy, receipt, repository, payload.get("revision"))
            target = receipt["revision"]
            if receipt.get("published") != target:
                if owner_git(personal, "rev-parse", ref) != target:
                    raise ValueError("The saved candidate has changed.")
                # Git's receive-pack must acknowledge the exact update. The project's workflow owns the subsequent merge.
                owner_git(personal, "push", "--porcelain", remote, target + ":" + ref)
                receipt["published"] = target
                atomic_json(receipt_path, receipt)
            return {"revision": target, "branch": ref.removeprefix("refs/heads/")}
        if payload["portfolio"] != "prepare":
            raise ValueError("Unknown project operation.")
        if receipt:
            if receipt.get("changed") != payload["change"] or receipt.get("goal") != payload["goal"]:
                raise ValueError("The original project request has changed.")
            return receipt
        # The parent and mount point cannot be replaced by the operator. No personal .git directory is mounted.
        with tempfile.TemporaryDirectory(dir=STATE) as name:
            directory = Path(name)
            directory.chmod(0o711)
            source, scratch = directory / "source.git", directory / "scratch"
            account = pwd.getpwnam(OWNER)
            for path in (source, scratch):
                path.mkdir()
                os.chown(path, account.pw_uid, account.pw_gid)
            owner_run([GIT, "init", "--bare", "--quiet", "--template=", source])
            owner_git(source, "fetch", "--no-tags", "--no-recurse-submodules", "--depth=1",
                      remote, "refs/heads/" + branch + ":refs/heads/source")
            base = owner_git(source, "rev-parse", "refs/heads/source")
            if not SHA.fullmatch(base):
                raise ValueError("Invalid canonical revision.")
            job = dict(repository=repository, base=base, defaultBranch=branch, branch=ref.removeprefix("refs/heads/"),
                       goal=payload["goal"], change=payload["change"], release="project",
                       files=payload["files"], selection=payload["selection"], gitToken="mounted-source")
            result = run_worker(job, source)
            if result.get("base") != base or bool(result.get("patch")) != job["change"]:
                raise ValueError("Worker result differs from its requested source or change mode.")
            revision = base
            if job["change"]:
                patch = result["patch"].encode()
                title = result["notes"].splitlines()[0][:150]
                revision = owner_run(["/usr/bin/python3", __file__, "record", source, scratch / "index", base, ref, title], patch)
                if not SHA.fullmatch(revision):
                    raise ValueError("Invalid saved candidate.")
                owner_git(personal, "fetch", "--no-tags", "--update-shallow", source, ref + ":" + ref)
            receipt = dict(repository=repository, base=base, revision=revision, changed=job["change"],
                           goal=job["goal"], notes=result["notes"], checks=result["checks"], branch=ref.removeprefix("refs/heads/"))
            atomic_json(receipt_path, receipt)
            return receipt


if __name__ == "__main__":
    if os.geteuid() == 0 or len(sys.argv) != 7 or sys.argv[1] != "record":
        raise SystemExit("Invalid candidate operation.")
    print(record_candidate(Path(sys.argv[2]), Path(sys.argv[3]), sys.argv[4], sys.argv[5], sys.stdin.buffer.read(), sys.argv[6]))
