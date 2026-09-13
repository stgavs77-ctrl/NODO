'use strict';
// Public phone DTOs: no tool payloads, context projections or filesystem metadata.
function content(data){
 const parts=data?.content||data?.message?.content;
 if(Array.isArray(parts))return parts.filter(v=>v?.type==='text').map(v=>({type:'text',text:v.text}));
 return (data?.stream||[]).filter(v=>Array.isArray(v)&&v[0]==='text').map(v=>({type:'text',text:v[1]}));
}
function sessions(list){return {items:list.items.map(s=>({sessionId:s.sessionId,title:s.projections?.values?.title||s.title||'Session',running:s.running,updatedAt:s.updatedAt}))};}
function session(frame){return {records:(frame.records||[]).filter(r=>['user/message','assistant/message'].includes(r.event?.type)).map(r=>({event:{type:r.event.type,data:{content:content(r.event.data)}}})),assistantStream:{activeAttempt:{stream:(frame.assistantStream?.activeAttempt?.stream||[]).filter(v=>Array.isArray(v)&&v[0]==='text')}}};}
module.exports={sessions,session};
