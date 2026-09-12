'use strict';
const fields=['inputTokens','outputTokens','cacheReadTokens','cacheWriteTokens','reasoningTokens','totalTokens'];
function createProviderUsageHook(send,warn=()=>{}){
 const pending=new Map();
 return async(session,event)=>{
  const sessionId=session?.id;
  if(typeof sessionId!=='string')return;
  if(event.type==='assistant/message'&&Number.isSafeInteger(event.seq)&&event.data?.usage){
   const usage={};
   for(const key of fields){const value=event.data.usage[key];if(Number.isSafeInteger(value)&&value>=0)usage[key]=value;}
   if(usage.inputTokens===undefined||usage.outputTokens===undefined)return;
   if(!pending.has(sessionId))pending.set(sessionId,new Map());
   pending.get(sessionId).set(event.seq,{type:'assistant/message',seq:event.seq,data:{usage}});
  }
  if(event.type!=='turn/end')return;
  const rows=pending.get(sessionId),events=rows?[...rows.values()]:[];
  try{
   await send({sessionId,events});
   // A new turn may append while this RPC is outstanding; delete only sent rows.
   if(rows){for(const e of events)rows.delete(e.seq);if(rows.size===0)pending.delete(sessionId);}
  }catch{warn('NODO usage delivery unavailable; retained counters retry after the next turn');}
 };
}
module.exports={createProviderUsageHook};
