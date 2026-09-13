'use strict';

// Pure Node backend for a custom Electron protocol.  It deliberately has no
// Electron dependency: the main process owns protocol registration and passes
// its trusted IPC descriptors or URL tokens to this module.
const crypto=require('node:crypto');
const fs=require('node:fs/promises');
const nodeFs=require('node:fs');
const {Readable}=require('node:stream');
const {constants:fsConstants}=nodeFs;
const path=require('node:path');

const SNIFF_BYTES=4096;
const DEFAULT_MAX_BYTES=512*1024*1024;
const MIME_BY_KIND=Object.freeze({
 image:Object.freeze({png:'image/png',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp'}),
 audio:Object.freeze({mp3:'audio/mpeg',wav:'audio/wav',ogg:'audio/ogg'}),
 video:Object.freeze({mp4:'video/mp4',webm:'video/webm'}),
 pdf:Object.freeze({pdf:'application/pdf'})
});

class MediaPreviewError extends Error{
 constructor(code,message){super(message);this.name='MediaPreviewError';this.code=code;}
}

function isInside(root,target){return target===root||target.startsWith(root+path.sep);}
function mimeFor(kind,format){return MIME_BY_KIND[kind]?.[format];}

function sniff(bytes){
 const has=(offset,...values)=>values.every((v,index)=>bytes[offset+index]===v);
 if(bytes.length>=8&&has(0,0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a))return {kind:'image',format:'png'};
 if(bytes.length>=3&&has(0,0xff,0xd8,0xff))return {kind:'image',format:'jpeg'};
 if(bytes.length>=6&&(has(0,0x47,0x49,0x46,0x38,0x37,0x61)||has(0,0x47,0x49,0x46,0x38,0x39,0x61)))return {kind:'image',format:'gif'};
 if(bytes.length>=12&&bytes.subarray(0,4).toString('ascii')==='RIFF'&&bytes.subarray(8,12).toString('ascii')==='WEBP')return {kind:'image',format:'webp'};
 if(bytes.length>=12&&bytes.subarray(0,4).toString('ascii')==='RIFF'&&bytes.subarray(8,12).toString('ascii')==='WAVE')return {kind:'audio',format:'wav'};
 if(bytes.length>=4&&bytes.subarray(0,4).toString('ascii')==='OggS')return {kind:'audio',format:'ogg'};
 if(bytes.length>=3&&bytes.subarray(0,3).toString('ascii')==='ID3')return {kind:'audio',format:'mp3'};
 if(bytes.length>=2&&bytes[0]===0xff&&(bytes[1]&0xe0)===0xe0)return {kind:'audio',format:'mp3'};
 if(bytes.length>=8&&bytes.subarray(4,8).toString('ascii')==='ftyp')return {kind:'video',format:'mp4'};
 if(bytes.length>=4&&has(0,0x1a,0x45,0xdf,0xa3))return {kind:'video',format:'webm'};
 if(bytes.length>=5&&bytes.subarray(0,5).toString('ascii')==='%PDF-')return {kind:'pdf',format:'pdf'};
 return {kind:'unknown',format:'unknown'};
}

function parseRange(value,size){
 if(value===undefined||value===null||value==='')return {start:0,end:size-1,partial:false};
 if(typeof value!=='string')throw new MediaPreviewError('RANGE_INVALID','Range must be a string');
 const match=/^bytes=(\d*)-(\d*)$/.exec(value.trim());
 if(!match||size===0)throw new MediaPreviewError('RANGE_NOT_SATISFIABLE','Only one satisfiable bytes range is supported');
 let [,left,right]=match;
 let start,end;
 if(left===''){
  const suffix=Number(right);if(!Number.isSafeInteger(suffix)||suffix<=0)throw new MediaPreviewError('RANGE_NOT_SATISFIABLE','Invalid suffix range');
  start=Math.max(0,size-suffix);end=size-1;
 }else{
  start=Number(left);end=right===''?size-1:Math.min(Number(right),size-1);
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start> end||start>=size)throw new MediaPreviewError('RANGE_NOT_SATISFIABLE','Invalid byte range');
 }
 return {start,end,partial:true};
}

class MediaPreview{
 constructor({workspaceRoots,maxBytes=DEFAULT_MAX_BYTES,maxBytesByKind={},tokenTtlMs=5*60*1000,tokenMax=1024,protocol='nodo-media',clock=()=>Date.now()}={}){
  if(!Array.isArray(workspaceRoots)||workspaceRoots.length===0)throw new MediaPreviewError('ROOTS_REQUIRED','workspaceRoots must contain at least one directory');
  if(!Number.isSafeInteger(maxBytes)||maxBytes<1)throw new MediaPreviewError('LIMIT_INVALID','maxBytes must be a positive safe integer');
  if(!Number.isSafeInteger(tokenMax)||tokenMax<1)throw new MediaPreviewError('TOKEN_LIMIT_INVALID','tokenMax must be a positive safe integer');
  this.workspaceRoots=[...workspaceRoots];this.maxBytes=maxBytes;this.maxBytesByKind={...maxBytesByKind};this.tokenTtlMs=tokenTtlMs;this.tokenMax=tokenMax;this.protocol=protocol;this.clock=clock;this.tokens=new Map();
 }
 async #roots(){
  const roots=[];
  for(const root of this.workspaceRoots){
   try{const provided=path.resolve(root),canonical=await fs.realpath(provided);const stat=await fs.stat(canonical);if(stat.isDirectory())roots.push({provided,canonical});}catch{}
  }
  if(roots.length===0)throw new MediaPreviewError('ROOT_UNAVAILABLE','No supplied workspace root is available');
  return roots;
 }
 async #file(filePath){
  if(typeof filePath!=='string'||filePath.length===0)throw new MediaPreviewError('PATH_INVALID','A local file path is required');
  const roots=await this.#roots(),requestedPath=path.resolve(filePath);
  const rootRecord=roots.find(candidate=>isInside(candidate.provided,requestedPath)||isInside(candidate.canonical,requestedPath));
  if(!rootRecord)throw new MediaPreviewError('OUTSIDE_WORKSPACE','Preview path is outside supplied workspace roots');
  const lexicalRoot=isInside(rootRecord.canonical,requestedPath)?rootRecord.canonical:rootRecord.provided;
  try{await this.#assertNoSymlinks(lexicalRoot,requestedPath,'PATH_PENDING');}catch(error){if(error?.code==='PATH_PENDING')return null;throw error;}
  let resolved;
  try{resolved=await fs.realpath(filePath);}catch(error){if(error?.code==='ENOENT'||error?.code==='ENOTDIR')return null;throw new MediaPreviewError('PATH_UNREADABLE','Preview file cannot be resolved');}
  const root=roots.find(candidate=>isInside(candidate.canonical,resolved))?.canonical;
  if(!root)throw new MediaPreviewError('OUTSIDE_WORKSPACE','Preview path is outside supplied workspace roots');
  let stat;try{stat=await fs.stat(resolved);}catch(error){if(error?.code==='ENOENT')return null;throw new MediaPreviewError('PATH_UNREADABLE','Preview file cannot be read');}
  if(!stat.isFile())throw new MediaPreviewError('NOT_REGULAR_FILE','Only regular local files may be previewed');
  return {path:resolved,root,stat};
 }
 async #assertNoSymlinks(root,target,missingCode='PREVIEW_CHANGED'){
  const relative=path.relative(root,target);
  if(relative===''||relative.startsWith('..')||path.isAbsolute(relative))throw new MediaPreviewError('OUTSIDE_WORKSPACE','Preview path escaped supplied workspace root');
  let current=root;
  for(const part of relative.split(path.sep)){
   current=path.join(current,part);
   let stat;try{stat=await fs.lstat(current);}catch(error){if(error?.code==='ENOENT'||error?.code==='ENOTDIR')throw new MediaPreviewError(missingCode,'Preview path changed during verification');throw new MediaPreviewError('PATH_UNREADABLE','Preview path cannot be verified');}
   if(stat.isSymbolicLink())throw new MediaPreviewError('SYMLINK_DISALLOWED','Preview path contains a symlink below its workspace root');
  }
 }
 async #openStable(file){
  // This is a best-effort Node filesystem race defence, not an OS capability
  // sandbox: it rejects symlinks below the canonical root and binds all reads to
  // one verified fd. The post-open identity check detects a path swap before it
  // can be streamed.
  await this.#assertNoSymlinks(file.root,file.path);
  let handle;try{handle=await fs.open(file.path,fsConstants.O_RDONLY|fsConstants.O_NOFOLLOW);}catch{throw new MediaPreviewError('PATH_UNREADABLE','Preview file cannot be opened safely');}
  try{
   const live=await handle.stat();
   if(!live.isFile())throw new MediaPreviewError('NOT_REGULAR_FILE','Only regular local files may be previewed');
   await this.#assertNoSymlinks(file.root,file.path);
   const afterPath=await fs.realpath(file.path),after=await fs.stat(afterPath);
   if(afterPath!==file.path||after.dev!==live.dev||after.ino!==live.ino)throw new MediaPreviewError('PREVIEW_CHANGED','Preview path changed during safe open');
   return {handle,stat:live};
  }catch(error){await handle.close();throw error;}
 }
 async #openStableFd(file){
  await this.#assertNoSymlinks(file.root,file.path);
  let fd;try{fd=nodeFs.openSync(file.path,fsConstants.O_RDONLY|fsConstants.O_NOFOLLOW);}catch{throw new MediaPreviewError('PATH_UNREADABLE','Preview file cannot be opened safely');}
  try{
   const live=nodeFs.fstatSync(fd);
   if(!live.isFile())throw new MediaPreviewError('NOT_REGULAR_FILE','Only regular local files may be previewed');
   await this.#assertNoSymlinks(file.root,file.path);
   const afterPath=await fs.realpath(file.path),after=await fs.stat(afterPath);
   if(afterPath!==file.path||after.dev!==live.dev||after.ino!==live.ino)throw new MediaPreviewError('PREVIEW_CHANGED','Preview path changed during safe open');
   return {fd,stat:live};
  }catch(error){try{nodeFs.closeSync(fd);}catch{}throw error;}
 }
 async #openDescriptor(descriptor){
  const file=await this.#file(descriptor.path);if(!file)throw new MediaPreviewError('PREVIEW_UNAVAILABLE','Preview is pending');
  const opened=await this.#openStableFd(file),live=opened.stat;
  try{
   if(live.size!==descriptor.size)throw new MediaPreviewError('PREVIEW_CHANGED','Preview file changed before streaming');
   const bytes=Buffer.alloc(Math.min(SNIFF_BYTES,live.size));if(bytes.length)nodeFs.readSync(opened.fd,bytes,0,bytes.length,0);
   const current=sniff(bytes),currentMime=mimeFor(current.kind,current.format);
   if(currentMime!==descriptor.mime)throw new MediaPreviewError('PREVIEW_CHANGED','Preview signature changed before streaming');
   return opened;
  }catch(error){try{nodeFs.closeSync(opened.fd);}catch{}throw error;}
 }
 async *#readDescriptor(descriptor,range){
  const opened=await this.#openDescriptor(descriptor);let position=range.start;
  try{while(position<=range.end){const bytes=Buffer.allocUnsafe(Math.min(64*1024,range.end-position+1)),read=nodeFs.readSync(opened.fd,bytes,0,bytes.length,position);if(read===0)throw new MediaPreviewError('PREVIEW_CHANGED','Preview file changed while streaming');position+=read;yield bytes.subarray(0,read);}}
  finally{try{nodeFs.closeSync(opened.fd);}catch{}}
 }
 #limit(kind){const value=this.maxBytesByKind[kind]??this.maxBytes;return Number.isSafeInteger(value)&&value>0?value:this.maxBytes;}
 async readText(filePath,maxBytes=1024*1024){
  const file=await this.#file(filePath);if(!file)throw new MediaPreviewError('PREVIEW_UNAVAILABLE','File not ready');
  const opened=await this.#openStable(file);
  try{if(opened.stat.size>maxBytes)throw new MediaPreviewError('TEXT_LIMIT','Text preview exceeds 1 MiB');const buffer=Buffer.alloc(maxBytes+1),result=await opened.handle.read(buffer,0,buffer.length,0);if(result.bytesRead>maxBytes)throw new MediaPreviewError('TEXT_LIMIT','Text preview exceeds 1 MiB');const text=new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,result.bytesRead));if(text.includes('\0'))throw new MediaPreviewError('TEXT_BINARY','Binary files require Reveal in Finder');return text;}finally{await opened.handle.close();}
 }
 async inspect(filePath){
  const file=await this.#file(filePath);
  if(!file)return {status:'pending',retryable:true,path:filePath};
  const opened=await this.#openStable(file);let bytes;
  try{bytes=Buffer.alloc(Math.min(SNIFF_BYTES,opened.stat.size));if(bytes.length)await opened.handle.read(bytes,0,bytes.length,0);}finally{await opened.handle.close();}
  const detected=sniff(bytes),mime=mimeFor(detected.kind,detected.format),base={name:path.basename(file.path),mime:mime||'application/octet-stream',size:opened.stat.size,path:file.path,kind:detected.kind,format:detected.format};
  if(!mime)return {...base,status:'unsupported',playable:false,reason:'unrecognized_signature'};
  if(file.stat.size>this.#limit(detected.kind))return {...base,status:'rejected',playable:false,reason:'too_large',maxBytes:this.#limit(detected.kind)};
  return {...base,status:'ready',playable:true,...(detected.kind==='pdf'?{preview:{mode:'pdf',initialPage:1,backendEnforcesFirstPage:false}}:{})};
 }
 #pruneTokens(){
  const now=this.clock();for(const [token,entry] of this.tokens){if(entry.expiresAt<=now)this.tokens.delete(token);}
  while(this.tokens.size>=this.tokenMax)this.tokens.delete(this.tokens.keys().next().value);
 }
 async issue(filePath){
  const descriptor=await this.inspect(filePath);
  if(descriptor.status!=='ready')return descriptor;
  this.#pruneTokens();const token=crypto.randomUUID();const expiresAt=this.clock()+this.tokenTtlMs;
  this.tokens.set(token,{path:descriptor.path,expiresAt});
  return {...descriptor,token,expiresAt,url:`${this.protocol}://preview/${encodeURIComponent(token)}`};
 }
 async openToken(token,rangeHeader){
  const entry=this.tokens.get(token);
  if(!entry||entry.expiresAt<=this.clock()){this.tokens.delete(token);throw new MediaPreviewError('TOKEN_INVALID','Preview token is invalid or expired');}
  const descriptor=await this.inspect(entry.path);
  if(descriptor.status!=='ready')throw new MediaPreviewError('PREVIEW_UNAVAILABLE',`Preview is ${descriptor.status}`);
  const range=parseRange(rangeHeader,descriptor.size),length=range.end-range.start+1;
  const checked=await this.#openDescriptor(descriptor);try{nodeFs.closeSync(checked.fd);}catch{}
  const headers={'Content-Type':descriptor.mime,'Content-Length':String(length),'Accept-Ranges':'bytes','X-Content-Type-Options':'nosniff','Content-Security-Policy':"sandbox; default-src 'none'",'Content-Disposition':`inline; filename*=UTF-8''${encodeURIComponent(descriptor.name)}`};
  if(range.partial)headers['Content-Range']=`bytes ${range.start}-${range.end}/${descriptor.size}`;
  return {status:range.partial?206:200,headers,stream:Readable.from(this.#readDescriptor(descriptor,range)),descriptor,start:range.start,end:range.end};
 }
 async openUrl(url,rangeHeader){
  const parsed=new URL(url);if(parsed.protocol!==`${this.protocol}:`||parsed.hostname!=='preview')throw new MediaPreviewError('URL_INVALID','Not a media preview URL');
  const token=decodeURIComponent(parsed.pathname.replace(/^\//,''));if(!token)throw new MediaPreviewError('URL_INVALID','Preview URL has no token');
  return this.openToken(token,rangeHeader);
 }
 revoke(token){return this.tokens.delete(token);}
}

module.exports={MediaPreview,MediaPreviewError,sniff,parseRange};
