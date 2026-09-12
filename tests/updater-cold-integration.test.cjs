const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto'),zlib=require('node:zlib');
const {rpc}=require('../lib/io.cjs');
const project=path.resolve(__dirname,'..');
const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
function put(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value));}
function inventory(root,ignored=[]){const files={},symlinks={};function walk(dir){for(const name of fs.readdirSync(dir)){const file=path.join(dir,name),rel=path.relative(root,file);if(ignored.some(x=>rel===x||rel.startsWith(x+'/')))continue;const s=fs.lstatSync(file);if(s.isSymbolicLink())symlinks[rel]=fs.readlinkSync(file);else if(s.isDirectory())walk(file);else files[rel]=hash(file);}}walk(root);return{files,symlinks,ignored};}
test('cold full installer encrypts, starts, validates, migrates watchdog, and rolls back code preserving new chats',{timeout:180000},async()=>{
 const root=fs.mkdtempSync('/private/tmp/nodo-e2e-'),home=path.join(root,'h'),data=path.join(home,'Library/Application Support/NODO'),bridge=path.join(home,'.dsh/plugins/telegram-bridge'),target=path.join(home,'Applications/NODO.app'),release=path.join(root,'release'),base=path.join(home,'Library/Application Support/NODO Rescue');
 const env={...process.env,HOME:home,NODO_TEST_HOME:home,NODE_OPTIONS:'--require '+path.join(__dirname,'updater-launchctl-preload.cjs')};
 let ownedPID=null;
 function command(bin,args,timeout=45000){const r=cp.spawnSync(bin,args,{encoding:'utf8',timeout,env});assert.equal(r.status,0,(r.stdout||'')+(r.stderr||''));return r.stdout;}
 const sleep=ms=>new Promise(r=>setTimeout(r,ms));
 async function stopOwned(){const i=JSON.parse(fs.readFileSync(path.join(data,'instance.json')));ownedPID=i.pid;await rpc(i.appSocket,'lifecycle.quit',{},3000);for(let n=0;n<100;n++){try{process.kill(i.pid,0);}catch{ownedPID=null;return;}await sleep(50);}throw Error('Owned fixture did not exit');}
 try{
  fs.mkdirSync(home,{recursive:true});
  fs.copyFileSync(path.join(project,'rescue/Rescue.swift'),path.join(root,'main.swift'));
  const rescue=path.join(root,'RescueTest');
  command('/usr/bin/swiftc',['-D','NODO_UPDATER_TESTING','-D','NODO_BACKUP_TESTING','-module-cache-path',path.join(root,'modules'),path.join(root,'main.swift'),...['UpdateLifecycle.swift','BackupScope.swift','UserBackup.swift'].map(x=>path.join(project,'rescue',x)),path.join(__dirname,'updater-test-support.swift'),'-o',rescue]);
  const fixture=path.join(root,'fixture');command('/usr/bin/clang',[path.join(__dirname,'updater-fixture-main.c'),'-o',fixture]);
  function makeApp(app,version){
   put(path.join(app,'Contents/Info.plist'),'<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleExecutable</key><string>NODO</string><key>CFBundleIdentifier</key><string>local.nodo.synthetic.e2e</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>');
   fs.mkdirSync(path.join(app,'Contents/MacOS'),{recursive:true});fs.copyFileSync(fixture,path.join(app,'Contents/MacOS/NODO'));fs.chmodSync(path.join(app,'Contents/MacOS/NODO'),0o755);
   const p=path.join(app,'Contents/Resources/project');
   for(const file of ['scripts/update-preflight.cjs','scripts/start-current-nodo.command','scripts/vk-factoscope-runner.sh','lib/io.cjs','lib/cold-preflight.cjs','lib/bridge-watch-scope.cjs','runtime/node']){fs.mkdirSync(path.dirname(path.join(p,file)),{recursive:true});fs.copyFileSync(path.join(project,file),path.join(p,file));}
   fs.cpSync(path.join(project,'runtime/node-libs'),path.join(p,'runtime/node-libs'),{recursive:true});
   fs.copyFileSync(path.join(__dirname,'updater-fixture-server.cjs'),path.join(p,'fixture-server.cjs'));put(path.join(p,'version'),version);put(path.join(p,'build-info.json'),{synthetic:true});
   command('/usr/bin/codesign',['--force','--deep','--sign','-',app]);
   const ignored=['Contents/Resources/nodo-manifest.json','Contents/_CodeSignature','Contents/MacOS/NODO'];
   put(path.join(app,'Contents/Resources/nodo-manifest.json'),{schema:2,signatureRequired:true,...inventory(app,ignored)});
   command('/usr/bin/codesign',['--force','--sign','-',app]);
  }
  makeApp(target,'OLD');makeApp(path.join(release,'NODO.app'),'NEW');
  put(path.join(data,'workstation.json'),{chats:[{deepseekId:'synthetic-old'}],workspaces:[{id:'bw'}],tabs:[{id:'tab'}]});
  put(path.join(data,'tasks.json'),[{id:'task',status:'Done'}]);put(path.join(data,'dsh/storages/workspace.json'),{tables:{workspaces:{workspace:{}}}});
  put(path.join(data,'dsh/settings.yaml'),'agent-default-model:\n  model: deepseek-flash\n  reasoningEffort: low\n');
  put(path.join(data,'dsh/profiles/web/cordis.patch.yml'),'thresholdRatio: 0.20\nretainTokens: 50000\nthresholds: [2, 4, 6]\n');
  put(path.join(data,'dsh/sessions/synthetic/session.zstd'),zlib.zstdCompressSync(Buffer.from('{"type":"turn/start"}\n{"type":"turn/end"}\n')));
  put(path.join(data,'dsh/attachments/synthetic.txt'),'SYNTHETIC_ATTACHMENT');put(path.join(data,'checkpoints/one.json'),'{}');
  for(const [name,value] of Object.entries({'state.json':{pending:[],cursor:1},'chat-sessions.json':{synthetic:{session:'synthetic-old'}},'allowed-chats.json':[],'bridge-config.json':{},'watch-config.json':{telegram:false}}))put(path.join(bridge,name),value);
  put(path.join(bridge,'send-ledger.jsonl'),' {"state":"unknown","key":"SYNTHETIC_UNKNOWN_DO_NOT_RETRY"}\n');
  const independent=['.dsh/plugins/telegram-bridge/lead-state.json','.dsh/plugins/telegram-bridge/lead-session/work.session','.dsh/plugins/telegram-bridge/lead-watch.log','.dsh/plugins/telegram-bridge/watch.json','Documents/ChatGPT/NODO Workspace/.private/deployment-v13/state.sqlite','Documents/ChatGPT/NODO Workspace/.private/journal-bridge-v1/raw-journal/mock.enc','Library/Application Support/nodo-optionalOrderInbox/receiver-health.json'];
  for(const file of independent)put(path.join(home,file),'SYNTHETIC_INDEPENDENT_UNCHANGED');
  const saved=Object.fromEntries([...Object.keys(inventory(data).files).map(x=>path.join(data,x)),...['state.json','chat-sessions.json','allowed-chats.json','bridge-config.json','send-ledger.jsonl'].map(x=>path.join(bridge,x)),...independent.map(x=>path.join(home,x))].map(x=>[x,hash(x)]));
  const plist=path.join(home,'Library/LaunchAgents/com.nodo-optional.dsh-watchdog.plist');
  put(plist,{Label:'com.nodo-optional.dsh-watchdog',ProgramArguments:['/synthetic/python','/synthetic/watchdog.py'],StartInterval:20,EnvironmentVariables:{DSH_BRIDGE_RESTART:'/synthetic/old/restart-nodo.sh'}});command('/usr/bin/plutil',['-convert','xml1',plist]);put(path.join(home,'mock-watchdog.json'),{loaded:true});
  const factoplist=path.join(home,'Library/LaunchAgents/com.nodo-optional.vk-factoscope.plist'),calendar=[{Hour:(new Date().getHours()+12)%24,Minute:0}];
  put(factoplist,{Label:'com.nodo-optional.vk-factoscope',ProgramArguments:['/bin/bash','/synthetic/old/vk-factoscope.sh'],RunAtLoad:false,StartCalendarInterval:calendar});command('/usr/bin/plutil',['-convert','xml1',factoplist]);put(path.join(home,'mock-factoscope.json'),{loaded:true});
  const updateKind=process.env.NODO_TEST_UPDATE_KIND==='patch'?'patch':'migration';
  put(path.join(release,'update.json'),{kind:updateKind,testOnly:false,targetApp:target,dataPath:data,sourceApp:target,backupKeyAccount:crypto.randomUUID(),baseline:[{root:target,...inventory(target)}]});
  command(rescue,['install',release],75000);
  const proof=JSON.parse(fs.readFileSync(path.join(home,'fixture-start-proof.json')));ownedPID=proof.parentPID;assert.equal(proof.version,'NEW');assert.equal(proof.encryptedBackupExisted,updateKind==='migration');
  const txn=path.join(base,'transactions',fs.readdirSync(path.join(base,'transactions'))[0]);assert.equal(JSON.parse(fs.readFileSync(path.join(txn,'result.json'))).phase,'verified');
  if(updateKind==='migration')assert.equal(JSON.parse(fs.readFileSync(path.join(txn,'backup-receipt.json'))).verified,true);else assert.equal(fs.existsSync(path.join(txn,'user-backup')),false,'Patch must not copy user profile');
  for(const [file,sha] of Object.entries(saved))assert.equal(hash(file),sha,file);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home,'mock-watchdog.json'))).loaded,true);
  const migrated=JSON.parse(command('/usr/bin/plutil',['-convert','json','-o','-',plist]));assert.equal(migrated.EnvironmentVariables.DSH_BRIDGE_RESTART,path.join(target,'Contents/Resources/project/scripts/start-current-nodo.command'));
  const factoMigrated=JSON.parse(command('/usr/bin/plutil',['-convert','json','-o','-',factoplist]));assert.deepEqual(factoMigrated.ProgramArguments,['/bin/bash',path.join(target,'Contents/Resources/project/scripts/vk-factoscope-runner.sh')]);assert.deepEqual(factoMigrated.StartCalendarInterval,calendar);assert.equal(factoMigrated.RunAtLoad,false);assert.equal(JSON.parse(fs.readFileSync(path.join(home,'mock-factoscope.json'))).loaded,true);
  put(path.join(data,'dsh/sessions/post-update/session.zstd'),zlib.zstdCompressSync(Buffer.from('{"type":"turn/start"}\n{"type":"turn/end"}\n')));
  const post=path.join(data,'dsh/attachments/post-update.txt');put(post,'SYNTHETIC_NEW_AFTER_UPDATE');const postHash=hash(post);
  await stopOwned();command(rescue,['rollback',base]);assert.equal(fs.readFileSync(path.join(target,'Contents/Resources/project/version'),'utf8'),'OLD');
  assert.equal(hash(post),postHash);assert(fs.existsSync(path.join(data,'dsh/sessions/post-update/session.zstd')));
  for(const [file,sha] of Object.entries(saved))assert.equal(hash(file),sha,file);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home,'mock-watchdog.json'))).loaded,true);
  const calls=fs.readFileSync(path.join(home,'mock-watchdog-calls.jsonl'),'utf8').trim().split('\n').map(JSON.parse);assert(calls.some(x=>x[0]==='bootout'));assert(calls.some(x=>x[0]==='bootstrap'));assert(calls.every(x=>!['enable','disable'].includes(x[0])));
  // Exercise the newly added automatic recovery branch using the same profile.
  // makeApp re-signs code and refreshes the payload's integrity manifest.
  makeApp(path.join(release,'NODO.app'),'BROKEN');
  const cfg=JSON.parse(fs.readFileSync(path.join(release,'update.json')));cfg.baseline=[{root:target,...inventory(target)}];put(path.join(release,'update.json'),cfg);
  const broken=cp.spawnSync(rescue,['install',release],{encoding:'utf8',timeout:75000,env});
  assert.notEqual(broken.status,0,'broken startup must not be reported successful');
  assert.match(broken.stderr,/previous.*restored|restored.*previous/i);
  const recoveredProof=JSON.parse(fs.readFileSync(path.join(home,'fixture-start-proof.json')));ownedPID=recoveredProof.parentPID;
  assert.equal(recoveredProof.version,'OLD');assert.equal(recoveredProof.encryptedBackupExisted,updateKind==='migration');
  assert.equal(fs.readFileSync(path.join(target,'Contents/Resources/project/version'),'utf8'),'OLD');
  const recoveredInstance=JSON.parse(fs.readFileSync(path.join(data,'instance.json')));
  const recoveredStatus=await rpc(recoveredInstance.appSocket,'lifecycle.status',{},3000);
  assert.equal(recoveredStatus.dshReady,true);assert.equal(recoveredStatus.codexReady,true);
  assert.equal(hash(post),postHash);assert(fs.existsSync(path.join(data,'dsh/sessions/post-update/session.zstd')));
  for(const [file,sha] of Object.entries(saved))assert.equal(hash(file),sha,file);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home,'mock-watchdog.json'))).loaded,true);
  await stopOwned();
  const factoRecovered=JSON.parse(command('/usr/bin/plutil',['-convert','json','-o','-',factoplist]));assert.deepEqual(factoRecovered.StartCalendarInterval,calendar);assert.deepEqual(factoRecovered.ProgramArguments,factoMigrated.ProgramArguments);assert.equal(JSON.parse(fs.readFileSync(path.join(home,'mock-factoscope.json'))).loaded,true);
  const allCalls=fs.readFileSync(path.join(home,'mock-watchdog-calls.jsonl'),'utf8').trim().split('\n').map(JSON.parse);for(const label of ['com.nodo-optional.dsh-watchdog','com.nodo-optional.vk-factoscope']){assert(allCalls.some(x=>x[0]==='bootout'&&x[1].endsWith('/'+label)));assert(allCalls.some(x=>x[0]==='bootstrap'&&x[2].endsWith('/'+label+'.plist')));}assert(allCalls.every(x=>!['enable','disable'].includes(x[0])));
 }finally{
  if(ownedPID===null&&fs.existsSync(path.join(data,'instance.json'))){const i=JSON.parse(fs.readFileSync(path.join(data,'instance.json')));const p=cp.spawnSync('/bin/ps',['-p',String(i.pid),'-o','comm='],{encoding:'utf8'});if(p.stdout.trim()===path.join(target,'Contents/MacOS/NODO'))ownedPID=i.pid;}
  if(ownedPID!==null){try{await stopOwned();}catch{throw Error('Fixture cleanup did not finish; retaining '+root);}}
  fs.rmSync(root,{recursive:true,force:true});
 }
});
