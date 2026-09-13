'use strict';
const fs=require('node:fs'),path=require('node:path');
const {read,save}=require('./io.cjs');
const {Updater}=require('./updater.cjs');
const {RemoteHost}=require('./remote-host.cjs');
class FeatureSettings{
 constructor({root,data,version,safeStorage,power,call,onChange,readCredential,isolated}){
  Object.assign(this,{root,data,version,safeStorage,power,call,onChange});
  // An isolated (DEV/Safe Mode) profile must never install anything: a real
  // update hands the staged bundle to NODO Rescue, which resolves the target
  // app itself and would replace the installed production NODO.
  this.isolated=!!isolated;
  this.readCredential=readCredential||((service,account)=>new Promise((resolve,reject)=>{const child=this.credentialChild=require('node:child_process').execFile('/usr/bin/security',['find-generic-password','-s',service,'-a',account,'-w'],{encoding:'utf8',timeout:60000,maxBuffer:65536},(error,stdout)=>{if(this.credentialChild===child)this.credentialChild=null;error?reject(Error('Keychain access was not granted. Enable Remote again and approve NODO Remote/Relay.')):resolve(stdout.trim());});}));
  this.file=path.join(data,'remote-update-preferences.json');this.prefs=read(this.file,{remoteEnabled:false,checkAutomatically:true});
  this.trust=read(path.join(root,'config/release-trust.json'),{});this.update={status:'unconfigured'};
  this.updater=new Updater({...this.trust,currentVersion:version,stagingDir:path.join(data,'updates'),onStatus:s=>{this.update=s;onChange();}});
  this.checkTimer=null;
 }
 vault(name){const file=path.join(this.data,name+'.encrypted');return {read:()=>{if(!fs.existsSync(file))return null;if(!this.safeStorage.isEncryptionAvailable())throw Error('macOS Keychain unavailable');return JSON.parse(this.safeStorage.decryptString(fs.readFileSync(file)));},write:value=>{if(!this.safeStorage.isEncryptionAvailable())throw Error('macOS Keychain unavailable');const tmp=file+'.tmp';fs.writeFileSync(tmp,this.safeStorage.encryptString(JSON.stringify(value)),{mode:0o600});fs.renameSync(tmp,file);}};}
 async getRemote(){
  if(this.stopping)throw Error('NODO is shutting down');
  if(this.remote)return this.remote;
  if(this.remoteLoading)return this.remoteLoading;
  this.remoteLoading=(async()=>{
   let config=this.vault('remote-relay').read();
   if(!config){const bundled=read(path.join(this.root,'config/remote-relay.json'),null);if(bundled?.url){
    if(bundled.keychainService!=='NODO Remote/Relay'||bundled.keychainAccount!=='nodo-remote-relay')throw Error('Unknown relay credential');
    const hostCredential=await this.readCredential(bundled.keychainService,bundled.keychainAccount);
    if(!hostCredential)throw Error('Remote credential is empty');
    config={...bundled,hostCredential};
   }}
   if(this.stopping)throw Error('NODO is shutting down');
   this.remote=new RemoteHost({config,store:this.vault('remote-devices'),call:this.call,power:this.power,onStatus:()=>this.onChange()});this.remoteError=null;return this.remote;
  })().catch(error=>{this.remoteError=error.message;throw error;}).finally(()=>{this.remoteLoading=null;this.onChange();});
  return this.remoteLoading;
 }
 snapshot(){return {remote:this.remote?.status()||{status:this.remoteLoading?'Waiting for Keychain':this.remoteError||'Off',enabled:false,configured:fs.existsSync(path.join(this.data,'remote-relay.encrypted'))||!!read(path.join(this.root,'config/remote-relay.json'),null)?.url,devices:[]},updates:{...this.update,currentVersion:this.version,configured:!!this.trust.publicKey&&!!this.trust.manifestUrl,checkAutomatically:this.prefs.checkAutomatically,downloadAutomatically:!!this.prefs.downloadAutomatically,installMode:this.prefs.installMode||'manual',channel:this.prefs.channel||this.trust.channel||'stable',latest:this.update?.manifest?.version||null,releaseNotes:this.update?.manifest?.releaseNotes||null,source:this.update?.source||null,checkedAt:this.lastCheck||null}};}
 persist(){save(this.file,this.prefs);this.onChange();}
 async start(){
  this.stopping=false;
  if(this.isolated)return;
  if(this.prefs.remoteEnabled)try{(await this.getRemote()).enable();}catch{}
  if(this.stopping||!this.prefs.checkAutomatically||!this.trust.publicKey||!(this.trust.repo||this.trust.manifestUrl))return;
  clearTimeout(this.autoTimer);clearInterval(this.checkTimer);
  // First check shortly after startup, then periodically, so an installed NODO
  // offers the next release without anyone asking it to.
  this.autoTimer=setTimeout(()=>this.dispatch('updates.check',{}).catch(()=>{}),12000);
  this.checkTimer=setInterval(()=>this.dispatch('updates.check',{}).catch(()=>{}),6*60*60*1000);
  if(this.checkTimer.unref)this.checkTimer.unref();
 }
 // Update flow helpers used by the main process update runner. All real work
 // (signature, digest, staging contract) stays in lib/updater.cjs.
 async downloadUpdate(){
  if(this.isolated)throw Error('Updates are disabled in isolated DEV/Safe Mode');
  if(!this.trust.publicKey||!(this.trust.repo||this.trust.manifestUrl))throw Error('Release channel is not configured');
  try{return await this.updater.download();}
  catch(e){this.update={...this.update,status:'error',detail:e.message};this.onChange();throw e;}
 }
 async installUpdate(local={}){
  if(this.isolated)throw Error('Updates are disabled in isolated DEV/Safe Mode');
  try{return await this.updater.install(local);}
  catch(e){this.update={...this.update,status:'error',detail:e.message};this.onChange();throw e;}
 }
 async dispatch(method,p={}){
  if(this.isolated&&method.startsWith('updates.'))throw Error('Updates are disabled in isolated DEV/Safe Mode');
  switch(method){
   case 'features.status':return this.snapshot();
   case 'remote.enable':(await this.getRemote()).enable();this.prefs.remoteEnabled=true;this.persist();return this.snapshot();
   case 'remote.disable':await (await this.getRemote()).disable();this.prefs.remoteEnabled=false;this.persist();return this.snapshot();
   case 'remote.pair':{const pairing=(await this.getRemote()).beginPairing();const png=await new Promise((resolve,reject)=>{const child=require('node:child_process').spawn(path.join(this.root,'runtime/nodo-qr'),[],{stdio:['pipe','pipe','ignore'],timeout:15000});const chunks=[];child.stdout.on('data',b=>chunks.push(b));child.on('error',reject);child.on('exit',code=>code===0?resolve(Buffer.concat(chunks)):reject(Error('QR generator unavailable')));child.stdin.on('error',reject);child.stdin.end(pairing.url);});return {...pairing,qr:'data:image/png;base64,'+png.toString('base64')};}
   case 'remote.revoke':(await this.getRemote()).revoke(p.id);return this.snapshot();
   case 'remote.reset':(await this.getRemote()).reset();return this.snapshot();
   case 'updates.preferences':{
    if(p.checkAutomatically!==undefined){if(typeof p.checkAutomatically!=='boolean')throw Error('Invalid preference');this.prefs.checkAutomatically=p.checkAutomatically;}
    if(p.downloadAutomatically!==undefined){if(typeof p.downloadAutomatically!=='boolean')throw Error('Invalid preference');this.prefs.downloadAutomatically=p.downloadAutomatically;}
    if(p.installMode!==undefined){if(!['manual','idle'].includes(p.installMode))throw Error('Invalid install mode');this.prefs.installMode=p.installMode;}
    if(p.channel!==undefined){if(!['stable','beta'].includes(p.channel))throw Error('Invalid channel');this.prefs.channel=p.channel;}
    if(p.skipVersion!==undefined){this.prefs.skipVersion=typeof p.skipVersion==='string'?p.skipVersion:null;}
    this.persist();return this.snapshot();
   }
   case 'updates.check':{
    if(!this.trust.publicKey||!(this.trust.repo||this.trust.manifestUrl))throw Error('Release channel and verification key are not configured');
    try{const manifest=await this.updater.check();this.lastCheck=new Date().toISOString();if(this.prefs.skipVersion&&this.prefs.skipVersion===manifest.version)this.update={...this.update,status:'skipped'};if(this.prefs.downloadAutomatically&&this.updater.status==='available')await this.downloadUpdate();return {...manifest,status:this.update.status};}
    catch(e){this.update={...this.update,status:'error',detail:e.message};this.onChange();throw e;}
   }
   case 'updates.download':return this.downloadUpdate();
   case 'updates.install':if(!this.trust.publicKey)throw Error('Release channel and verification key are not configured');return this.onInstallRequest?this.onInstallRequest():this.installUpdate();
   default:throw Error('Unknown NODO setting');
  }
 }
 async stop(){this.stopping=true;clearTimeout(this.autoTimer);clearInterval(this.checkTimer);this.checkTimer=null;this.credentialChild?.kill('SIGTERM');await this.remote?.disable();}
}
module.exports={FeatureSettings};
