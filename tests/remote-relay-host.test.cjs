'use strict';
const assert=require('node:assert/strict');
const test=require('node:test');
const Ws=require('../runtime/node_modules/ws');
const {createRelay,sha256}=require('../remote-relay/server.cjs');
const {RemoteHost}=require('../lib/remote-host.cjs');
const {seal,open}=require('../lib/remote-pairing.cjs');
const ORIGIN='https://phone.example.test';
const pack=v=>Buffer.from(JSON.stringify(v)).toString('base64url');
const unpack=v=>JSON.parse(Buffer.from(v,'base64url').toString());
const wait=ws=>new Promise(resolve=>ws.once('message',data=>resolve(JSON.parse(data.toString()))));
const delay=()=>new Promise(resolve=>setTimeout(resolve,0));

test('synthetic relay preserves pair, challenge and narrow call boundaries',async()=>{
 const token='x'.repeat(64),relay=createRelay({ownerTokenHash:sha256(token),allowedOrigins:[ORIGIN]});
 await new Promise(resolve=>relay.server.listen(0,'127.0.0.1',resolve));
 const localUrl=`ws://127.0.0.1:${relay.server.address().port}/relay`,url='wss://relay.example.test/relay';
 class OriginWs extends Ws { constructor(target,options={}){super(target===url?localUrl:target,{...options,headers:{...options.headers,Origin:ORIGIN}});}}
 const state=[];const store={read:()=>state,write:v=>{state.splice(0,state.length,...v)}};
 const calls=[];const host=new RemoteHost({config:{url,webURL:ORIGIN,roomId:'room_1234567890123456',hostCredential:token},store,call:async(method,params)=>{calls.push([method,params]);if(method!=='list')throw Error('blocked');return {sameInstance:true};},power:{start:()=>1,stop:()=>{}},WebSocket:OriginWs});
 try {
  host.enable();for(let i=0;!host.connected&&i<30;i++)await delay();assert.equal(host.connected,true);
  const phone=new OriginWs(url);await new Promise(resolve=>phone.once('open',resolve));phone.send(JSON.stringify({type:'attach',roomId:'room_1234567890123456'}));const connected=await wait(phone);
  const pairing=host.beginPairing(),fragment=new URL(pairing.url).hash.slice(1),pair=Object.fromEntries(new URLSearchParams(fragment));
  phone.send(JSON.stringify({type:'to_host',connectionId:connected.connectionId,frame:pack({type:'pair',pairingId:pair.pair,box:seal(pair.secret,{name:'synthetic phone'},'nodo-pair-v1:'+pair.pair)})}));
  const paired=await wait(phone),device=open(pair.secret,unpack(paired.frame).box,'nodo-pair-result-v1:'+pair.pair);
  phone.send(JSON.stringify({type:'to_host',connectionId:connected.connectionId,frame:pack({type:'hello',deviceId:device.deviceId})}));const challenge=unpack((await wait(phone)).frame).challenge;
  const request={seq:1,method:'list',params:{}};phone.send(JSON.stringify({type:'to_host',connectionId:connected.connectionId,frame:pack({type:'request',box:seal(device.key,request,'nodo-request-v1:'+connected.connectionId+':'+challenge)})}));
  const response=unpack((await wait(phone)).frame);assert.deepEqual(open(device.key,response.box,'nodo-response-v1:'+connected.connectionId+':'+challenge),{seq:1,result:{sameInstance:true}});assert.deepEqual(calls,[['list',{}]]);
  phone.close();await host.disable();
 } finally {await host.disable();await relay.close();}
});
