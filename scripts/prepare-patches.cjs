'use strict';
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const manifest=require('../patches/ui.json');
const hash=text=>crypto.createHash('sha256').update(text).digest('hex');
function prepare(root,{check=false}={}){
 // Validate every target before writing any of them. Never patch an unknown upgrade.
 const prepared=manifest.patches.map(p=>{
  const file=path.join(root,p.file);
  const version=JSON.parse(fs.readFileSync(path.join(root,'node_modules',p.package,'package.json'),'utf8')).version;
  if(version!==p.version)throw Error(`${p.package}: incompatible version ${version}; expected ${p.version}`);
  const current=fs.readFileSync(file,'utf8'),digest=hash(current);
  if(digest===p.patchedHash)return {file,status:'already-patched'};
  if(digest!==p.originalHash)throw Error(`${p.package}: unknown source hash; refusing to patch`);
  if(current.slice(p.offset,p.offset+p.remove.length)!==p.remove)throw Error(`${p.package}: patch anchor mismatch`);
  const result=current.slice(0,p.offset)+p.insert+current.slice(p.offset+p.remove.length);
  if(hash(result)!==p.patchedHash)throw Error(`${p.package}: patch result hash mismatch`);
  return {file,status:check?'needs-patch':'patched',result};
 });
 if(!check)for(const p of prepared)if(p.result!==undefined){const temporary=p.file+'.nodo-patch.tmp';fs.writeFileSync(temporary,p.result);fs.renameSync(temporary,p.file);}
 return prepared.map(({file,status})=>({file,status}));
}
module.exports={prepare};
if(require.main===module){try{const args=process.argv.slice(2);const root=args.find(x=>!x.startsWith('--'))||path.resolve(__dirname,'../runtime');console.log(JSON.stringify(prepare(root,{check:args.includes('--check')}),null,2));}catch(error){console.error(error.message);process.exitCode=1;}}
