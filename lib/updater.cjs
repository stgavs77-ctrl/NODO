'use strict';
const fs=require('node:fs'),path=require('node:path'),https=require('node:https'),crypto=require('node:crypto'),cp=require('node:child_process');
const {verify,sha256}=require('./release-signature.cjs');
const MAX_MANIFEST_AGE_MS=31*24*60*60*1000;
// Release trust is intentionally unconfigured in this DEV checkout. A caller
// must provide the reviewed pinned key from its local release-trust config.
function fail(message){const e=Error(message);e.code='NODO_UPDATE_REJECTED';throw e;}
function semver(v){const m=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/.exec(v||'');if(!m)fail('Invalid version');return m.slice(1,4).map(Number);}
function compare(a,b){a=semver(a);b=semver(b);for(let i=0;i<3;i++)if(a[i]!==b[i])return a[i]-b[i];return 0;}
function validateManifest(m,{publicKey,currentVersion,channel='dev',now=Date.now(),allowEqual=false}){
 if(typeof publicKey!=='string'||!publicKey)fail('Release trust is not configured');
 if(!m||m.schema!==1||typeof m.signature!=='string')fail('Unsupported signed manifest');
 const signed={...m};delete signed.signature;
 if(!verify(signed,m.signature,publicKey))fail('Manifest signature is invalid');
 if(m.channel!==channel||!['patch','migration'].includes(m.kind)||m.platform!==process.platform||m.arch!==process.arch||!Number.isSafeInteger(m.appSchema)||m.appSchema!==3||m.rollbackPolicy!=='code-only')fail('Unsupported update compatibility');
 if(typeof m.url!=='string'||!m.url.startsWith('https://'))fail('Update URL must use HTTPS');
 if(!/^[0-9a-f]{64}$/.test(m.sha256||'')||!Number.isSafeInteger(m.bytes)||m.bytes<1||m.bytes>2*1024*1024*1024)fail('Invalid package digest or size');
 if(m.parts!==undefined){if(!Array.isArray(m.parts)||!m.parts.length||m.parts.length>128||m.parts.some(p=>typeof p.url!=='string'||!p.url.startsWith('https://')||!Number.isSafeInteger(p.bytes)||p.bytes<1||p.bytes>20*1024*1024||!/^[0-9a-f]{64}$/.test(p.sha256||''))||m.parts.reduce((n,p)=>n+p.bytes,0)!==m.bytes)fail('Invalid signed package parts');}
 if(!Number.isSafeInteger(m.issuedAt)||!Number.isSafeInteger(m.expiresAt)||m.issuedAt>now+5*60e3||m.expiresAt<=now||m.expiresAt-m.issuedAt>MAX_MANIFEST_AGE_MS)fail('Manifest is expired or has invalid lifetime');
 if(compare(m.version,currentVersion)<0||(!allowEqual&&compare(m.version,currentVersion)===0))fail('Replay or downgrade rejected');
 if(m.minVersion&&compare(currentVersion,m.minVersion)<0)fail('Current version is incompatible');
 if(m.maxVersion&&compare(currentVersion,m.maxVersion)>0)fail('Current version is incompatible');
 return Object.freeze({...m});
}
function getJson(url,maxBytes=256*1024){return new Promise((resolve,reject)=>{const u=new URL(url);if(u.protocol!=='https:'||u.username||u.password||u.hash)throw Error('Public manifest must use HTTPS without credentials');https.get(u,{timeout:15000},r=>{let n=0,body='';r.on('error',reject);r.on('aborted',()=>reject(Error('Manifest response interrupted')));if(r.statusCode!==200){r.resume();return reject(Error('Manifest HTTP '+r.statusCode));}r.setEncoding('utf8');r.on('data',c=>{n+=Buffer.byteLength(c);if(n>maxBytes)r.destroy(Error('Manifest too large'));else body+=c;});r.on('end',()=>{try{resolve(JSON.parse(body));}catch{reject(Error('Invalid manifest JSON'));}});}).on('timeout',function(){this.destroy(Error('Manifest timeout'));}).on('error',reject);});}
function download(url,destination,expected,maxBytes=2*1024*1024*1024){return new Promise((resolve,reject)=>{let done=false,bytes=0;const end=e=>{if(done)return;done=true;out.destroy();fs.rmSync(destination,{force:true});reject(e)};const out=fs.createWriteStream(destination,{flags:'wx',mode:0o600});const h=crypto.createHash('sha256');const req=https.get(url,{timeout:120000},r=>{if(r.statusCode!==200)return end(Error('Package HTTP '+r.statusCode));if(Number(r.headers['content-length'])>maxBytes)return end(Error('Package too large'));r.on('data',c=>{bytes+=c.length;if(bytes>maxBytes)r.destroy(Error('Package too large'));else h.update(c)});r.on('error',end);r.pipe(out);out.on('finish',()=>out.close(()=>{if(done)return;done=true;const got=h.digest('hex');if(got!==expected){fs.rmSync(destination,{force:true});return reject(Error('Package digest mismatch'));}resolve(destination)}));}).on('timeout',function(){this.destroy(Error('Package timeout'))}).on('error',end);out.on('error',end);});}
async function checkAndStage({manifestUrl,publicKey,currentVersion,channel='dev',stagingDir}){const m=validateManifest(await getJson(manifestUrl),{publicKey,currentVersion,channel});fs.mkdirSync(stagingDir,{recursive:true,mode:0o700});const file=path.join(stagingDir,`${m.version}.zip`);if(fs.existsSync(file)&&sha256(file)===m.sha256)return {manifest:m,package:file};if(fs.existsSync(file))fs.rmSync(file,{force:true});
 if(m.parts){
  const joined=file+'.assembling';fs.rmSync(joined,{force:true});const fd=fs.openSync(joined,'wx',0o600);let ok=false;
  try{for(let i=0;i<m.parts.length;i++){const part=m.parts[i],piece=file+'.part-'+i;
   if(!fs.existsSync(piece)||fs.statSync(piece).size!==part.bytes||sha256(piece)!==part.sha256){fs.rmSync(piece,{force:true});await download(part.url,piece,part.sha256,part.bytes);}
   if(fs.statSync(piece).size!==part.bytes)fail('Package part size mismatch');
   const source=fs.openSync(piece,'r'),buffer=Buffer.alloc(1024*1024);try{let n;while((n=fs.readSync(source,buffer,0,buffer.length,null))>0)fs.writeSync(fd,buffer,0,n);}finally{fs.closeSync(source);}
  }fs.fsyncSync(fd);ok=true;}finally{fs.closeSync(fd);if(!ok)fs.rmSync(joined,{force:true});}
  if(fs.statSync(joined).size!==m.bytes||sha256(joined)!==m.sha256){fs.rmSync(joined,{force:true});fail('Assembled package digest mismatch');}fs.renameSync(joined,file);
 }else await download(m.url,file,m.sha256,m.bytes);return {manifest:m,package:file};}
function checkedExec(file,args){try{return cp.execFileSync(file,args,{encoding:'utf8',maxBuffer:64*1024*1024,timeout:120000,stdio:['ignore','pipe','pipe']});}catch{fail('Verified package check failed: '+path.basename(file));}}
function isInside(root,file){const r=path.resolve(root)+path.sep;return path.resolve(file).startsWith(r);}
function unpackVerifiedZip(zip,expected,destination){
 if(sha256(zip)!==expected)fail('Verified package changed before install');
 const listing=checkedExec('/usr/bin/unzip',['-Z1',zip]).split(/\r?\n/).filter(Boolean),detail=checkedExec('/usr/bin/zipinfo',['-l',zip]);
 if(!listing.length||new Set(listing).size!==listing.length||listing.some(p=>p.startsWith('/')||p.split('/').includes('..')||p.includes('\\')||/[\r\n]/.test(p)))fail('Unsafe package archive path');
 // zipinfo identifies symlinks before extraction. Their link bytes are read
 // without materializing anything; no archive member may live below one.
 const links=detail.split(/\r?\n/).filter(x=>/^l/.test(x)).map(x=>/\d{2}:\d{2}\s+(.+)$/.exec(x)?.[1]).filter(Boolean);
 if(links.some(x=>!listing.includes(x)))fail('Unparseable package symlink');
 for(const link of links){const target=checkedExec('/usr/bin/unzip',['-p',zip,link]);const root='/'+link.split('/')[0];if(!target||/[\r\n\0]/.test(target)||path.isAbsolute(target)||!isInside(root,path.resolve(path.dirname('/'+link),target))||listing.some(x=>x.startsWith(link+'/')))fail('Unsafe package symlink');}
 fs.mkdirSync(destination,{recursive:true,mode:0o700});checkedExec('/usr/bin/ditto',['-x','-k',zip,destination]);
 const entries=fs.readdirSync(destination);if(entries.length!==2||!entries.includes('NODO.app')||!entries.includes('NODO Rescue.app'))fail('Package must contain fixed NODO and Rescue bundles');
 const app=path.join(destination,'NODO.app');
 (function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name),s=fs.lstatSync(p);if(s.isSymbolicLink()&&!isInside(destination,path.resolve(dir,fs.readlinkSync(p))))fail('Package symlink escapes staging');if(s.isDirectory()&&!s.isSymbolicLink())walk(p);}})(app);
 if(!fs.existsSync(path.join(app,'Contents/Info.plist')))fail('Invalid app bundle');checkedExec('/usr/bin/codesign',['--verify','--deep','--strict',app]);checkedExec('/usr/bin/codesign',['--verify','--deep','--strict',path.join(destination,'NODO Rescue.app')]);return app;
}
class Updater {
 constructor(options){this.options=options;this.status='idle';this.manifest=null;this.package=null;}
 emit(status,detail){this.status=status;this.options.onStatus?.({status,detail,manifest:this.manifest});}
 async check(){this.emit('checking');this.manifest=validateManifest(await getJson(this.options.manifestUrl),{...this.options,allowEqual:true});this.emit(compare(this.manifest.version,this.options.currentVersion)===0?'up-to-date':'available');return this.manifest;}
 async download(){if(!this.manifest)await this.check();if(compare(this.manifest.version,this.options.currentVersion)===0)return {manifest:this.manifest,package:null};this.emit('downloading');const staged=await checkAndStage({...this.options,stagingDir:this.options.stagingDir});this.manifest=staged.manifest;this.package=staged.package;this.emit('ready');return staged;}
 // UI owns explicit Restart Update. This function does not restart or execute
 // anything; it only returns the verified staged package + local-only metadata.
 installMetadata(local){if(!this.package||sha256(this.package)!==this.manifest.sha256)fail('Verified package is not staged');return {package:this.package,metadata:installerMetadata(this.manifest,local)};}
 async install(local){
  if(['installing','pending-restart'].includes(this.status))fail('Update installation is already running');
  if(!this.package||!this.manifest)fail('Verified package is not staged');
  const manifest=validateManifest(this.manifest,this.options),metadata=installerMetadata(manifest,local);
  this.emit('installing');
  try{
   const folder=fs.mkdtempSync(path.join(this.options.stagingDir,'install-'));
   // Hashing, archive traversal and native codesign must not freeze Electron UI.
   const {Worker}=require('node:worker_threads');
   const app=await new Promise((resolve,reject)=>{const worker=new Worker(path.join(__dirname,'updater-worker.cjs'),{workerData:{zip:this.package,hash:manifest.sha256,folder}});worker.once('message',v=>v.error?reject(Error(v.error)):resolve(v.app));worker.once('error',reject);worker.once('exit',code=>{if(code)reject(Error('Package verification worker failed'));});});
   fs.writeFileSync(path.join(folder,'update.json'),JSON.stringify(metadata),{mode:0o600});
   const bundledRescue=path.join(folder,'NODO Rescue.app','Contents','MacOS','NODORescue');
   const log=fs.openSync(path.join(folder,'installer.log'),'a',0o600);
   let child;try{child=cp.spawn(bundledRescue,['install',folder],{detached:true,stdio:['ignore',log,log],shell:false});}finally{fs.closeSync(log);}
   await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
   child.once('exit',code=>{if(code)this.emit('error','Update did not complete. See NODO Rescue; previous code and user data are retained.');});
   child.unref();this.emit('pending-restart');return {pending:true,folder,app,version:manifest.version};
  }catch(e){this.emit('error',e.message);throw e;}
 }
}
// Called only after signature + package digest verification. It deliberately
// serializes no remote filesystem path: Rescue derives profile and app target.
function installerMetadata(manifest,{backupKeyAccount}={}){const out={schema:3,kind:manifest.kind,version:manifest.version};if(manifest.kind==='migration'){if(!/^[0-9a-f-]{36}$/i.test(backupKeyAccount||''))fail('Migration requires a local recovery Keychain account');out.backupKeyAccount=backupKeyAccount;}return out;}
module.exports={compare,validateManifest,getJson,download,checkAndStage,installerMetadata,unpackVerifiedZip,Updater};
