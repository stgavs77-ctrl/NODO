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
const {environment,prepare,sandboxArgs}=require('./lib/environment.cjs');
const {DeepSeekBalance}=require('./lib/balance.cjs');
const {UsageLedger}=require('./lib/usage.cjs');
const {QuitControl,clearIntentionalStop}=require('./lib/quit-control.cjs');
const sourceRoot=__dirname;
const config=environment(sourceRoot);const data=config.data;
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
 constructor(){this.data=data;this.root=sourceRoot;this.workspace=path.join(data,'workspace');this.started=Date.now();this.balance=new DeepSeekBalance({getKey:()=>this.getKey(),onChange:()=>this.changed()});this.temp=fs.mkdtempSync(path.join(data,'tmp/nodo-'));fs.chmodSync(this.temp,0o700);this.dshSocket=path.join(this.temp,'dsh.sock');this.appSocket=path.join(this.temp,'app.sock');this.stateFile=path.join(data,'workstation.json');const ws=randomUUID();this.state=read(this.stateFile,{workspaceId:ws,workspaces:[{id:ws,name:'Personal'}],tabs:[],closedTabs:[],activeTab:null,chats:[],chatId:null,view:'split',deepseekModel:'deepseek-flash',codexDefault:null});if(config.safe){this.state.tabs=[];this.state.closedTabs=[];this.state.activeTab=null;}for(const t of this.state.tabs){t.granted=false;t.loading=false;}this.codex=new Codex(sourceRoot,data);this.checkpoints=new Checkpoints(data);this.lastHealth=[];this.dshReady=false;}
 changed(){if(this.saveTimer)return;this.saveTimer=setTimeout(()=>{this.saveTimer=null;save(this.stateFile,this.state);if(this.win&&!this.win.isDestroyed())this.win.webContents.send('rc:changed');},120);}
 async start(){
  app.dock?.setIcon(path.join(sourceRoot,'assets/NODO.iconset/icon_256x256@2x.png'));
  app.setAboutPanelOptions({applicationName:config.name,applicationVersion:config.version,version:'1'});
  this.win=new BrowserWindow({width:1460,height:940,minWidth:1080,minHeight:700,title:config.name,backgroundColor:'#10141b',webPreferences:{preload:path.join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true}});
  this.win.on('close',event=>{if(!this.stopped){event.preventDefault();app.quit();}});
  this.win.webContents.on('page-title-updated',e=>{e.preventDefault();this.win.setTitle(config.name);});
  this.usage=new UsageLedger(data);
  const {safeStorage,powerSaveBlocker}=require('electron');
  this.features=new (require('./lib/feature-settings.cjs').FeatureSettings)({root:sourceRoot,data,version:config.version,safeStorage,power:powerSaveBlocker,call:(method,params)=>this.dsh('remote.call',{method,params}),onChange:()=>this.changed()});
  void this.features.start();
  this.win.webContents.on('render-process-gone',(_e,d)=>status('failed',{error:'renderer:'+d.reason}));
  this.win.webContents.on('before-mouse-event',(_e,input)=>{if(input.type==='mouseDown')this.browser?.chatIntent();});
  this.win.webContents.setWindowOpenHandler(()=>({action:'deny'}));this.win.webContents.on('will-navigate',e=>e.preventDefault());
  this.browser=new Browser(this.win,this.state,sourceRoot,()=>this.changed());this.tasks=new Tasks(this);
  this.harnessGuard=require('./lib/harness-guard.cjs').install(this.win,this.browser,config.ports.dsh,path.join(__dirname,'ui/index.html'));
  ipcMain.handle('rc:call',async(event,method,params)=>{if(event.sender!==this.win.webContents||event.senderFrame!==this.win.webContents.mainFrame||!this.harnessGuard.trusted(event.senderFrame.url))throw Error('Untrusted sender');return this.dispatch(method,params||{},true);});
  const uiFile=path.join(data,'imported-ui.json'),uiMarker=path.join(data,'ui-imported.json');
  ipcMain.on('rc:initial-ui',event=>{if(event.sender!==this.win.webContents||event.senderFrame?.parent!==null||!fs.existsSync(uiFile)){event.returnValue=null;return;}const raw=fs.readFileSync(uiFile),hash=createHash('sha256').update(raw).digest('hex');event.returnValue=read(uiMarker,{})?.hash!==hash?{hash,prefs:JSON.parse(raw)}:null;});
  ipcMain.on('rc:ui-imported',(event,hash)=>{if(event.sender!==this.win.webContents||event.senderFrame?.parent!==null)return;const expected=createHash('sha256').update(fs.readFileSync(uiFile)).digest('hex');if(hash===expected)save(uiMarker,{at:new Date().toISOString(),hash});});
  this.server=serve(this.appSocket,(m,p)=>this.dispatch(m,p,false));
  this.testServer=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><title>RC Test Page</title><h1>RC browser workspace</h1><p id="result">Agent isolation verified. Code: HARNESS-RC-42</p><label>Name <input id="name"></label><button id="check" onclick="document.getElementById(\'result\').textContent=\'Clicked successfully\'">Check</button>');});this.testServer.on('error',e=>{this.testServerError=e.message;});this.testServer.listen(config.ports.test,'127.0.0.1');
  Menu.setApplicationMenu(Menu.buildFromTemplate([{label:'NODO',submenu:[{label:'About NODO',click:()=>{const about=new BrowserWindow({parent:this.win,modal:true,width:300,height:150,resizable:false,minimizable:false,maximizable:false,title:'About NODO',backgroundColor:'#1b1b1b',webPreferences:{sandbox:true,nodeIntegration:false,contextIsolation:true}});about.setMenu(null);about.loadFile(path.join(__dirname,'ui/about.html'));}},{type:'separator'},{role:'quit'}]},{label:'Edit',submenu:[{role:'undo'},{role:'redo'},{type:'separator'},{role:'cut'},{role:'copy'},{role:'paste'},{role:'selectAll'}]},{label:'View',submenu:[{role:'resetZoom'},{role:'zoomIn'},{role:'zoomOut'}]},{label:'Window',submenu:[{role:'minimize'},{role:'zoom'}]}]));
  if(!this.state.chats.length)this.newChat();await this.win.loadFile(path.join(__dirname,'ui/index.html'));
  if(process.env.NODO_BRAND_SMOKE==='1'){const shot=await this.win.webContents.capturePage();fs.writeFileSync(path.join(sourceRoot,'evidence/nodo-splash.png'),shot.toPNG());}
  this.browser.layout({x:0,y:0,width:0,height:0},false);
  if(!config.safe)this.codex.start().then(()=>this.changed()).catch(e=>{this.codex.lastError=e.message;this.changed();});
  this.startDeepSeek().then(async()=>{const log=fs.readFileSync(path.join(data,'dsh.log'),'utf8');const url=log.match(new RegExp('http://127\\.0\\.0\\.1:'+config.ports.dsh+'/\\?token=[A-Za-z0-9_-]+','g'))?.at(-1);if(!url)throw Error('Dev Harness login URL missing');await this.win.loadURL(url);status('ready');this.balance.start();void this.recordHealthyStartup();}).catch(e=>{this.dshError=e.message;status('failed',{error:e.code||e.name});this.changed();});
  save(path.join(data,'instance.json'),{pid:process.pid,appSocket:this.appSocket,dshSocket:this.dshSocket,started:new Date(this.started).toISOString(),sourceRoot,ports:config.ports,dataPath:data});this.startupMs=Date.now()-this.started;
 }
 async recordHealthyStartup(){if(config.isolated)return;for(let i=0;i<30&&!this.stopped;i++){try{const s=await this.dsh('lifecycle.status');if(this.codex.ready&&s.services.every(v=>!v.missing&&!v.paused)){save(path.join(os.homedir(),'Library/Application Support/NODO Rescue/last-known-good.json'),{app:path.resolve(sourceRoot,'../../..'),verifiedAt:new Date().toISOString(),version:config.version,verification:'DSH, Codex, bridge and observer ready'});return;}}catch{}await new Promise(r=>setTimeout(r,1000));}status('degraded',{error:'SERVICE_HEALTH_UNCONFIRMED'});}
 async getKey(){return await new Promise((resolve,reject)=>execFile('/usr/bin/security',['find-generic-password','-s','codex-deepseek-api-key','-a','deepseek','-w'],{timeout:15000},(e,out)=>{if(!e)return resolve(out.trim());const failure=Error('DeepSeek key unavailable from existing Keychain item');failure.code=e.code===44?'NODO_KEY_MISSING':'NODO_KEY_UNAVAILABLE';reject(failure);}));}
 async startDeepSeek(){
  let key;try{key=await this.getKey();}catch(error){if(error.code!=='NODO_KEY_MISSING')throw error;}
  const env={...process.env,DSH_HOME:path.join(data,'dsh'),DSH_TELEMETRY_DISABLED:'1',NODO_OPTIONAL_SERVICES:JSON.stringify(config.requiredServices||[]),DEEPSEEK_API_KEY:key,RC_PLUGIN_PATH:path.join(sourceRoot,'dsh-plugin.mjs'),RC_DSH_SOCKET:this.dshSocket,RC_APP_SOCKET:this.appSocket,RC_WORKSPACE:this.workspace,TMPDIR:this.temp,NODO_ISOLATED:config.isolated?'1':'0',DSH_PERMISSION_MODE:config.isolated?'workspace-write':undefined,NODO_OUTER_SANDBOX:config.isolated?'1':'0',PATH:path.join(sourceRoot,'runtime')+':/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin'};
  delete env.OPENAI_API_KEY;delete env.DSH_WEB_URL;
  const log=fs.openSync(path.join(data,'dsh.log'),'a',0o600);const launch=sandboxArgs(config,config.node,[path.join(sourceRoot,'runtime/node_modules/@deepseek-ai/dsh/lib/bin.js'),'--profile','web','--patch',overlay,'--host','127.0.0.1','--port',String(config.ports.dsh),'--no-open']);this.dshChild=spawn(launch.bin,launch.args,{cwd:this.workspace,env,stdio:['ignore',log,log]});fs.closeSync(log);
  this.dshChild.on('error',e=>{this.dshError=e.message;this.dshReady=false;this.changed();});this.dshChild.on('exit',code=>{this.dshReady=false;this.dshError='Harness server exited: '+code;if(!this.stopping)status('failed',{error:'DSH_EXIT_'+code});this.changed();});
  for(let i=0;i<30;i++){try{await this.dsh('health');this.dshReady=true;this.dshError=null;this.changed();return;}catch{}await new Promise(r=>setTimeout(r,500));}throw Error('Dev Harness did not become ready. See dsh.log');
 }
 dsh(method,p={}){return rpc(this.dshSocket,method,p,30000);}
 newChat(){const chat={id:randomUUID(),title:'New conversation',agent:'DeepSeek',messages:[],workspaceId:this.state.workspaceId,codexChoice:null};this.state.chats.unshift(chat);this.state.chatId=chat.id;this.changed();return chat;}
 files(){const walk=(dir,prefix='')=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(d=>d.isSymbolicLink()?[]:d.isDirectory()?walk(path.join(dir,d.name),prefix+d.name+'/'):[prefix+d.name]);return walk(this.workspace).slice(0,500);}
 snapshot(){return{...this.state,appName:config.name,isolated:config.isolated,balance:this.balance.snapshot(),usage:this.usage.snapshot(),tasks:this.tasks.items.map(({timer,approval,...t})=>({...t,...approval?{approval:{method:approval.method,params:approval.params}}:{}})),codex:this.codex.status(),dsh:{ready:this.dshReady,error:this.dshError,lastSuccess:this.deepseekLastSuccess},workspace:this.workspace,startupMs:this.startupMs,health:this.lastHealth,checkpoints:this.checkpoints.list()};}
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
  if(method==='features.status'||method.startsWith('remote.')||method.startsWith('updates.')){if(!user)throw Error('NODO settings require the local interface');return this.features.dispatch(method,p);}
  if(method==='lifecycle.status')return {protocol:1,pid:process.pid,codexReady:this.codex.ready,dshReady:this.dshReady,tasks:this.tasks.items.filter(t=>['Running','Queued','Waiting','Pending','Starting'].includes(t.status)).length,...await this.dsh('lifecycle.status')};
  if(method==='lifecycle.pause'){this.updatePaused=true;try{if(this.tasks.items.some(t=>['Running','Queued','Waiting','Pending','Starting'].includes(t.status)))throw Error('Tasks are not idle');const s=await rpc(this.dshSocket,'lifecycle.pause',{},60000);save(this.stateFile,this.state);return s;}catch(e){throw Error('Shutdown blocked: '+e.message);}}
  if(method==='lifecycle.resume'){const s=await this.dsh('lifecycle.resume');this.updatePaused=false;return s;}
  if(method==='lifecycle.quit'){if(!this.updatePaused)throw Error('Pause/drain is required');quitControl.request('updater');return {accepted:true};}
  if(this.updatePaused&&['chat.send','tasks.start','tasks.delegate','native.track'].includes(method))throw Error('NODO is paused for update');
  const localOnly=new Set(['browser.action','layout','workspace.create','workspace.select','chat.new','chat.select','chat.switch','chat.send','codex.login','codex.refresh','codex.select','tasks.start','tasks.cancel','tasks.deny','checkpoint.create','checkpoint.restore','view','open.workspace','native.bind','native.track']);
  if(!user&&localOnly.has(method))throw Error('This action requires the RC user interface');
  switch(method){
   case'state':return this.snapshot();
   case'health':return this.health();
   case'balance.refresh':return this.balance.refresh();
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
   case'chat.switch':{const chat=this.state.chats.find(c=>c.id===this.state.chatId);if(!['DeepSeek','Codex'].includes(p.agent))throw Error('Invalid agent');chat.handoffPending=p.consumeHandoff?false:chat.agent!==p.agent;chat.agent=p.agent;this.changed();return this.tasks.handoff(chat,'Continue current task');}
   case'chat.send':{const chat=this.state.chats.find(c=>c.id===this.state.chatId);if(this.tasks.items.some(t=>t.chatId===chat.id&&!t.delegated&&t.status==='Running'))throw Error('This conversation is running. Stop it or create another chat.');const prepared=await this.attachmentInput(p,chat);const t=await this.tasks.start({...p,...prepared,chatId:chat.id,agent:chat.agent,handoff:chat.handoffPending});chat.handoffPending=false;if(chat.title==='New conversation')chat.title=p.text.slice(0,45);this.changed();return{...t,timer:undefined};}
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
 async hasActiveTasks(){const local=this.tasks?.items.some(t=>['Running','Queued','Waiting','Pending','Starting'].includes(t.status))||false;if(!this.dshChild||this.dshChild.exitCode!==null)return local;const lifecycle=await this.dsh('lifecycle.status');return local||lifecycle.activeTurns>0;}
 async cancelActiveTasks(){if(this.dshChild?.exitCode===null)await this.dsh('lifecycle.prepareQuit');const active=this.tasks.items.filter(t=>['Running','Queued','Waiting','Pending','Starting'].includes(t.status)&&t.agent==='Codex');for(const t of active){if(!t.threadId||!t.turnId)throw Error('Задача ещё запускается - безопасная отмена пока недоступна');await this.tasks.cancel(t.id);}if(this.dshChild?.exitCode===null)await this.dsh('lifecycle.cancel');const until=Date.now()+15000;while(await this.hasActiveTasks()){if(Date.now()>=until)throw Error('Отмена задачи не подтвердилась за 15 секунд');await new Promise(resolve=>setTimeout(resolve,250));}}
 async resumeAfterFailedQuit(){if(!this.stopped&&this.dshChild?.exitCode===null){this.stopping=false;await this.dispatch('lifecycle.resume',{},false);await this.features?.start();}}
 async stopGracefully(reason='user'){if(this.stopPromise)return this.stopPromise;this.stopPromise=(async()=>{this.shutdownReason=reason;this.stopping=true;await this.features?.stop();if(this.dshChild?.exitCode===null)await this.dispatch('lifecycle.pause',{},false);if(this.saveTimer)clearTimeout(this.saveTimer);save(this.stateFile,this.state);this.balance.stop();const children=[this.dshChild,this.codex.child].filter(c=>c&&c.exitCode===null);await Promise.all(children.map(child=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('A child has not exited; no force kill was used')),30000);child.once('exit',()=>{clearTimeout(timer);resolve();});child.kill('SIGTERM');})));this.browser?.dispose();this.server?.close();this.testServer?.close();this.stopped=true;status('stopped',{reason});})().catch(e=>{this.stopPromise=null;throw e;});return this.stopPromise;}
}
