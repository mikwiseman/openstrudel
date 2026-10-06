import { randomUUID, createPublicKey, createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

export class ProviderError extends Error { constructor(code,definitive=false) {super(code);this.code=code;this.definitive=definitive;} }
export function publicIPv4(ip) {
  if(typeof ip!=='string'||isIP(ip)!==4)return false;
  const [a,b,c]=ip.split('.').map(Number);
  return !(a===0||a===10||a===127||a>=224||a===169&&b===254||a===172&&b>=16&&b<=31||
    a===100&&b>=64&&b<=127||a===192&&(b===168||b===0||b===88&&c===99)||
    a===198&&(b===18||b===19||b===51&&c===100)||a===203&&b===0&&c===113);
}
export function commandId(result) {
  let value=result?.command_ids??result;
  if(Array.isArray(value)) {if(value.length!==1)throw new ProviderError('unknown_response');value=value[0];}
  if(!['string','number'].includes(typeof value)||typeof value==='number'&&!Number.isSafeInteger(value)||
      !/^[1-9]\d*$/.test(String(value)))throw new ProviderError('unknown_response');
  return String(value);
}

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function ownedName(server) {
  if(!UUID.test(server?.id||'')||server.provider_name!=='wai-vds-'+server.id.replaceAll('-',''))
    throw new ProviderError('ownership_guard',true);
}
function ed25519PublicKey(value) {
  if(typeof value!=='string'||!/^ssh-ed25519 [A-Za-z0-9+/]+={0,2}(?: [^\r\n]+)?$/.test(value))return false;
  const encoded=value.split(' ')[1],key=Buffer.from(encoded,'base64');
  return key.length===51&&key.toString('base64')===encoded&&key.readUInt32BE(0)===11&&
    key.subarray(4,15).toString()==='ssh-ed25519'&&key.readUInt32BE(15)===32;
}
function validMinimums(min,diskSize=0,ramMb=2048,diskGb=20) {
  return [[min?.minCpu??0,1],[min?.minRamMB??min?.minRamMb??0,ramMb],
    [min?.minDiskSize??0,diskGb],[diskSize,diskGb]].every(([value,max])=>
      Number.isFinite(Number(value))&&Number(value)>=0&&Number(value)<=max);
}

const PRICE_SOURCE='https://kamatera.github.io/kamateratoolbox/calculator.js.php';
const PRICE_MAX_BYTES=512*1024;
// Kamatera's image list can return uppercase hex IDs while the per-image
// options and public calculator return lowercase. Only hex identity folds case.
const imagePart=value=>typeof value==='string'&&/^[A-Fa-f0-9-]{32,36}$/.test(value)?value.toLowerCase():value;
const sameImage=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.split(':')[0]===b.split(':')[0]&&imagePart(a.split(':')[1])===imagePart(b.split(':')[1]);
function priceMicros(value) {
  // Compare decimal prices without rounding a fractional fee down. Unknown
  // precision/units are not an invitation to use a historical price instead.
  if(typeof value!=='number'||!Number.isFinite(value)||value<0||value>1000000||!/^\d+(?:\.\d{1,6})?$/.test(String(value)))throw new ProviderError('price_unverified',true);
  const [whole,fraction='']=String(value).split('.');
  return BigInt(whole)*1000000n+BigInt(fraction.padEnd(6,'0'));
}
function publicPrice(catalog,region,image,{ramMb=2048,diskGb=20}={}) {
  const invalid=()=>{throw new ProviderError('price_unverified',true);};
  if(!catalog||typeof catalog!=='object'||Array.isArray(catalog)||!Array.isArray(catalog.datacenters)||!catalog.datacenters.includes(region))invalid();
  const parts=typeof image==='string'?image.split(':'):[];
  if(parts.length!==2||parts[0]!==region||!parts[1]||!Array.isArray(catalog.os))invalid();
  const images=catalog.os.filter(x=>imagePart(x?.id)===imagePart(parts[1]));
  if(images.length!==1||!Array.isArray(images[0].datacenters)||!images[0].datacenters.includes(region))invalid();
  const selected={base:'Base Price',cpu:'1A','ramMB.A':String(ramMb),diskGB:String(diskGb),wan:'1',['netPck.'+region]:'t5000',managed:'0'};
  const components={image:images[0].price};let micros=priceMicros(components.image);
  for(const [key,value] of Object.entries(selected)) {
    const groups=catalog[key];
    if(!Array.isArray(groups)||!groups.length||groups.some(x=>!Array.isArray(x?.options)))invalid();
    const options=groups.flatMap(x=>x.options).filter(x=>x?.value===value);
    if(options.length!==1)invalid();
    micros+=priceMicros(options[0].price);components[key]=options[0].price;
  }
  // The published backup values are coefficients, not a disabled-backup fee.
  // This profile explicitly sends backup:false and managed:false to Kamatera.
  const totalCents=(micros*102n+999999n)/1000000n;
  return {kind:'public_estimate',currency:'USD',baseMonthlyUsd:Number(micros)/1000000,administrationFeePercent:2,
    monthlyUsdWithAdministrationFee:Number(totalCents)/100,accountPriceVerified:false,taxVerified:false,components,
    profile:{datacenter:region,image,cpu:'1A',ramMb,diskGb,ipv4:1,traffic:'t5000',billing:'monthly',backup:false,managed:false}};
}

export class Emulator {
  constructor(store,now=Date.now) {this.s=store;this.now=now;this.mode='emulator';this.fault=null;}
  async preflight() {return {available:true,mode:'emulator',monthlyEstimate:6};}
  async list() {return this.s.all('SELECT * FROM sim_machines WHERE state != ?', 'deleted');}
  async find(name) {return (await this.list()).filter(x=>x.name===name);}
  async create(server) {
    if(['capacity','balance'].includes(this.fault))throw new ProviderError(this.fault,true);
    if(this.fault==='timeout_before')throw new ProviderError('unknown_result');
    const id=randomUUID();this.s.run('INSERT INTO sim_machines VALUES(?,?,?,?,?)',id,server.provider_name,'192.0.2.'+(10+Number(this.s.get('SELECT count(*) AS n FROM sim_machines').n)%220),'running',this.now());
    if(this.fault==='timeout_after')throw new ProviderError('unknown_result');
    return {commandId:'1'};
  }
  async details(server) {return this.s.get('SELECT * FROM sim_machines WHERE id=? AND state!=?',server.provider_id,'deleted');}
  async setup(server) {if(this.fault==='setup')throw new ProviderError('setup_failed');return {hostKey:'emulator: no SSH host exists'};}
  async check() {if(this.fault==='readiness')throw new ProviderError('readiness_failed');return true;}
  async poweroff(server) {this.s.run('UPDATE sim_machines SET state=? WHERE id=? AND name=?','off',server.provider_id,server.provider_name);}
  async remove(server) {this.s.run('UPDATE sim_machines SET state=? WHERE id=? AND name=?','deleted',server.provider_id,server.provider_name);}
}

// Only the operator-owned WAI VDS prefix and exact persisted UUID can be mutated.
export class Kamatera {
  constructor(config,vault,{fetcher=fetch,runner=runCommand}={}) {this.c=config;this.v=vault;this.fetcher=fetcher;this.runner=runner;this.mode='kamatera';this.auth=null;}
  async request(method,path,body,authenticated=true,beforeSend) {
    if(authenticated && (!this.auth||this.auth.until<Date.now())) {
      if(!this.c.kamateraId||!this.c.kamateraSecret)throw new ProviderError('credentials_missing',true);
      const a=await this.request('POST','/authenticate',{clientId:this.c.kamateraId,secret:this.c.kamateraSecret},false);
      if(typeof a?.authentication!=='string'||!a.authentication)throw new ProviderError('authentication_failed',true);
      this.auth={token:a.authentication,until:Date.now()+45*60e3};
    }
    // This synchronous fence is after auth refresh and all other asynchronous
    // preflight. Throw outside the transport catch: no paid POST was sent.
    if(beforeSend)beforeSend();
    let r;
    try {r=await this.fetcher('https://console.kamatera.com/service'+path,{method,redirect:'error',signal:AbortSignal.timeout(20000),headers:{'Content-Type':'application/json',...(authenticated?{Authorization:`Bearer ${this.auth.token}`}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});}
    catch {throw new ProviderError(method==='GET'?'read_unavailable':'unknown_result');}
    if(!r.ok) {if(r.status===401)this.auth=null;throw new ProviderError(r.status===402?'balance':`provider_http_${r.status}`,[400,401,402,403,422].includes(r.status));}
    let result;try {result=await r.json();}catch{throw new ProviderError('unknown_response');}
    if(result?.error||result?.errors)throw new ProviderError('provider_rejected');
    return result;
  }
  profile(id='start') {
    if(id==='start')return {region:this.c.region,image:this.c.approvedImage,ramMb:2048,diskGb:20};
    if(id==='openstrudel-home-v1')return {region:this.c.region,image:this.c.homeImage,ramMb:4096,diskGb:30};
    throw new ProviderError('profile_unavailable',true);
  }
  async priceEstimate(profileId='start') {
    // Public price data never receives the account bearer token. Fetch anew for
    // every preflight/create; neither cache nor a hardcoded fallback can allow a
    // purchase after a failed or changed price lookup.
    const selected=this.profile(profileId),{region,image}=selected;
    try {
      const r=await this.fetcher(PRICE_SOURCE,{method:'GET',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(15000),headers:{Accept:'application/javascript, text/javascript','Cache-Control':'no-cache'}});
      if(!r.ok||r.url&&r.url!==PRICE_SOURCE||!r.body)throw Error('Invalid price response');
      const declared=r.headers.get('content-length');
      if(declared!==null&&(!/^\d+$/.test(declared)||BigInt(declared)>BigInt(PRICE_MAX_BYTES)))throw Error('Price body too large');
      const chunks=[];let bytes=0;
      for await(const chunk of r.body) {
        bytes+=chunk.byteLength;if(bytes>PRICE_MAX_BYTES)throw Error('Price body too large');
        chunks.push(Buffer.from(chunk));
      }
      const body=Buffer.concat(chunks),text=new TextDecoder('utf-8',{fatal:true}).decode(body);
      const match=/^\s*var prd_prices = '(\{[\s\S]*\})';\s*$/.exec(text);
      if(!match)throw Error('Unknown price format');
      // Only JSON is parsed. Do not evaluate the surrounding JavaScript.
      const estimate=publicPrice(JSON.parse(match[1]),region,image,selected);
      const modified=Date.parse(r.headers.get('last-modified')||'');
      return {...estimate,source:PRICE_SOURCE,checkedAt:new Date().toISOString(),lastModified:Number.isFinite(modified)?new Date(modified).toISOString():null,sha256:createHash('sha256').update(body).digest('hex')};
    } catch {throw new ProviderError('price_unverified',true);}
  }
  checkPrice(estimate,profileId='start') {
    const p=this.profile(profileId);
    if(estimate.profile.image!==p.image||estimate.profile.datacenter!==p.region||estimate.profile.ramMb!==p.ramMb||estimate.profile.diskGb!==p.diskGb)throw new ProviderError('price_unverified',true);
    // Zero is the intentional closed gate: availability/pricing reads still
    // work, while create separately requires a positive explicit spend limit.
    if(this.c.maxMonthly===0)return;
    if(!Number.isFinite(this.c.maxMonthly)||this.c.maxMonthly<0)throw new ProviderError('budget_approval_required',true);
    if(priceMicros(estimate.monthlyUsdWithAdministrationFee)>priceMicros(this.c.maxMonthly))throw new ProviderError('budget_approval_required',true);
  }
  async preflight(profileId='start') {
    const p=this.profile(profileId);
    if(typeof p.image!=='string'||!p.image.startsWith(p.region+':'))throw new ProviderError('image_not_approved',true);
    const images=await this.request('GET','/server/options/images/'+encodeURIComponent(p.region));
    const matches=Array.isArray(images)?images.filter(x=>sameImage(x?.id,p.image)):[];
    const image=matches.length===1?matches[0]:null;
    if(!image)throw new ProviderError('image_unavailable',true);
    if(profileId==='openstrudel-home-v1'&&image.description!=='ubuntu_server_24.04_64-bit')throw new ProviderError('home_image_unverified',true);
    if(!validMinimums(image.minRequirements,image.sizeGB??0,p.ramMb,p.diskGb)||image.additionalDisks?.length)
      throw new ProviderError('image_requirements_changed',true);
    // The image list uses minRamMB; the per-image endpoint uses minRamMb.
    // Check the actual configuration choices, not only template minimums.
    const options=await this.request('GET','/server/options/image/'+encodeURIComponent(p.image));
    if(options?.datacenter!==p.region||!sameImage(options.image,p.image)||
        !Array.isArray(options.cpu)||!options.cpu.includes('1A')||
        !Array.isArray(options.ram?.A)||!options.ram.A.includes(p.ramMb)||
        !Array.isArray(options.disk)||!options.disk.includes(p.diskGb)||
        !Array.isArray(options.billing)||!options.billing.includes('monthly')||
        !Array.isArray(options.traffic)||!options.traffic.some(x=>x?.name==='t5000'))
      throw new ProviderError('profile_unavailable',true);
    if(!validMinimums(options.imageRequirements,0,p.ramMb,p.diskGb))throw new ProviderError('image_requirements_changed',true);
    const price=await this.priceEstimate(profileId);this.checkPrice(price,profileId);
    return {available:true,mode:this.mode,image:p.image,capacityGuaranteed:false,price};
  }
  async list() {const r=await this.request('GET','/servers');if(!Array.isArray(r))throw new ProviderError('inventory_invalid');return r;}
  async find(name) {return (await this.list()).filter(s=>s.name===name);}
  async assertOwned(s) {
    ownedName(s);
    if(!UUID.test(s.provider_id||''))throw new ProviderError('ownership_guard',true);
    const items=await this.find(s.provider_name);if(items.length!==1||items[0].id!==s.provider_id)throw new ProviderError('ownership_guard',true);
  }
  async create(s,{beforePost}={}) {
    const profileId=s.purpose==='openstrudel_home'?'openstrudel-home-v1':'start',p=this.profile(profileId);
    if(profileId==='openstrudel-home-v1'&&this.c.homeLiveApproval!=='I_APPROVE_OPENSTRUDEL_HOME_SPEND')throw new ProviderError('home_launch_not_approved',true);
    if(this.c.allowPaid!=='I_APPROVE_KAMATERA_SPEND'||!Number.isFinite(this.c.maxMonthly)||this.c.maxMonthly<=0||!this.c.approvedImage)
      throw new ProviderError('budget_approval_required',true);
    if(!Number.isSafeInteger(this.c.maxServers)||this.c.maxServers<1)throw new ProviderError('server_limit',true);
    ownedName(s);
    if(s.provider_id)throw new ProviderError('creation_already_recorded');
    if(!ed25519PublicKey(s.public_key))throw new ProviderError('invalid_ssh_key',true);
    const inventory=await this.list();
    // An exact-name match must return to durable reconciliation, even at the cap.
    if(inventory.some(x=>x.name===s.provider_name))throw new ProviderError('provider_name_exists');
    const existing=inventory.filter(x=>x.name?.startsWith('wai-vds-'));
    if(existing.length>=this.c.maxServers)throw new ProviderError('server_limit',true);
    const {price}=await this.preflight(profileId);
    // No HTTP retry for this paid POST. The durable worker owns reconciliation.
    const body={name:s.provider_name,datacenter:p.region,disk_src_0:p.image,cpu:'1A',ram:p.ramMb,disk_size_0:p.diskGb,network_name_0:'wan',selectedSSHKeyValue:s.public_key+'\n',password:'Wa1'+randomUUID().replaceAll('-','').slice(0,23),billing:'monthly',traffic:'t5000',power:true,backup:false,managed:false};
    return {commandId:commandId(await this.request('POST','/server',body,true,()=>{
      if(this.c.allowPaid!=='I_APPROVE_KAMATERA_SPEND'||!Number.isFinite(this.c.maxMonthly)||this.c.maxMonthly<=0)throw new ProviderError('budget_approval_required',true);
      if(profileId==='openstrudel-home-v1'&&this.c.homeLiveApproval!=='I_APPROVE_OPENSTRUDEL_HOME_SPEND')throw new ProviderError('home_launch_not_approved',true);
      this.checkPrice(price,profileId);if(beforePost)beforePost();
    }))};
  }
  async details(s) {
    await this.assertOwned(s);const d=await this.request('GET','/server/'+s.provider_id);
    if(!d||Array.isArray(d)||d.id!==s.provider_id||d.name!==s.provider_name||!Array.isArray(d.networks))
      throw new ProviderError('details_invalid');
    const candidates=d.networks.filter(n=>typeof n?.network==='string'&&/^wan(?:-|$)/.test(n.network))
      .flatMap(n=>Array.isArray(n.ips)?n.ips:[]);
    const ip=candidates.find(publicIPv4);
    const power=String(d.power).toLowerCase();
    return {id:s.provider_id,name:s.provider_name,ip,state:['off','0','false'].includes(power)?'off':['on','1','true'].includes(power)?'running':'unknown'};
  }
  async ssh(s,script) {
    if(!publicIPv4(s.ip))throw new ProviderError('invalid_public_ip');
    // Bind the connection to the current provider record, not a stale caller IP.
    const current=await this.details(s);
    if(current.ip!==s.ip)throw new ProviderError('provider_ip_changed');
    const dir=mkdtempSync(join(this.v.dir,'ssh-'));
    try {
      const key=join(dir,'key'),known=join(dir,'known_hosts');writeFileSync(key,this.v.open(s.private_key,s.id),{mode:0o600});
      let host=s.host_key;
      if(!host) {
        // First contact uses API-bound public IP with TOFU, then pins persistently.
        const scan=await this.runner('ssh-keyscan',['-T','8','-t','ed25519',s.ip],{timeout:12000});
        host=scan.stdout.split('\n').filter(l=>l.startsWith(s.ip+' ssh-ed25519 ')).join('\n');if(!host)throw new ProviderError('ssh_host_key_unavailable');
      }
      if(typeof host!=='string'||host.includes('\n')||!host.startsWith(s.ip+' ')||!ed25519PublicKey(host.slice(s.ip.length+1)))
        throw new ProviderError('ssh_host_key_invalid');
      writeFileSync(known,host+'\n',{mode:0o600});
      const args=['-F','/dev/null','-i',key,'-o','IdentitiesOnly=yes','-o','IdentityAgent=none','-o','ForwardAgent=no',
        '-o','BatchMode=yes','-o','PreferredAuthentications=publickey','-o','StrictHostKeyChecking=yes',
        '-o','GlobalKnownHostsFile=/dev/null','-o','UserKnownHostsFile='+known,'-o','ConnectTimeout=8',
        '-o','ServerAliveInterval=10','-o','ServerAliveCountMax=2','root@'+s.ip,'sh','-s'];
      const r=await this.runner('ssh',args,{input:script,timeout:180000});return {...r,hostKey:host};
    } finally {rmSync(dir,{recursive:true,force:true});}
  }
  async setup(s) {
    const script=bootstrapScript(s.purpose==='openstrudel_home'?'clean':s.purpose);const signature=this.v.signature(script).toString('base64');
    const pub=createPublicKey(this.v.signing).export({type:'spki',format:'pem'});
    const envelope=`set -eu\numask 077\nd=$(mktemp -d)\ntrap 'rm -rf "$d"' EXIT\nprintf '%s' '${Buffer.from(script).toString('base64')}' | base64 -d > "$d/setup"\nprintf '%s' '${signature}' | base64 -d > "$d/sig"\nprintf '%s' '${Buffer.from(pub).toString('base64')}' | base64 -d > "$d/pub"\nopenssl pkeyutl -verify -pubin -inkey "$d/pub" -rawin -in "$d/setup" -sigfile "$d/sig" >/dev/null\nsh "$d/setup"\n`;
    return this.ssh(s,envelope);
  }
  async check(s) {const command=`set -eu\ntest "$(id -u)" = 0\ntest -f /var/lib/wai-vds-ready\nsshd -t\nsettings=$(sshd -T)\nprintf '%s\\n' "$settings" | grep -qx 'passwordauthentication no'\nprintf '%s\\n' "$settings" | grep -qx 'kbdinteractiveauthentication no'\nprintf '%s\\n' "$settings" | grep -Eq '^permitrootlogin (prohibit-password|without-password)$'\n${s.purpose==='site'?'curl -fsS http://127.0.0.1/ >/dev/null':s.purpose==='agent'?'docker info >/dev/null':'true'}\nprintf WAI_READY\n`;const r=await this.ssh(s,command);if(!r.stdout.includes('WAI_READY'))throw new ProviderError('readiness_failed');return true;}
  async poweroff(s) {
    const current=await this.details(s);
    if(current.state==='off')return null;
    if(current.state!=='running')throw new ProviderError('power_state_unknown');
    return this.request('PUT',`/server/${s.provider_id}/power`,{power:'off'});
  }
  async remove(s) {
    const current=await this.details(s);
    if(current.state!=='off')throw new ProviderError('server_must_be_off',true);
    // Never force-delete a running VM, and never retry an uncertain DELETE.
    return this.request('DELETE',`/server/${s.provider_id}/terminate`,{confirm:1});
  }
}

export function sshHardeningScript() {
  return `set -eu
config=/etc/ssh/sshd_config
candidate=$(mktemp /etc/ssh/.wai-config.XXXXXX)
trap 'rm -f "$candidate"' EXIT
# This image may omit Include entirely. Put the policy in the primary file,
# ahead of existing global settings; OpenSSH takes the first global value.
cat > "$candidate" <<'EOF'
# BEGIN WAI VDS SSH POLICY
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
# END WAI VDS SSH POLICY
EOF
awk '/^# BEGIN WAI VDS SSH POLICY$/{managed=1;next} /^# END WAI VDS SSH POLICY$/{managed=0;next} !managed{print} END{if(managed)exit 1}' "$config" >> "$candidate"
sshd -t -f "$candidate"
check_policy() {
  settings=$(sshd -T -f "$candidate" "$@")
  printf '%s\n' "$settings" | grep -qx 'passwordauthentication no'
  printf '%s\n' "$settings" | grep -qx 'kbdinteractiveauthentication no'
  printf '%s\n' "$settings" | grep -Eq '^permitrootlogin (prohibit-password|without-password)$'
}
check_policy
# Validate the actual root connection as well, so a conflicting Match block
# cannot silently leave password authentication enabled for this client.
if [ -n "\${SSH_CONNECTION:-}" ]; then
  set -- $SSH_CONNECTION
  check_policy -C "user=root,addr=$1,host=$1,laddr=$3,lport=$4"
fi
if ! cmp -s "$candidate" "$config"; then
  backup=$(mktemp -d "/var/lib/wai-vds-ssh-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX")
  cp -p "$config" "$backup/previous"
  chmod 644 "$candidate"
  mv -f "$candidate" "$config"
  if ! sshd -t || ! systemctl reload ssh; then
    cp -p "$backup/previous" "$candidate"
    mv -f "$candidate" "$config"
    sshd -t && systemctl reload ssh
    exit 1
  fi
fi
rm -f "$candidate"
trap - EXIT
`;
}

export function bootstrapScript(purpose) {
  if(!['agent','site','clean'].includes(purpose))throw Error('Invalid template');
  return `#!/bin/sh
set -eu
export DEBIAN_FRONTEND=noninteractive
umask 077
install -d -m 755 /srv/wai
apt-get update -qq
apt-get install -y -qq ca-certificates curl openssh-server ${purpose==='site'?'nginx':purpose==='agent'?'docker.io':''}
${sshHardeningScript()}
${purpose==='site'?'systemctl enable --now nginx':purpose==='agent'?'systemctl enable --now docker':''}
install -d /var/lib
touch /var/lib/wai-vds-ready
printf 'WAI_SETUP_OK\n'
`;
}

export function runCommand(file,args,{input='',timeout=30000}={}) {
  return new Promise((resolve,reject)=>{const p=spawn(file,args,{stdio:['pipe','pipe','pipe']});let stdout='',finished=false,timedOut=false,killTimer;
    const cleanup=()=>{clearTimeout(timer);clearTimeout(killTimer);};
    // Only this spawned child is signalled; ensure a stuck client cannot retain a decrypted key forever.
    const timer=setTimeout(()=>{timedOut=true;p.kill('SIGTERM');killTimer=setTimeout(()=>p.kill('SIGKILL'),2000);},timeout);
    p.stdout.on('data',d=>{if(stdout.length<65536)stdout+=d.toString().slice(0,65536-stdout.length);});p.stderr.on('data',()=>{});p.stdin.on('error',()=>{});
    p.on('error',()=>{cleanup();finished=true;reject(new ProviderError('command_failed'));});
    p.on('close',code=>{cleanup();if(finished)return;timedOut?reject(new ProviderError('command_timeout')):code===0?resolve({stdout}):reject(new ProviderError('ssh_or_setup_failed'));});p.stdin.end(input);
  });
}
