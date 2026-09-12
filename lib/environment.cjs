const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
function environment(root,argv=process.argv){
 const mode=JSON.parse(fs.readFileSync(path.join(root,'build-mode.json'),'utf8')).mode;
 const safe=process.env.NODO_SAFE_MODE==='1'||argv.includes('--safe-mode');
 const dev=mode==='dev';const isolated=dev||safe;
 const name=safe?'NODO Safe Mode':dev?'NODO DEV':'NODO';
 const data=path.join(os.homedir(),'Library/Application Support',name);
 const port=safe?4380:dev?4280:4180;
 return {name,data,dev,safe,isolated,ports:{dsh:port,cdp:port+2,test:port+3},version:JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version,node:path.join(root,'runtime/node')};
}
function prepare(root,c){
 for(const p of ['workspace','tmp','checkpoints','codex','dsh/profiles/web'])fs.mkdirSync(path.join(c.data,p),{recursive:true,mode:0o700});
 const profile=path.join(c.data,'dsh/profiles/web');
 if(!fs.existsSync(path.join(profile,'package.json')))fs.writeFileSync(path.join(profile,'package.json'),JSON.stringify({name:'nodo-web',version:'1.0.0',private:true,type:'module',dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app'],patchReload:'startup'}}}));
 if(!fs.existsSync(path.join(profile,'cordis.patch.yml')))fs.copyFileSync(path.join(root,'profile.patch.yml'),path.join(profile,'cordis.patch.yml'));
 if(c.isolated){
  fs.writeFileSync(path.join(c.data,'dsh/settings.yaml'),'agent-default-model:\n  provider: deepseek-official\n  model: deepseek-flash\n  reasoningEffort: low\npermission:\n  defaultPreset: workspace-write\nui-theme:\n  preference: dark\n');
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
module.exports={environment,prepare,sandboxArgs};
