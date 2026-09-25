// Admission gate for background services (NODO tools, optional bridge/observer).
// Reconstructed from the contract in tests/services-lifecycle.test.cjs after the
// public export dropped services/. pause() closes admission, waits for admitted
// jobs to finish, flushes durable state and only then reports drained.
const symbol=Symbol.for('nodo.lifecycle.gates');
function createGate(name,{registry=globalThis[symbol]||(globalThis[symbol]=new Map()),flush=null}={}){
 let paused=false,drained=false,inflight=0,pausing=null;const idle=[];
 const settle=()=>{if(inflight===0)for(const wake of idle.splice(0))wake();};
 const status=()=>({name,paused,drained,inflight,missing:false});
 const gate={
  name,status,
  run(fn){
   if(paused)return Promise.reject(Object.assign(Error(name+' is paused for a safe update'),{code:'NODO_PAUSED'}));
   inflight++;
   return Promise.resolve().then(fn).finally(()=>{inflight--;settle();});
  },
  pause(){
   if(pausing)return pausing;
   paused=true;drained=false;
   pausing=(async()=>{
    if(inflight>0)await new Promise(resolve=>idle.push(resolve));
    if(flush)await flush();
    drained=true;return status();
   })().finally(()=>{pausing=null;});
   return pausing;
  },
  resume(){
   if(pausing)throw Error(name+' is still draining; resume after pause settles');
   paused=false;drained=false;return status();
  }
 };
 registry.set(name,gate);return gate;
}
module.exports={createGate,symbol};
