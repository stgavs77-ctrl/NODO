'use strict';
// This is the whole phone capability boundary, not an Electron IPC proxy.
// Authentication belongs to the transport; this layer must still validate each call.
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const METHODS=new Set(['workspaces','sessions','session','newSession','send','stop','interactions','answer']);
function object(value){if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid request');return value;}
function fields(p,allowed){object(p);if(Object.keys(p).some(k=>!allowed.includes(k)))throw Error('Unexpected parameter');}
function id(value){if(typeof value!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(value)||['constructor','prototype','__proto__'].includes(value))throw Error('Invalid identity');return value;}
function requestId(value){if(typeof value!=='string'||!UUID.test(value))throw Error('Invalid request identity');return value;}
function createRemoteAPI({dsh,paused=()=>false}){
 return async function call(method,p={}){
  if(!METHODS.has(method))throw Error('Remote operation is not allowed');
  if(['send','newSession'].includes(method)&&paused())throw Error('NODO restarting; retry after reconnect');
  if(method==='workspaces'){fields(p,[]);return dsh('remote.workspaces',{});}
  if(method==='interactions'){fields(p,['sessionId']);return dsh('remote.interactions',{sessionId:id(p.sessionId)});}
  if(method==='answer'){fields(p,['sessionId','eventId','answer']);id(p.sessionId);id(p.eventId);return dsh('remote.answer',p);}
  if(method==='sessions'){fields(p,[]);return dsh('remote.sessions',{});}
  if(method==='session'){fields(p,['sessionId','afterSeq']);id(p.sessionId);if(p.afterSeq!==undefined&&(!Number.isSafeInteger(p.afterSeq)||p.afterSeq<0))throw Error('Invalid cursor');return dsh('remote.session',{sessionId:p.sessionId,afterSeq:p.afterSeq??0});}
  if(method==='newSession'){fields(p,['workspaceId','requestId']);return dsh('remote.create',{workspaceId:id(p.workspaceId),sessionId:requestId(p.requestId)});}
  if(method==='stop'){fields(p,['sessionId']);return dsh('cancel',{sessionId:id(p.sessionId)});}
  fields(p,['sessionId','requestId','text']);id(p.sessionId);requestId(p.requestId);
  if(typeof p.text!=='string'||!p.text.trim()||Buffer.byteLength(p.text)>64000)throw Error('Message must contain 1-64000 bytes');
  // Native controller persists requestId and owns admission/idempotency for both clients.
  return dsh('remote.prompt',{sessionId:p.sessionId,requestId:p.requestId,text:p.text});
 };
}
module.exports={createRemoteAPI,METHODS};
