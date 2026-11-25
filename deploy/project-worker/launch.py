#!/usr/bin/python3
"""Fixed SSH command. Only a read token and the current OAuth access token reach one job."""
import json
import os
import signal
import subprocess
import sys
import uuid
from pathlib import Path

def main():
    if sys.argv[1:] or os.environ.get("SSH_ORIGINAL_COMMAND"):
        raise ValueError("This key accepts only the Wolf project protocol.")
    request=sys.stdin.buffer.read(40*1024*1024+1)
    if len(request)>40*1024*1024:
        raise ValueError("Request is too large.")
    job=json.loads(request)
    config=json.loads(Path("/etc/wolf-project-worker/config.json").read_text())
    if not config["image"].startswith("sha256:") or len(config["image"])!=71:
        raise ValueError("Configure an immutable worker image.")
    if job.get("portfolio") == "package":
        sys.path.insert(0, "/opt/wolf-tools")
        from packages import build
        result = build(job)
    elif "portfolio" in job:
        sys.path.insert(0, "/opt/wolf-tools")
        from portfolio import handle
        result = handle(job, lambda task, source: run_worker(task, config, source))
    else:
        result = run_worker(job, config)
    json.dump(result, sys.stdout)
    return 0

def run_worker(job, config, source=None):
    account=json.loads(subprocess.check_output(["/usr/sbin/runuser","-u","wolf-dev","--","/usr/bin/env","HOME=/var/lib/wolf-dev","/usr/local/bin/node","/opt/wolf-tools/account.mjs"],cwd="/var/tmp",timeout=40))
    if account["email"].lower()!=config["email"].lower():
        raise ValueError("The worker subscription has changed.")
    name="wolf-job-"+uuid.uuid4().hex
    argv=["/usr/bin/docker","run","--rm","--init","--interactive","--name",name,
          "--read-only","--cap-drop=ALL","--security-opt=no-new-privileges",
          "--security-opt=seccomp=/etc/wolf-project-worker/seccomp.json","--security-opt=apparmor=openstrudel-container",
          "--pids-limit=512","--cpus=4","--memory=6g","--memory-swap=6g","--user=1000:1000",
          "--tmpfs=/work:rw,exec,nosuid,nodev,size=4g,uid=1000,gid=1000,mode=0700",
          "--tmpfs=/tmp:rw,exec,nosuid,nodev,size=256m,mode=1777",config["image"]]
    if source is not None:
        argv[-1:] = ["--mount", "type=bind,src=" + str(source) + ",dst=/wolf-source,readonly", config["image"], "--mounted-source"]
    def stop(signum,frame):
        raise InterruptedError("The SSH connection closed.")
    for signum in (signal.SIGHUP,signal.SIGTERM):
        signal.signal(signum,stop)
    try:
        result=subprocess.run(argv,input=json.dumps({"job":job,"account":account}).encode(),stdout=subprocess.PIPE,timeout=3600,check=True)
        if len(result.stdout) > 40 * 1024 * 1024:
            raise ValueError("Project result is too large.")
        return json.loads(result.stdout)
    finally:
        subprocess.run(["/usr/bin/docker","rm","-f",name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=20)
if __name__=="__main__":
    try:
        sys.exit(main())
    except (ValueError,OSError,subprocess.SubprocessError,KeyError) as error:
        print("Wolf project runner:",str(error)[-1600:],file=sys.stderr)
        sys.exit(1)
