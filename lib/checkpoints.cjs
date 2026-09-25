const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {save,read}=require('./io.cjs');
class Checkpoints{
 constructor(data,options={}){this.root=options.root||path.join(data,'workspace');this.dir=options.dir||path.join(data,'checkpoints');fs.mkdirSync(this.root,{recursive:true});fs.mkdirSync(this.dir,{recursive:true});}
 resolve(relative){if(typeof relative!=='string'||!relative.trim())throw Error('File path required');const p=path.resolve(this.root,relative);if(!p.startsWith(this.root+path.sep))throw Error('RC files must stay inside the RC workspace');let q=p;while(q!==this.root){if(fs.existsSync(q)&&fs.lstatSync(q).isSymbolicLink())throw Error('Symlinks are not allowed for RC file operations');q=path.dirname(q);}return p;}
 create(files,task='manual'){if(!Array.isArray(files)||!files.length||files.length>100)throw Error('Select 1–100 files');const rows=files.map(f=>{const p=this.resolve(f);if(fs.existsSync(p)){const s=fs.statSync(p);if(!s.isFile()||s.size>10*1024*1024)throw Error('Checkpoint supports regular files up to 10 MB');return {path:path.relative(this.root,p),existed:true,bytes:fs.readFileSync(p).toString('base64'),mode:s.mode&0o777};}return{path:path.relative(this.root,p),existed:false};});const id=crypto.randomUUID();save(path.join(this.dir,id+'.json'),{id,at:new Date().toISOString(),task,files:rows});return{id,files:rows.map(r=>r.path)};}
 list(){return fs.readdirSync(this.dir).filter(n=>/^[a-f0-9-]{36}\.json$/.test(n)).map(n=>{try{return read(path.join(this.dir,n));}catch{return null;}}).filter(c=>c&&Array.isArray(c.files)&&typeof c.at==='string').map(({id,at,task,files})=>({id,at,task,files:files.map(f=>f.path)})).sort((a,b)=>b.at.localeCompare(a.at));}
 restore(id){if(!/^[a-f0-9-]{36}$/.test(id))throw Error('Invalid checkpoint');const c=read(path.join(this.dir,id+'.json'));const undo=this.create(c.files.map(f=>f.path),'before-restore:'+id);for(const f of c.files){const p=this.resolve(f.path);if(f.existed){fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,Buffer.from(f.bytes,'base64'),{mode:f.mode});}else if(fs.existsSync(p))fs.unlinkSync(p);}return{restored:c.files.map(f=>f.path),undo:undo.id};}
 write(file,text,task){if(typeof text!=='string'||Buffer.byteLength(text)>10*1024*1024)throw Error('Text file too large');const p=this.resolve(file),checkpoint=this.create([file],task);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,text,{mode:0o600});return{file,checkpoint:checkpoint.id};}
 read(file){const p=this.resolve(file);if(fs.statSync(p).size>1024*1024)throw Error('File exceeds 1 MB');return fs.readFileSync(p,'utf8');}
}
module.exports={Checkpoints};
