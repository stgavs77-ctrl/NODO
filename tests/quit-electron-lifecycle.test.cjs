const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process');
const root=path.resolve(__dirname,'..');
test('isolated Electron before-quit waits for drain and leaves a user marker',async t=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'nodo-electron-quit-')),app=path.join(temp,'NODO.app'),data=path.join(temp,'profile');
 t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
 cp.execFileSync('/bin/cp',['-cR',path.join(root,'vendor/Shell.app'),app]);
 const appRoot=path.join(app,'Contents/Resources/app');fs.rmSync(path.join(app,'Contents/Resources/app.asar'),{force:true});fs.mkdirSync(appRoot,{recursive:true});
 const fixture=path.join(temp,'main.cjs');
 fs.writeFileSync(fixture,`const {app}=require('electron');const fs=require('node:fs');const {QuitControl}=require(${JSON.stringify(path.join(root,'lib/quit-control.cjs'))});const data=process.env.NODO_TEST_DATA;let drained=false;const q=new QuitControl({data,isBusy:async()=>false,cancelBusy:async()=>{},stop:async()=>{await new Promise(r=>setTimeout(r,40));drained=true;},status:()=>{},requestQuit:()=>app.quit(),promptBusy:async()=>true,promptError:e=>{throw e;}});app.on('before-quit',e=>q.beforeQuit(e));app.on('will-quit',()=>{if(!drained)process.exitCode=23;process.stdout.write('WILL_QUIT\\n');});app.whenReady().then(()=>setTimeout(()=>app.quit(),20));`);
 fs.writeFileSync(path.join(appRoot,'package.json'),JSON.stringify({name:'nodo-quit-fixture',main:'index.cjs'}));fs.writeFileSync(path.join(appRoot,'index.cjs'),`require(${JSON.stringify(fixture)});`);
 const child=cp.spawn(path.join(app,'Contents/MacOS/NODO'),[],{env:{...process.env,NODO_TEST_DATA:data,ELECTRON_RUN_AS_NODE:undefined},stdio:['ignore','pipe','pipe']});let out='',err='';child.stdout.on('data',d=>out+=d);child.stderr.on('data',d=>err+=d);
 const code=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill('SIGTERM');reject(Error('Electron fixture timed out'));},15000);child.once('exit',value=>{clearTimeout(timer);resolve(value);});child.once('error',reject);});
 assert.equal(code,0,err);assert.match(out,/WILL_QUIT/);assert.deepEqual(JSON.parse(fs.readFileSync(path.join(data,'intentional-stop.json'))),{intentional:true,reason:'user',stoppedAt:JSON.parse(fs.readFileSync(path.join(data,'intentional-stop.json'))).stoppedAt});
});
