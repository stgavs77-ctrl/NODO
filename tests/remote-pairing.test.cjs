const test=require('node:test'),assert=require('node:assert/strict');
const {Pairings,seal,open}=require('../lib/remote-pairing.cjs');
function fixture(){let state=[],now=100;const p=new Pairings({store:{read:()=>state,write:v=>state=v},now:()=>now});return {p,advance:()=>now+=300001};}
function pair(p){const one=p.begin();const b=seal(one.key,{name:'Synthetic iPhone'},'nodo-pair-v1:'+one.id);const reply=p.pair(one.id,b);return {one,b,device:open(one.key,reply,'nodo-pair-result-v1:'+one.id)};}
test('one-time pairing expires and does not expose device credential in list',()=>{
 const f=fixture(),{one,b,device}=pair(f.p);assert.throws(()=>f.p.pair(one.id,b),/expired/);assert.equal(f.p.list()[0].key,undefined);assert(device.key);
 const next=f.p.begin();f.advance();assert.throws(()=>f.p.pair(next.id,{}),/expired/);
});
test('authenticated requests are bound to fresh channel, monotonic and revocable',()=>{
 const {p}=fixture(),{device}=pair(p),challenge=p.challenge(device.deviceId,'channel');
 const box=seal(device.key,{seq:1,method:'sessions'},'nodo-request-v1:channel:'+challenge);
 const accepted=p.accept('channel',box);assert.equal(accepted.request.method,'sessions');
 assert.deepEqual(open(device.key,accepted.respond({result:[]}), 'nodo-response-v1:channel:'+challenge),{seq:1,result:[]});
 assert.throws(()=>p.accept('channel',box),/Replay/);
 p.disconnect('channel');p.challenge(device.deviceId,'channel');assert.throws(()=>p.accept('channel',box));
 p.revoke(device.deviceId);assert.throws(()=>p.challenge(device.deviceId,'another'),/revoked/);
});
test('forged pairing is rejected without consuming valid one-time QR',()=>{
 const {p}=fixture(),one=p.begin();assert.throws(()=>p.pair(one.id,{iv:'bad',body:'bad',tag:'bad'}));assert.equal(p.pending.id,one.id);
});
