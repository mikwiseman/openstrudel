import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {generateKeyPairSync,randomUUID,createPublicKey,X509Certificate} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {validateHomeBootstrap,verifyHomeCertificate,verifyHomeAttestation,probePinnedHome,homeScriptsForTest,HOME_RECIPE_SHA256} from '../src/openstrudel-home.mjs';
import {hash} from '../src/security.mjs';
import {HOME_RELEASE_SHA256} from '../src/openstrudel.mjs';
function cert(t) {
  const dir=mkdtempSync(join(tmpdir(),'wai-cert-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  execFileSync('openssl',['req','-x509','-newkey','ec','-pkeyopt','ec_paramgen_curve:prime256v1','-nodes','-days','2','-subj','/CN=OpenStrudel','-keyout',join(dir,'key.pem'),'-out',join(dir,'cert.pem')],{stdio:'ignore'});
  const key=readFileSync(join(dir,'key.pem'),'utf8'),certificate=readFileSync(join(dir,'cert.pem'),'utf8'),payload={installationId:randomUUID(),privateKeyPEM:key,ownerTokenHash:hash('owner-token')};
  const row={id:payload.installationId,release_sha256:HOME_RELEASE_SHA256,public_key_sha256:hash(createPublicKey(key).export({type:'spki',format:'der'})),owner_token_hash:payload.ownerTokenHash};return {payload,row,certificate};
}
test('bootstrap accepts only existing P256 protocol, never raw owner token or shell fields',t=>{
  const f=cert(t);assert.equal(validateHomeBootstrap(f.payload).publicKeySHA256,f.row.public_key_sha256);
  for(const payload of [{...f.payload,ownerToken:'private'},{...f.payload,shell:'id'},{...f.payload,installationId:'../../another-home'},{...f.payload,ownerTokenHash:'bad'},{...f.payload,privateKeyPEM:String(generateKeyPairSync('ed25519').privateKey.export({type:'pkcs8',format:'pem'}))}])assert.throws(()=>validateHomeBootstrap(payload));
});
test('readiness verifies installation, release, owner, service and original TLS public key',t=>{
  const f=cert(t),pin=verifyHomeCertificate(f.certificate,f.row);assert.equal(pin.length,64);
  const result={installation_id:f.row.id,release_sha256:f.row.release_sha256,owner_bound:true,health:{ok:true,service:'openstrudel'},single_home:true,certificate_pem:f.certificate};
  assert.equal(verifyHomeAttestation(f.row,result).certificate_sha256,pin);
  for(const change of [{installation_id:randomUUID()},{release_sha256:'0'.repeat(64)},{owner_bound:false},{health:{ok:true,service:'other'}},{single_home:false},{certificate_pem:'bad'}])assert.throws(()=>verifyHomeAttestation(f.row,{...result,...change}));
  assert.throws(()=>verifyHomeCertificate(f.certificate,{...f.row,public_key_sha256:'0'.repeat(64)}));assert.throws(()=>verifyHomeCertificate(f.certificate,{...f.row,certificate_sha256:'0'.repeat(64)}));assert.throws(()=>verifyHomeCertificate(f.certificate,f.row,Date.now()+3*86400e3));
});
test('pinned public TLS sends no bytes before validation, never sends owner token or follows redirect',async t=>{
  const f=cert(t),writes=[];
  const fake=(pem,response='HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\n\r\n{}')=>(options,callback)=>{
    const s=new EventEmitter();s.destroy=()=>{};s.setTimeout=()=>{};s.getPeerCertificate=()=>({raw:new X509Certificate(pem).raw});s.write=data=>{writes.push(data);process.nextTick(()=>{s.emit('data',Buffer.from(response));s.emit('end');});};process.nextTick(callback);return s;
  };
  await assert.rejects(()=>probePinnedHome('8.8.8.8',{...f.row,public_key_sha256:'0'.repeat(64)},{connect:fake(f.certificate)}));assert.equal(writes.length,0);
  await probePinnedHome('8.8.8.8',f.row,{connect:fake(f.certificate)});assert.equal(writes.length,1);assert(!writes[0].includes('Authorization'));
  await assert.rejects(()=>probePinnedHome('8.8.8.8',f.row,{connect:fake(f.certificate,'HTTP/1.1 302 Found\r\nLocation: https://evil.test/\r\n\r\n')}));
  for(const ip of ['127.0.0.1','169.254.169.254','10.0.0.1','::1'])assert.throws(()=>probePinnedHome(ip,f.row),e=>e.code==='home_public_ip_invalid');
});
test('installation uses pinned vendored recipe, one staging directory, secret cleanup and read-only readiness checks',t=>{
  const f=cert(t),script=homeScriptsForTest.installationScript(f.row,f.payload),inspect=homeScriptsForTest.inspectScript(f.row);
  execFileSync('sh',['-n'],{input:script});execFileSync('sh',['-n'],{input:inspect});
  assert(script.includes(HOME_RECIPE_SHA256));assert(script.includes('ExecStartPost=/bin/rm -f /var/lib/openstrudel-cloud/bootstrap.json'));assert(script.includes('wai-owner-sha256'));
  assert(!script.includes(f.payload.privateKeyPEM));assert(inspect.includes('label=com.docker.compose.project=openstrudel'));assert(inspect.includes('docker volume inspect openstrudel_data'));assert(!inspect.includes(f.payload.privateKeyPEM));assert(!inspect.includes('docker compose up'));
});
