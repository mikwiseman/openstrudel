"""Build a registered QA package and publish an expiring private download."""
import fcntl
import hashlib
import json
import os
import pwd
import re
import secrets
import shutil
import stat
import subprocess
import tempfile
from pathlib import Path


def save_artifact(source, public, name):
    fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as original:
        st = os.fstat(original.fileno())
        if not stat.S_ISREG(st.st_mode) or not 0 < st.st_size <= 512 * 1024 ** 2:
            raise ValueError("The package is empty, oversized or invalid.")
        token = secrets.token_urlsafe(32)
        directory = public / token
        directory.mkdir(mode=0o755)
        digest = hashlib.sha256()
        try:
            with (directory / name).open("xb") as dest:
                for chunk in iter(lambda: original.read(1024*1024), b""):
                    dest.write(chunk)
                    digest.update(chunk)
                dest.flush(); os.fsync(dest.fileno()); os.fchmod(dest.fileno(),0o644)
        except BaseException:
            shutil.rmtree(directory)
            raise
    return token + "/" + name, digest.hexdigest(), st.st_size


def build(payload):
    import portfolio as git
    repo, target, job_id = payload["repository"], payload["target"], payload["id"]
    if not git.REPO.fullmatch(repo) or target not in ("android","web") or not git.REQUEST.fullmatch(job_id):
        raise ValueError("Invalid package request.")
    cfg = json.loads(Path("/etc/wolf-project-worker/packages.json").read_text())
    row = cfg["projects"].get(repo, {})
    subdir, branch = row.get(target), row.get("branch")
    if not isinstance(subdir,str) or not branch or Path(subdir).is_absolute() or ".." in Path(subdir).parts:
        raise ValueError("This repository has no registered package for that platform.")
    if not re.fullmatch(r"sha256:[a-f0-9]{64}", cfg["image"]):
        raise ValueError("Invalid configured package image.")
    receipt = git.STATE / "receipts" / (job_id + "-package.json")
    receipt.parent.mkdir(mode=0o700, exist_ok=True)
    public = Path("/var/lib/wolf-package-downloads")
    with (git.STATE / "packages.lock").open("a") as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        if receipt.is_file():
            result=json.loads(receipt.read_text())
            if (result["repository"],result["target"]) != (repo,target):
                raise ValueError("Package request identity changed.")
            return result
        if shutil.disk_usage(git.STATE).free < 8 * 1024**3:
            raise ValueError("The project server needs more free disk space.")
        with tempfile.TemporaryDirectory(dir=git.STATE) as tmp:
            directory=Path(tmp); directory.chmod(0o711)
            source,export=directory/"source.git",directory/"export"
            source.mkdir(); export.mkdir()
            owner=pwd.getpwnam(git.OWNER)
            os.chown(source,owner.pw_uid,owner.pw_gid)
            os.chown(export,1000,1000)
            git.owner_run([git.GIT,"init","--bare","--quiet","--template=",source])
            origin="git@github.com:"+repo+".git"
            requested=payload.get("revision")
            if requested and not git.SHA.fullmatch(requested):
                raise ValueError("The source revision is invalid.")
            git.owner_git(source,"fetch","--no-tags","--no-recurse-submodules","--depth=1",origin,requested or "refs/heads/"+branch)
            sha=git.owner_git(source,"rev-parse","FETCH_HEAD")
            if not git.SHA.fullmatch(sha) or requested and requested!=sha:
                raise ValueError("The package source revision changed.")
            git.owner_git(source,"update-ref","refs/heads/source",sha)
            container="wolf-package-"+job_id
            command=["/usr/bin/docker","run","--rm","--init","--name",container,"--network=wolf-packages",
                     "--read-only","--security-opt=no-new-privileges","--cap-drop=ALL","--pids-limit=768",
                     "--cpus=4","--memory=9g","--memory-swap=9g","--user=1000:1000",
                     "--tmpfs=/work:rw,exec,nosuid,nodev,size=5g,uid=1000,gid=1000,mode=0700",
                     "--tmpfs=/tmp:rw,exec,nosuid,nodev,size=256m,mode=1777",
                     "--mount","type=bind,src="+str(source)+",dst=/wolf-source,readonly",
                     "--mount","type=bind,src="+str(export)+",dst=/export"]
            if target=="android":
                command.extend(["--mount","type=bind,src=/opt/wolf-android,dst=/opt/android,readonly"])
            command.extend([cfg["image"],target,subdir,sha])
            try:
                # The package tools need public registries. The dedicated bridge blocks the host and private networks.
                with (directory/"build.log").open("w+b") as log:
                    run=subprocess.run(command,stdout=log,stderr=subprocess.STDOUT,timeout=2700)
                    if run.returncode:
                        log.seek(max(0,log.tell()-2400))
                        reason=log.read().decode(errors="replace")
                        git.atomic_json(receipt.with_suffix(".error.json"),{"revision":sha,"exitCode":run.returncode,"log":reason})
                        raise ValueError("Package build failed: "+reason[-1800:])
            finally:
                subprocess.run(["/usr/bin/docker","rm","-f",container],capture_output=True,timeout=20)
            artifact=export/"artifact"
            if target=="android":
                signer=pwd.getpwnam("wolf-qa-sign")
                stage=directory/"sign";stage.mkdir(mode=0o700);os.chown(stage,signer.pw_uid,signer.pw_gid)
                fd=os.open(artifact,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
                with os.fdopen(fd,"rb") as binary:
                    statbuf=os.fstat(binary.fileno())
                    if not stat.S_ISREG(statbuf.st_mode) or not 0<statbuf.st_size<=512*1024**2:
                        raise ValueError("Invalid Android package.")
                    with (stage/"input.apk").open("xb") as copied:
                        shutil.copyfileobj(binary,copied);os.fchmod(copied.fileno(),0o444)
                artifact=stage/"signed.apk"
                subprocess.run(["/usr/sbin/runuser","-u","wolf-qa-sign","--","/usr/bin/python3","/opt/wolf-tools/sign-qa.py",
                                repo,row["packageId"],stage/"input.apk",artifact],check=True,timeout=180)
            suffix="qa.apk" if target=="android" else "web.zip"
            name=repo.split("/")[1]+"-"+sha[:12]+"-"+suffix
            relative,digest,size=save_artifact(artifact,public,name)
            result=dict(repository=repo,target=target,revision=sha,name=name,size=size,sha256=digest,
                        url=cfg["baseUrl"].rstrip("/")+"/"+relative)
            git.atomic_json(receipt,result)
            return result
