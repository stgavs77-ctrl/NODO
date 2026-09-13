'use strict';

const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const {isUtf8}=require('node:buffer');

const MAX_FILES=100;
const MAX_PREVIEW_FILES=10;
const MAX_PREVIEW_BYTES=4000;

class ABActionsError extends Error{
 constructor(code,message){super(message);this.name='ABActionsError';this.code=code;}
}

function inside(root,target){return target===root||target.startsWith(root+path.sep);}
function hash(bytes){return crypto.createHash('sha256').update(bytes).digest('hex');}
function preview(bytes){
 if(!isUtf8(bytes))return null;
 let end=Math.min(bytes.length,MAX_PREVIEW_BYTES);while(end>0&&!isUtf8(bytes.subarray(0,end)))end--;
 return {encoding:'utf8',text:bytes.subarray(0,end).toString('utf8'),truncated:end<bytes.length};
}

class ABActions{
 constructor({checkpoints,storeFile}={}){
  if(!checkpoints||typeof checkpoints.create!=='function'||typeof checkpoints.restore!=='function'||typeof checkpoints.resolve!=='function'||typeof checkpoints.dir!=='string')throw new ABActionsError('CHECKPOINTS_REQUIRED','A Checkpoints instance is required');
  if(typeof storeFile!=='string'||!path.isAbsolute(storeFile))throw new ABActionsError('STORE_REQUIRED','An absolute AB state file is required');
  const dir=path.resolve(checkpoints.dir),store=path.resolve(storeFile);
  if(!inside(dir,store)||store===dir)throw new ABActionsError('STORE_OUTSIDE_CHECKPOINTS','AB state must stay inside the supplied checkpoint directory');
  this.checkpoints=checkpoints;this.storeFile=store;this.state=this.#load();
 }
 #load(){
  try{const value=JSON.parse(fs.readFileSync(this.storeFile,'utf8'));if(value?.schema!==1||!Array.isArray(value.actions))throw Error();return value;}catch(error){if(error.code==='ENOENT')return {schema:1,actions:[],activeId:null};throw new ABActionsError('STATE_INVALID','AB state is invalid');}
 }
 #save(){fs.mkdirSync(path.dirname(this.storeFile),{recursive:true,mode:0o700});const temp=this.storeFile+'.tmp';fs.writeFileSync(temp,JSON.stringify(this.state),{mode:0o600});fs.renameSync(temp,this.storeFile);}
 #active(){const action=this.state.actions.find(item=>item.id===this.state.activeId);if(!action)throw new ABActionsError('CREATE_REQUIRED','Create an A/B action first');return action;}
 #validateFiles(files){
  if(!Array.isArray(files)||files.length<1||files.length>MAX_FILES)throw new ABActionsError('FILES_INVALID','Select 1–100 files');
  const normalized=files.map(file=>{try{return path.relative(this.checkpoints.root,this.checkpoints.resolve(file));}catch{throw new ABActionsError('PATH_INVALID','A selected file is outside the checkpoint workspace or unsafe');}});
  if(new Set(normalized).size!==normalized.length)throw new ABActionsError('FILES_INVALID','Selected files must be unique');return normalized;
 }
 #snapshot(id,expectedFiles){
  if(typeof id!=='string'||!/^[a-f0-9-]{36}$/.test(id))throw new ABActionsError('SNAPSHOT_INVALID','Invalid A/B snapshot');
  const filename=path.resolve(this.checkpoints.dir,id+'.json');if(!inside(path.resolve(this.checkpoints.dir),filename))throw new ABActionsError('SNAPSHOT_INVALID','Invalid A/B snapshot');
  let value;try{value=JSON.parse(fs.readFileSync(filename,'utf8'));}catch{throw new ABActionsError('SNAPSHOT_UNAVAILABLE','A/B snapshot is unavailable');}
  if(value?.id!==id||!Array.isArray(value.files)||value.files.length!==expectedFiles.length)throw new ABActionsError('SNAPSHOT_INVALID','A/B snapshot does not match its action');
  const rows=new Map();for(const row of value.files){if(!row||typeof row.path!=='string'||!expectedFiles.includes(row.path)||rows.has(row.path))throw new ABActionsError('SNAPSHOT_INVALID','A/B snapshot has unsafe file paths');this.checkpoints.resolve(row.path);rows.set(row.path,row);}return rows;
 }
 create(files){
  const selected=this.#validateFiles(files),original=this.checkpoints.create(selected,'ab:original');
  const action={id:crypto.randomUUID(),files:selected,original:original.id,captures:{},createdAt:new Date().toISOString()};this.state.actions.push(action);this.state.actions=this.state.actions.slice(-50);this.state.activeId=action.id;this.#save();return {id:action.id,files:[...selected],original:original.id};
 }
 capture(label){
  if(label!=='A'&&label!=='B')throw new ABActionsError('LABEL_INVALID','Capture label must be A or B');const action=this.#active();
  if(label==='B'&&!action.captures.A)throw new ABActionsError('CAPTURE_A_REQUIRED','Capture A before B');
  const snapshot=this.checkpoints.create(action.files,'ab:'+action.id+':'+label);action.captures[label]=snapshot.id;this.#save();return {label,snapshot:snapshot.id,files:[...action.files]};
 }
 startB(){const action=this.#active();if(!action.captures.A)throw new ABActionsError('CAPTURE_A_REQUIRED','Capture A before starting B');const restored=this.checkpoints.restore(action.original);action.startedBAt=new Date().toISOString();this.#save();return {original:action.original,restored:restored.restored};}
 compare(){
  const action=this.#active();if(!action.captures.A||!action.captures.B)throw new ABActionsError('CAPTURES_REQUIRED','Capture both A and B before comparing');
  const snapshots={original:this.#snapshot(action.original,action.files),A:this.#snapshot(action.captures.A,action.files),B:this.#snapshot(action.captures.B,action.files)};
  const files=action.files.map((file,index)=>{const describe=row=>{if(!row.existed)return {status:'missing',size:0,sha256:null};const bytes=Buffer.from(row.bytes,'base64'),value={status:'present',size:bytes.length,sha256:hash(bytes)};if(index<MAX_PREVIEW_FILES){const text=preview(bytes);if(text)value.preview=text;}return value;};const original=describe(snapshots.original.get(file)),A=describe(snapshots.A.get(file)),B=describe(snapshots.B.get(file));const same=(left,right)=>left.status===right.status&&left.size===right.size&&left.sha256===right.sha256;return {path:file,original,A,B,status:{A:same(original,A)?'unchanged':'changed',B:same(original,B)?'unchanged':'changed',AtoB:same(A,B)?'same':'different'}};});
  return {id:action.id,files};
 }
 keepBoth(){
  const action=this.#active();if(!action.captures.A||!action.captures.B)throw new ABActionsError('CAPTURES_REQUIRED','Capture both A and B before keeping both');
  const snapshots={A:this.#snapshot(action.captures.A,action.files),B:this.#snapshot(action.captures.B,action.files)},planned=[];
  for(const file of action.files){for(const label of ['A','B']){const row=snapshots[label].get(file);if(!row.existed)continue;const relative=file+'.nodo-'+label,absolute=this.checkpoints.resolve(relative);if(fs.existsSync(absolute))throw new ABActionsError('VARIANT_EXISTS','A/B variant already exists: '+relative);planned.push({file,label,relative,absolute,bytes:Buffer.from(row.bytes,'base64')});}}
  const created=[];
  try{for(const item of planned){const checkpoint=this.checkpoints.create([item.relative],'ab:'+action.id+':keep-both:'+item.label);let fd;try{fd=fs.openSync(item.absolute,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);fs.writeFileSync(fd,item.bytes);}finally{if(fd!==undefined)fs.closeSync(fd);}created.push({...item,checkpoint:checkpoint.id});}}
  catch(error){for(const item of created.toReversed()){try{this.checkpoints.restore(item.checkpoint);}catch{}}throw error;}
  const variants=action.files.map(file=>({path:file,A:created.find(item=>item.file===file&&item.label==='A')&&{path:file+'.nodo-A',checkpoint:created.find(item=>item.file===file&&item.label==='A').checkpoint},B:created.find(item=>item.file===file&&item.label==='B')&&{path:file+'.nodo-B',checkpoint:created.find(item=>item.file===file&&item.label==='B').checkpoint}}));
  action.kept='both';action.keptAt=new Date().toISOString();this.#save();return {kept:'both',variants};
 }
 keep(label){
  if(label==='both')return this.keepBoth();
  if(!['original','A','B'].includes(label))throw new ABActionsError('LABEL_INVALID','Keep label must be original, A, B or both');const action=this.#active(),snapshot=label==='original'?action.original:action.captures[label];if(!snapshot)throw new ABActionsError('CAPTURE_REQUIRED','Requested A/B snapshot has not been captured');const restored=this.checkpoints.restore(snapshot);action.kept=label;action.keptAt=new Date().toISOString();this.#save();return {kept:label,restored:restored.restored};
 }
}

module.exports={ABActions,ABActionsError};
