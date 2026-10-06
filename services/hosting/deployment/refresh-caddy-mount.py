#!/usr/bin/env python3
"""Finish the v9 cutover: refresh the read-only Caddy bind inode with exact-service recreation."""
import datetime,fcntl,hashlib,ipaddress,json,os,pathlib,re,shutil,subprocess,time,urllib.request
r=pathlib.Path('/srv/wai-vds');b=r/'backups/domain-20261005T144003Z';source=pathlib.Path('/srv/wai-pay/app/Caddyfile')
assert os.getuid()==0 and (r/'current-release').read_text().strip()=='20261005-vds-v9'
lock=(r/'deploy.lock').open('w');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
def run(args,data=None):
    p=subprocess.run(args,input=data,capture_output=True,timeout=90)
    if p.returncode:raise RuntimeError('exact_service_operation_failed')
    return p.stdout
def health(url):
    with urllib.request.urlopen(url,timeout=10) as p:
        d=json.load(p);assert p.status==200 and d.get('ok') is True
def up(version):
    env=os.environ.copy();env['WAI_VDS_RELEASE']=version
    p=subprocess.run(['docker','compose','-p','wai-vds','--project-directory',str(r),'--env-file','/dev/null','-f',str(r/'releases'/version/'deploy/compose.yml'),'up','-d','--no-deps','--no-build','--pull','never','wai-vds'],env=env,capture_output=True,timeout=90)
    assert p.returncode==0
def atomic(path,data,mode):
    t=path.with_name(path.name+'.mount-new');t.write_bytes(data);t.chmod(mode);os.replace(t,path)
cmd=['docker','compose','-p','app','--project-directory','/srv/wai-pay/app','-f','/srv/wai-pay/app/docker-compose.yml','up','-d','--no-deps','--no-build','--pull','never','--force-recreate','caddy']
expected='sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648'
assert run(['docker','inspect','waipay-caddy','--format','{{.Image}} {{index .Config.Labels "com.docker.compose.project"}} {{index .Config.Labels "com.docker.compose.service"}}']).decode().strip()==expected+' app caddy'
assert run(['docker','image','inspect','caddy:2-alpine','--format','{{.Id}}']).decode().strip()==expected
assert hashlib.sha256(source.read_bytes()).hexdigest()=='26d71c3300a8370b79e503530ce361276f07d47f2872c32e26afd83c1f0350f2'
mounted=run(['docker','exec','waipay-caddy','cat','/etc/caddy/Caddyfile'])
assert mounted!=source.read_bytes(),'mount_already_current_no_restart'
assert mounted in [(r/'releases/20261005-vds-v9/deploy'/name).read_bytes() for name in ['Caddyfile.before','Caddyfile.after']]
run(['docker','exec','-i','waipay-caddy','caddy','validate','--config','-','--adapter','caddyfile'],source.read_bytes())
stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ');snap=r/'backups'/('proxy-'+stamp);snap.mkdir(mode=0o700)
for p,name in [(source,'Caddyfile'),(r/'runtime.env','runtime.env')]:shutil.copy2(p,snap/name)
try:
    run(cmd)
    assert run(['docker','inspect','waipay-caddy','--format','{{.Image}}']).decode().strip()==expected
    assert run(['docker','exec','waipay-caddy','cat','/etc/caddy/Caddyfile'])==source.read_bytes()
    ip=run(['docker','inspect','waipay-caddy','--format','{{with index .NetworkSettings.Networks "app_waipay"}}{{.IPAddress}}{{end}}']).decode().strip()
    assert re.fullmatch(r'172\.18\.0\.[0-9]{1,3}',ip)
    env=(r/'runtime.env').read_text();lines=[x for x in env.splitlines() if x.startswith('WAI_TRUSTED_PROXY_CIDRS=')];assert len(lines)==1
    ranges=lines[0].split('=',1)[1].strip('"').split(',')
    proxy_trusted=any(ipaddress.ip_address(ip) in ipaddress.ip_network(x,strict=False) for x in ranges)
    if not proxy_trusted:atomic(r/'runtime.env',env.replace(lines[0],'WAI_TRUSTED_PROXY_CIDRS='+ip+'/32').encode(),0o600);up('20261005-vds-v9')
    ready=False
    for n in range(15):
        try:
            health('https://server.waiwai.is/healthz');health('https://pay.waiwai.is/api/v1/healthz');ready=True;break
        except Exception:time.sleep(2)
    assert ready
    print(json.dumps({'ok':True,'exactService':'app/caddy','reason':'replace_stale_readonly_bind_inode','backup':str(snap),'imageUnchanged':True,'mountedConfigMatchesHost':True,'proxyIP':ip,'vdsRestartedForProxyAddress':not proxy_trusted}))
except BaseException:
    restored=False
    try:
        atomic(r/'runtime.env',(b/'runtime.env').read_bytes(),0o600);up('20261005-vds-v7')
        atomic(source,(b/'Caddyfile').read_bytes(),0o644);run(cmd)
        result=json.loads(run(['docker','exec','-i','waipay-backend','node','--input-type=module','-','rollback'],(r/'releases/20261005-vds-v9/deploy/domain-callback.mjs').read_bytes()));assert result['ok']
        atomic(r/'operations/operations-monitor.sh',(b/'operations-monitor.sh').read_bytes(),0o500)
        atomic(r/'current-release',b'20261005-vds-v7\n',0o600)
        health('https://pay.waiwai.is/vds/healthz');health('https://pay.waiwai.is/api/v1/healthz');restored=True
    except Exception:pass
    print(json.dumps({'ok':False,'previousDomainRestored':restored,'currentDatabasePreserved':True,'backup':str(snap)}));raise SystemExit(1)
