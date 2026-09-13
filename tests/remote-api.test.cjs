const test=require('node:test'),assert=require('node:assert/strict');
const {createRemoteAPI}=require('../lib/remote-api.cjs');
const sessionId='08e6e315-92b3-425e-8c94-47e0a42c335d',requestId='18e6e315-92b3-425e-8c94-47e0a42c335d';
test('phone cannot reach privileged Electron or generic DSH APIs',async()=>{
 let calls=0;const api=createRemoteAPI({dsh:()=>{calls++;}});
 for(const m of ['rc.call','files.read','files.write','browser.action','lifecycle.quit','shell','codex.login','__proto__','constructor'])await assert.rejects(api(m,{}),/not allowed/);
 await assert.rejects(api('newSession',{workspaceId:sessionId,requestId,cwd:'/'}),/Unexpected/);
 await assert.rejects(api('send',{sessionId,requestId,text:'x',method:'shell'}),/Unexpected/);
 assert.equal(calls,0);
});
test('same session and durable request identity survive retry without local writer',async()=>{
 const calls=[];const api=createRemoteAPI({dsh:async(m,p)=>{calls.push({m,p});return {accepted:true};}});
 const message={sessionId,requestId,text:'Synthetic test'};
 await api('send',message);await api('send',message);
 assert.deepEqual(calls,[{m:'remote.prompt',p:message},{m:'remote.prompt',p:message}]);
 await api('session',{sessionId,afterSeq:42});assert.equal(calls[2].p.afterSeq,42);
});
test('pause denies new work but keeps read/reconnect/stop available',async()=>{
 const api=createRemoteAPI({dsh:async()=>({ok:true}),paused:()=>true});
 await assert.rejects(api('send',{sessionId,requestId,text:'x'}),/restarting/);
 await api('stop',{sessionId});await api('session',{sessionId});
 await assert.rejects(api('session',{sessionId:'../../secrets'}),/identity/);
 await assert.rejects(api('session',{sessionId,afterSeq:-1}),/cursor/);
});
test('remote project is a read-only view allowlist, including while paused',async()=>{
 const calls=[];const api=createRemoteAPI({paused:()=>true,dsh:async(method,params)=>{calls.push({method,params});return {readonly:true};}});
 for(const view of ['brain','rules','context','mission'])assert.deepEqual(await api('project',{sessionId,view}),{readonly:true});
 assert.deepEqual(calls.map(call=>call.method),['remote.project','remote.project','remote.project','remote.project']);
 assert.deepEqual(calls.map(call=>call.params.view),['brain','rules','context','mission']);
 await assert.rejects(api('project',{sessionId,view:'save'}),/Read-only project view/);
 await assert.rejects(api('project',{sessionId,view:'brain',action:'delete'}),/Unexpected parameter/);
 await assert.rejects(api('project',{sessionId:'../../history',view:'brain'}),/Invalid identity/);
 assert.equal(calls.length,4);
});
test('remote media forwards only an absolute path and session identity',async()=>{
 const calls=[];const api=createRemoteAPI({dsh:async(method,params)=>{calls.push({method,params});return {status:'pending',retryable:true};}});
 const request={sessionId,path:'/selected-workspace/incoming/photo.png'};
 assert.deepEqual(await api('media',request),{status:'pending',retryable:true});
 assert.deepEqual(calls,[{method:'remote.media',params:request}]);
 await assert.rejects(api('media',{sessionId,path:'relative.png'}),/Invalid media path/);
 await assert.rejects(api('media',{sessionId,path:'/selected-workspace/a.png',token:'forged'}),/Unexpected parameter/);
 await assert.rejects(api('media',{sessionId:'constructor',path:'/selected-workspace/a.png'}),/Invalid identity/);
 assert.equal(calls.length,1);
});
