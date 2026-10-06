import { randomBytes, scryptSync, timingSafeEqual, createHash, createHmac, createCipheriv, createDecipheriv, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

export const token = () => randomBytes(32).toString('hex');
export const hash = s => createHash('sha256').update(s).digest('hex');
export function safeEqual(a,b) { const x=Buffer.from(String(a)), y=Buffer.from(String(b)); return x.length===y.length && timingSafeEqual(x,y); }
export function passwordHash(password) { const salt=randomBytes(16).toString('hex'); return salt+':'+scryptSync(password,salt,64).toString('hex'); }
export function passwordOK(password, encoded) { const [s,h]=encoded.split(':'); return safeEqual(scryptSync(password,s,64).toString('hex'),h); }
export class Vault {
  constructor(dir) {
    this.dir=dir; mkdirSync(dir,{recursive:true,mode:0o700});
    const file=join(dir,'master.key');
    if (!existsSync(file)) { try {writeFileSync(file,randomBytes(32),{mode:0o600,flag:'wx'});} catch(e) {if(e.code!=='EEXIST')throw e;} }
    this.key=readFileSync(file); if(this.key.length!==32)throw Error('Invalid master key');
    this.webhookSecret=createHmac('sha256',this.key).update('local-checkout').digest('hex');
    const signing=join(dir,'bootstrap-signing.pem');
    if(!existsSync(signing)) { const pair=generateKeyPairSync('ed25519'); try {writeFileSync(signing,pair.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600,flag:'wx'});} catch(e) {if(e.code!=='EEXIST')throw e;} }
    this.signing=readFileSync(signing);
  }
  seal(text,aad) { const iv=randomBytes(12), c=createCipheriv('aes-256-gcm',this.key,iv); c.setAAD(Buffer.from(aad)); const body=Buffer.concat([c.update(text,'utf8'),c.final()]); return Buffer.concat([iv,c.getAuthTag(),body]).toString('base64'); }
  open(data,aad) { const b=Buffer.from(data,'base64'),d=createDecipheriv('aes-256-gcm',this.key,b.subarray(0,12));d.setAAD(Buffer.from(aad));d.setAuthTag(b.subarray(12,28));return Buffer.concat([d.update(b.subarray(28)),d.final()]).toString(); }
  keypair(id) {
    const dir=mkdtempSync(join(this.dir,'key-')), file=join(dir,'id_ed25519');
    try {execFileSync('ssh-keygen',['-q','-t','ed25519','-N','','-C','wai-vds','-f',file],{stdio:'ignore'});return {publicKey:readFileSync(file+'.pub','utf8').trim(),privateKey:this.seal(readFileSync(file,'utf8'),id)};}
    finally {rmSync(dir,{recursive:true,force:true});}
  }
  signature(script) {return sign(null,Buffer.from(script),this.signing);}
}
export function webhookSignature(body,secret,ts=Math.floor(Date.now()/1000)) {return `t=${ts},v1=${createHmac('sha256',secret).update(`${ts}.${body}`).digest('hex')}`;}
export function verifyWebhook(body,signature,secret,now=Date.now()) {
  const fields=String(signature||'').split(',').map(x=>x.split('='));const ts=fields.find(x=>x[0]==='t')?.[1];
  if(!/^\d+$/.test(ts||'')||Math.abs(now/1000-Number(ts))>300)return false;
  const expected=createHmac('sha256',secret).update(`${ts}.${body}`).digest('hex');
  return fields.filter(x=>x[0]==='v1').some(x=>safeEqual(x[1],expected));
}
