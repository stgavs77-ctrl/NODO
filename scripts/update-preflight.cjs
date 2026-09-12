// Called only by the verified Rescue installer. No sending, no launchd mutations.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process'),crypto=require('node:crypto');
const {rpc}=require('../lib/io.cjs');
// Independent nodo-optional data is no longer part of transactional NODO backup.
// Do not query, stop or take ownership of shadow, lead-watch or balance-monitor.
const foreignJobs=['com.local.dsh-bridge-watch'];
const {passiveWatch}=require('../lib/bridge-watch-scope.cjs');
const data=path.join(os.homedir(),'Library/Application Support/NODO');
function json(file){try{return JSON.parse(fs.readFileSync(file));}catch{throw Error('State JSON unavailable: '+path.basename(file));}}
function files(root){if(!fs.existsSync(root))return[];return fs.readdirSync(root,{withFileTypes:true}).flatMap(e=>e.isSymbolicLink()?[]:e.isDirectory()?files(path.join(root,e.name)):[path.join(root,e.name)]);}
function snapshot(root=data,bridge=path.join(os.homedir(),'.dsh/plugins/telegram-bridge')){
 const w=json(path.join(root,'workstation.json')),t=json(path.join(root,'tasks.json')),storage=json(path.join(root,'dsh/storages/workspace.json'));
 const sessions=files(path.join(root,'dsh/sessions')).filter(f=>f.endsWith('.zstd')).map(f=>path.relative(root,f));
 const attachments=files(path.join(root,'dsh/attachments')).map(f=>({id:path.relative(root,f),sha:crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')}));
 const settings=fs.readFileSync(path.join(root,'dsh/settings.yaml'),'utf8'),patch=fs.readFileSync(path.join(root,'dsh/profiles/web/cordis.patch.yml'),'utf8');
 const taskRows=Array.isArray(t)?t:t.items;if(!Array.isArray(taskRows))throw Error('Invalid tasks schema');
 return{counts:{sessions:sessions.length,workspaces:Object.keys(storage.tables?.workspaces||{}).length,attachments:attachments.length,tasks:taskRows.length,checkpoints:files(path.join(root,'checkpoints')).length,chatBindings:w.chats.filter(c=>c.deepseekId).length,browserWorkspaces:w.workspaces.length,browserTabs:w.tabs.length,telegramBindings:Object.keys(json(path.join(bridge,'chat-sessions.json'))).length},sessions,attachments,taskIds:taskRows.map(t=>t.id),bindings:w.chats.map(c=>c.deepseekId).filter(Boolean),workspaceIds:Object.keys(storage.tables?.workspaces||{}),tabIds:w.tabs.map(t=>t.id),settingsSHA:crypto.createHash('sha256').update(settings).digest('hex'),contextSHA:crypto.createHash('sha256').update(patch).digest('hex'),preferences:{defaultModel:settings.match(/\n  model: (.+)/)?.[1],reasoning:settings.match(/reasoningEffort: (.+)/)?.[1],compaction:Number(patch.match(/thresholdRatio: ([\d.]+)/)?.[1]),keep:Number(patch.match(/retainTokens: (\d+)/)?.[1]),repeat:patch.match(/thresholds: (.+)/)?.[1]}};
}
function compare(before,after){const errors=[];for(const key of ['sessions','taskIds','bindings','workspaceIds','tabIds'])if(before[key].some(id=>!after[key].includes(id)))errors.push(key+' lost entries');const hashes=new Map(after.attachments.map(a=>[a.id,a.sha]));if(before.attachments.some(a=>hashes.get(a.id)!==a.sha))errors.push('attachments lost or changed');for(const key of ['settingsSHA','contextSHA'])if(before[key]!==after[key])errors.push(key+' changed');for(const key of Object.keys(before.counts))if(after.counts[key]<before.counts[key])errors.push(key+' count decreased');return errors;}
function jobLoaded(label){try{cp.execFileSync('/bin/launchctl',['print',`gui/${process.getuid()}/${label}`],{stdio:'pipe'});return true;}catch(e){if(e.status===113||e.status===3)return false;throw Error('Cannot determine launchd job state: '+label);}}
function externalBlockers(){return foreignJobs.filter(label=>{
 if(!jobLoaded(label))return false;
 try{
  const home=os.homedir(),bridge=path.join(home,'.dsh/plugins/telegram-bridge');
  const plist=JSON.parse(cp.execFileSync('/usr/bin/plutil',['-convert','json','-o','-',path.join(home,'Library/LaunchAgents',label+'.plist')],{encoding:'utf8'}));
  return !passiveWatch({plist,config:json(path.join(bridge,'watch-config.json')),source:fs.readFileSync(path.join(bridge,'watch.py')),home});
 }catch{return true;}
 });}
async function endpoint(method){const i=json(path.join(data,'instance.json'));const exe=cp.execFileSync('/bin/ps',['-p',String(i.pid),'-o','comm='],{encoding:'utf8'}).trim();if(!exe.endsWith('/NODO.app/Contents/MacOS/NODO'))throw Error('NODO PID identity mismatch');return rpc(i.appSocket,method,{},65000);}
async function inspect(){const other=externalBlockers();if(other.length)throw Error('Shared Telegram state still has independent writers (not authorized to stop): '+other.join(', '));let live;try{live=await endpoint('lifecycle.status');}catch{throw Error('OLD_RUNTIME_QUIESCE_UNSUPPORTED: no verified pause/drain protocol. No shutdown or file replacement performed.');}if(live.protocol!==1||live.activeTurns!==0||live.tasks!==0)throw Error('Active turns/Tasks or unsupported shutdown protocol');return live;}
async function run(mode){
 if(mode==='cold'){const blocked=externalBlockers();if(blocked.length)throw Error('Bridge watcher requires verified drain');return require('../lib/cold-preflight.cjs').coldPreflight(data,path.join(os.homedir(),'.dsh/plugins/telegram-bridge'));}
 if(mode==='backup-policy'){const blocked=externalBlockers();if(blocked.length)throw Error('Bridge watcher may write shared sender ledger; verified drain required: '+blocked.join(', '));return {scope:'NODO profile + explicit bridge state',independentServicesExcluded:true};}
 if(mode==='inspect')return inspect();
 if(mode==='pause'){await inspect();const r=await endpoint('lifecycle.pause');if(r.activeTurns||r.services.some(s=>!s.drained))throw Error('Quiescence not confirmed');return r;}
 if(mode==='quit')return endpoint('lifecycle.quit');
 if(mode==='resume')return endpoint('lifecycle.resume');
 if(mode==='snapshot')return snapshot();
 if(mode==='health'){const s=await endpoint('lifecycle.status');const bad=[];if(!s.dshReady)bad.push('DSH');if(!s.codexReady)bad.push('Codex');for(const name of ['nodo-tools',...s.services.filter(x=>['telegram-bridge','sessions-observer'].includes(x.name)).map(x=>x.name)]){const v=s.services.find(x=>x.name===name);if(!v||v.missing||v.paused)bad.push(name);}if(bad.length)throw Error('Services failed to start: '+bad.join(', '));return {ready:true,snapshot:snapshot()};}
 throw Error('Unknown preflight mode');
}
module.exports={snapshot,compare,foreignJobs};
if(require.main===module)run(process.argv[2]).then(v=>process.stdout.write(JSON.stringify(v))).catch(e=>{console.error(e.message);process.exitCode=1;});
