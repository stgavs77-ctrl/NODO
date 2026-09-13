'use strict';
const fs=require('node:fs'),path=require('node:path'),https=require('node:https'),http=require('node:http'),crypto=require('node:crypto'),cp=require('node:child_process');
const {verify,sha256}=require('./release-signature.cjs');
// A published manifest is valid for 30 days; the cap keeps a stale channel
// from silently pinning an install to an old release.
const MAX_MANIFEST_AGE_MS=31*24*60*60*1000;
// Release trust is intentionally unconfigured in this DEV checkout. A caller
// must provide the reviewed pinned key from its local release-trust config.
function fail(message){const e=Error(message);e.code='NODO_UPDATE_REJECTED';throw e;}
// Release packages are always fetched over TLS. The single exception is an
// explicit loopback feed used by the end-to-end update tests, which never
// applies to a shipped build (the flag is not set in production).
function isHttps(url){return typeof url==='string'&&url.startsWith('https://');}
function isLocalFeed(){return process.env.NODO_LOCAL_FEED==='1';}
function isPackageUrl(url){return isHttps(url)||(isLocalFeed()&&typeof url==='string'&&/^http:\/\/(127\.0\.0\.1|\[::1\]):\d+\//.test(url));}
function semver(v){const m=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/.exec(v||'');if(!m)fail('Invalid version');return m.slice(1,4).map(Number);}
function compare(a,b){a=semver(a);b=semver(b);for(let i=0;i<3;i++)if(a[i]!==b[i])return a[i]-b[i];return 0;}
function validateManifest(m,{publicKey,currentVersion,channel='dev',now=Date.now(),allowEqual=false}){
 if(typeof publicKey!=='string'||!publicKey)fail('Release trust is not configured');
 if(!m||m.schema!==1||typeof m.signature!=='string')fail('Unsupported signed manifest');
 const signed={...m};delete signed.signature;
 if(!verify(signed,m.signature,publicKey))fail('Manifest signature is invalid');
 if(m.channel!==channel||!['patch','migration'].includes(m.kind)||m.platform!==process.platform||m.arch!==process.arch||!Number.isSafeInteger(m.appSchema)||m.appSchema!==3||m.rollbackPolicy!=='code-only')fail('Unsupported update compatibility');
 if(!isPackageUrl(m.url))fail('Update URL must use HTTPS');
 if(!/^[0-9a-f]{64}$/.test(m.sha256||'')||!Number.isSafeInteger(m.bytes)||m.bytes<1||m.bytes>2*1024*1024*1024)fail('Invalid package digest or size');
 if(m.parts!==undefined){if(!Array.isArray(m.parts)||!m.parts.length||m.parts.length>128||m.parts.some(p=>!isPackageUrl(p.url)||!Number.isSafeInteger(p.bytes)||p.bytes<1||p.bytes>20*1024*1024||!/^[0-9a-f]{64}$/.test(p.sha256||''))||m.parts.reduce((n,p)=>n+p.bytes,0)!==m.bytes)fail('Invalid signed package parts');}
 if(!Number.isSafeInteger(m.issuedAt)||!Number.isSafeInteger(m.expiresAt)||m.issuedAt>now+5*60e3||m.expiresAt<=now||m.expiresAt-m.issuedAt>MAX_MANIFEST_AGE_MS)fail('Manifest is expired or has invalid lifetime');
 if(compare(m.version,currentVersion)<0||(!allowEqual&&compare(m.version,currentVersion)===0))fail('Replay or downgrade rejected');
 if(m.minVersion&&compare(currentVersion,m.minVersion)<0)fail('Current version is incompatible');
 if(m.maxVersion&&compare(currentVersion,m.maxVersion)>0)fail('Current version is incompatible');
 return Object.freeze({...m});
}
// GitHub release URLs answer with a 302 to its CDN. Follow a few hops so the
// updater can read the manifest and the package on the published channel; the
// body of a redirect response is dropped, and the final URL is fetched normally.
async function resolveUpdateUrl(url,maxHops=5,timeout=15000){
 for(let i=0;i<maxHops;i++){const u=new URL(url);
  const r=await new Promise((resolve,reject)=>{const req=(u.protocol==="http:"?http:https).get(u,{timeout},resolve);req.on("timeout",()=>req.destroy(Error("Update URL timeout")));req.on("error",reject);});
  if(r.statusCode>=300&&r.statusCode<400&&r.headers.location){r.resume();url=new URL(r.headers.location,u).toString();continue;}
  r.destroy();return url;}
 throw Error("Update URL redirect loop");
}
async function getJson(url,maxBytes=256*1024){const target=await resolveUpdateUrl(url);return new Promise((resolve,reject)=>{const u=new URL(target);if((u.protocol!=='https:'&&!(isLocalFeed()&&u.protocol==='http:'&&['127.0.0.1','::1'].includes(u.hostname)))||u.username||u.password||u.hash)throw Error('Public manifest must use HTTPS without credentials');(u.protocol==='http:'?http:https).get(u,{timeout:15000},r=>{let n=0,body='';r.on('error',reject);r.on('aborted',()=>reject(Error('Manifest response interrupted')));if(r.statusCode!==200){r.resume();return reject(Error('Manifest HTTP '+r.statusCode));}r.setEncoding('utf8');r.on('data',c=>{n+=Buffer.byteLength(c);if(n>maxBytes)r.destroy(Error('Manifest too large'));else body+=c;});r.on('end',()=>{try{resolve(JSON.parse(body));}catch{reject(Error('Invalid manifest JSON'));}});}).on('timeout',function(){this.destroy(Error('Manifest timeout'));}).on('error',reject);});}
async function download(url,destination,expected,maxBytes=2*1024*1024*1024){const target=await resolveUpdateUrl(url,5,120000);return new Promise((resolve,reject)=>{let done=false,bytes=0;const end=e=>{if(done)return;done=true;out.destroy();fs.rmSync(destination,{force:true});reject(e)};const out=fs.createWriteStream(destination,{flags:'wx',mode:0o600});const h=crypto.createHash('sha256');const req=(String(target).startsWith('http:')?http:https).get(target,{timeout:120000},r=>{if(r.statusCode!==200)return end(Error('Package HTTP '+r.statusCode));if(Number(r.headers['content-length'])>maxBytes)return end(Error('Package too large'));r.on('data',c=>{bytes+=c.length;if(bytes>maxBytes)r.destroy(Error('Package too large'));else h.update(c)});r.on('error',end);r.pipe(out);out.on('finish',()=>out.close(()=>{if(done)return;done=true;const got=h.digest('hex');if(got!==expected){fs.rmSync(destination,{force:true});return reject(Error('Package digest mismatch'));}resolve(destination)}));}).on('timeout',function(){this.destroy(Error('Package timeout'))}).on('error',end);out.on('error',end);});}
async function checkAndStage({manifestUrl,publicKey,currentVersion,channel='dev',stagingDir,manifest:given}){const m=given?validateManifest(given,{publicKey,currentVersion,channel}):validateManifest(await getJson(manifestUrl),{publicKey,currentVersion,channel});fs.mkdirSync(stagingDir,{recursive:true,mode:0o700});const file=path.join(stagingDir,`${m.version}.zip`);if(fs.existsSync(file)&&sha256(file)===m.sha256)return {manifest:m,package:file};if(fs.existsSync(file))fs.rmSync(file,{force:true});
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
 constructor(options){this.options=options;this.status='idle';this.manifest=null;this.package=null;this.source=null;}
 emit(status,detail){this.status=status;this.options.onStatus?.({status,detail,manifest:this.manifest,source:this.source});}
 // The public GitHub release channel is authoritative; the legacy signed
 // manifest stays as a fallback so an install that already trusts the old host
 // still receives the release that moves it onto the new channel.
 async resolve({allowEqual=false}={}){
  const {publicKey,currentVersion,channel='stable',manifestUrl,repo,githubToken}=this.options;
  if(!publicKey)fail('Release trust is not configured');
  const attempts=[];
  if(repo)attempts.push({name:'github',run:async()=>{const {readFeed}=require('./github.cjs');const {manifest,release}=await readFeed({repo,publicKey,currentVersion,channel,allowEqual,token:githubToken});return {manifest,source:'github',release};}});
  const legacy=this.options.legacyManifestUrl;
  const primary=manifestUrl;
  if(primary)attempts.push({name:'manifest',run:async()=>({manifest:validateManifest(await getJson(primary),{publicKey,currentVersion,channel,allowEqual}),source:'manifest',release:null})});
  // Older installs trust the previous host; it can still deliver the release
  // that moves them onto the GitHub channel.
  if(legacy&&legacy!==primary)attempts.push({name:'legacy',run:async()=>({manifest:validateManifest(await getJson(legacy),{publicKey,currentVersion,channel,allowEqual}),source:'legacy',release:null})});
  if(!attempts.length)fail('No update channel is configured');
  const errors=[];
  for(const attempt of attempts){
   try{
    const {manifest,source,release}=await attempt.run();
    if(this.manifest&&compare(manifest.version,this.manifest.version)<0)return {manifest:this.manifest,source:this.source,release:this.release};
    this.manifest=manifest;this.source=source;this.release=release||null;
    return {manifest,source,release:this.release};
   }catch(error){errors.push(attempt.name+': '+error.message);}
  }
  fail('No published update could be verified ('+errors.join('; ')+')');
 }
 async check(){
  this.emit('checking');
  const {manifest,source}=await this.resolve({allowEqual:true});
  this.emit(compare(manifest.version,this.options.currentVersion)===0?'up-to-date':'available',{version:manifest.version,source});
  return manifest;
 }
 async download(){
  if(!this.manifest)await this.check();
  if(compare(this.manifest.version,this.options.currentVersion)<=0)return {manifest:this.manifest,package:null};
  this.emit('downloading');
  const staged=await checkAndStage({...this.options,manifestUrl:this.source==='github'?undefined:this.options.manifestUrl,manifest:this.manifest,stagingDir:this.options.stagingDir});
  this.manifest=staged.manifest;this.package=staged.package;this.emit('ready');return staged;
 }
 // A GitHub release ships one asset; a legacy manifest may ship signed parts.
 async stage(manifest){
  if(manifest.parts)return checkAndStage({...this.options,manifest});
  fs.mkdirSync(this.options.stagingDir,{recursive:true,mode:0o700});
  const file=path.join(this.options.stagingDir,manifest.version+'.zip');
  if(fs.existsSync(file)&&sha256(file)===manifest.sha256)return {manifest,package:file};
  fs.rmSync(file,{force:true});
  await download(manifest.url,file,manifest.sha256,manifest.bytes);
  return {manifest,package:file};
 }
 installMetadata(local){if(!this.package||sha256(this.package)!==this.manifest.sha256)fail('Verified package is not staged');return {package:this.package,metadata:installerMetadata(this.manifest,local)};}
 // Builds the ONE valid Rescue staging folder, then starts the independent
 // installer. Returns immediately after the handover; Rescue owns the rest.
 async install(local={}){
  if(['installing','pending-restart'].includes(this.status))fail('Update installation is already running');
  if(!this.package||!this.manifest)fail('Verified package is not staged');
  const manifest=validateManifest(this.manifest,this.options);
  this.emit('installing');
  try{
   const prepared=prepareUpdateForRescue(this.package,manifest,{stagingDir:this.options.stagingDir,backupKeyAccount:local.backupKeyAccount,onProgress:s=>this.emit(s.status,{folder:s.folder})});
   const child=startRescueInstall({folder:prepared.folder});
   await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
   child.once('exit',code=>{if(code)this.emit('error','Update did not complete. NODO Rescue kept the previous code and user data; open Rescue for details.');});
   child.unref();this.emit('pending-restart',{folder:prepared.folder,version:manifest.version});
   return {pending:true,folder:prepared.folder,app:prepared.app,version:manifest.version,pid:child.pid};
  }catch(e){this.emit('error',e.message);throw e;}
 }
}
// Called only after signature + package digest verification. It deliberately
// serializes no remote filesystem path: Rescue derives profile and app target.
function installerMetadata(manifest,{backupKeyAccount,testOnly,targetApp,dataPath}={}){const out={schema:3,kind:manifest.kind,version:manifest.version};if(manifest.kind==='migration'){if(!/^[0-9a-f-]{36}$/i.test(backupKeyAccount||''))fail('Migration requires a local recovery Keychain account');out.backupKeyAccount=backupKeyAccount;}
 // A local test harness may nominate its own application, profile and Rescue
 // state root. Rescue accepts those only under a temporary root, so testOnly can
 // never point an install at the installed NODO or at the user profile.
 if(testOnly===true){
  if(typeof targetApp!=='string'||!path.isAbsolute(targetApp)||path.basename(targetApp)!=='NODO.app')fail('Synthetic install requires an absolute NODO.app path');
  if(typeof dataPath!=='string'||!path.isAbsolute(dataPath))fail('Synthetic install requires an absolute profile path');
  out.testOnly=true;out.targetApp=targetApp;out.dataPath=dataPath;
 }
 return out;}
// THE single staging contract. NODORescue install reads exactly
//   <folder>/update.json  plus  <folder>/NODO.app (with its integrity manifest)
//   and  <folder>/NODO Rescue.app
// so nothing else in NODO may assemble a Rescue staging folder by hand.
// Callers get back a folder that has already passed the same integrity checks
// Rescue performs, and must hand it to `NODORescue install <folder>` unchanged.
function rescueContract(folder){
 const app=path.join(folder,'NODO.app'),rescue=path.join(folder,'NODO Rescue.app','Contents','MacOS','NODORescue');
 const required=[path.join(folder,'update.json'),path.join(app,'Contents','Info.plist'),path.join(app,'Contents','Resources','nodo-manifest.json'),rescue];
 for(const file of required)if(!fs.existsSync(file))fail('Update staging folder is incomplete: '+path.relative(folder,file));
 const update=JSON.parse(fs.readFileSync(path.join(folder,'update.json'),'utf8'));
 if(update.schema!==3||!['patch','migration'].includes(update.kind))fail('Update staging metadata is not schema 3 patch/migration');
 const integrity=JSON.parse(fs.readFileSync(path.join(app,'Contents','Resources','nodo-manifest.json'),'utf8'));
 if(integrity.schema!==2||integrity.signatureRequired!==true)fail('Staged app has no signature policy schema 2 manifest');
 checkedExec('/usr/bin/codesign',['--verify','--deep','--strict',app]);
 checkedExec('/usr/bin/codesign',['--verify','--deep','--strict',path.join(folder,'NODO Rescue.app')]);
 return {folder,app,rescue,version:update.version,kind:update.kind};
}
function prepareUpdateForRescue(zip,manifest,{stagingDir,backupKeyAccount,onProgress,testOnly,targetApp,dataPath}={}){
 if(sha256(zip)!==manifest.sha256)fail('Verified package changed before install');
 const root=path.resolve(stagingDir||path.dirname(zip));fs.mkdirSync(root,{recursive:true,mode:0o700});
 // The folder name carries the version only; Rescue resolves the target itself.
 const folder=path.join(root,'install-'+manifest.version+'-'+Date.now()+'-'+crypto.randomBytes(4).toString('hex'));
 try{
  fs.mkdirSync(folder,{recursive:false,mode:0o700});
  const app=unpackVerifiedZip(zip,manifest.sha256,folder);
  fs.writeFileSync(path.join(folder,'update.json'),JSON.stringify(installerMetadata(manifest,{backupKeyAccount,testOnly,targetApp,dataPath}),null,1),{mode:0o600});
  onProgress?.({status:'staged',folder});
  return {...rescueContract(folder),stagedApp:app};
 }catch(error){fs.rmSync(folder,{recursive:true,force:true});throw error;}
}
// Starts the independent installer. NODORescue owns shutdown coordination,
// backup, swap, start, health verification and rollback from this point on; the
// main process only waits for it to take over.
function startRescueInstall({folder,logFile}={}){
 const {rescue}=rescueContract(folder);
 const log=fs.openSync(logFile||path.join(folder,'installer.log'),'a',0o600);
 let child;try{child=cp.spawn(rescue,['install',folder],{detached:true,stdio:['ignore',log,log],shell:false});}finally{fs.closeSync(log);}
 return child;
}
module.exports={compare,validateManifest,getJson,download,checkAndStage,installerMetadata,unpackVerifiedZip,rescueContract,prepareUpdateForRescue,startRescueInstall,Updater};
