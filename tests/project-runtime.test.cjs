const {test}=require('node:test');
const assert=require('node:assert/strict');
const {installProjectRuntime}=require('../lib/project-runtime.cjs');

test('unavailable optional checkpoint does not change original native tool permission flow',async()=>{
 const handlers=new Map();let called=0;installProjectRuntime({on:(n,h)=>handlers.set(n,h)},async(_m,p)=>{if(p.action==='checkpoint.create')throw Error('unsafe checkpoint root');},x=>x);
 const result=await handlers.get('tools/execute')({name:'write',arguments:{path:'file.txt'},agent:{session:{id:'s',header:{cwd:'/project'}}}},async()=>{called++;return{isError:false};});assert.equal(called,1);assert.equal(result.isError,false);
});

test('Smart Context reads explicitly selected files only inside the bound workspace',async()=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),root=fs.mkdtempSync(path.join(os.tmpdir(),'nodo-context-'));
 try{const workspace=path.join(root,'workspace');fs.mkdirSync(workspace);fs.writeFileSync(path.join(workspace,'fact.txt'),'FILE-CONTEXT-791');fs.writeFileSync(path.join(root,'outside.txt'),'NOT-IN-CONTEXT');const runtime=new(require('../lib/project-runtime.cjs').ProjectRuntime)({data:root,workspace});
 const call=p=>runtime.backend({workspace,sessionId:'test',...p});await call({action:'save',kind:'entries',type:'file',text:'fact.txt',pinned:true});await call({action:'save',kind:'entries',type:'file',text:'../outside.txt',pinned:true});const selected=await call({action:'select',text:'Read project files'});assert.ok(selected.included.some(x=>x.kind==='file'&&x.text==='FILE-CONTEXT-791'));assert.ok(!JSON.stringify(selected).includes('NOT-IN-CONTEXT'));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('Mission arms native goal driver exactly once without duplicate prompt',async()=>{
 let creates=0,prompts=0;const session={id:'s',header:{cwd:'/project'}},agent={session,status:'idle'};
 const ctx={on:()=>()=>{},sessions:new Map([['s',session]]),agents:{list:()=>[agent]},sessionController:{prompt:()=>{prompts++;}},goals:{create:(_agent,{objective})=>{creates++;return{id:'g',objective};}}};
 const runtime=installProjectRuntime(ctx,async()=>{},x=>x);
 assert.equal((await runtime.call({sessionId:'s',action:'mission.start',text:'Verify a fixture'})).id,'g');
 assert.equal(creates,1);assert.equal(prompts,0);
});

test('pre-step admits selected context for the incoming user query in the same turn',async()=>{
 const handlers=new Map();
 const ctx={on:(name,handler)=>{handlers.set(name,handler);return()=>{};}};
 const bridge=async(_name,request)=>{
  assert.equal(request.action,'select');
  assert.equal(request.text,'Find ORBIT-731');
  return {included:[{kind:'brain',source:'Project Brain',text:'ORBIT-731 is active'}]};
 };
 const createUserMessage=payload=>({role:'user',...payload});
 installProjectRuntime(ctx,bridge,createUserMessage);
 const incoming={role:'user',source:{kind:'user'},content:[{type:'text',text:'Find ORBIT-731'}]};
 const agent={session:{id:'session-1',header:{cwd:'/project'}}};
 const decision=await handlers.get('agent/pre-step')({agent,messages:[incoming]},async()=>({kind:'enter',messages:[incoming]}));
 assert.equal(decision.messages.length,2);
 const injected=decision.messages[1];
 assert.deepEqual(injected.source,{kind:'plugin',plugin:'nodo-project-context',form:'recall'});
 assert.match(injected.content[0].text,/ORBIT-731 is active/);
});
