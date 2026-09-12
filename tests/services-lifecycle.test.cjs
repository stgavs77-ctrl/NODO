const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createGate,symbol}=require('../services/lifecycle-gate.cjs');
test('pause drains admitted jobs, forbids new jobs, flushes before ack and resumes',async()=>{
 let release,flushed=false;const registry=new Map();
 const g=createGate('mock',{registry,flush:()=>{flushed=true;}});
 const job=g.run(()=>new Promise(r=>{release=r;}));await Promise.resolve();
 const paused=g.pause();assert.equal(g.status().inflight,1);assert.equal(g.status().drained,false);
 await assert.rejects(g.run(()=>{}),{code:'NODO_PAUSED'});assert.throws(()=>g.resume());
 release();await job;assert.equal((await paused).drained,true);assert.equal(flushed,true);
 g.resume();assert.equal(g.status().paused,false);await g.run(()=>42);
});
test('flush failure fails closed, retry does not repeat old work',async()=>{
 let fail=true,calls=0;const g=createGate('bad',{registry:new Map(),flush:()=>{if(fail)throw Error('disk');}});
 await g.run(()=>{calls++;});await assert.rejects(g.pause(),/disk/);assert.equal(g.status().drained,false);
 fail=false;assert.equal((await g.pause()).drained,true);assert.equal(calls,1);
});
test('packaged bridge and observer mock contexts pause with durable files; startup sentinel untouched',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'nodo-services-'));
 const old=globalThis[symbol];globalThis[symbol]=new Map();const cleanup=[];
 const ctx={effect:f=>cleanup.push(f()),logger:{info(){},warn(){}},tools:{register(){}},sessions:{get(){}},typert:{lookups:new Map()}};
 try{
  const helper=path.join(root,'mock.cjs');fs.writeFileSync(helper,'process.stdout.write(JSON.stringify({messages:[]}))');
  fs.writeFileSync(path.join(root,'selftest.txt'),'SYNTHETIC_DO_NOT_SEND');
  const bridge=await import('../services/telegram-bridge-live.mjs');
  bridge.apply(ctx,{state:path.join(root,'state.json'),registry:path.join(root,'registry.json'),config:path.join(root,'config.json'),journal:root,python:process.execPath,helper,maker:helper,sender:helper,prompter:helper,intervalMs:999999});
  const observer=await import('../services/sessions-observer.mjs');
  observer.apply(ctx,{bridgeState:path.join(root,'state.json'),bridgeAlerts:path.join(root,'alerts.json'),bridgeWatch:path.join(root,'watch.json'),sessionsRoot:root,projections:root,outDir:path.join(root,'observer'),healLog:path.join(root,'heal.log'),wakeController:false,intervalMs:999999});
  const gates=[...globalThis[symbol].values()];assert.equal(gates.length,2);
  assert((await Promise.all(gates.map(g=>g.pause()))).every(s=>s.drained));
  assert.equal(fs.readFileSync(path.join(root,'selftest.txt'),'utf8'),'SYNTHETIC_DO_NOT_SEND');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root,'state.json'))).pending.length,0);
  assert(Array.isArray(JSON.parse(fs.readFileSync(path.join(root,'observer/board.json'))).sessions));
 }finally{await Promise.all(cleanup.map(f=>f()));globalThis[symbol]=old;fs.rmSync(root,{recursive:true,force:true});}
});
