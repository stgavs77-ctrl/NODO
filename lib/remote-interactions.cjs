'use strict';
// Adapter for the pinned DSH event gateway. We never expose its generic invoke
// method. Results can address only an exact pending approval/question delivered
// to this adapter; the native gateway arbitrates against the Mac UI once.
class RemoteInteractions{
 constructor(ctx){this.ctx=ctx;this.pending=new Map();this.lastUse=0;this.generation=0;}
 async start(){
  this.lastUse=Date.now();if(this.starting)return this.starting;
  const generation=++this.generation;this.starting=(async()=>{
   const g=this.ctx.typertGateway;if(!g?.wireStream?.open||typeof g.dispatchRpc!=='function'||!(g.pendingRemoteEvents instanceof Map)||!(g.remoteEventClients instanceof Map))throw Error('Pinned interaction adapter unavailable');
   this.abort=new AbortController();const stream=await g.wireStream.open('$events',{args:{}},this.abort.signal);
   let ready;const readiness=new Promise((resolve,reject)=>ready={resolve,reject});
   this.consume=(async()=>{try{for await(const f of stream){if(generation!==this.generation)break;
    if(f.type==='ready'){this.clientId=f.clientId;ready.resolve();}
    else if(f.type==='cancel')this.pending.delete(f.eventId);
    else if(f.type==='waterfall'){
     if(!['approval/request','user-questions/request'].includes(f.event)){await g.dispatchRpc('$events/result',{args:{clientId:this.clientId,eventId:f.eventId,outcome:{kind:'next'}}},this.abort.signal);continue;}
     const agent=this.ctx.agents.list().find(a=>a.id===f.agentId);if(!agent?.session?.id){await g.dispatchRpc('$events/result',{args:{clientId:this.clientId,eventId:f.eventId,outcome:{kind:'next'}}},this.abort.signal);continue;}
     this.pending.set(f.eventId,{...f,sessionId:agent.session.id});
    }
   }}catch{ready.reject(Error('Interaction stream unavailable'));}finally{if(generation===this.generation){this.pending.clear();this.clientId=null;this.starting=null;}}})();
   this.timer=setInterval(()=>{if(Date.now()-this.lastUse>30000)this.stop();},5000);this.timer.unref?.();await readiness;
  })();try{await this.starting;}catch(e){this.stop();throw e;}
 }
 async list(sessionId){await this.start();return [...this.pending.values()].filter(f=>f.sessionId===sessionId).map(f=>({eventId:f.eventId,kind:f.event==='approval/request'?'approval':'questions',toolName:f.request.toolName,reason:f.request.reason,questions:f.request.questions}));}
 async answer(p){await this.start();const f=this.pending.get(p.eventId);if(!f||f.sessionId!==p.sessionId)throw Error('Request is no longer pending');let value;
  if(f.event==='approval/request'){if(!['allowed-once','rejected'].includes(p.answer))throw Error('Only a one-time decision is allowed');value=p.answer;}
  else{const answers=p.answer?.answers,questions=f.request.questions;if(!Array.isArray(answers)||answers.length!==questions.length)throw Error('Answer every question');const ids=new Set();for(const a of answers){const q=questions.find(q=>q.id===a.id);if(!q||ids.has(a.id)||!Array.isArray(a.selected)||a.selected.some(v=>!q.options?.some(o=>o.label===v))||(!q.multiSelect&&a.selected.length>1)||(a.custom!==undefined&&(typeof a.custom!=='string'||a.custom.length>8000)))throw Error('Invalid question answer');ids.add(a.id);}value={answers:answers.map(a=>({id:a.id,selected:a.selected,...a.custom!==undefined?{custom:a.custom}:{}}))};}
  const g=this.ctx.typertGateway;if(!g.pendingRemoteEvents.get(f.eventId)?.deliveries.has(g.remoteEventClients.get(this.clientId)))throw Error('Request was already resolved');const result=await g.dispatchRpc('$events/result',{args:{clientId:this.clientId,eventId:f.eventId,outcome:{kind:'result',value}}},this.abort.signal);if(!result.ok)throw Error('Native decision was not accepted');this.pending.delete(f.eventId);return {accepted:true};
 }
 stop(){++this.generation;clearInterval(this.timer);this.abort?.abort();this.pending.clear();this.starting=null;}
}
module.exports={RemoteInteractions};
