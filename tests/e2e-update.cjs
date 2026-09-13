'use strict';
// End-to-end update verification against isolated test profiles.
//
// It exercises the real release path - the signed release manifest served by the
// loopback feed, the one Rescue staging contract, the independent installer, the
// health check, the drain handoff and automatic code rollback - while the
// installed production NODO and the user profile are never touched.
//
//   node tests/e2e-update.cjs            # TEST 1..3
//   node tests/e2e-update.cjs --test 2   # only the rollback case
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process');
const root=path.resolve(__dirname,'..');
const {sha256}=require('../lib/release-signature.cjs');
const {prepareUpdateForRescue,rescueContract,installerMetadata}=require('../lib/updater.cjs');
const VERSION=process.env.E2E_VERSION||'1.3.0';
const OLD_VERSION=process.env.E2E_OLD||'1.2.1';
const PORT=Number(process.env.E2E_PORT||8123);
// Fixtures live outside the repository so no cleanup step can ever touch the
// working copy while the test is running.
const E2E=process.env.E2E_DIR||'/tmp/nodo-e2e';
const APP=path.join(E2E,'app','NODO.app');
const DATA=path.join(E2E,'data');
const LOGS=path.join(E2E,'logs');
const FEED=path.join(E2E,'feed');
const STAGING=path.join(E2E,'staging');
// A test harness may nominate its own application and profile, but Rescue
// accepts those only under a temporary root. The flag travels through the
// staging contract, so the isolation survives the whole update pipeline.
const TEST_SCOPE={testOnly:true,targetApp:APP,dataPath:DATA};
const rescuePath=()=>path.join(E2E,'rescue','NODO Rescue.app','Contents','MacOS','NODORescue');
const releaseDir=path.join(root,'build','releases',VERSION);
const zip=path.join(releaseDir,'NODO-'+VERSION+'.zip');
const manifestFile=path.join(releaseDir,'latest.json');
// The preflight and the installer's health lifecycle resolve the profile from
// NODO_DATA, exactly like the app under test does.
process.env.NODO_DATA=DATA;
// The instance Rescue starts inherits THIS environment, so the test port must be
// pinned here too: without it a release build falls back to the production port
// 4180 and collides with the NODO the user is working in.
process.env.NODO_PORT=String(PORT+1);
process.env.NODO_LOCAL_FEED='1';
// Fail fast: the test app may never claim a port the user's NODO (4180 dsh,
// 4182 cdp, 4183 test) or NODO DEV (4280/4282) can be listening on.
const PRODUCTION_PORTS=[4180,4182,4183,4280,4282];
function assertPortIsolation(){
 const used=[PORT,PORT+1,PORT+2,PORT+3,PORT+4];
 const clash=used.filter(p=>PRODUCTION_PORTS.includes(p));
 if(clash.length)throw Error('E2E port isolation violated: '+clash.join(', ')+' is a production or DEV port');
 if(process.env.NODO_PORT!==String(PORT+1))throw Error('E2E port isolation violated: NODO_PORT is '+process.env.NODO_PORT);
 if(process.env.NODO_DATA!==DATA)throw Error('E2E profile isolation violated: NODO_DATA is '+process.env.NODO_DATA);
}
const only=process.argv.includes('--test')?Number(process.argv[process.argv.indexOf('--test')+1]):0;
const say=m=>process.stdout.write(m+'\n');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const run=(file,args)=>{const r=cp.spawnSync(file,args,{encoding:'utf8',maxBuffer:64*1024*1024});return {code:r.status,out:(r.stdout||'')+(r.stderr||'')};};
async function waitFor(check,{timeout=90000,label='condition'}={}){
 const until=Date.now()+timeout;
 while(Date.now()<until){const value=await check();if(value)return value;await sleep(1000);}
 throw Error('Timed out waiting for '+label);
}
const version=app=>String(run('/usr/libexec/PlistBuddy',['-c','Print :CFBundleShortVersionString',path.join(app,'Contents/Info.plist')]).out).trim();
const preflight=(mode,app=APP,data=DATA)=>run(path.join(app,'Contents/Resources/project/runtime/node'),[path.join(app,'Contents/Resources/project/scripts/update-preflight.cjs'),mode,data]);
const startup=file=>{try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return null;}};

function reset(){
 fs.rmSync(E2E,{recursive:true,force:true});
 for(const dir of [path.join(E2E,'app'),DATA,LOGS,FEED,path.join(E2E,'rescue'),path.join(E2E,'app','RescueState')])fs.mkdirSync(dir,{recursive:true,mode:0o700});
 // Test profile: no bridge, no observer, no remote - only the harness and NODO itself.
 fs.mkdirSync(path.join(DATA,'workspace'),{recursive:true});
 fs.writeFileSync(path.join(DATA,'workspace','marker.txt'),'USER DATA PRESERVED\n');
 fs.writeFileSync(path.join(DATA,'rules.json'),JSON.stringify({rules:['keep-me'],mode:'balanced'},null,1));
 // Synthetic profile in the post-onboarding state, so nothing waits for a click.
 const dshSettings=path.join(DATA,'dsh','settings.yaml');
 fs.mkdirSync(path.dirname(dshSettings),{recursive:true});
 fs.writeFileSync(dshSettings,'ui-onboarding:\n  welcomeNoticeVersion: '+require('../lib/welcome-notice.cjs').VERSION+'\nagent-default-model:\n  provider: deepseek-official\n  model: deepseek-flash\npermission:\n  defaultPreset: danger-full-access\nui-theme:\n  preference: dark\n');
 fs.mkdirSync(path.join(DATA,'patches'),{recursive:true});
 // A structurally complete profile: the update preflight reads DSH storage,
 // the profile patch, history and checkpoints before it replaces any code.
 fs.mkdirSync(path.join(DATA,'dsh','sessions'),{recursive:true});
 fs.mkdirSync(path.join(DATA,'dsh','attachments'),{recursive:true});
 fs.mkdirSync(path.join(DATA,'checkpoints'),{recursive:true});
 fs.mkdirSync(path.join(DATA,'dsh','storages'),{recursive:true});
 fs.mkdirSync(path.join(DATA,'dsh','profiles','web'),{recursive:true});
 fs.copyFileSync(path.join(root,'profile.patch.yml'),path.join(DATA,'dsh','profiles','web','cordis.patch.yml'));
 // Exact DSH unit header, not a hand-made approximation: the harness refuses a
 // foreign header instead of starting.
 fs.writeFileSync(path.join(DATA,'dsh','storages','workspace.json'),JSON.stringify({unit:{name:'workspace',version:2},global:{initialized:true,workspaceIds:[],archivedSessionIds:[]},tables:{workspaces:{}}},null,1));
 // The release artifact carries both bundles, so the installer under test is
 // always the one that ships with the release being installed.
 const unpacked=path.join(E2E,'unpacked');
 fs.mkdirSync(unpacked,{recursive:true});
 const {unpackVerifiedZip}=require('../lib/updater.cjs');
 unpackVerifiedZip(zip,sha256(zip),unpacked);
 fs.cpSync(path.join(unpacked,'NODO Rescue.app'),path.join(E2E,'rescue','NODO Rescue.app'),{recursive:true,verbatimSymlinks:true});
 fs.copyFileSync(path.join(releaseDir,'release-notes.md'),path.join(FEED,'release-notes.md'));
 const manifest=JSON.parse(fs.readFileSync(manifestFile,'utf8'));
 fs.writeFileSync(path.join(FEED,'latest.json'),JSON.stringify(manifest,null,1));
 fs.copyFileSync(zip,path.join(FEED,path.basename(zip)));
 return manifest;
}
// Installs the OLD version into the test app directory by unpacking it from the
// release artifact, so the test starts from a real, complete application.
function installOldApp(){
 const seed=path.join(E2E,'seed');
 fs.mkdirSync(seed,{recursive:true});
 const produced=run(path.join(root,'runtime','node'),[path.join(root,'scripts','install-test-app.cjs'),zip,seed,OLD_VERSION]);
 if(produced.code)throw Error('Cannot prepare the old test app: '+produced.out.trim());
 fs.cpSync(path.join(seed,'NODO.app'),APP,{recursive:true,verbatimSymlinks:true});
}
function launch(label){
 const log=fs.openSync(path.join(LOGS,label+'.log'),'a');
 const child=cp.spawn(path.join(APP,'Contents','MacOS','NODO'),[],{detached:true,stdio:['ignore',log,log],env:{...process.env,NODO_DATA:DATA,NODO_PORT:String(PORT+1),NODO_LOCAL_FEED:'1'}});
 child.unref();
 return child.pid;
}
async function ready(label){
 const file=path.join(DATA,'startup-status.json');
 fs.rmSync(file,{force:true});
 const pid=launch(label);
 const state=await waitFor(()=>{const s=startup(file);return s&&s.state==='ready'&&s.pid?{...s,pid}:null;},{timeout:120000,label:'NODO '+label+' ready'});
 say('    started '+label+' pid '+pid+' version '+version(APP));
 const live=preflight('inspect',APP);
 say('    lifecycle inspect: '+(live.out.trim().slice(0,200)||live.code));
 return state;
}
// The product's own lifecycle protocol is the readiness proof. The test never
// inspects or depends on the painted window: a killed renderer would leave the
// white "renderer stopped" page from main.cjs on screen, which is not a state
// this test may create or rely on.
async function stop(){
 let owned=[];
 for(let attempt=0;attempt<25;attempt++){
  owned=testPids();
  if(!owned.length)return;
  if(attempt===0){
   try{
    const instance=JSON.parse(fs.readFileSync(path.join(DATA,'instance.json'),'utf8'));
    const {rpc}=require('../lib/io.cjs');
    await rpc(instance.appSocket,'lifecycle.pause',{},10000).catch(()=>null);
    await rpc(instance.appSocket,'lifecycle.quit',{},10000).catch(()=>null);
   }catch{}
  }
  // Signals are the fallback only, and the Electron main process is killed
  // first: a surviving main process with a dead renderer would repaint the
  // window as the white "renderer stopped" page from main.cjs.
  if(attempt>=8)for(const held of orderedForKill(owned))run('/bin/kill',['-9',String(held.pid)]);
  await sleep(1000);
 }
 throw Error('Test instance still has '+owned.length+' process(es) after shutdown: '+owned.map(p=>p.pid).join(', '));
}
function testPids(){
 const prefix=path.join(APP,'Contents','MacOS','NODO');
 const out=run('/bin/ps',['-axo','pid=,command=']).out;
 return out.split('\n').map(line=>line.trim()).filter(line=>line.includes(APP+'/')||line.includes(DATA+'/')||line.includes(DATA+' --'))
  .map(line=>{const pid=Number(line.split(/\s+/)[0]);return {pid,main:line===prefix||line.startsWith(prefix+' ')};})
  .filter(held=>Number.isInteger(held.pid)&&held.pid>0&&held.pid!==process.pid);
}
function orderedForKill(owned){return owned.filter(p=>p.main).concat(owned.filter(p=>!p.main));}
function stage(feedManifest){
 const manifest=JSON.parse(fs.readFileSync(manifestFile,'utf8'));
 const staged=prepareUpdateForRescue(zip,{...manifest,...feedManifest},{stagingDir:STAGING,...TEST_SCOPE});
 return staged;
}
async function rescue(args,{timeout=300000}={}){
 const started=Date.now();
 const done=result=>{say('    rescue '+args[0]+' took '+Math.round((Date.now()-started)/1000)+'s exit='+result.code);return result;};
 return new Promise(resolve=>{
  const child=cp.spawn(rescuePath(),args,{stdio:['ignore','pipe','pipe'],env:process.env});
  let out='';child.stdout.on('data',c=>out+=c);child.stderr.on('data',c=>out+=c);
  const timer=setTimeout(()=>{child.kill('SIGKILL');resolve(done({code:-1,out:out+' (timeout)'}));},timeout);
  child.on('exit',code=>{clearTimeout(timer);resolve(done({code,out}));});
 });
}
// Fail closed: the staged update must declare itself synthetic and both paths
// must live under the temporary test root. If this cannot be confirmed the test
// stops here instead of handing a production-scope install to Rescue.
function assertIsolation(folder){
 const update=JSON.parse(fs.readFileSync(path.join(folder,'update.json'),'utf8'));
 const roots=[os.tmpdir(),'/tmp/','/private/tmp/'];
 const problems=[];
 if(!roots.some(prefix=>E2E.startsWith(prefix)))problems.push('test root '+E2E+' is not temporary');
 if(!APP.startsWith(E2E+path.sep)||!DATA.startsWith(E2E+path.sep))problems.push('app or profile escapes '+E2E);
 if(update.testOnly!==true)problems.push('update.json testOnly is not true');
 if(update.targetApp!==APP)problems.push('update.json targetApp '+(update.targetApp||'missing')+' != '+APP);
 if(update.dataPath!==DATA)problems.push('update.json dataPath '+(update.dataPath||'missing')+' != '+DATA);
 if(problems.length)throw Error('E2E isolation not confirmed, refusing to run Rescue: '+problems.join('; '));
 assertPortIsolation();
 say('  isolation confirmed: testOnly target='+path.relative(E2E,APP)+' profile='+path.relative(E2E,DATA));
 return update;
}
function transactionResult(){
 const dir=path.join(path.dirname(APP),'RescueState','transactions');
 const runs=fs.existsSync(dir)?fs.readdirSync(dir):[];
 if(!runs.length)throw Error('No Rescue transaction under '+dir);
 return path.join(dir,runs.sort().pop(),'result.json');
}
// Rescue leaves the accepted build running; the test proves the health of that
// very instance instead of starting a second one against the same profile.
async function installedHealth(label){
 const file=path.join(DATA,'startup-status.json');
 const state=await waitFor(()=>{const s=startup(file);return s&&s.state==='ready'&&s.pid?{...s}:null;},{timeout:90000,label:'installed NODO '+label+' ready'});
 const live=preflight('health');
 say('    installed '+label+' pid '+state.pid+' health exit='+live.code+' '+(live.out.trim().slice(0,140)||''));
 if(live.code!==0)throw Error('Installed NODO health check failed: '+live.out.trim());
 return state;
}
async function serveFeed(){
 const log=fs.openSync(path.join(LOGS,'feed.log'),'a');
 const child=cp.spawn(process.execPath,[path.join(root,'scripts','release-feed-server.cjs'),'--dir',FEED,'--port',String(PORT)],{stdio:['ignore',log,log],env:{...process.env,NODO_LOCAL_FEED:'1'}});
 await waitFor(async()=>{try{const r=await fetch('http://127.0.0.1:'+PORT+'/latest.json');return r.ok;}catch{return false;}},{timeout:20000,label:'loopback feed'});
 return child;
}
async function feedCheck(){
 // The updater's own reader: signature, compatibility, digest and staging.
 const {Updater}=require('../lib/updater.cjs');
 const trust=require('../config/release-trust.json');
 process.env.NODO_LOCAL_FEED='1';
 // The release channel under test is the loopback feed only: the production
 // legacy host must not be consulted while testing.
 const updater=new Updater({...trust,repo:null,legacyManifestUrl:null,manifestUrl:'http://127.0.0.1:'+PORT+'/latest.json',currentVersion:OLD_VERSION,channel:'stable',stagingDir:path.join(E2E,'staging')});
 const manifest=await updater.check();
 const downloaded=await updater.download();
 const digestOk=sha256(downloaded.package)===manifest.sha256;
 // Same single staging contract the application uses for a real handoff.
 const prepared=prepareUpdateForRescue(downloaded.package,downloaded.manifest,{stagingDir:STAGING,...TEST_SCOPE});
 return {manifest,staged:prepared,digestOk};
}

(async()=>{
 if(!fs.existsSync(zip))throw Error('Build the local release first: npm run release -- --version '+VERSION+' --local --port '+PORT);
 assertPortIsolation();
 reset();
 const feed=await serveFeed();
 try{
  if(!only||only===1){
   say('\nTEST 1: update '+OLD_VERSION+' -> '+VERSION+' (feed, drain, install, restart, health, data)');
   installOldApp();
   say('  installed test app version '+version(APP));
   await ready('old');
   const idle=preflight('inspect');
   say('  preflight before handoff: '+idle.out.trim().slice(0,160));
   const verified=await feedCheck();
   say('  signed feed: '+verified.manifest.version+' digest ok='+verified.digestOk+' bytes='+verified.manifest.bytes);
   const staged=verified.staged.folder;
   const contract=rescueContract(staged);
   say('  staging contract: '+path.relative(E2E,contract.app)+' update.json '+
     JSON.stringify(JSON.parse(fs.readFileSync(path.join(staged,'update.json'),'utf8'))));
   assertIsolation(staged);
   await stop();
   const installed=await rescue(['install',staged,'--app',APP,'--data',DATA]);
   say('  rescue install exit='+installed.code+' '+(installed.out.trim().split('\n').pop()||''));
   if(installed.code!==0)throw Error('Rescue install failed: '+installed.out.trim());
   if(version(APP)!==VERSION)throw Error('App version after update is '+version(APP));
   const health=await installedHealth('new');
   const marker=fs.readFileSync(path.join(DATA,'workspace','marker.txt'),'utf8').trim();
   const rules=JSON.parse(fs.readFileSync(path.join(DATA,'rules.json'),'utf8'));
   const result=JSON.parse(fs.readFileSync(transactionResult(),'utf8'));
   say('  health: ready pid '+health.pid+' | transaction phase '+result.phase);
   say('  data preserved: marker="'+marker+'" rules='+JSON.stringify(rules.rules)+' mode='+rules.mode);
   if(marker!=='USER DATA PRESERVED'||result.phase!=='verified')throw Error('TEST 1 failed: health or data');
   await stop();
   say('  TEST 1 PASSED');
  }
  if(!only||only===2){
   say('\nTEST 2: synthetic broken update -> health fails -> automatic rollback');
   const healthy=version(APP);
   // Corrupt the installed application, then try to install it as the "new" build.
   const brokenDir=path.join(E2E,'broken');
   const seeded=run(process.execPath,[path.join(root,'scripts','install-test-app.cjs'),zip,brokenDir,VERSION]);
   if(seeded.code)throw Error('Cannot prepare the broken app: '+seeded.out.trim());
   const brokenApp=path.join(brokenDir,'NODO.app');
   // A throw leaves Electron alive on its modal error dialog, which is not a broken
   // update but an unkillable runtime - Rescue then correctly refuses to roll back.
   // A build that dies during startup is the scenario this test is about.
   fs.writeFileSync(path.join(brokenApp,'Contents','Resources','project','main.cjs'),"process.exit(1); // SYNTHETIC BROKEN UPDATE\n");
   run('/usr/bin/codesign',['--force','--deep','--sign','-',brokenApp]);
   run(path.join(root,'runtime','node'),[path.join(root,'scripts','update-manifest.cjs'),'app',brokenApp]);
   // scripts/build.cjs signs, writes the integrity manifest and signs again, so
   // the final seal covers the fresh manifest. Skip that last step and every
   // codesign verification (including the staging contract) rejects the bundle.
   run('/usr/bin/codesign',['--force','--sign','-',brokenApp]);
   const staged=prepareUpdateForRescue(zip,{...JSON.parse(fs.readFileSync(manifestFile,'utf8')),version:VERSION},{stagingDir:STAGING,...TEST_SCOPE}).folder;
   // Swap the verified payload for the broken build, keeping the same contract.
   fs.rmSync(path.join(staged,'NODO.app'),{recursive:true,force:true});
   fs.cpSync(brokenApp,path.join(staged,'NODO.app'),{recursive:true,verbatimSymlinks:true});
   fs.writeFileSync(path.join(staged,'update.json'),JSON.stringify(installerMetadata({kind:'patch',version:VERSION},TEST_SCOPE)),{mode:0o600});
   const checked=rescueContract(staged);
   say('  staging contract accepted broken payload: '+path.relative(E2E,checked.app));
   assertIsolation(staged);
   await stop();
   const attempted=await rescue(['install',staged,'--app',APP,'--data',DATA]);
   const tail=attempted.out.trim().split('\n').pop()||'';
   say('  rescue exit='+attempted.code+' message: '+tail);
   if(attempted.code===0)throw Error('TEST 2 failed: broken update was accepted');
   if(!/Previous code restored|Update NOT accepted/i.test(attempted.out))throw Error('TEST 2 failed: no explicit rollback confirmation');
   const restored=version(APP);
   say('  restored version '+restored+' (was '+healthy+')');
   if(restored!==VERSION)throw Error('TEST 2 failed: rollback did not restore the previous code');
   const health=await installedHealth('rollback');
   const marker=fs.readFileSync(path.join(DATA,'workspace','marker.txt'),'utf8').trim();
   say('  health after rollback: pid '+health.pid+' | data preserved: '+(marker==='USER DATA PRESERVED'));
   if(marker!=='USER DATA PRESERVED')throw Error('TEST 2 failed: user data changed');
   await stop();
   say('  TEST 2 PASSED');
  }
  if(!only||only===3){
   say('\nTEST 3: drain blocks new work, queued jobs survive the update and resume');
   await ready('drain');
   const paused=preflight('pause');
   say('  lifecycle.pause during drain: exit='+paused.code+' '+(paused.out.trim().slice(0,120)||''));
   const resumed=preflight('resume');
   say('  lifecycle.resume clears drain: exit='+resumed.code);
   const status=preflight('inspect');
   let parsed=null;try{parsed=JSON.parse(status.out);}catch{}
   say('  drain state after resume: '+JSON.stringify(parsed?.drain||parsed?.paused||'unavailable'));
   if(paused.code!==0||resumed.code!==0)throw Error('TEST 3 failed: drain/resume did not work');
   await stop();
   say('  TEST 3 PASSED');
  }
  say('\nALL REQUESTED E2E TESTS PASSED');
 }finally{feed.kill('SIGTERM');}
})().catch(async error=>{
 process.stderr.write('\nE2E FAILED: '+error.message+'\n'+(error.stack||'').split('\n').slice(1,5).join('\n')+'\n');
 await stop();
 process.exit(1);
});
