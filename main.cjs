const {app,BrowserWindow,ipcMain,Menu,shell,nativeTheme,dialog}=require('electron');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const http=require('node:http');
const {spawn,execFile}=require('node:child_process');
const {randomUUID,createHash}=require('node:crypto');
const {save,read,rpc,serve}=require('./lib/io.cjs');
const {Codex}=require('./lib/codex.cjs');
const {Browser}=require('./lib/browser.cjs');
const {Checkpoints}=require('./lib/checkpoints.cjs');
const {Tasks}=require('./lib/tasks.cjs');
const {environment,prepare,sandboxArgs,isolationViolations,scrubEnvironment}=require('./lib/environment.cjs');
const {DeepSeekBalance}=require('./lib/balance.cjs');
const {UsageLedger}=require('./lib/usage.cjs');
const {QuitControl,clearIntentionalStop}=require('./lib/quit-control.cjs');
const sourceRoot=__dirname;
require('electron').protocol.registerSchemesAsPrivileged([{scheme:'nodo-media',privileges:{standard:true,secure:true,supportFetchAPI:true,stream:true}}]);
const config=environment(sourceRoot);const data=config.data;
// Fail closed BEFORE the first create or write. A DEV build that can see the
// production profile, its ports or its app in the inherited environment stops
// here: the environment is what once carried the production profile into a DEV
// launch, and no DEV process may touch production state.
const appBundle=path.resolve(sourceRoot,'../../..');
const violations=isolationViolations(sourceRoot,config);
if(violations.length){
 console.error('NODO DEV refuses to start: the production scope is visible to this process.\n- '+violations.join('\n- ')+'\nLaunch the DEV build with a clean environment, for example:\n  open '+appBundle);
 process.exit(78);
}
// An isolated profile keeps nothing that a parent production process exported,
// so the harness it starts cannot open a production socket, resume a production
// session or write into the production profile.
if(config.isolated){const kept=scrubEnvironment(process.env);for(const key of Object.keys(process.env))if(!(key in kept))delete process.env[key];}
const overlay=prepare(sourceRoot,config);
let quitControl;
process.env.NODO_ISOLATED=config.isolated?'1':'0';
process.env.NODO_CDP_PORT=String(config.ports.cdp);process.env.NODO_TEST_PORT=String(config.ports.test);
const status=(state,extra={})=>save(path.join(data,'startup-status.json'),{state,pid:process.pid,version:config.version,updatedAt:new Date().toISOString(),sourceRoot,...extra});
if(process.argv.includes('--nodo-export-ui')){require(path.join(sourceRoot,'scripts/export-ui-electron.cjs'));}else{
nativeTheme.themeSource='dark';app.setName(config.name);app.setPath('userData',path.join(data,'Electron'));app.setPath('sessionData',path.join(data,'Electron'));
app.commandLine.appendSwitch('remote-debugging-address','127.0.0.1');app.commandLine.appendSwitch('remote-debugging-port',String(config.ports.cdp));
const acquired=app.requestSingleInstanceLock();if(!acquired){app.quit();}else{
 let rc;
 clearIntentionalStop(data);
 app.whenReady().then(async()=>{status('starting');rc=new Workstation();await rc.start();}).catch(e=>{status('failed',{error:e.code||e.name});quitControl.request('system');});
 quitControl=new QuitControl({data,isBusy:()=>rc?.hasActiveTasks()||false,cancelBusy:()=>rc?.cancelActiveTasks(),stop:reason=>rc?.stopGracefully(reason),resume:()=>rc?.resumeAfterFailedQuit(),status,requestQuit:()=>app.quit(),promptBusy:async()=>{const r=await dialog.showMessageBox(rc?.win,{type:'question',buttons:['Выйти','Отмена'],defaultId:0,cancelId:1,message:'Задача ещё выполняется',detail:'NODO безопасно отменит задачу и дождётся завершения.'});return r.response===0;},promptError:e=>dialog.showMessageBox(rc?.win,{type:'error',buttons:['OK'],message:'NODO не смог безопасно завершить работу',detail:e.message})});
 app.on('second-instance',()=>rc?.win?.show());app.on('window-all-closed',()=>app.quit());app.on('before-quit',event=>quitControl.beforeQuit(event));
 process.on('SIGTERM',()=>quitControl.request('system'));process.on('SIGINT',()=>quitControl.request('system'));
}
}
class Workstation{
 constructor(){this.data=data;this.root=sourceRoot;this.workspace=path.join(data,'workspace');this.started=Date.now();this.balance=new DeepSeekBalance({getKey:()=>this.getKey(),onChange:()=>this.changed(),provider:process.env.NODO_BALANCE_PROVIDER||'deepseek',model:()=>this.state?.deepseekModel||null});this.temp=fs.mkdtempSync(path.join(data,'tmp/nodo-'));fs.chmodSync(this.temp,0o700);this.dshSocket=path.join(this.temp,'dsh.sock');this.appSocket=path.join(this.temp,'app.sock');this.stateFile=path.join(data,'workstation.json');this.drain=null;this.updateRun=null;this.lastLifecycle=null;const ws=randomUUID();this.state=read(this.stateFile,{workspaceId:ws,workspaces:[{id:ws,name:'Personal'}],tabs:[],closedTabs:[],activeTab:null,chats:[],chatId:null,view:'split',deepseekModel:'deepseek-flash',codexDefault:null});if(config.safe){this.state.tabs=[];this.state.closedTabs=[];this.state.activeTab=null;}for(const t of this.state.tabs){t.granted=false;t.loading=false;}this.codex=new Codex(sourceRoot,data);this.checkpoints=new Checkpoints(data);this.lastHealth=[];this.dshReady=false;}
 changed(){if(this.saveTimer)return;this.saveTimer=setTimeout(()=>{this.saveTimer=null;save(this.stateFile,this.state);if(this.win&&!this.win.isDestroyed())this.win.webContents.send('rc:changed');},120);}
 async start(){
  app.dock?.setIcon(path.join(sourceRoot,'assets/NODO.iconset/user@example.invalid'));
  app.setAboutPanelOptions({applicationName:config.name,applicationVersion:config.version,credits:'Created by Stanislav Galitskiy'});
  this.win=new BrowserWindow({width:1460,height:940,minWidth:1080,minHeight:700,title:config.name,backgroundColor:'#ffffff',webPreferences:{preload:path.join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true}});
  this.win.on('close',event=>{if(!this.stopped){event.preventDefault();app.quit();}});
  this.win.webContents.on('page-title-updated',e=>{e.preventDefault();this.win.setTitle(config.name);});
  this.usage=new UsageLedger(data);this.cost=new (require('./lib/cost-meter.cjs').CostMeter)({usage:this.usage});
  const {safeStorage,powerSaveBlocker}=require('electron');
  this.features=new (require('./lib/feature-settings.cjs').FeatureSettings)({root:sourceRoot,data,version:config.version,isolated:config.isolated,safeStorage,power:powerSaveBlocker,call:(method,params)=>this.dsh('remote.call',{method,params}),onChange:()=>this.changed(),onInstallRequest:()=>this.runUpdate()});
  void this.features.start();
  this.win.webContents.on('render-process-gone',(_e,d)=>{
   status('failed',{error:'renderer:'+d.reason});
   fs.appendFileSync(path.join(data,'dsh.log'),'renderer process gone: '+d.reason+'\n');
   if(!this.win.isDestroyed()&&d.reason!=='clean-exit')this.win.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent('<body style="font:13px -apple-system,system-ui;padding:24px;color:#111;background:#fff">NODO renderer stopped ('+d.reason+'). Reopen NODO to continue; your data and sessions are intact.</body>'));
  });
  this.win.webContents.on('before-mouse-event',(_e,input)=>{if(input.type==='mouseDown')this.browser?.chatIntent();});
  this.win.webContents.setWindowOpenHandler(()=>({action:'deny'}));this.win.webContents.on('will-navigate',e=>e.preventDefault());
  this.browser=new Browser(this.win,this.state,sourceRoot,()=>this.changed());this.tasks=new Tasks(this);
  // Supervisor host: presentation and user controls for the mechanical
  // anti-loop governor that runs inside the harness plugin.
  this.supervisor=new (require('./lib/supervisor-host.cjs').SupervisorHost)(this);
  this.links=require('./lib/links.cjs').installLinks(this,require('electron'));
  this.projects=new (require('./lib/project-runtime.cjs').ProjectRuntime)(this);
  this.reaperContext=new (require('./lib/reaper-context.cjs').ReaperContext)({enabled:!config.isolated});
  this.mediaByWorkspace=new Map();
  this.mediaThumbs=path.join(this.temp,'media-thumbnails');fs.mkdirSync(this.mediaThumbs,{mode:0o700});
  require('electron').protocol.handle('nodo-media',async request=>{
   if(request.method!=='GET')return new Response(null,{status:405});
   for(const media of this.mediaByWorkspace.values()){try{const r=await media.openUrl(request.url,request.headers.get('range'));return new Response(require('node:stream').Readable.toWeb(r.stream),{status:r.status,headers:r.headers});}catch(e){if(e.code!=='TOKEN_INVALID')return new Response(null,{status:e.code==='RANGE_NOT_SATISFIABLE'?416:403});}}
   return new Response(null,{status:404});
  });
  this.harnessGuard=require('./lib/harness-guard.cjs').install(this.win,this.browser,config.ports.dsh,path.join(__dirname,'ui/index.html'));
  ipcMain.handle('rc:call',async(event,method,params)=>{if(event.sender!==this.win.webContents||event.senderFrame!==this.win.webContents.mainFrame||!this.harnessGuard.trusted(event.senderFrame.url))throw Error('Untrusted sender');return this.dispatch(method,params||{},true);});
  const uiFile=path.join(data,'imported-ui.json'),uiMarker=path.join(data,'ui-imported.json');
  ipcMain.on('rc:initial-ui',event=>{if(event.sender!==this.win.webContents||event.senderFrame?.parent!==null||!fs.existsSync(uiFile)){event.returnValue=null;return;}const raw=fs.readFileSync(uiFile),hash=createHash('sha256').update(raw).digest('hex');event.returnValue=read(uiMarker,{})?.hash!==hash?{hash,prefs:JSON.parse(raw)}:null;});
  ipcMain.on('rc:ui-imported',(event,hash)=>{if(event.sender!==this.win.webContents||event.senderFrame?.parent!==null)return;const expected=createHash('sha256').update(fs.readFileSync(uiFile)).digest('hex');if(hash===expected)save(uiMarker,{at:new Date().toISOString(),hash});});
  this.server=serve(this.appSocket,(m,p)=>this.dispatch(m,p,false));
  this.testServer=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><title>RC Test Page</title><h1>RC browser workspace</h1><p id="result">Agent isolation verified. Code: HARNESS-RC-42</p><label>Name <input id="name"></label><button id="check" onclick="document.getElementById(\'result\').textContent=\'Clicked successfully\'">Check</button>');});this.testServer.on('error',e=>{this.testServerError=e.message;});this.testServer.listen(config.ports.test,'127.0.0.1');
  // About reads the running application metadata. app.getVersion() is the
  // installed bundle version (Info.plist), which is the only value that cannot
  // go stale in a shipped build; config.version from the packaged package.json
  // is the fallback.
  ipcMain.on('rc:about-request',event=>{
   const sender=event.sender;
   // Only this dialog may ask, and it receives metadata, never authority.
   if(sender!==this.about?.webContents)return;
   sender.send('rc:about-info',{name:app.getName(),version:app.getVersion()||config.version||'unknown'});
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([{label:'NODO',submenu:[{label:'About NODO',click:()=>this.openAbout()},{type:'separator'},{role:'quit'}]},{label:'Edit',submenu:[{role:'undo'},{role:'redo'},{type:'separator'},{role:'cut'},{role:'copy'},{role:'paste'},{role:'selectAll'}]},{label:'View',submenu:[{role:'resetZoom'},{role:'zoomIn'},{role:'zoomOut'}]},{label:'Window',submenu:[{role:'minimize'},{role:'zoom'}]}]));
  if(!this.state.chats.length)this.newChat();await this.win.loadFile(path.join(__dirname,'ui/index.html'));
  if(process.env.NODO_BRAND_SMOKE==='1'){const shot=await this.win.webContents.capturePage();fs.writeFileSync(path.join(sourceRoot,'evidence/nodo-splash.png'),shot.toPNG());}
  this.browser.layout({x:0,y:0,width:0,height:0},false);
  if(!config.safe)this.codex.start().then(()=>this.changed()).catch(e=>{this.codex.lastError=e.message;this.changed();});
  if(process.env.NODO_ABOUT_PROBE)setTimeout(()=>{try{this.openAbout();}catch(e){fs.writeFileSync(process.env.NODO_ABOUT_PROBE,JSON.stringify({error:e.message}));}},2500);
  this.startDeepSeek().then(async()=>{const log=fs.readFileSync(path.join(data,'dsh.log'),'utf8');const url=log.match(new RegExp('http://127\\.0\\.0\\.1:'+config.ports.dsh+'/\\?token=[A-Za-z0-9_-]+','g'))?.at(-1);if(!url)throw Error('Dev Harness login URL missing');await this.win.loadURL(url);status('ready');this.balance.start();void this.recordHealthyStartup();}).catch(e=>{this.dshError=e.message;status('failed',{error:e.code||e.name});this.changed();});
  save(path.join(data,'instance.json'),{pid:process.pid,appSocket:this.appSocket,dshSocket:this.dshSocket,started:new Date(this.started).toISOString(),sourceRoot,ports:config.ports,dataPath:data});this.startupMs=Date.now()-this.started;
 }
 // About window: one instance, closable by the title bar button, Escape,
 // Command+W and a click outside the modal. It never keeps the main window
 // blocked: closing it always releases modality and returns focus to NODO.
 openAbout(){
  if(this.about&&!this.about.isDestroyed()){this.about.focus();return this.about;}
  const about=this.about=new BrowserWindow({parent:this.win,modal:true,width:340,height:180,resizable:false,minimizable:false,maximizable:false,closable:true,title:'About NODO',backgroundColor:'#000000',webPreferences:{preload:path.join(__dirname,'about-preload.cjs'),sandbox:true,nodeIntegration:false,contextIsolation:true}});
  about.setMenu(null);
  about.loadFile(path.join(__dirname,'ui/about.html'));
  if(process.env.NODO_ABOUT_OPEN==='1'&&!process.env.NODO_ABOUT_PROBE)process.env.NODO_ABOUT_PROBE=path.join(os.tmpdir(),'nodo-about-probe.json');
  about.on('closed',()=>{this.about=null;if(this.win&&!this.win.isDestroyed())this.win.focus();});
  // Menu-less windows receive no default key bindings in Electron; the shared
  // helper adds Escape, Command+W / Control+W and click-outside (blur).
  require('./lib/about-lifecycle.cjs').aboutClosable(about);
  if(process.env.NODO_ABOUT_PROBE){
   // Verification hook for the DEV smoke run only: reports what the dialog
   // really rendered and which close affordances the window exposes.
   about.webContents.once('did-finish-load',async()=>{
    await new Promise(r=>setTimeout(r,500));
    const text=await about.webContents.executeJavaScript("document.getElementById('version').textContent").catch(e=>'error: '+e.message);
    const report={shown:text,title:about.getTitle(),closable:about.isClosable(),modal:about.isModal(),menuBar:about.isMenuBarVisible(),focused:about.isFocused(),mainVersion:app.getVersion()};
    fs.writeFileSync(process.env.NODO_ABOUT_PROBE,JSON.stringify(report,null,1));
   });
  }
  return about;
 }
 async recordHealthyStartup(){if(config.isolated)return;for(let i=0;i<30&&!this.stopped;i++){try{const s=await this.dsh('lifecycle.status');if(this.codex.ready&&s.services.every(v=>!v.missing&&!v.paused)){save(path.join(config.rescue,'last-known-good.json'),{app:path.resolve(sourceRoot,'../../..'),verifiedAt:new Date().toISOString(),version:config.version,verification:'DSH, Codex, bridge and observer ready'});return;}}catch{}await new Promise(r=>setTimeout(r,1000));}status('degraded',{error:'SERVICE_HEALTH_UNCONFIRMED'});}
 async getKey(){return await new Promise((resolve,reject)=>execFile('/usr/bin/security',['find-generic-password','-s','codex-deepseek-api-key','-a','deepseek','-w'],{timeout:15000},(e,out)=>{if(!e)return resolve(out.trim());const failure=Error('DeepSeek key unavailable from existing Keychain item');failure.code=e.code===44?'NODO_KEY_MISSING':'NODO_KEY_UNAVAILABLE';reject(failure);}));}
 async startDeepSeek(){
  let key;try{key=await this.getKey();}catch(error){if(error.code!=='NODO_KEY_MISSING')throw error;}
  const env={...process.env,DSH_HOME:path.join(data,'dsh'),DSH_TELEMETRY_DISABLED:'1',NODO_OPTIONAL_SERVICES:JSON.stringify(config.requiredServices||[]),DEEPSEEK_API_KEY:key,RC_PLUGIN_PATH:path.join(sourceRoot,'dsh-plugin.mjs'),RC_DSH_SOCKET:this.dshSocket,RC_APP_SOCKET:this.appSocket,RC_WORKSPACE:this.workspace,TMPDIR:this.temp,NODO_DATA:data,NODO_ISOLATED:config.isolated?'1':'0',DSH_PERMISSION_MODE:config.isolated?'workspace-write':undefined,NODO_OUTER_SANDBOX:config.isolated?'1':'0',PATH:path.join(sourceRoot,'runtime')+':/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin'};
  delete env.OPENAI_API_KEY;delete env.DSH_WEB_URL;
  const log=fs.openSync(path.join(data,'dsh.log'),'a',0o600);const launch=sandboxArgs(config,config.node,[path.join(sourceRoot,'runtime/node_modules/@deepseek-ai/dsh/lib/bin.js'),'--profile','web','--patch',overlay,'--host','127.0.0.1','--port',String(config.ports.dsh),'--no-open']);this.dshChild=spawn(launch.bin,launch.args,{cwd:this.workspace,env,stdio:['ignore',log,log]});fs.closeSync(log);
  this.dshChild.on('error',e=>{this.dshError=e.message;this.dshReady=false;this.changed();});this.dshChild.on('exit',code=>{this.dshReady=false;this.dshError='Harness server exited: '+code;if(!this.stopping)status('failed',{error:'DSH_EXIT_'+code});this.changed();});
  for(let i=0;i<30;i++){try{await this.dsh('health');this.dshReady=true;this.dshError=null;this.changed();return;}catch{}await new Promise(r=>setTimeout(r,500));}throw Error('Dev Harness did not become ready. See dsh.log');
 }
 dsh(method,p={}){return rpc(this.dshSocket,method,p,30000);}
 newChat(){const chat={id:randomUUID(),title:'New conversation',agent:'DeepSeek',messages:[],workspaceId:this.state.workspaceId,codexChoice:null};this.state.chats.unshift(chat);this.state.chatId=chat.id;this.changed();return chat;}
 files(){const walk=(dir,prefix='')=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(d=>d.isSymbolicLink()?[]:d.isDirectory()?walk(path.join(dir,d.name),prefix+d.name+'/'):[prefix+d.name]);return walk(this.workspace).slice(0,500);}
 snapshot(){return{...this.state,appName:config.name,isolated:config.isolated,balance:this.balance.snapshot(),usage:this.usage.snapshot(),tasks:this.tasks.items.map(({timer,approval,...t})=>({...t,...approval?{approval:{method:approval.method,params:approval.params}}:{}})),codex:this.codex.status(),supervisor:this.supervisor?.snapshot()||{statuses:{},cards:{},notes:{}},dsh:{ready:this.dshReady,error:this.dshError,lastSuccess:this.deepseekLastSuccess},workspace:this.workspace,startupMs:this.startupMs,health:this.lastHealth,checkpoints:this.checkpoints.list()};}
 async health(){const now=new Date().toISOString();let dh;try{dh=await this.dsh('health');this.dshReady=true;}catch(e){this.dshReady=false;this.dshError=e.message;}const status=(name,color,detail,version,pid,lastError,lastSuccess)=>({name,color,detail,version:version||null,pid:pid||null,lastError:lastError||null,lastSuccess:lastSuccess||null,checkedAt:now});this.lastHealth=[
  status('Harness server',dh?'green':'red',dh?config.name+' runtime · 127.0.0.1:'+config.ports.dsh:'Dev Harness unavailable',dh?.version,dh?.pid,this.dshError,dh?now:null),
  status('DeepSeek',this.deepseekLastSuccess?'green':dh?'yellow':'red',this.deepseekLastSuccess?'API request completed':dh?'Runtime ready; request not checked in this launch':'Runtime unavailable','0.1.5-rc.1',dh?.pid,this.tasks.items.find(t=>t.agent==='DeepSeek'&&t.status==='Failed')?.error,this.deepseekLastSuccess),
  status('Codex',!this.codex.ready?'red':this.codex.account?.type==='chatgpt'?'green':'yellow',this.codex.account?.type==='chatgpt'?'ChatGPT subscription connected':'Connect Codex: official ChatGPT sign-in required','0.151.0',this.codex.child?.pid,this.codex.lastError,this.codex.account?now:null),
  status('Browser',this.browser.lastError?'yellow':'green',`${this.state.tabs.length} tabs · isolated Chromium`,process.versions.chrome,process.pid,this.browser.lastError,this.browser.lastSuccess),
  status('Browser automation',this.browser.pw?'green':'yellow',this.browser.pw?'Playwright connected to RC tabs':'Installed; connection opens on first Agent Tab operation',require(path.join(sourceRoot,'runtime/playwright/node_modules/playwright/package.json')).version,null,this.browser.lastError,this.browser.pw?this.browser.lastSuccess:null),
  status('Computer Use','yellow','Installed on this Mac; not connected to RC to avoid controlling production','0.2.0',null,'RC does not request system Accessibility permissions',null),
  status('MCP layer','yellow','Existing production MCP unchanged; RC browser uses installed Playwright directly',null,null,'No external MCP servers enabled in RC',null)
 ];return this.lastHealth;}
 async attachmentInput(p,chat){if(!Array.isArray(p.attachments)||!p.attachments.length)return{attachmentInput:[],attachments:[]};if(!chat?.deepseekId)throw Error('Native session required for attachments');const prepared=await this.dsh('attachments.resolve',{sessionId:chat.deepseekId,parts:p.attachments});return{attachmentInput:prepared.input,attachments:prepared.attachments};}
 async dispatch(method,p,user){
  if(method==='reaper.context'){if(!user)throw Error('REAPER panel requires local interface');return this.reaperContext.getState();}
  if(method==='media.inspect'||method==='media.action'){
   if(!user)throw Error('Media access requires the local interface');
   const identity=await this.dsh('project.call',{action:'identity',sessionId:p.sessionId});
   const thumbnailRoot=path.join(this.mediaThumbs,this.projects.brain.key(identity.workspace));fs.mkdirSync(thumbnailRoot,{recursive:true,mode:0o700});
   let media=this.mediaByWorkspace.get(identity.workspace);if(!media){media=new (require('./lib/media-preview.cjs').MediaPreview)({workspaceRoots:[identity.workspace,thumbnailRoot],tokenTtlMs:3600000});this.mediaByWorkspace.set(identity.workspace,media);}
   if(typeof p.path!=='string'||p.path.length>4096)throw Error('Invalid file path');
   const target=path.resolve(identity.workspace,p.path);
   if(method==='media.inspect'){
    const info=await media.issue(target);
    if(info.kind==='pdf'&&info.status==='ready'){
     const stamp=createHash('sha256').update(info.path+':'+fs.statSync(info.path).mtimeMs).digest('hex'),dir=path.join(thumbnailRoot,stamp);fs.mkdirSync(dir,{mode:0o700,recursive:true});const thumbnail=path.join(dir,path.basename(info.path)+'.png');
     if(!fs.existsSync(thumbnail))await new Promise(resolve=>execFile('/usr/bin/qlmanage',['-t','-s','420','-o',dir,info.path],{timeout:8000,maxBuffer:16384},()=>resolve()));
     if(fs.existsSync(thumbnail))info.thumbnail=(await media.issue(thumbnail)).url;
     delete info.url;delete info.token;info.playable=false;
    }
    return info;
   }
   const info=await media.inspect(target);if(!info.name)throw Error('File not ready');
   if(p.action==='reveal')return shell.showItemInFolder(info.path);
   if(p.action==='copy')return require('electron').clipboard.writeText(info.path);
   if(p.action==='open'){
    if(info.status!=='ready'){
     const text=await media.readText(info.path),escape=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
     const viewer=new BrowserWindow({width:760,height:620,parent:this.win,title:info.name,backgroundColor:'#000000',webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true}});
     viewer.webContents.setWindowOpenHandler(()=>({action:'deny'}));viewer.webContents.on('will-navigate',event=>event.preventDefault());
     await viewer.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent('<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"><title>'+escape(info.name)+'</title><pre style="white-space:pre-wrap;background:#000;color:#fff;padding:16px">'+escape(text)+'</pre>'));return;
    }
    return shell.openPath(info.path);
   }
   throw Error('Unknown media action');
  }
  if(method==='auto.route'){
   if(!user)throw Error('Routing requires the local interface');
   const chat=this.state.chats.find(c=>c.deepseekId===p.sessionId);if(!chat)throw Error('Bind the native session first');
   const project=await this.dsh('project.call',{action:'list',sessionId:p.sessionId});
   const selection=await this.dsh('project.call',{action:'select',sessionId:p.sessionId,text:p.text});
   const choice=chat.codexChoice||this.state.codexDefault;let codexReady=false;try{this.codex.validate(choice?.model,choice?.effort);codexReady=this.codex.ready;}catch{}
   const decision=require('./lib/auto-router.cjs').route({text:p.text,codexReady,choice,rules:project.rules,contextChars:selection.chars,balance:this.balance.snapshot(),contextMode:selection.metrics?.mode||project.modes?.mode});
   chat.lastRoute=decision;this.changed();return decision;
  }
  if(method==='project.call'){
   if(!user)throw Error('Project edits require the local interface');
   // The running application version travels with every project call: the
   // CURRENT STATE layer needs it to judge documents, and the context inspector
   // needs it before the first request of a session has been built.
   return this.dsh('project.call',{...p,appVersion:app.getVersion(),appName:app.getName()});
  }
  if(method==='context.status'){
   if(!user)throw Error('Context status requires the local interface');
   // One round trip to the plugin: selection metrics, resolved mode, provider
   // usage for the session and the project aggregate. Money is always marked as
   // estimated because only the provider knows the billed amount.
   // The live application version travels with the request: the CURRENT STATE
   // layer has to compare documents against the version actually running, and
   // only the Electron main process knows it.
   const project=await this.dsh('project.call',{action:'context.status',sessionId:p.sessionId,workspace:this.workspace,appVersion:app.getVersion(),appName:app.getName()});
   return {...project,turn:this.cost.turn(p.sessionId,p.turn),today:this.cost.project().today,exactness:{tokens:'provider',money:'estimated from the configured pricing table'}};
  }
  if(method==='context.mode'){if(!user)throw Error('Context mode requires the local interface');return this.dsh('project.call',{action:'mode.set',sessionId:p.sessionId,scope:p.scope||'session',mode:p.mode});}
  if(method==='cost.status'){if(!user)throw Error('Cost status requires the local interface');return this.cost.session(p.sessionId);}
  if(method==='project.backend'){if(user)throw Error('Workspace identity is backend-only');return this.projects.backend(p);}
  // Supervisor: status and history are readable by the local interface, every
  // decision that changes a turn is a user action.
  if(method==='supervisor.backend'){if(user)throw Error('Supervisor telemetry is backend-only');return this.supervisor.backend(p);}
  if(method==='supervisor.status')return this.dsh('supervisor.status',p);
  if(method==='supervisor.events')return this.dsh('supervisor.events',p);
  if(method==='supervisor.card')return this.supervisor.card(p.sessionId)||this.dsh('supervisor.card',p);
  if(method==='supervisor.act')return this.supervisor.act(p,user);
  if(method==='supervisor.userMessage')return this.supervisor.userMessage(p,user);
  if(method==='supervisor.settings')return this.dsh('supervisor.settings',p);
  if(['interpreter.status','interpreter.brief','interpreter.response','rules.propose'].includes(method))return this.dsh(method,p);
  if(method==='interpreter.configure'||method==='rules.save'){if(!user)throw Error('Interpreter changes require the local interface');return this.dsh(method,p);}
  if(method==='links.action'){if(!user)throw Error('Links require the local interface');return this.links.action(p);}
  if(method==='features.status'||method.startsWith('remote.')||method.startsWith('updates.')){if(!user)throw Error('NODO settings require the local interface');return this.features.dispatch(method,p);}
  if(method==='update.status')return this.features.dispatch('features.status',{}).updates;
  if(method==='update.now'){if(!user)throw Error('NODO settings require the local interface');return this.runUpdate();}
  if(method==='update.drain')return this.drainState();
  if(method==='lifecycle.status'){const live=await this.dsh('lifecycle.status');this.lastLifecycle=live;return {protocol:1,pid:process.pid,codexReady:this.codex.ready,dshReady:this.dshReady,tasks:this.tasks.items.filter(t=>['Running','Queued','Waiting','Pending','Starting'].includes(t.status)).length,...live,drain:this.drainState()};}
  if(method==='lifecycle.pause'){
    // Drain, do not abort: running turns and jobs finish, new ones stay queued.
    try{await this.waitForDrain(120000);const s=await rpc(this.dshSocket,'lifecycle.pause',{},60000);save(this.stateFile,this.state);return {...s,drain:this.drainState()};}
    catch(e){this.endDrain();throw Error('Shutdown blocked: '+e.message);}
   }
  if(method==='lifecycle.resume'){const s=await this.dsh('lifecycle.resume');this.endDrain();return {...s,drain:this.drainState()};}
  if(method==='lifecycle.quit'){if(!this.updatePaused)throw Error('Pause/drain is required');quitControl.request('updater');return {accepted:true};}
  if(this.updatePaused&&['chat.send','tasks.start','tasks.delegate','native.track'].includes(method))throw Error('NODO is paused for update');
  const localOnly=new Set(['browser.action','layout','workspace.create','workspace.select','chat.new','chat.select','chat.switch','chat.send','codex.login','codex.refresh','codex.select','tasks.start','tasks.cancel','tasks.deny','checkpoint.create','checkpoint.restore','view','open.workspace','native.bind','native.track','supervisor.act','supervisor.userMessage']);
  if(!user&&localOnly.has(method))throw Error('This action requires the RC user interface');
  switch(method){
   case'state':return this.snapshot();
   case'health':return this.health();
   case'balance.refresh':return this.balance.refresh();
  // Opens the provider billing/usage page for the header indicator. Only the
  // URL the backend itself attached to the live indicator is accepted.
  case'balance.open':{const target=this.balance.snapshot().indicator?.url;if(!/^https:\/\//.test(String(p.url||''))||p.url!==target)throw Error('Provider page is not configured');await shell.openExternal(target);return{opened:target};}
   case'usage.deepseek':if(user)throw Error('Backend usage only');this.usage.recordDeepSeek(p.sessionId,p.events);this.balance.afterTurn();this.changed();return;
   case'browser.chatIntent':this.browser.chatIntent();return;
   case'native.bind':{if(typeof p.sessionId!=='string')throw Error('Session required');let c=this.state.chats.find(c=>c.deepseekId===p.sessionId);if(!c){c={id:randomUUID(),title:'Harness session',deepseekId:p.sessionId,agent:'DeepSeek',messages:[],workspaceId:this.state.workspaceId};this.state.chats.unshift(c);}this.state.chatId=c.id;const inspection=await this.dsh('inspect',{sessionId:p.sessionId});const {extractAssistant}=require('./lib/tasks.cjs');c.messages=inspection.events.filter(e=>e.type==='user/message'||e.type==='assistant/message').slice(-12).map(e=>({role:e.type==='user/message'?'user':'assistant',agent:'DeepSeek',text:e.type==='user/message'?(e.data.content||[]).filter(c=>c.type==='text').map(c=>c.text).join(''):extractAssistant(e.data),at:new Date(e.time).toISOString()})).concat(c.messages.filter(m=>m.agent==='Codex'));this.changed();return c;}
   case'native.track':{const c=this.state.chats.find(c=>c.deepseekId===p.sessionId);if(!c)return;const inspection=await this.dsh('inspect',{sessionId:p.sessionId});const lastUser=inspection.events.filter(e=>e.type==='user/message').at(-1);const afterSeq=lastUser?lastUser.seq-1:inspection.events.at(-1)?.seq||0;const t={id:randomUUID(),chatId:c.id,sessionId:p.sessionId,agent:'DeepSeek',model:this.state.deepseekModel,reasoning:'runtime default',runtime:'DeepSeek · API',status:'Running',text:p.text,output:'',at:new Date().toISOString(),lastAction:'Working',allowedTools:['rc_browser','rc_read_file','rc_write_file','rc_list_files'],afterSeq};this.tasks.items.unshift(t);this.tasks.changed();this.tasks.pollDeepSeek(t,c);return{id:t.id};}
   case'layout':{const r=p.rect;for(const k of ['x','y','width','height'])if(!Number.isFinite(r?.[k])||r[k]<0||r[k]>10000)throw Error('Invalid view bounds');if(p.visible&&this.state.activeTab&&!this.browser.views.has(this.state.activeTab))await this.browser.materialize(this.browser.tab(this.state.activeTab));this.browser.layout(r,!!p.visible);return;}
   case'browser.action':return this.browser.action(p);
   case'browser.agent':return this.browser.agent(p);
   case'workspace.create':{if(!p.name?.trim())throw Error('Workspace name required');const w={id:randomUUID(),name:p.name.trim().slice(0,60)};this.state.workspaces.push(w);this.state.workspaceId=w.id;this.browser.layout();this.changed();return w;}
   case'workspace.select':if(!this.state.workspaces.some(w=>w.id===p.id))throw Error('Workspace not found');this.state.workspaceId=p.id;{const t=this.state.tabs.find(t=>t.workspaceId===p.id);if(t)await this.browser.activate(t.id);else{this.state.activeTab=null;this.browser.layout();}}this.changed();return;
   case'chat.new':return this.newChat();
   case'chat.select':if(!this.state.chats.some(c=>c.id===p.id))throw Error('Chat not found');this.state.chatId=p.id;this.changed();return;
   case'chat.switch':{const chat=this.state.chats.find(c=>c.id===this.state.chatId);if(!['AUTO','DeepSeek','Codex'].includes(p.agent))throw Error('Invalid agent');chat.handoffPending=p.consumeHandoff?false:chat.agent!==p.agent;chat.agent=p.agent;this.changed();return this.tasks.handoff(chat,'Continue current task');}
   case'chat.send':{const chat=this.state.chats.find(c=>c.id===this.state.chatId);if(this.tasks.items.some(t=>t.chatId===chat.id&&!t.delegated&&t.status==='Running'))throw Error('This conversation is running. Stop it or create another chat.');const prepared=await this.attachmentInput(p,chat);const t=await this.tasks.start({...p,...prepared,chatId:chat.id,agent:chat.agent==='AUTO'?(chat.lastRoute?.agent||'DeepSeek'):chat.agent,handoff:chat.handoffPending});chat.handoffPending=false;if(chat.title==='New conversation')chat.title=p.text.slice(0,45);this.changed();return{...t,timer:undefined};}
   case'codex.login':{const login=await this.codex.login();const u=new URL(login.authUrl);if(!['https:'].includes(u.protocol)||!['auth.openai.com','chatgpt.com'].includes(u.hostname))throw Error('Unexpected official login URL');await shell.openExternal(login.authUrl);return{started:true};}
   case'codex.refresh':await this.codex.refresh();this.changed();return this.codex.status();
   case'codex.select':{this.codex.validate(p.model,p.effort);const choice={model:p.model,effort:p.effort};if(p.scope==='default')this.state.codexDefault=choice;else this.state.chats.find(c=>c.id===this.state.chatId).codexChoice=choice;this.changed();return choice;}
   case'tasks.start':{const chat=this.state.chats.find(c=>c.id===this.state.chatId);const prepared=await this.attachmentInput(p,chat);return this.tasks.start({...p,...prepared,agent:'Codex',delegated:true,chatId:this.state.chatId});}
   case'tasks.delegate':{const chat=this.state.chats.find(c=>c.deepseekId===p.parentSession);if(!chat)throw Error('Parent RC chat not found');return this.tasks.start({text:p.task,chatId:chat.id,agent:'Codex',delegated:true,parentSession:p.parentSession});}
   case'tasks.get':{const{timer,...t}=this.tasks.get(p.id);return t;}
   case'tasks.cancel':return this.tasks.cancel(p.id);
   case'tasks.deny':{const t=this.tasks.get(p.id);if(!t.approval)throw Error('No pending request');this.codex.send({id:t.approval.id,error:{code:-32000,message:'Denied: outside enabled RC capabilities'}});delete t.approval;t.status='Running';this.tasks.changed();return;}
   case'files.list':return this.files();
   case'files.read':return this.checkpoints.read(p.path);
   case'files.write':{const r=this.checkpoints.write(p.path,p.text,p.task);this.changed();return r;}
   case'checkpoint.create':{const r=this.checkpoints.create(p.files);this.changed();return r;}
   case'checkpoint.restore':{const r=this.checkpoints.restore(p.id);this.changed();return r;}
   case'view':if(!['chat','split','browser'].includes(p.mode))throw Error('Unknown view');this.state.view=p.mode;this.changed();return;
   case'open.workspace':return shell.openPath(this.workspace);
   default:throw Error('Unknown RC operation');
  }
 }
 // UPDATE DRAIN MODE. Entering drain stops new agent work from starting, while
  // turns that are already running are allowed to finish and background jobs
  // (Tasks, Telegram events) stay queued instead of being lost. Only genuinely
  // in-flight work is waited for, so 24/7 bridges cannot block an update
  // forever; queued rows are persisted by stopGracefully before the handover.
  beginDrain(reason='update'){
   if(this.drain){this.updatePaused=true;return this.drain;}
   this.updatePaused=true;
   const drain=this.drain={reason,startedAt:Date.now(),session:this.drainSession||null};
   drain.timer=setInterval(()=>{
    const state=this.drainState();this.changed();
    if(state.drained){clearInterval(drain.timer);drain.timer=null;save(this.stateFile,this.state);status('drained',{reason,waited:state.waited});}
   },1000);
   if(drain.timer.unref)drain.timer.unref();
   status('draining',{reason,queued:this.queuedTasks().length});
   return drain;
  }
  queuedTasks(){return this.tasks.items.filter(t=>['Queued','Pending','Waiting'].includes(t.status));}
  busyTasks(){return this.tasks.items.filter(t=>['Running','Pending','Starting'].includes(t.status));}
  drainState(){
   const d=this.drain;if(!d)return {draining:false,drained:true,activeTurns:0,tasks:0,inflight:0,queued:0,waited:0};
   const tasks=this.busyTasks();
   const turns=Number(this.lastLifecycle?.activeTurns||0);
   const services=this.lastLifecycle?.services||[];
   // A service that is still working keeps the update waiting; a service that is
   // merely alive (Telegram bridge, sessions observer) does not. Anything those
   // services receive while draining is queued, not lost.
   const inflight=services.reduce((sum,s)=>sum+(Number.isFinite(s.inflight)?s.inflight:0),0);
   const pendingServices=services.filter(s=>!s.missing&&Number.isFinite(s.inflight)&&s.inflight>0).length;
   const known=this.lastLifecycle&&Number.isFinite(this.lastLifecycle.activeTurns);
   return {draining:true,reason:d.reason,waited:Date.now()-d.startedAt,drained:known&&turns===0&&pendingServices===0&&tasks.length===0,activeTurns:turns,tasks:tasks.length,inflight,queued:this.queuedTasks().length};
  }
  async waitForDrain(timeoutMs=120000){
   const drain=this.beginDrain('update');
   const until=Date.now()+timeoutMs;
   for(;;){
    const state=this.drainState();
    if(state.drained)return {drained:true,waited:Date.now()-drain.startedAt,queued:state.queued};
    if(Date.now()>=until)throw Error('Update drain did not finish in '+Math.round(timeoutMs/1000)+'s: '+state.activeTurns+' running, '+state.tasks+' tasks');
    await new Promise(resolve=>setTimeout(resolve,500));
   }
  }
  endDrain(){if(this.drain&&this.drain.timer)clearInterval(this.drain.timer);this.drain=null;this.updatePaused=false;return {draining:false};}
  // One update run: drain, stage the verified package through the single Rescue
  // staging contract, hand over to the independent installer, and let Rescue
  // complete the quit itself. Any failure before the handover resumes services.
  async runUpdate(){
   if(this.updateRun)throw Error('Update is already running');
   this.updateRun=(async()=>{
    try{
     const drained=await this.waitForDrain(120000);
     const staged=await this.features.downloadUpdate();
     if(!staged||!staged.package){this.endDrain();return {upToDate:true,drained};}
     const result=await this.features.installUpdate({backupKeyAccount:read(path.join(this.data,'backup-recovery.json'),{}).account});
     status('update-handoff',{version:result.version,folder:result.folder,pid:result.pid,queued:drained.queued});
     return {...result,drained};
    }catch(error){this.endDrain();this.updateRun=null;status('update-failed',{error:error.code||error.name});throw error;}
   })();
   return this.updateRun;
  }
  async hasActiveTasks(){const local=this.tasks?.items.some(t=>['Running','Queued','Waiting','Pending','Starting'].includes(t.status))||false;if(!this.dshChild||this.dshChild.exitCode!==null)return local;const lifecycle=await this.dsh('lifecycle.status');return local||lifecycle.activeTurns>0;}
 async cancelActiveTasks(){if(this.dshChild?.exitCode===null)await this.dsh('lifecycle.prepareQuit');const active=this.tasks.items.filter(t=>['Running','Queued','Waiting','Pending','Starting'].includes(t.status)&&t.agent==='Codex');for(const t of active){if(!t.threadId||!t.turnId)throw Error('Задача ещё запускается - безопасная отмена пока недоступна');await this.tasks.cancel(t.id);}if(this.dshChild?.exitCode===null)await this.dsh('lifecycle.cancel');const until=Date.now()+15000;while(await this.hasActiveTasks()){if(Date.now()>=until)throw Error('Отмена задачи не подтвердилась за 15 секунд');await new Promise(resolve=>setTimeout(resolve,250));}}
 async resumeAfterFailedQuit(){if(!this.stopped&&this.dshChild?.exitCode===null){this.stopping=false;await this.dispatch('lifecycle.resume',{},false);await this.features?.start();}}
 async stopGracefully(reason='user'){if(this.stopPromise)return this.stopPromise;this.stopPromise=(async()=>{this.shutdownReason=reason;this.stopping=true;await this.features?.stop();if(this.dshChild?.exitCode===null)await this.dispatch('lifecycle.pause',{},false);if(this.saveTimer)clearTimeout(this.saveTimer);save(this.stateFile,this.state);this.balance.stop();const children=[this.dshChild,this.codex.child].filter(c=>c&&c.exitCode===null);await Promise.all(children.map(child=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('A child has not exited; no force kill was used')),30000);child.once('exit',()=>{clearTimeout(timer);resolve();});child.kill('SIGTERM');})));this.browser?.dispose();this.server?.close();this.testServer?.close();this.stopped=true;status('stopped',{reason});})().catch(e=>{this.stopPromise=null;throw e;});return this.stopPromise;}
}
