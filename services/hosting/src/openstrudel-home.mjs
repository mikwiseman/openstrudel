import {createPrivateKey,createPublicKey,createHash,X509Certificate} from 'node:crypto';
import {readFileSync} from 'node:fs';
import tls from 'node:tls';
import {ProviderError,publicIPv4} from './providers.mjs';
const digest=value=>createHash('sha256').update(value).digest('hex');
const fail=code=>{throw new ProviderError(code,true);};
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const HASH=/^[a-f0-9]{64}$/;
export const HOME_RELEASE_URL='https://waiwai.is/openstrudel/downloads/OpenStrudel-Home-1.0.tar.gz';
const recipe=readFileSync(new URL('./vendor/openstrudel-cloud-init.sh',import.meta.url));
export const HOME_RECIPE_SHA256=digest(recipe);

export function validateHomeBootstrap(input) {
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).sort().join(',')!=='installationId,ownerTokenHash,privateKeyPEM'
     ||typeof input.installationId!=='string'||!UUID.test(input.installationId)||typeof input.ownerTokenHash!=='string'||!HASH.test(input.ownerTokenHash)
     ||typeof input.privateKeyPEM!=='string'||input.privateKeyPEM.length>4096)fail('home_bootstrap_invalid');
  try {
    const key=createPrivateKey(input.privateKeyPEM);
    if(key.asymmetricKeyType!=='ec'||key.asymmetricKeyDetails?.namedCurve!=='prime256v1')fail('home_bootstrap_invalid');
    return {payload:{installationId:input.installationId,ownerTokenHash:input.ownerTokenHash,privateKeyPEM:String(key.export({type:'pkcs8',format:'pem'}))},
      publicKeySHA256:digest(createPublicKey(key).export({type:'spki',format:'der'}))};
  } catch {fail('home_bootstrap_invalid');}
}

export function verifyHomeCertificate(pem,expected,now=Date.now()) {
  try {
    const cert=new X509Certificate(pem);
    if(!HASH.test(expected.public_key_sha256)||digest(cert.publicKey.export({type:'spki',format:'der'}))!==expected.public_key_sha256
       ||!cert.verify(cert.publicKey)||Date.parse(cert.validFrom)>now||Date.parse(cert.validTo)<=now)fail('home_tls_identity_mismatch');
    const pin=digest(cert.raw);
    if(expected.certificate_sha256&&pin!==expected.certificate_sha256)fail('home_tls_identity_mismatch');
    return pin;
  } catch {fail('home_tls_identity_mismatch');}
}

// This endpoint uses the Home's self-signed P-256 identity. Send HTTP only after
// checking the pinned certificate/SPKI on the provider-bound public IP. No owner
// token is ever sent by VDS; SSH separately verifies authenticated Home health.
export function probePinnedHome(ip,expected,{connect=tls.connect,now=Date.now}={}) {
  if(!publicIPv4(ip))fail('home_public_ip_invalid');
  return new Promise((resolve,reject)=>{
    let settled=false,bytes='',socket;
    const finish=(error,value)=>{if(settled)return;settled=true;socket?.destroy();error?reject(error):resolve(value);};
    socket=connect({host:ip,port:7789,minVersion:'TLSv1.2',rejectUnauthorized:false},()=>{
      try {
        const raw=socket.getPeerCertificate(true)?.raw;
        if(!raw)fail('home_tls_identity_mismatch');
        verifyHomeCertificate(raw,expected,now());
        socket.write('GET /health HTTP/1.1\r\nHost: '+ip+':7789\r\nConnection: close\r\nAccept: application/json\r\n\r\n');
      } catch {finish(new ProviderError('home_tls_identity_mismatch',true));}
    });
    socket.setTimeout(10000,()=>finish(new ProviderError('home_not_reachable')));
    socket.on('error',()=>finish(new ProviderError('home_not_reachable')));
    socket.on('close',()=>finish(new ProviderError('home_not_reachable')));
    socket.on('data',chunk=>{bytes+=chunk.toString('utf8');if(bytes.length>32768)finish(new ProviderError('home_response_invalid'));});
    socket.on('end',()=>{
      if(!/^HTTP\/1\.[01] 401\b/.test(bytes)||!bytes.includes('application/json'))finish(new ProviderError('home_public_auth_unverified'));
      else finish(null,{reachable:true,authentication_required:true});
    });
  });
}

export function verifyHomeAttestation(row,result,now=Date.now()) {
  if(!result||result.installation_id!==row.id||result.release_sha256!==row.release_sha256||result.owner_bound!==true
     ||result.health?.ok!==true||result.health?.service!=='openstrudel'||result.single_home!==true)fail('home_identity_unverified');
  return {certificate_sha256:verifyHomeCertificate(result.certificate_pem,row,now),installation_id:row.id,release_sha256:row.release_sha256};
}

function installationScript(row,payload) {
  if(!HASH.test(row.release_sha256))fail('home_release_unverified');
  const body=JSON.stringify(payload),bodyHash=digest(body);
  return `set -eu
umask 077
test "$(id -u)" = 0
d=/var/lib/openstrudel-cloud
test ! -L "$d"
install -d -m 700 "$d"
if test -f "$d/wai-owner-sha256"; then
  test "$(cat "$d/wai-owner-sha256")" = '${bodyHash}'
else
  test ! -e "$d/bootstrap.json"
  test ! -e "$d/install.sh"
  printf '%s' '${bodyHash}' > "$d/wai-owner-sha256"
fi
if test -f "$d/complete"; then printf WAI_HOME_SCHEDULED; exit 0; fi
if test -f "$d/install.sh"; then test "$(sha256sum "$d/install.sh" | cut -d ' ' -f 1)" = '${HOME_RECIPE_SHA256}'; fi
printf '%s' '${Buffer.from(body).toString('base64')}' | base64 -d > "$d/bootstrap.json.new"
chmod 600 "$d/bootstrap.json.new"
mv -f "$d/bootstrap.json.new" "$d/bootstrap.json"
printf '%s' '${row.release_sha256}' > "$d/release.sha256"
printf '%s' '${recipe.toString('base64')}' | base64 -d > "$d/install.sh.new"
chmod 500 "$d/install.sh.new"
mv -f "$d/install.sh.new" "$d/install.sh"
install -d -m 755 /etc/systemd/system/openstrudel-install.service.d
printf '%s\n' '[Service]' 'ExecStartPost=/bin/rm -f /var/lib/openstrudel-cloud/bootstrap.json' > /etc/systemd/system/openstrudel-install.service.d/wai-cleanup.conf
bash "$d/install.sh" --install-service
printf WAI_HOME_SCHEDULED
`;
}

function inspectScript(row) {
  const js=`import {readFile} from 'node:fs/promises';import {DatabaseSync} from 'node:sqlite';
const d=new DatabaseSync('/data/.data/openstrudel.sqlite',{readOnly:true});
const setting=k=>d.prepare('SELECT value FROM settings WHERE key=?').get(k)?.value;
const identity=JSON.parse(await readFile('/data/.data/mobile/cloud-bootstrap.json','utf8'));
const c=JSON.parse(await readFile('/data/.data/LocalConnection.json','utf8'));
const response=await fetch(new URL('/health',c.url),{headers:{authorization:'Bearer '+c.token},signal:AbortSignal.timeout(3000)});
const health=await response.json();if(!response.ok)throw Error('health');
const owners=JSON.parse(setting('mobile.owners')||'[]'),tokens=JSON.parse(setting('mobile.tokens')||'[]');
console.log(JSON.stringify({installation_id:setting('cloud.installationId'),owner_bound:identity.installationId===${JSON.stringify(row.id)}&&identity.ownerTokenHash===${JSON.stringify(row.owner_token_hash)}&&owners.includes(${JSON.stringify(row.owner_token_hash)})&&tokens.includes(${JSON.stringify(row.owner_token_hash)}),certificate_pem:await readFile('/data/.data/mobile/certificate.pem','utf8'),health}));d.close();`;
  return `set -eu
test -f /var/lib/openstrudel-cloud/complete
test "$(cat /opt/openstrudel-home/.cloud-release.sha256)" = '${row.release_sha256}'
ids=$(docker ps -q --filter label=com.docker.compose.project=openstrudel --filter label=com.docker.compose.service=home)
test "$(printf '%s\n' "$ids" | wc -l)" = 1
test -n "$ids"
test "$(docker volume inspect openstrudel_data --format '{{index .Labels "is.openstrudel.installation"}}')" = '${row.id}'
printf '%s' '${Buffer.from(js).toString('base64')}' | base64 -d | docker exec -i "$ids" node --input-type=module -
`;
}

export class HomeInstaller {
  constructor(service,{probe=probePinnedHome}={}) {this.s=service;this.probe=probe;}
  async schedule(server,row) {
    const {s}=this;
    if(!row.bootstrap_sealed)fail('home_bootstrap_missing');
    const payload=JSON.parse(s.vault.open(row.bootstrap_sealed,'home:'+row.id));
    validateHomeBootstrap(payload);
    const result=await s.provider.ssh(server,installationScript(row,payload));
    if(!result.stdout.endsWith('WAI_HOME_SCHEDULED'))fail('home_installation_unconfirmed');
  }
  async verify(server,row) {
    const result=await this.s.provider.ssh(server,inspectScript(row));
    let data;try {data=JSON.parse(result.stdout);}catch{fail('home_not_ready');}
    // The SSH command checks these values before producing the bounded payload.
    data={...data,release_sha256:row.release_sha256,single_home:true};
    const verified=verifyHomeAttestation(row,data,this.s.now());
    await this.probe(server.ip,{...row,...verified},{now:this.s.now});
    return {...verified,mode:'kamatera',checked_at:this.s.now(),url:'https://'+server.ip+':7789'};
  }
  async recover(server,row) {
    // Reuse Home's existing owner invitation protocol. The ephemeral key is
    // returned only in an authenticated JSON body, never as a redirect URL.
    const js=`import {readFile} from 'node:fs/promises';const c=JSON.parse(await readFile('/data/.data/LocalConnection.json','utf8'));
const r=await fetch(new URL('/v1/mobile/pairing',c.url),{method:'POST',headers:{authorization:'Bearer '+c.token,'Content-Type':'application/json'},body:JSON.stringify({owner:true}),signal:AbortSignal.timeout(5000)});
if(!r.ok)throw Error('pairing failed');const v=await r.json();console.log(JSON.stringify(v));`;
    const script=`set -eu\nids=$(docker ps -q --filter label=com.docker.compose.project=openstrudel --filter label=com.docker.compose.service=home)\ntest "$(printf '%s\\n' "$ids" | wc -l)" = 1\ntest -n "$ids"\nprintf '%s' '${Buffer.from(js).toString('base64')}' | base64 -d | docker exec -i "$ids" node --input-type=module -\n`;
    // Verify the existing Home and pin again before issuing owner access.
    await this.verify(server,row);
    const r=await this.s.provider.ssh(server,script);
    try {
      const result=JSON.parse(r.stdout),u=new URL(result.url),expires=Date.parse(result.expiresAt),pin=u.searchParams.get('pin');
      if(u.protocol!=='openstrudel:'||u.hostname!=='connect'||pin!==row.certificate_sha256||!HASH.test(u.searchParams.get('key')||'')||expires<=this.s.now()||expires>this.s.now()+310000)throw Error('invalid');
      return {host:server.ip,port:7789,certificate_sha256:pin,invitation_key:u.searchParams.get('key'),expires_at:expires,path:'/pair',method:'POST',authorization:'Bearer invitation_key'};
    } catch {fail('home_owner_recovery_unconfirmed');}
  }
}

// Explicit local simulation. It performs no SSH/TLS or resource calls; clients
// receive mode=emulator and documentation-range IPs, never a real Home claim.
export class EmulatedHomeInstaller {
  constructor(service){this.s=service;this.fault=null;this.scheduled=0;}
  async schedule(){if(this.fault==='schedule')fail('home_installation_unconfirmed');this.scheduled++;}
  async verify(server,row){if(this.fault)fail('home_identity_unverified');return {installation_id:row.id,release_sha256:row.release_sha256,certificate_sha256:digest('emulated:'+row.id),mode:'emulator',checked_at:this.s.now(),url:'https://'+server.ip+':7789'};}
  async recover(server,row){return {host:server.ip,port:7789,certificate_sha256:row.certificate_sha256,invitation_key:digest('emulated-invitation:'+row.id),expires_at:this.s.now()+300000,path:'/pair',method:'POST',authorization:'Bearer invitation_key',emulated:true};}
}

export const homeScriptsForTest={installationScript,inspectScript};
