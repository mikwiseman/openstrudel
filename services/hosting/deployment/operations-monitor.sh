#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ $(id -u) == 0 ]] || exit 1
root=/srv/wai-vds
ops=$root/operations
exec 9>"$root/deploy.lock"
flock -n 9 || { echo '{"action":"none","reason":"deployment_in_progress"}'; exit 0; }
[[ ! -e "$ops/maintenance" ]] || { echo '{"action":"none","reason":"maintenance"}'; exit 0; }
release=$(cat "$root/current-release")
[[ "$release" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$ ]] || exit 1
image=$(docker image inspect "wai-vds:$release" --format '{{.Id}}')
[[ "$image" =~ ^sha256:[a-f0-9]{64}$ ]] || exit 1
stage=$(mktemp -d "$ops/tmp/monitor.XXXXXXXX")
trap 'rm -rf -- "$stage"' EXIT
# Deliberately never captures Config.Env or health-check log output.
docker inspect wai-vds --format '{"id":{{json .Id}},"name":{{json .Name}},"image":{{json .Config.Image}},"imageId":{{json .Image}},"project":{{json (index .Config.Labels "com.docker.compose.project")}},"service":{{json (index .Config.Labels "com.docker.compose.service")}},"running":{{json .State.Running}},"status":{{json .State.Status}},"health":{{json .State.Health.Status}},"mounts":{{json .Mounts}}}' > "$stage/container.json" 2>/dev/null || printf '{}\n' > "$stage/container.json"
owned_id=$(python3 - "$stage/container.json" "$release" "$image" <<'PY'
import sys,json,re
c=json.load(open(sys.argv[1]));m=next((x for x in c.get('mounts',[]) if x.get('Destination')=='/var/lib/wai-vds'),{})
valid=c.get('name')=='/wai-vds' and c.get('project')==c.get('service')=='wai-vds' and c.get('image')=='wai-vds:'+sys.argv[2] and c.get('imageId')==sys.argv[3] and m.get('Source')=='/srv/wai-vds/data' and re.fullmatch(r'[a-f0-9]{64}',c.get('id',''))
print(c['id'] if valid else '')
PY
)
probe_internal() {
  [[ -n "$owned_id" ]] && docker exec "$owned_id" node -e "require('node:http').get('http://127.0.0.1:4781/healthz',{headers:{host:'server.waiwai.is'},timeout:4000},r=>{let b='';r.on('data',x=>b+=x);r.on('end',()=>{try{let j=JSON.parse(b);console.log(JSON.stringify({ok:r.statusCode===200&&j.ok===true,service:j.service,provider:j.provider,payments:j.payments}))}catch{console.log('{}')}})}).on('timeout',function(){this.destroy()}).on('error',()=>process.exit(1))" > "$stage/internal.json" 2>/dev/null || printf '{}\n' > "$stage/internal.json"
}
probe_internal
curl -fsS --max-time 5 https://server.waiwai.is/healthz > "$stage/public.json" 2>/dev/null || printf '{}\n' > "$stage/public.json"
# Run the reviewed monitor module as the data owner; no environment dump or app imports.
# SQLite is opened readOnly/query_only. Probe failure is an alert, never a restart input.
[[ -n "$owned_id" ]] && timeout 8s docker exec -i --user 1000:1000 "$owned_id" node --input-type=module - probe /var/lib/wai-vds/wai.sqlite < "$ops/production-monitor.mjs" > "$stage/business.json" 2>/dev/null || printf '{}\n' > "$stage/business.json"
python3 - "$stage" "$ops/monitor-state.json" "$release" "$image" "$ops/backups" <<'PY'
import sys,json,pathlib,re,datetime
p,state,release,image=pathlib.Path(sys.argv[1]),pathlib.Path(sys.argv[2]),sys.argv[3],sys.argv[4]
def load(f):
 try:return json.loads(f.read_text())
 except:return {}
c=load(p/'container.json');mount=next((m for m in c.pop('mounts',[]) if m.get('Destination')=='/var/lib/wai-vds'),{})
c['dataSource']=mount.get('Source');c['dataDestination']=mount.get('Destination')
snapshot={'release':release,'expectedImageId':image,'container':c,'internal':load(p/'internal.json'),'public':load(p/'public.json'),'business':load(p/'business.json')}
latest=[];verified=[]
for f in pathlib.Path(sys.argv[5]).glob('wai-vds-*.tar.age.json'):
 if not re.fullmatch(r'wai-vds-\d{8}T\d{6}Z-[a-f0-9]{8}\.tar\.age\.json',f.name):continue
 meta=load(f)
 for key,target in [('created',latest),('restore_verified_at',verified)]:
  try:target.append(datetime.datetime.fromisoformat(meta[key].replace('Z','+00:00')).timestamp()*1000)
  except:pass
snapshot['backup']={'latest':max(latest,default=None),'verified':max(verified,default=None)}
(p/'input.json').write_text(json.dumps({'snapshot':snapshot,'state':load(state)}))
PY
docker run --rm --pull never --network none --read-only --user 0:0 --cap-drop ALL --security-opt no-new-privileges --memory 64m --pids-limit 16 --entrypoint node --mount "type=bind,source=$ops/production-monitor.mjs,target=/operation.mjs,readonly" -i "$image" /operation.mjs < "$stage/input.json" > "$stage/decision.json"
python3 - "$stage/decision.json" "$ops/monitor-state.json" <<'PY'
import sys,json,pathlib,os
d=json.loads(pathlib.Path(sys.argv[1]).read_text());p=pathlib.Path(sys.argv[2]);t=p.with_suffix('.tmp');t.write_text(json.dumps(d['state']));os.chmod(t,0o600);os.replace(t,p)
PY
action=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["action"])' "$stage/decision.json")
if [[ "$action" == restart ]]; then
  id=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["containerId"])' "$stage/decision.json")
  [[ "$id" =~ ^[a-f0-9]{64}$ ]]
  test "$(cat "$root/current-release")" = "$release"
  test "$(docker inspect wai-vds --format '{{.Id}} {{.Image}} {{.State.Health.Status}} {{index .Config.Labels "com.docker.compose.project"}} {{index .Config.Labels "com.docker.compose.service"}}')" = "$id $image unhealthy wai-vds wai-vds"
  # One exact already-owned container, only after three failed checks. Never compose up.
  docker restart --time 20 "$id" >/dev/null
  recovered=0
  for attempt in $(seq 1 10); do
    if [[ $(docker inspect "$id" --format '{{.State.Health.Status}}') == healthy ]]; then
      probe_internal
      curl -fsS --max-time 5 https://server.waiwai.is/healthz > "$stage/public.json" 2>/dev/null || printf '{}\n' > "$stage/public.json"
      if python3 - "$stage" <<'PY'
import sys,pathlib,json
p=pathlib.Path(sys.argv[1]);a=json.loads((p/'internal.json').read_text());b=json.loads((p/'public.json').read_text());assert a.get('ok') is True and b.get('ok') is True and a.get('service')==b.get('service')=='wai-vds' and a.get('provider')=='kamatera' and a.get('payments')=='wai_pay'
PY
      then recovered=1; break; fi
    fi
    sleep 3
  done
  printf '{"action":"restart","owned_service":"wai-vds","recovered":%s}\n' "$([[ "$recovered" == 1 ]] && echo true || echo false)"
  [[ "$recovered" == 1 ]] || exit 1
else
  python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));print(json.dumps({k:d[k] for k in ("action","reason","business") if k in d}))' "$stage/decision.json"
  [[ "$action" == none ]] || exit 1
fi
