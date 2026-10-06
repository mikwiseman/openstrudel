import { isIP } from 'node:net';

const normalize=ip=>String(ip||'').replace(/^::ffff:/i,'');
const number=ip=>ip.split('.').reduce((value,part)=>(value*256+Number(part))>>>0,0);
export function trustedProxyRanges(value='') {
  if(!value)return [];
  return value.split(',').map(item=>{
    const [address,prefix='32',extra]=item.trim().split('/');
    if(extra!==undefined||isIP(address)!==4||!/^\d{1,2}$/.test(prefix)||Number(prefix)<8||Number(prefix)>32)throw Error('Trusted proxies must be explicit IPv4 networks (/8 through /32)');
    const mask=(0xffffffff<<(32-Number(prefix)))>>>0;
    return {network:(number(address)&mask)>>>0,mask};
  });
}
export function clientIP(req,ranges=[]) {
  const peer=normalize(req.socket.remoteAddress);
  if(isIP(peer)!==4||!ranges.some(r=>((number(peer)&r.mask)>>>0)===r.network))return peer||'unknown';
  // Caddy overwrites inbound X-Forwarded-For by default. Accept one address only.
  const forwarded=req.headers['x-forwarded-for'];
  if(typeof forwarded!=='string'||forwarded.length>64)return peer;
  const candidate=normalize(forwarded.trim());
  return isIP(candidate)?candidate:peer;
}
