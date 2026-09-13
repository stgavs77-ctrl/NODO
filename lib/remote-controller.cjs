'use strict';
// Native DSH remains the only history/session writer. No second host is started.
const {createRemoteAPI}=require('./remote-api.cjs');
async function opening(iterable){const iterator=iterable[Symbol.asyncIterator]();try{const value=await iterator.next();if(value.done)throw Error('Native state unavailable');return value.value;}finally{await iterator.return?.();}}
function createRemoteController(ctx,lifecycle,projects){
 const interactions=new (require('./remote-interactions.cjs').RemoteInteractions)(ctx);
 const signal=()=>AbortSignal.timeout(15000);
 const call=createRemoteAPI({paused:()=>lifecycle.paused,dsh:async(method,p)=>{
  switch(method){
   case 'remote.media':return projects.call({sessionId:p.sessionId,action:'media.remote',path:p.path});
   case 'remote.project':{
    if(!projects)throw Error('Project view unavailable');
    if(p.view==='mission')return projects.call({sessionId:p.sessionId,action:'mission.status'});
    if(p.view==='context')return projects.call({sessionId:p.sessionId,action:'context'});
    const list=await projects.call({sessionId:p.sessionId,action:'list'});return (p.view==='brain'?list.entries:list.rules).slice(0,50).map(x=>({...x,text:x.text.slice(0,2000)}));
   }
   case 'remote.interactions':return interactions.list(p.sessionId);
   case 'remote.answer':return interactions.answer(p);
   case 'remote.workspaces':{
    const frame=await opening(ctx.workspaceController.follow(signal()));
    if(frame.type!=='baseline')throw Error('Unexpected workspace baseline');
    return frame;
   }
   case 'remote.sessions':{
    const list=await ctx.sessionController.list({},signal());
    // The phone needs names and identities, not full context/usage projections.
    return require('./remote-view.cjs').sessions(list);
   }
   case 'remote.session':return require('./remote-view.cjs').session(await opening(ctx.sessionController.follow({address:{kind:'session',sessionId:p.sessionId},maxMessages:60,assistantStream:true},signal())));
   case 'remote.create':return ctx.sessionController.create(p);
   case 'remote.prompt':await interactions.start();return ctx.sessionController.prompt({sessionId:p.sessionId,requestId:p.requestId,mode:'queue',content:[{type:'text',text:p.text}]},signal());
   case 'cancel':return ctx.sessionController.cancel(p);
   default:throw Error('Remote operation not supported');
  }
 }});
 return {call,dispose:()=>interactions.stop()};
}
module.exports={createRemoteController,opening};
