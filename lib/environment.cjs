const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
// Profiles, ports and the installed app are fixed facts of this machine, not
// preferences of the parent process: DEV owns them whatever it inherits.
const PROFILES=path.join(os.homedir(),'Library','Application Support');
const PRODUCTION={name:'NODO',data:path.join(PROFILES,'NODO'),port:4180,app:path.join(os.homedir(),'Applications','NODO.app')};
const DEV={name:'NODO DEV',data:path.join(PROFILES,'NODO DEV'),port:4280};
const SAFE={name:'NODO Safe Mode',data:path.join(PROFILES,'NODO Safe Mode'),port:4380};
// Exactly what a parent shell or a running production NODO can hand down. Inside
// an isolated profile none of it may survive: this list is what leaked the
// production profile into a DEV launch once.
const INHERITED=['NODO_DATA','NODO_PORT','NODO_SAFE_MODE','NODO_ISOLATED','NODO_OUTER_SANDBOX','NODO_OPTIONAL_SERVICES','NODO_CDP_PORT','NODO_TEST_PORT','RC_DSH_SOCKET','RC_APP_SOCKET','RC_WORKSPACE','RC_PLUGIN_PATH','DSH_HOME','DSH_WEB_URL','DSH_SESSION_ID'];
const canonical=p=>{try{return fs.realpathSync(p);}catch{return path.resolve(p);}};
const within=(child,parent)=>{const c=canonical(child),p=canonical(parent);return c===p||c.startsWith(p+path.sep);};
function environment(root,argv=process.argv,env=process.env){
 const mode=JSON.parse(fs.readFileSync(path.join(root,'build-mode.json'),'utf8')).mode;
 const safe=env.NODO_SAFE_MODE==='1'||argv.includes('--safe-mode');
 const dev=mode==='dev';const isolated=dev||safe;
 // DEV and Safe Mode never take a profile or a port from the environment. Only a
 // release build honours the overrides the updater end-to-end tests rely on.
 const data=dev?DEV.data:safe?SAFE.data:(typeof env.NODO_DATA==='string'&&path.isAbsolute(env.NODO_DATA)?env.NODO_DATA:PRODUCTION.data);
 const basePort=dev?DEV.port:safe?SAFE.port:(Number(env.NODO_PORT)||PRODUCTION.port);
 return {name:dev?DEV.name:safe?SAFE.name:PRODUCTION.name,data,dev,safe,isolated,
  rescue:isolated?path.join(data,'rescue'):path.join(PROFILES,'NODO Rescue'),
  ports:{dsh:basePort,cdp:basePort+2,test:basePort+3},
  version:JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version,node:path.join(root,'runtime/node')};
}
// Fail-closed preflight for a DEV build: every way this process could reach
// production is reported here, and main.cjs refuses to start on a non-empty list
// before it creates or writes anything.
function isolationViolations(root,c,env=process.env){
 if(!c.dev)return [];
 const sites=[];
 if(canonical(c.data)!==canonical(DEV.data))sites.push('profile resolved to '+c.data+' instead of '+DEV.data);
 else if(within(c.data,PRODUCTION.data))sites.push('profile resolves inside the production profile '+PRODUCTION.data);
 if(c.ports.dsh===PRODUCTION.port||c.ports.cdp===PRODUCTION.port+2||c.ports.test===PRODUCTION.port+3)sites.push('ports collide with production: '+[c.ports.dsh,c.ports.cdp,c.ports.test].join('/'));
 if(within(root,PRODUCTION.app))sites.push('running from inside the production app '+PRODUCTION.app);
 if(env.NODO_DATA&&within(env.NODO_DATA,PRODUCTION.data))sites.push('NODO_DATA inherited from production: '+env.NODO_DATA);
 if(env.NODO_PORT&&Number(env.NODO_PORT)===PRODUCTION.port)sites.push('NODO_PORT inherited from production: '+env.NODO_PORT);
 if(env.NODO_SAFE_MODE==='1')sites.push('NODO_SAFE_MODE inherited from another profile');
 if(env.DSH_WEB_URL&&env.DSH_WEB_URL.includes(':'+PRODUCTION.port))sites.push('DSH_WEB_URL points at the production harness: '+env.DSH_WEB_URL);
 for(const key of ['RC_DSH_SOCKET','RC_APP_SOCKET','RC_WORKSPACE','RC_PLUGIN_PATH','DSH_HOME','TMPDIR'])
  if(env[key]&&within(env[key],PRODUCTION.data))sites.push(key+' inherited from the production profile: '+env[key]);
 if(env.RC_PLUGIN_PATH&&within(env.RC_PLUGIN_PATH,PRODUCTION.app))sites.push('RC_PLUGIN_PATH points into the production app '+PRODUCTION.app);
 return sites;
}
// Isolated profiles hand nothing down: every inherited variable is dropped, so a
// child harness cannot open a production socket or resume a production session.
function scrubEnvironment(env=process.env){
 const out={...env};
 for(const key of INHERITED)delete out[key];
 // A temporary directory inside the production profile is how a DEV process
 // would still write into production state; the system temp is fine.
 if(out.TMPDIR&&within(out.TMPDIR,PRODUCTION.data))delete out.TMPDIR;
 return out;
}
function prepare(root,c){
 for(const p of ['workspace','tmp','checkpoints','codex','dsh/profiles/web'])fs.mkdirSync(path.join(c.data,p),{recursive:true,mode:0o700});
 const profile=path.join(c.data,'dsh/profiles/web');
 if(!fs.existsSync(path.join(profile,'package.json')))fs.writeFileSync(path.join(profile,'package.json'),JSON.stringify({name:'nodo-web',version:'1.0.0',private:true,type:'module',dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app'],patchReload:'startup'}}}));
 if(!fs.existsSync(path.join(profile,'cordis.patch.yml')))fs.copyFileSync(path.join(root,'profile.patch.yml'),path.join(profile,'cordis.patch.yml'));
 if(c.isolated){
  // Isolated profiles start past the first-run notice: the notice is a durable
  // acknowledgement the client writes into this same file, and a workspace is
  // already selected, so no synthetic session ever waits for a click.
  fs.writeFileSync(path.join(c.data,'dsh/settings.yaml'),'ui-onboarding:\n  welcomeNoticeVersion: '+require('./welcome-notice.cjs').VERSION+'\nagent-default-model:\n  provider: deepseek-official\n  model: deepseek-flash\n  reasoningEffort: low\npermission:\n  defaultPreset: workspace-write\nui-theme:\n  preference: dark\n');
  fs.writeFileSync(path.join(c.data,'dsh/AGENTS.md'),'Synthetic NODO verification workspace. No external messages or client data. Write only in this workspace. Do not read global journals or update memories.\n');
 }
 if(!fs.existsSync(path.join(c.data,'codex/config.toml')))fs.copyFileSync(path.join(root,'codex-config.toml'),path.join(c.data,'codex/config.toml'));
 // Last overlay remaps only our package to this release. User profile remains intact.
 const overlay=[{id:'rc-workstation',disabled:true},{insert:[{id:'nodo-release',name:path.join(root,'extension/index.mjs')}] }];
 c.requiredServices=[];
 if(!c.isolated){
  const patches=require(path.join(root,'runtime/node_modules/yaml')).parse(fs.readFileSync(path.join(profile,'cordis.patch.yml'),'utf8'));
  const entries=patches.flatMap(p=>[p,...(p.insert||[])]),options=id=>entries.find(p=>p.id===id&&p.name)?.config||{};
  const enabled=id=>entries.some(p=>p.id===id&&p.name&&p.disabled!==true)&&!patches.some(p=>p.id===id&&p.disabled===true);
  const adapters=[];
  if(enabled('telegram-bridge')){c.requiredServices.push('telegram-bridge');adapters.push({id:'nodo-telegram-bridge',name:path.join(root,'services/telegram-bridge-live.mjs'),config:{...options('telegram-bridge'),harnessHost:'127.0.0.1:'+c.ports.dsh}});}
  if(enabled('sessions-observer')){c.requiredServices.push('sessions-observer');adapters.push({id:'nodo-sessions-observer',name:path.join(root,'services/sessions-observer.mjs'),config:options('sessions-observer')});}
  overlay.push({id:'telegram-bridge',disabled:true},{id:'sessions-observer',disabled:true},...(adapters.length?[{insert:adapters}]:[]));
 }
 if(c.isolated)overlay.push({id:'telegram-bridge',disabled:true},{id:'sessions-observer',disabled:true},{id:'sandbox-policy',config:{mode:'workspace-write',workspaceRoot:path.join(c.data,'workspace')}},{id:'sandbox',config:{runnerCommand:[c.node,path.join(root,'scripts/outer-sandbox-runner.cjs')],runnerFailureSignatures:['NODO_OUTER_SANDBOX_FAILURE:']}});
 const f=path.join(c.data,'tmp/release-overlay.json');fs.writeFileSync(f,JSON.stringify(overlay));return f;
}
function sandboxArgs(c,bin,args){
 if(!c.isolated)return {bin,args};
 const q=s=>JSON.stringify(fs.realpathSync(s));
 const rules='(version 1)(allow default)(deny file-write*)(allow file-write* (subpath '+q(c.data)+') (literal "/dev/null") (literal "/dev/tty") (regex #"^/dev/ttys[0-9]+$"))';
 return {bin:'/usr/bin/sandbox-exec',args:['-p',rules,bin,...args]};
}
module.exports={environment,prepare,sandboxArgs,isolationViolations,scrubEnvironment,INHERITED,PRODUCTION,DEV,SAFE};
