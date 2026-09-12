'use strict';
const fs=require('node:fs');
const symbol=Symbol.for('nodo.lifecycle');
function createGate(name,{flush=()=>{},registry=globalThis[symbol]||(globalThis[symbol]=new Map())}={}){
 if(registry.has(name))throw Error('Lifecycle service already registered: '+name);
 let paused=false,pausePromise=null,flushed=false;
 const inflight=new Set();
 const status=()=>({name,paused,inflight:inflight.size,drained:paused&&inflight.size===0&&!pausePromise&&flushed});
 const gate={status,
  run(fn){
   if(paused)return Promise.reject(Object.assign(Error('Service paused: '+name),{code:'NODO_PAUSED'}));
   const job=Promise.resolve().then(fn);inflight.add(job);
   job.then(()=>inflight.delete(job),()=>inflight.delete(job));return job;
  },
  pause(){
   paused=true;flushed=false;
   if(pausePromise)return pausePromise;
   pausePromise=(async()=>{await Promise.allSettled([...inflight]);await flush();})()
    .then(()=>{flushed=true;pausePromise=null;return status();},error=>{pausePromise=null;throw error;});
   return pausePromise;
  },
  resume(){if(pausePromise)throw Error('Service still draining: '+name);paused=false;flushed=false;return status();},
 };
 registry.set(name,gate);return gate;
}
function fsyncFile(file){const fd=fs.openSync(file,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
module.exports={createGate,fsyncFile,symbol};
