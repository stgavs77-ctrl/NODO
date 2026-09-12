'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(process.argv[2]||path.join(__dirname,'../runtime')),manifest=require('../patches/bootstrap.json'),hash=s=>crypto.createHash('sha256').update(s).digest('hex');
const changes=manifest.entries.map(p=>{const file=path.join(root,p.file),current=fs.readFileSync(file,'utf8');if(hash(current)===p.targetHash)return null;if(hash(current)!==p.originalHash||current.slice(p.offset,p.offset+p.remove.length)!==p.remove)throw Error('Unknown pristine runtime source: '+p.file);const result=current.slice(0,p.offset)+p.insert+current.slice(p.offset+p.remove.length);if(hash(result)!==p.targetHash)throw Error('Bootstrap delta mismatch');return {file,result};}).filter(Boolean);
for(const {file,result} of changes){fs.writeFileSync(file+'.bootstrap.tmp',result);fs.renameSync(file+'.bootstrap.tmp',file);}console.log('Verified runtime normalization:',changes.length,'files');
