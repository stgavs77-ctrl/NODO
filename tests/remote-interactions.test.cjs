const test=require('node:test'),assert=require('node:assert/strict');
const {RemoteInteractions}=require('../lib/remote-interactions.cjs');
test('pending native approval is scoped, one-time, and cannot be widened',{timeout:5000},async()=>{
 let wake,frames=[],signal;const client={id:'client'},results=[];
 const gateway={remoteEventClients:new Map([['client',client]]),pendingRemoteEvents:new Map(),wireStream:{open:async(_name,_payload,s)=>{signal=s;return (async function*(){yield {type:'ready',clientId:'client'};while(!s.aborted){if(!frames.length)await new Promise(r=>{wake=r;s.addEventListener('abort',r,{once:true});});while(frames.length)yield frames.shift();}})();}},dispatchRpc:async(endpoint,payload)=>{assert.equal(endpoint,'$events/result');results.push(payload.args);gateway.pendingRemoteEvents.delete(payload.args.eventId);return {ok:true};}};
 const remote=new RemoteInteractions({typertGateway:gateway,agents:{list:()=>[{id:'agent',session:{id:'session-native'}}]}});
 try{
  await remote.start();gateway.pendingRemoteEvents.set('event',{deliveries:new Set([client])});frames.push({type:'waterfall',event:'approval/request',eventId:'event',agentId:'agent',request:{toolName:'write',reason:'Synthetic operation'}});wake();await new Promise(r=>setImmediate(r));
  assert.equal((await remote.list('session-native')).length,1);assert.equal((await remote.list('another-session')).length,0);
  await assert.rejects(remote.answer({eventId:'event',sessionId:'session-native',answer:'always-allow'}),/one-time/);
  await assert.rejects(remote.answer({eventId:'event',sessionId:'another-session',answer:'allowed-once'}),/pending/);
  await remote.answer({eventId:'event',sessionId:'session-native',answer:'allowed-once'});assert.equal(results.length,1);
  await assert.rejects(remote.answer({eventId:'event',sessionId:'session-native',answer:'allowed-once'}),/pending/);
 }finally{remote.stop();assert(signal.aborted);}
});
