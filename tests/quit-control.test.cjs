const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process');
const {QuitControl,markerPath,clearIntentionalStop}=require('../lib/quit-control.cjs');
const {lifecycleControl}=require('../lib/lifecycle-control.cjs');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture({busy=false,answer=true,stopError=null,onStop=null}={}){
 const data=fs.mkdtempSync(path.join(os.tmpdir(),'nodo-quit-'));let active=busy,stops=0,cancels=0,requests=0,errors=0,resumes=0;
 const control=new QuitControl({data,isBusy:()=>active,cancelBusy:async()=>{cancels++;active=false;},stop:async()=>{stops++;onStop?.(data);if(stopError)throw stopError;},resume:async()=>{resumes++;},status:()=>{},requestQuit:()=>{requests++;},promptBusy:async()=>answer,promptError:async()=>{errors++;}});
 const event={preventDefault(){this.prevented=true;}};
 return {data,control,event,state:()=>({active,stops,cancels,requests,errors}),resumeCount:()=>resumes};
}
test('idle DEV quit drains, persists an intentional user stop, then permits one quit',async()=>{
 let markerSeen=false;const f=fixture({onStop:data=>{markerSeen=fs.existsSync(markerPath(data));}});try{f.control.beforeQuit(f.event);await tick();await tick();assert.equal(f.event.prevented,true);assert.equal(markerSeen,true);assert.deepEqual(f.state(),{active:false,stops:1,cancels:0,requests:1,errors:0});assert.equal(JSON.parse(fs.readFileSync(markerPath(f.data))).reason,'user');const second={preventDefault(){throw Error('already permitted');}};f.control.beforeQuit(second);}finally{fs.rmSync(f.data,{recursive:true,force:true});}
});
test('busy DEV quit presents one decision, safely cancels then drains',async()=>{
 const f=fixture({busy:true});try{f.control.beforeQuit(f.event);f.control.beforeQuit({preventDefault(){}});await tick();await tick();await tick();assert.deepEqual(f.state(),{active:false,stops:1,cancels:1,requests:1,errors:0});}finally{fs.rmSync(f.data,{recursive:true,force:true});}
});
test('busy Cancel leaves the task and does not write a stop marker',async()=>{
 const f=fixture({busy:true,answer:false});try{f.control.beforeQuit(f.event);await tick();await tick();assert.deepEqual(f.state(),{active:true,stops:0,cancels:0,requests:0,errors:0});assert.equal(fs.existsSync(markerPath(f.data)),false);}finally{fs.rmSync(f.data,{recursive:true,force:true});}
});
test('failed drain remains visible and never persists or retries quit',async()=>{
 const f=fixture({stopError:Error('pause failed')});try{f.control.beforeQuit(f.event);await tick();await tick();assert.deepEqual(f.state(),{active:false,stops:1,cancels:0,requests:0,errors:1});assert.equal(f.resumeCount(),1);assert.equal(fs.existsSync(markerPath(f.data)),false);}finally{fs.rmSync(f.data,{recursive:true,force:true});}
});
test('updater quit records a distinct intentional-stop reason',async()=>{
 const f=fixture();try{f.control.request('updater');f.control.beforeQuit(f.event);await tick();await tick();assert.equal(JSON.parse(fs.readFileSync(markerPath(f.data))).reason,'updater');assert.equal(f.state().requests,2);}finally{fs.rmSync(f.data,{recursive:true,force:true});}
});
test('manual launch clears the intentional marker',()=>{
 const data=fs.mkdtempSync(path.join(os.tmpdir(),'nodo-quit-'));try{fs.mkdirSync(data,{recursive:true});fs.writeFileSync(markerPath(data),'{}');clearIntentionalStop(data);assert.equal(fs.existsSync(markerPath(data)),false);}finally{fs.rmSync(data,{recursive:true,force:true});}
});
test('watchdog launcher suppresses only an intentional user stop',{skip:fs.existsSync(path.resolve(__dirname,'../scripts/start-current-nodo.command'))&&fs.existsSync('/bin/zsh')?false:'start-current-nodo.command (private tree) or zsh unavailable'},()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'nodo-launcher-')),marker=path.join(home,'Library/Application Support/NODO/intentional-stop.json');try{fs.mkdirSync(path.dirname(marker),{recursive:true});const run=reason=>{fs.writeFileSync(marker,JSON.stringify({intentional:true,reason}));return cp.spawnSync('/bin/zsh',[path.resolve(__dirname,'../scripts/start-current-nodo.command')],{env:{HOME:home,PATH:process.env.PATH},encoding:'utf8'});};assert.equal(run('user').status,0);assert.notEqual(run('updater').status,0);fs.rmSync(marker);assert.notEqual(cp.spawnSync('/bin/zsh',[path.resolve(__dirname,'../scripts/start-current-nodo.command')],{env:{HOME:home,PATH:process.env.PATH},encoding:'utf8'}).status,0);}finally{fs.rmSync(home,{recursive:true,force:true});}
});
test('native quit closes prompt admission before cancelling exact active sessions',async()=>{
 const cancelled=[];let active=true;const commands={prompt(){return 'accepted';}};
 const ctx={agents:{list:()=>active?[{status:'running',session:{id:'native-session'}}]:[]},sessionController:{commands,cancel:async({sessionId})=>{cancelled.push(sessionId);active=false;}}};
 const control=lifecycleControl(ctx,true);try{assert.deepEqual(control.prepareQuit(),{prepared:true,activeTurns:1});assert.throws(()=>commands.prompt(),/paused/);active=true;assert.deepEqual(await control.cancelActive(),{prepared:true,cancelled:['native-session']});assert.deepEqual(cancelled,['native-session']);control.resume();assert.equal(commands.prompt(),'accepted');}finally{control.dispose();}
});
