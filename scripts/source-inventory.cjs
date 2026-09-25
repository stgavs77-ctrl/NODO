#!/usr/bin/env node
// Regenerates or checks source-inventory.json (sha256 of every listed source file).
// Usage: node scripts/source-inventory.cjs [--check] [--add path ...]
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),file=path.join(root,'source-inventory.json');
const args=process.argv.slice(2),check=args.includes('--check');
const added=args.filter((a,i)=>args[i-1]==='--add');
const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(path.join(root,p))).digest('hex');
const rows=JSON.parse(fs.readFileSync(file,'utf8'));
for(const p of added)if(!rows.some(r=>r.path===p))rows.push({path:p,sha256:''});
const problems=[];
for(const r of rows){
 if(!fs.existsSync(path.join(root,r.path))){problems.push('missing '+r.path);continue;}
 const h=hash(r.path);if(h!==r.sha256){problems.push('changed '+r.path);r.sha256=h;}
}
if(check){if(problems.length){console.error(problems.join('\n'));process.exit(1);}console.log('source-inventory: '+rows.length+' files match');}
else{fs.writeFileSync(file,JSON.stringify(rows,null,2)+'\n');console.log('source-inventory: '+rows.length+' files, '+problems.length+' updated');}
