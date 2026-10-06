#!/usr/bin/env python3
"""One reviewed domain cutover on the documented host; retains current DB on rollback."""
import datetime,fcntl,hashlib,json,os,pathlib,re,shutil,socket,sqlite3,subprocess,sys,time,urllib.request

root=pathlib.Path('/srv/wai-vds');source=pathlib.Path('/srv/wai-pay/app/Caddyfile')
assert os.getuid()==0
release=sys.argv[1];assert re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}',release)
lock=(root/'deploy.lock').open('w');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
previous=(root/'current-release').read_text().strip();assert previous!=release
bundle=root/'releases'/release/'deploy';old=root/'releases'/previous/'deploy'
new_origin='https://server.waiwai.is';old_origin='https://pay.waiwai.is/vds'

def run(args,stdin=None,timeout=120):
    r=subprocess.run(args,input=stdin,capture_output=True,timeout=timeout)
    if r.returncode: raise RuntimeError('command_failed:'+args[0])
    return r.stdout
def health(origin):
    with urllib.request.urlopen(origin+'/healthz',timeout=10) as r:
        v=json.load(r);assert r.status==200 and v.get('ok') is True
        return v
def getjson(url):
    with urllib.request.urlopen(url,timeout=10) as r:return json.load(r)
def atomic(path,data,mode):
    temp=path.with_name(path.name+'.domain-new');temp.write_bytes(data);temp.chmod(mode);os.replace(temp,path)
def compose(version,verb):
    env=os.environ.copy();env['WAI_VDS_RELEASE']=version
    args=['docker','compose','-p','wai-vds','--project-directory',str(root),'--env-file','/dev/null','-f',str(root/'releases'/version/'deploy/compose.yml')]+verb
    result=subprocess.run(args,env=env,capture_output=True,timeout=180)
    if result.returncode:raise RuntimeError('compose_failed')
    return result.stdout
def wait_container(version):
    expected=json.loads(run(['docker','image','inspect','wai-vds:'+version,'--format','{{json .Id}}']))
    for attempt in range(40):
        c=json.loads(run(['docker','inspect','wai-vds','--format','{"image":{{json .Config.Image}},"id":{{json .Image}},"health":{{json .State.Health.Status}},"project":{{json (index .Config.Labels "com.docker.compose.project")}},"service":{{json (index .Config.Labels "com.docker.compose.service")}}}']))
        if c=={'image':'wai-vds:'+version,'id':expected,'health':'healthy','project':'wai-vds','service':'wai-vds'}:return c
        time.sleep(2)
    raise RuntimeError('container_health_failed')
def app(phase):
    out=json.loads(run(['docker','exec','-i','waipay-backend','node','--input-type=module','-',phase],(bundle/'domain-callback.mjs').read_bytes()))
    assert out.get('ok') is True
    return out
def files(path):return {str(x.relative_to(path)):hashlib.sha256(x.read_bytes()).hexdigest() for x in path.rglob('*') if x.is_file()}

assert files(bundle.parent/'app')==files(old.parent/'app'),'domain_deploy_must_not_change_application'
assert source.read_bytes()==(bundle/'Caddyfile.after').read_bytes(),'caddy_source_changed'
assert '103.45.247.25' in {x[4][0] for x in socket.getaddrinfo('server.waiwai.is',443)}
wait_container(previous)
assert health(old_origin)['service']=='wai-vds'
assert getjson('https://pay.waiwai.is/api/v1/healthz')['service']=='wai-pay'
catalog=getjson(old_origin+'/api/v1/catalog')
own_app=app('inspect')
compose(release,['config','--quiet']);compose(release,['build','wai-vds'])
run(['docker','exec','-i','waipay-caddy','caddy','validate','--config','-','--adapter','caddyfile'],(bundle/'Caddyfile.server').read_bytes())
active=run(['docker','exec','waipay-caddy','wget','-qO-','http://127.0.0.1:2019/config/'])
adapted=run(['docker','exec','-i','waipay-caddy','caddy','adapt','--config','-','--adapter','caddyfile'],source.read_bytes())
assert json.loads(active)==json.loads(adapted),'caddy_runtime_drift'
envfile=root/'runtime.env';envdata=envfile.read_bytes();assert envfile.stat().st_mode&0o777==0o600
old_line=('WAI_ORIGIN='+old_origin).encode();assert envdata.splitlines().count(old_line)==1
new_env=b'\n'.join(('WAI_ORIGIN='+new_origin).encode() if line==old_line else line for line in envdata.split(b'\n'))
stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
backup=root/'backups'/('domain-'+stamp);backup.mkdir(mode=0o700)
for src,name in [(envfile,'runtime.env'),(source,'Caddyfile'),(root/'operations/operations-monitor.sh','operations-monitor.sh'),(root/'current-release','current-release')]:shutil.copy2(src,backup/name)
(backup/'Caddy.active.json').write_bytes(active);(backup/'callback.before.json').write_text(json.dumps(own_app))
db=sqlite3.connect('file:'+str(root/'data/wai.sqlite')+'?mode=ro',uri=True)
assert db.execute('PRAGMA user_version').fetchone()[0]==7
assert db.execute("SELECT count(*) FROM capacity_reservations WHERE state IN ('held','committed')").fetchone()[0]==0
assert db.execute("SELECT count(*) FROM servers WHERE state!='deleted'").fetchone()[0]==0
assert db.execute("SELECT count(*) FROM orders WHERE status='needs_refund'").fetchone()[0]==0
saved=sqlite3.connect(backup/'wai.sqlite');db.backup(saved);assert saved.execute('PRAGMA integrity_check').fetchone()[0]=='ok';saved.close();db.close()
for name in ['master.key','bootstrap-signing.pem']:shutil.copy2(root/'data'/name,backup/name)
for path in backup.iterdir():path.chmod(0o600)
applied=False;callback_changed=False
try:
    applied=True
    atomic(envfile,new_env,0o600)
    compose(release,['up','-d','--no-deps','--no-build','--pull','never','wai-vds']);container=wait_container(release)
    atomic(source,(bundle/'Caddyfile.server').read_bytes(),0o644)
    # Existing single-file bind mount may point at an older inode. Reload exact host source via stdin.
    run(['docker','exec','-i','waipay-caddy','caddy','reload','--config','-','--adapter','caddyfile'],source.read_bytes())
    healthy=False
    for attempt in range(18):
        try:
            healthy=health(new_origin).get('service')=='wai-vds'
            if healthy:break
        except Exception:pass
        time.sleep(3)
    assert healthy,'https_not_ready'
    assert getjson(new_origin+'/api/v1/catalog')==catalog
    assert getjson('https://pay.waiwai.is/api/v1/healthz')['service']=='wai-pay'
    callback_changed=True;callback=app('apply')
    atomic(root/'operations/operations-monitor.sh',(bundle/'operations-monitor.sh').read_bytes(),0o500)
    atomic(root/'current-release',(release+'\n').encode(),0o600)
    report={'ok':True,'release':release,'origin':new_origin,'backup':str(backup),'container':container,'callback':callback,'applicationUnchanged':True,'credentialsUnchanged':True,'schema':7,'newInvoices':0,'newVMs':0,'legacyCompatibility':False,'checkedAt':datetime.datetime.now(datetime.timezone.utc).isoformat()}
    (backup/'result.json').write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2))
except BaseException:
    if applied:
        recovered=True
        try:
            if callback_changed:app('rollback')
            atomic(envfile,(backup/'runtime.env').read_bytes(),0o600)
            compose(previous,['up','-d','--no-deps','--no-build','--pull','never','wai-vds']);wait_container(previous)
            atomic(source,(backup/'Caddyfile').read_bytes(),0o644)
            run(['docker','exec','-i','waipay-caddy','caddy','reload','--config','-'],active)
            atomic(root/'operations/operations-monitor.sh',(backup/'operations-monitor.sh').read_bytes(),0o500)
            atomic(root/'current-release',(previous+'\n').encode(),0o600)
            assert health(old_origin)['service']=='wai-vds'
            assert getjson('https://pay.waiwai.is/api/v1/healthz')['service']=='wai-pay'
        except Exception:recovered=False
        print(json.dumps({'ok':False,'rollbackVerified':recovered,'currentDatabasePreserved':True,'backup':str(backup)}))
    raise SystemExit(1)
