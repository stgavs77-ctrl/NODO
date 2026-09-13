'use strict';
// About window preload: exposes only the running application metadata the
// dialog displays. It answers from the main process, so a shipped build can
// never show a version baked into the HTML.
const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('nodoAbout',{
 info:()=>new Promise(resolve=>{
  let done=false;
  const finish=value=>{if(done)return;done=true;ipcRenderer.off('rc:about-info',finish);resolve(value);};
  ipcRenderer.once('rc:about-info',(_event,value)=>finish(value));
  ipcRenderer.send('rc:about-request');
  setTimeout(()=>finish({}),3000);
 })
});
