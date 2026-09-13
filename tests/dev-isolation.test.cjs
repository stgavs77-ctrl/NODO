'use strict';
// DEV isolation: a DEV build owns its profile, its ports and its scope no matter
// what the process that started it exported. These are the practical rules the
// production-profile incident of 13.09.2026 broke.
const test=require('node:test'),assert=require('node:assert'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {environment,isolationViolations,scrubEnvironment,PRODUCTION,DEV}=require('../lib/environment.cjs');
const {FeatureSettings}=require('../lib/feature-settings.cjs');

const PROFILE=path.join(os.homedir(),'Library','Application Support','NODO');
function fakeBuild(mode){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'nodo-iso-'));
 fs.writeFileSync(path.join(root,'build-mode.json'),JSON.stringify({mode}));
 fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({version:'1.3.0'}));
 return root;
}
// What a shell inside a running production NODO hands down - the exact shape of
// the launch that clobbered the production profile.
const productionShell={
 NODO_DATA:PROFILE,NODO_PORT:'4180',NODO_CDP_PORT:'4182',NODO_TEST_PORT:'4183',
 TMPDIR:path.join(PROFILE,'tmp/nodo-1a2b3c'),
 RC_DSH_SOCKET:path.join(PROFILE,'dsh/dsh.sock'),RC_APP_SOCKET:path.join(PROFILE,'dsh/app.sock'),
 RC_WORKSPACE:path.join(PROFILE,'workspace'),RC_PLUGIN_PATH:path.join(PRODUCTION.app,'Contents/Resources/project/dsh-plugin.mjs'),
 DSH_HOME:path.join(PROFILE,'dsh'),DSH_WEB_URL:'http://127.0.0.1:4180/?token=x',DSH_SESSION_ID:'session-abc',
 PATH:'/usr/bin:/bin',HOME:os.homedir()
};

test('A. a DEV build ignores an inherited production profile and production ports',()=>{
 const c=environment(fakeBuild('dev'),['node'],productionShell);
 assert.equal(c.data,DEV.data,'DEV keeps its own profile');
 assert.deepEqual([c.ports.dsh,c.ports.cdp,c.ports.test],[4280,4282,4283],'DEV keeps its own ports');
 assert.equal(c.isolated,true);
 assert.equal(c.rescue,path.join(DEV.data,'rescue'),'even Rescue scope is DEV-local');
});

test('B. a release build still honours the updater test overrides',()=>{
 const scratch=path.join(os.tmpdir(),'nodo-release-profile');
 const c=environment(fakeBuild('release'),['node'],{NODO_DATA:scratch,NODO_PORT:'5180'});
 assert.equal(c.data,scratch);
 assert.equal(c.ports.dsh,5180,'the release e2e harness keeps its own ports');
 assert.equal(c.rescue,path.join(os.homedir(),'Library','Application Support','NODO Rescue'));
});

test('C. the guard names every way this process could reach production',()=>{
 const root=fakeBuild('dev');
 const c=environment(root,['node'],productionShell);
 const sites=isolationViolations(root,c,productionShell);
 assert.ok(sites.length>=6,'several production leaks are reported: '+sites.length);
 for(const needle of ['NODO_DATA','NODO_PORT','RC_DSH_SOCKET','RC_PLUGIN_PATH','DSH_HOME','TMPDIR'])
  assert.ok(sites.some(s=>s.startsWith(needle)),needle+' is reported');
 assert.ok(sites.some(s=>s.includes('production harness')),'the production web socket is reported');
});

test('C2. a clean environment and a release build raise nothing',()=>{
 const clean={PATH:'/usr/bin:/bin',HOME:os.homedir()};
 const dev=fakeBuild('dev');
 assert.deepEqual(isolationViolations(dev,environment(dev,['node'],clean),clean),[]);
 const rel=fakeBuild('release');
 const cfg=environment(rel,['node'],{...productionShell});
 assert.deepEqual(isolationViolations(rel,cfg,productionShell),[],'production is allowed to be production');
});

test('D. an isolated profile drops everything a parent exported',()=>{
 const kept=scrubEnvironment(productionShell);
 for(const key of ['NODO_DATA','NODO_PORT','RC_DSH_SOCKET','RC_APP_SOCKET','RC_WORKSPACE','RC_PLUGIN_PATH','DSH_HOME','DSH_WEB_URL','DSH_SESSION_ID'])assert.equal(key in kept,false,key+' is dropped');
 assert.equal('TMPDIR' in kept,false,'a production temporary directory is dropped');
 assert.equal(kept.PATH,productionShell.PATH,'unrelated variables survive');
 assert.equal(scrubEnvironment({TMPDIR:'/var/folders/xy/T',PATH:'/usr/bin'}).TMPDIR,'/var/folders/xy/T','the system temporary directory survives');
});

test('E. the guard runs before the first write in main.cjs',()=>{
 const source=fs.readFileSync(path.join(__dirname,'..','main.cjs'),'utf8');
 const guard=source.indexOf('process.exit(78)'),prepare=source.indexOf('prepare(sourceRoot,config)');
 assert.ok(guard>0&&prepare>0,'both the guard and the bootstrap exist');
 assert.ok(guard<prepare,'the refusal is evaluated before anything is created');
});

test('F. an isolated profile never installs an update',async()=>{
 const data=fs.mkdtempSync(path.join(os.tmpdir(),'nodo-iso-data-'));
 const settings=new FeatureSettings({root:fakeBuild('dev'),data,version:'1.3.0',isolated:true,safeStorage:{},power:{},call:async()=>{},onChange:()=>{}});
 await settings.start();
 await assert.rejects(settings.dispatch('updates.check',{}),/disabled in isolated/);
 await assert.rejects(settings.dispatch('updates.install',{}),/disabled in isolated/);
 await assert.rejects(settings.downloadUpdate(),/disabled in isolated/);
 const release=new FeatureSettings({root:fakeBuild('release'),data,version:'1.3.0',isolated:false,safeStorage:{},power:{},call:async()=>{},onChange:()=>{}});
 await assert.rejects(release.dispatch('updates.check',{}),/not configured/,'a release build reports its real configuration instead');
});
