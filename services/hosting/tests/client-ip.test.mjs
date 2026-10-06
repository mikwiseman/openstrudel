import test from 'node:test';
import assert from 'node:assert/strict';
import {clientIP,trustedProxyRanges} from '../src/client-ip.mjs';

const request=(remoteAddress,forwarded)=>({socket:{remoteAddress},headers:{'x-forwarded-for':forwarded}});
test('untrusted clients cannot bypass address limits with forwarded headers',()=>{
  const ranges=trustedProxyRanges('172.18.0.0/16');
  assert.equal(clientIP(request('203.0.113.1','198.51.100.1'),ranges),'203.0.113.1');
  assert.equal(clientIP(request('172.18.0.5','198.51.100.1')),'172.18.0.5');
});
test('only a single valid client address from the configured proxy is accepted',()=>{
  const ranges=trustedProxyRanges('172.18.0.5/32');
  assert.equal(clientIP(request('::ffff:172.18.0.5','198.51.100.1'),ranges),'198.51.100.1');
  assert.equal(clientIP(request('172.18.0.5','2001:db8::1'),ranges),'2001:db8::1');
  for(const value of ['garbage','198.51.100.1, 203.0.113.1',['198.51.100.1'],'198.51.100.1:123','1'.repeat(65)])assert.equal(clientIP(request('172.18.0.5',value),ranges),'172.18.0.5');
  assert.equal(clientIP(request('172.18.0.6','198.51.100.1'),ranges),'172.18.0.6');
});
test('trust configuration rejects universal networks and malformed CIDRs',()=>{
  for(const value of ['0.0.0.0/0','::/0','127.0.0.1/33','172.18.0.0/16/2','host','172.18.0.0/no'])assert.throws(()=>trustedProxyRanges(value));
  assert.equal(trustedProxyRanges('127.0.0.1,172.18.0.0/16').length,2);
});
