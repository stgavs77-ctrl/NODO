const fs=require('node:fs');
const path=require('node:path');

const markerPath=data=>path.join(data,'intentional-stop.json');
function clearIntentionalStop(data){fs.rmSync(markerPath(data),{force:true});}
function persistIntentionalStop(data,reason){
 const file=markerPath(data),tmp=file+'.'+process.pid+'.tmp';
 const dir=path.dirname(file);fs.mkdirSync(dir,{recursive:true,mode:0o700});
 let fd;try{fd=fs.openSync(tmp,'w',0o600);fs.writeFileSync(fd,JSON.stringify({intentional:true,reason,stoppedAt:new Date().toISOString()}));fs.fsyncSync(fd);fs.closeSync(fd);fd=null;fs.renameSync(tmp,file);const directory=fs.openSync(dir,'r');try{fs.fsyncSync(directory);}finally{fs.closeSync(directory);}}catch(error){if(fd!==undefined&&fd!==null)fs.closeSync(fd);fs.rmSync(tmp,{force:true});throw error;}
}

class QuitControl{
 constructor({data,isBusy,cancelBusy,stop,resume,status,requestQuit,promptBusy,promptError}){
  Object.assign(this,{data,isBusy,cancelBusy,stop,resume,status,requestQuit,promptBusy,promptError});
  this.running=false;this.allowQuit=false;this.reason='user';
 }
 request(reason='user'){this.reason=reason;this.requestQuit();}
 beforeQuit(event){
  if(this.allowQuit)return;
  event.preventDefault();
  if(this.running)return;
  this.running=true;
  void this.run(this.reason).catch(async error=>{
   try{await this.resume?.();}catch{}
   this.status('shutdown-blocked',{error:error.code||error.name||'QUIT_FAILED'});
   await this.promptError(error);
  }).finally(()=>{if(!this.allowQuit)this.running=false;});
 }
 async run(reason){
  if(await this.isBusy()){
   if(!await this.promptBusy()){return;}
   await this.cancelBusy();
   if(await this.isBusy())throw Error('A task did not stop safely');
  }
  persistIntentionalStop(this.data,reason);
  try{await this.stop(reason);}catch(error){clearIntentionalStop(this.data);throw error;}
  this.allowQuit=true;this.requestQuit();
 }
}
module.exports={QuitControl,markerPath,clearIntentionalStop,persistIntentionalStop};
