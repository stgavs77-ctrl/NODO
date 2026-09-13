const {contextBridge,ipcRenderer}=require('electron');
// Hydrate before native client modules mount. Applying preferences after load
// races the sidebar's initial current-session/order persistence.
function hydrateUI(){if(!/^http:\/\/127\.0\.0\.1:(4180|4280|4380)$/.test(location.origin))return;
 const initial=ipcRenderer.sendSync('rc:initial-ui');
 if(initial){for(const[key,value]of Object.entries(initial.prefs))if(key.startsWith('dsh.'))localStorage.setItem(key,value);ipcRenderer.send('rc:ui-imported',initial.hash);}
}
// The sandbox preload can run before the navigation's main frame is committed.
// 'interactive' precedes the deferred native ES module's execution.
if(document.readyState==='loading')document.addEventListener('readystatechange',hydrateUI,{once:true});else hydrateUI();
const allowed=new Set(['state','health','balance.refresh','browser.chatIntent','layout','browser.action','workspace.create','workspace.select','chat.new','chat.select','chat.switch','chat.send','codex.login','codex.refresh','codex.select','tasks.start','tasks.cancel','tasks.deny','checkpoint.create','checkpoint.restore','view','open.workspace','native.bind','native.track']);
for(const method of ['features.status','remote.enable','remote.disable','remote.pair','remote.revoke','remote.reset','updates.check','updates.download','updates.install','updates.preferences'])allowed.add(method);
 // Supervisor: status and history are read-only; act/userMessage are the four
 // user controls of the intervention card.
 for(const method of ['supervisor.status','supervisor.events','supervisor.card','supervisor.act','supervisor.userMessage','supervisor.settings','interpreter.status','interpreter.configure','interpreter.brief','interpreter.response','rules.propose','rules.save'])allowed.add(method);
allowed.add('links.action');
allowed.add('project.call');
allowed.add('context.status');allowed.add('context.mode');
allowed.add('auto.route');
allowed.add('media.inspect');allowed.add('media.action');
allowed.add('reaper.context');
ipcRenderer.on('rc:open-browser',()=>window.dispatchEvent(new Event('nodo-open-browser')));
// Never expose privileged IPC to an external page, even after direct CDP navigation.
if(process.isMainFrame!==false&&/^http:\/\/127\.0\.0\.1:(4180|4280|4380)$/.test(location.origin))contextBridge.exposeInMainWorld('rc',{call:(method,params={})=>{if(!allowed.has(method))throw Error('Unknown operation');return ipcRenderer.invoke('rc:call',method,params);},onChanged:fn=>{const cb=()=>fn();ipcRenderer.on('rc:changed',cb);return()=>ipcRenderer.removeListener('rc:changed',cb);}});
