'use strict';
function httpURL(raw){
 if(typeof raw!=='string'||raw.length>16384)throw Error('Invalid link');
 const u=new URL(raw);
 if(!['http:','https:'].includes(u.protocol)||u.username||u.password)throw Error('Only HTTP(S) links without credentials are supported');
 return u.href;
}
function installLinks(app,{Menu,shell,clipboard}){
 const open=async raw=>{const url=httpURL(raw);await app.browser.open(url,'user');app.win.webContents.send('rc:open-browser');};
 app.win.webContents.setWindowOpenHandler(({url})=>{open(url).catch(e=>{app.browser.lastError=e.message;});return{action:'deny'};});
 app.win.webContents.on('context-menu',(_event,p)=>{
  if(!p.linkURL)return;let url;try{url=httpURL(p.linkURL);}catch{return;}
  Menu.buildFromTemplate([
   {label:'Open in NODO Browser',click:()=>open(url).catch(e=>{app.browser.lastError=e.message;})},
   {label:'Open in External Browser',click:()=>shell.openExternal(url)},
   {label:'Copy Link',click:()=>clipboard.writeText(url)}
  ]).popup({window:app.win});
 });
 return {open,async action(p){const url=httpURL(p.url);if(p.action==='external')return shell.openExternal(url);if(p.action==='copy')return clipboard.writeText(url);return open(url);}};
}
module.exports={httpURL,installLinks};
