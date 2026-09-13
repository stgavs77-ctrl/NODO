// A single offline Electron acceptance pass. Only a cloned vendor app is bootstrapped.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
if(!process.versions.electron){
 const {execFileSync,spawn}=require('node:child_process');
 const temp=fs.mkdtempSync(path.join(root,'../renderer-guard-')),copy=path.join(temp,'Guard Test.app');
 execFileSync('/bin/cp',['-cR',path.join(root,'vendor/Shell.app'),copy]);
 const resources=path.join(copy,'Contents/Resources');fs.unlinkSync(path.join(resources,'app.asar'));
 const boot=path.join(resources,'app');fs.mkdirSync(boot,{recursive:true});fs.writeFileSync(path.join(boot,'package.json'),JSON.stringify({name:'nodo-guard-test',version:'1.0.0',main:'index.cjs'}));fs.writeFileSync(path.join(boot,'index.cjs'),'require('+JSON.stringify(__filename)+');\n');
 execFileSync('/usr/bin/codesign',['--force','--deep','--sign','-',copy],{stdio:'pipe'});
 const env={...process.env,NODO_GUARD_FIXTURE_DIR:temp};delete env.ELECTRON_RUN_AS_NODE;delete env.NODE_OPTIONS;
 const child=spawn(path.join(copy,'Contents/MacOS/NODO'),[],{env,stdio:['ignore','pipe','pipe']});let output='',errors='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>errors+=b);const timer=setTimeout(()=>{child.kill('SIGTERM');console.error('FAIL renderer guard timeout');},45000);child.on('exit',code=>{clearTimeout(timer);const facts=output.split('\n').filter(l=>/^PASS |^FAIL /.test(l));console.log(facts.join('\n'));if(code!==0){console.error(errors.slice(-1800));process.exitCode=1;}});
}else{
 const {app,BrowserWindow,ipcMain}=require('electron'),http=require('node:http');
 const temp=process.env.NODO_GUARD_FIXTURE_DIR;if(!temp||!temp.startsWith(path.resolve(root,'..')+'/renderer-guard-'))throw Error('Fixture directory required');
 const data=path.join(temp,'profile');fs.mkdirSync(data);app.setPath('userData',data);app.setPath('sessionData',data);app.commandLine.appendSwitch('disable-background-networking');app.commandLine.appendSwitch('disable-component-update');
 const pause=ms=>new Promise(r=>setTimeout(r,ms));const listen=(server,port)=>new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});const fact=s=>console.log('PASS '+s);let trustedServer,externalServer,browser;
 app.whenReady().then(async()=>{
  ipcMain.on('rc:initial-ui',event=>event.returnValue=null);
  trustedServer=http.createServer((_q,r)=>{r.setHeader('Content-Type','text/html');r.end('<html><body><input id="composer"><div>TRUSTED HARNESS FIXTURE</div></body></html>');});await listen(trustedServer,4280);
  externalServer=http.createServer((_q,r)=>{r.setHeader('Content-Type','text/html');r.end('<html><body><input id="page-input"><div>EXTERNAL FIXTURE</div></body></html>');});await listen(externalServer,0);const externalURL='http://127.0.0.1:'+externalServer.address().port+'/';process.env.NODO_TEST_PORT=String(externalServer.address().port);
  const prefs={preload:path.join(root,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true};
  const win=new BrowserWindow({show:false,width:1100,height:800,webPreferences:{...prefs,partition:'guard-harness'}});const state={tabs:[],closedTabs:[],workspaceId:'test',workspaces:[{id:'test'}],activeTab:null,view:'split'};
  const {Browser}=require('../lib/browser.cjs');browser=new Browser(win,state,root,()=>{});const {install}=require('../lib/harness-guard.cjs');install(win,browser,4280,path.join(root,'ui/index.html'));
  await win.loadURL('http://127.0.0.1:4280/');assert.equal(await win.webContents.executeJavaScript('typeof window.rc.call'),'function');fact('trusted Harness exposes rc IPC');
  const untrusted=new BrowserWindow({show:false,webPreferences:{...prefs,partition:'guard-untrusted'}});await untrusted.loadURL(externalURL);assert.equal(await untrusted.webContents.executeJavaScript('typeof window.rc'),'undefined');fact('untrusted document with actual preload has no window.rc');
  win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('Page.navigate',{url:externalURL}).catch(()=>{});await pause(350);assert.match(win.webContents.getURL(),/^http:\/\/127\.0\.0\.1:4280\//);assert.equal(await win.webContents.executeJavaScript('typeof window.rc.call'),'function');fact('main CDP navigation blocked or recovered to Harness');win.webContents.debugger.detach();
  const tab=await browser.open(externalURL,'user','test'),view=browser.views.get(tab.id);assert.equal(view.webContents.getURL(),externalURL);assert.equal(await view.webContents.executeJavaScript('typeof window.rc'),'undefined');fact('actual Browser WebContentsView accepts page without privileged IPC');
  browser.layout({x:0,y:0,width:99999,height:99999},true);const bounds=view.getBounds(),content=win.getContentBounds();assert.ok(bounds.x>=320&&bounds.y>=88&&bounds.x+bounds.width<=content.width&&bounds.y+bounds.height<=content.height);fact('oversized browser layout preserves header/sidebar and stays in window');
  await view.webContents.executeJavaScript('document.querySelector("#page-input").value="keep-page-state"');view.webContents.sendInputEvent({type:'keyDown',keyCode:'H',modifiers:['control','shift']});await pause(150);assert.equal(browser.visible,false);assert.equal(state.view,'chat');assert.equal(view.webContents.getURL(),externalURL);assert.equal(await view.webContents.executeJavaScript('document.querySelector("#page-input").value'),'keep-page-state');fact('Ctrl Shift H hides only browser view and preserves page state');
  browser.layout({x:320,y:88,width:500,height:500},true);const crashed=new Promise(resolve=>view.webContents.once('render-process-gone',resolve));view.webContents.forcefullyCrashRenderer();await crashed;assert.equal(browser.visible,false);assert.equal(state.tabs.length,1);fact('browser renderer crash reveals Harness and preserves tab record');
  untrusted.destroy();browser.dispose();win.destroy();trustedServer.close();externalServer.close();app.exit(0);
 }).catch(error=>{console.error('FAIL '+error.stack);trustedServer?.close();externalServer?.close();app.exit(1);});
}
