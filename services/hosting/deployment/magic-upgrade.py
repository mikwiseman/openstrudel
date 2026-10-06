#!/usr/bin/env python3
"""Reviewed schema 8→9 magic-link release; changes only auth and mail configuration."""
import datetime,fcntl,json,os,pathlib,re,shutil,signal,sqlite3,subprocess,sys,time
os.umask(0o077)
def interrupted(signum,frame):raise InterruptedError('Deployment interrupted')
signal.signal(signal.SIGTERM,interrupted)
signal.signal(signal.SIGINT,interrupted)
root=pathlib.Path('/srv/wai-vds')
release=sys.argv[1]
assert os.geteuid()==0 and re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}',release)
lock=(root/'deploy.lock').open('a');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
previous=(root/'current-release').read_text().strip()
if previous==release:print('Already installed; no restart.');sys.exit(0)
assert previous in ('20261005-vds-v10','20261005-vds-v11')
def run(args,**kw):return subprocess.check_output(args,text=True,**kw).strip()
def image(version):return run(['docker','image','inspect','wai-vds:'+version,'--format','{{.Id}}'])
def inspect():return json.loads(run(['docker','inspect','wai-vds','--format','{{json .}}']))
def compose(version,args):
    env=os.environ.copy();env['WAI_VDS_RELEASE']=version
    return run(['docker','compose','-p','wai-vds','--project-directory',str(root),'--env-file','/dev/null','-f',str(root/'releases'/version/'deploy/compose.yml')]+args,env=env)
def healthy(version,expected):
    for _ in range(40):
        c=inspect()
        if c['Image']==expected and c['Config']['Image']=='wai-vds:'+version and c['State'].get('Health',{}).get('Status')=='healthy':return
        time.sleep(2)
    raise RuntimeError('Exact release health failed')
def get(path,host='server.waiwai.is'):
    return json.loads(run(['curl','-fsS','--max-time','15','https://'+host+path]))
def atomic(path,data,mode=0o600):
    temp=path.with_name(path.name+'.next');temp.write_text(data);temp.chmod(mode);temp.replace(path)
c=inspect();old_image=image(previous)
assert c['Image']==old_image and c['State']['Health']['Status']=='healthy'
assert c['Config']['Labels']['com.docker.compose.project']=='wai-vds' and c['Config']['Labels']['com.docker.compose.service']=='wai-vds'
env_path=root/'runtime.env';env_text=env_path.read_text();env=dict(l.split('=',1) for l in env_text.splitlines() if l and not l.startswith('#'))
assert env_path.stat().st_uid==0 and env_path.stat().st_mode&0o777==0o600
assert env['WAI_ORIGIN']=='https://server.waiwai.is' and env['WAI_PROVIDER']=='kamatera' and env['WAI_PAYMENTS']=='wai_pay' and env['WAI_PAY_MODE']=='live'
assert not env.get('WAI_HOME_LIVE_APPROVAL')
baseline=get('/api/v1/catalog');get('/api/v1/healthz','pay.waiwai.is')
compose(release,['config','--quiet']);print('Building and testing candidate image.',flush=True)
subprocess.run(['docker','build','-f',str(root/'releases'/release/'app/Dockerfile'),'-t','wai-vds:'+release,str(root/'releases'/release/'app')],check=True)
candidate=image(release)
stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ');backup=root/'backups'/('magic-'+stamp);backup.mkdir(mode=0o700)
for file in ['runtime.env','current-release']:shutil.copy2(root/file,backup/file)
for file in ['master.key','bootstrap-signing.pem']:shutil.copy2(root/'data'/file,backup/file)
db=sqlite3.connect((root/'data/wai.sqlite').as_uri()+'?mode=ro',uri=True)
assert db.execute('PRAGMA user_version').fetchone()[0] in (8,9)
assert db.execute("SELECT count(*) FROM servers WHERE state!='deleted' AND provider_mode='kamatera'").fetchone()[0]==0
assert db.execute("SELECT count(*) FROM capacity_reservations WHERE state IN('held','committed')").fetchone()[0]==0
saved=sqlite3.connect(backup/'wai.sqlite');db.backup(saved);saved.close();db.close();(backup/'wai.sqlite').chmod(0o600)
shutil.copy2(backup/'wai.sqlite',backup/'migration-review.sqlite')
migration=json.loads(run(['docker','run','--rm','--pull','never','--network','none','--read-only','--user','0:0','--cap-drop','ALL','--cap-add','DAC_READ_SEARCH','--security-opt','no-new-privileges','--memory','256m','--pids-limit','32','--mount','type=bind,source='+str(backup)+',target=/review','--entrypoint','node',candidate,'scripts/check-migration.mjs','/review/migration-review.sqlite']))
assert migration['to']==9 and migration['existing_rows_unchanged'] is True
(backup/'migration-review.json').write_text(json.dumps(migration,indent=2)+'\n')
secret_path=root/'incoming/resend-magic.env'
if secret_path.exists():
    assert secret_path.stat().st_uid==0 and secret_path.stat().st_mode&0o777==0o600
    secret=secret_path.read_text().strip().split('=',1)
else:secret=['WAI_RESEND_API_KEY',env.get('WAI_RESEND_API_KEY','')]
assert secret[0]=='WAI_RESEND_API_KEY' and re.fullmatch(r're_[A-Za-z0-9_-]+',secret[1])
updates={'WAI_MAGIC_LINK_ENABLED':'1','WAI_RESEND_API_KEY':secret[1],'WAI_RESEND_FROM':'WAI Server <login@mail.waiwai.is>'}
seen=set();lines=[]
for l in env_text.splitlines():
    k=l.split('=',1)[0]
    if k in updates:assert k not in seen;seen.add(k);l=k+'='+updates[k]
    lines.append(l)
lines.extend(k+'='+v for k,v in updates.items() if k not in seen)
try:
    atomic(env_path,'\n'.join(lines)+'\n')
    compose(release,['up','-d','--no-deps','--no-build','wai-vds']);healthy(release,candidate)
    health=get('/healthz');catalog=get('/api/v1/catalog');home=get('/api/v2/openstrudel/catalog');api=get('/api/v2/openstrudel/openapi.json');oauth=get('/.well-known/oauth-authorization-server');pay=get('/api/v1/healthz','pay.waiwai.is')
    auth=get('/api/v1/auth/options');assert auth['magic_link'] is True
    assert health['ok'] and health['service']=='wai-vds' and pay['ok'] and pay['service']=='wai-pay'
    assert catalog==baseline and home['purchase_enabled'] is False and home['platforms']['ios']['purchase_enabled'] is False
    assert home['profile']['ram_mb']==4096 and home['profile']['disk_gb']==30 and all(m['amount_minor'] is None for m in home['payment_methods'])
    assert api['openapi']=='3.1.0' and oauth['issuer']=='https://server.waiwai.is'
    db=sqlite3.connect((root/'data/wai.sqlite').as_uri()+'?mode=ro',uri=True)
    assert db.execute('PRAGMA user_version').fetchone()[0]==9 and db.execute('PRAGMA integrity_check').fetchone()[0]=='ok' and not db.execute('PRAGMA foreign_key_check').fetchall()
    assert db.execute('SELECT count(*) FROM os_orders').fetchone()[0]==0
    db.close()
    for file in ['master.key','bootstrap-signing.pem']:assert (backup/file).read_bytes()==(root/'data'/file).read_bytes()
    atomic(root/'current-release',release+'\n')
    report={'ok':True,'release':release,'previous':previous,'image':candidate,'backup':str(backup),'schema':9,'magic_link_enabled':True,'sender':'login@mail.waiwai.is','home_purchase_enabled':False,'retail_price_published':False,'standalone_catalog_unchanged':True,'keys_unchanged':True,'new_invoices':0,'new_vms':0,'migration':migration,'checked_at':datetime.datetime.now(datetime.timezone.utc).isoformat()}
    atomic(backup/'result.json',json.dumps(report,indent=2)+'\n');print(json.dumps(report));secret_path.unlink(missing_ok=True)
except BaseException:
    atomic(env_path,env_text);compose(previous,['up','-d','--no-deps','--no-build','wai-vds']);healthy(previous,old_image)
    assert get('/healthz')['ok'] and get('/api/v1/catalog')==baseline
    atomic(root/'current-release',previous+'\n')
    print('Candidate failed; exact previous release restored, current database retained. Backup: '+str(backup),file=sys.stderr);raise
