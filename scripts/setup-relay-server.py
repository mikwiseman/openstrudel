#!/usr/bin/env python3
"""One restricted SSH forward; application TLS stays end to end on the Mac."""
import json, os, pathlib, pwd, subprocess, sys

request=json.load(open(sys.argv[1]))
key=request['key'].strip()
if not key.startswith('ssh-ed25519 ') or '\n' in key:raise ValueError('Invalid public key')
user='strudel-relay'
try:
    account=pwd.getpwnam(user)
    if account.pw_gecos != 'OpenStrudel encrypted transport':raise ValueError('User name already in use')
except KeyError:
    subprocess.run(['useradd','--create-home','--shell','/usr/sbin/nologin','--comment','OpenStrudel encrypted transport',user],check=True)
    subprocess.run(['usermod','-p','*',user],check=True)
    account=pwd.getpwnam(user)
directory=pathlib.Path(account.pw_dir)/'.ssh'
directory.mkdir(mode=0o700,exist_ok=True)
os.chown(directory,account.pw_uid,account.pw_gid)
authorized=directory/'authorized_keys'
authorized.write_text('restrict,port-forwarding,permitlisten="0.0.0.0:17789",command="/bin/false" '+key+'\n')
authorized.chmod(0o600);os.chown(authorized,account.pw_uid,account.pw_gid)
config=pathlib.Path('/etc/ssh/sshd_config.d/95-openstrudel-relay.conf')
config.write_text('''# OpenStrudel: a dedicated account can open exactly one encrypted public port.
Match User strudel-relay
    AuthenticationMethods publickey
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    AllowTcpForwarding remote
    AllowStreamLocalForwarding no
    GatewayPorts clientspecified
    PermitListen 0.0.0.0:17789
    PermitOpen none
    ClientAliveInterval 20
    ClientAliveCountMax 3
    AllowAgentForwarding no
    X11Forwarding no
    PermitTTY no
    ForceCommand /bin/false
Match all
''')
subprocess.run(['/usr/sbin/sshd','-t'],check=True)
subprocess.run(['systemctl','reload','ssh'],check=True)
print('Restricted relay account ready; existing SSH accounts unchanged')
