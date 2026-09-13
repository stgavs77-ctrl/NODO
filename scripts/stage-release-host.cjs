'use strict';
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),version=require('../package.json').version;
const from=path.join(root,'build/releases',version),m=JSON.parse(fs.readFileSync(path.join(from,'manifest.json')));
const {validateManifest}=require('../lib/updater.cjs');validateManifest(m,{...require('../config/release-trust.json'),currentVersion:'0.2.0'});
const dest=path.join(root,'build/release-host-assets');
if(fs.existsSync(dest))fs.renameSync(dest,dest+'-previous-'+Date.now());fs.mkdirSync(dest,{recursive:true});
const {sha256}=require('../lib/release-signature.cjs');
if(sha256(path.join(from,'NODO-'+version+'.zip'))!==m.sha256)throw Error('Package digest mismatch');
for(const p of m.parts){const name=path.basename(new URL(p.url).pathname),source=path.join(from,'parts',name);if(sha256(source)!==p.sha256||fs.statSync(source).size!==p.bytes)throw Error('Part mismatch');const target=path.join(dest,new URL(p.url).pathname);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(source,target);}
for(const file of ['manifest.json','release-notes.md'])fs.copyFileSync(path.join(from,file),path.join(dest,file));
fs.writeFileSync(path.join(root,'release-host/catalog.json'),JSON.stringify({path:new URL(m.url).pathname,bytes:m.bytes,parts:m.parts.map(p=>new URL(p.url).pathname)}));
console.log('Verified release staged: '+m.parts.length+' immutable signed parts, '+m.bytes+' bytes');
