"""Run as the QA signing account. Its debug keys never enter a project build."""
import os
from pathlib import Path
import re
import subprocess
import sys

if os.geteuid() == 0 or len(sys.argv) != 5:
    raise SystemExit("Use the QA signing account.")
repository, expected, source, output = sys.argv[1:]
if not re.fullmatch(r"[A-Za-z0-9_-]+/[A-Za-z0-9_.-]+",repository):
    raise SystemExit("Invalid signing project.")
tools=Path("/opt/wolf-android/build-tools/36.0.0")
identity=subprocess.check_output([tools/"aapt","dump","badging",source],text=True).splitlines()[0]
if not identity.startswith("package: name='"+expected+"'"):
    raise SystemExit("The package ID differs from this project's QA application.")
os.umask(0o077)
key=Path("/var/lib/wolf-qa-sign/keys")/(repository+".jks")
key.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
if not key.is_file():
    subprocess.run(["keytool","-genkeypair","-keystore",key,"-storepass","android","-keypass","android",
                    "-alias","androiddebugkey","-keyalg","RSA","-keysize","2048","-validity","10000",
                    "-dname","CN=Wolf Android QA"],check=True,stdout=subprocess.DEVNULL)
subprocess.run([tools/"apksigner","sign","--ks",key,"--ks-key-alias","androiddebugkey","--ks-pass","pass:android",
                "--key-pass","pass:android","--out",output,source],check=True)
subprocess.run([tools/"apksigner","verify",output],check=True)
