'use strict';
// No build or installation. Revalidate every prepared byte before signing.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const {sign,sha256,verify}=require('../lib/release-signature.cjs');
const dir=path.resolve(process.argv[2]||''),root=path.resolve(__dirname,'..');
if(!process.argv[2]||!dir.startsWith(path.join(root,'build/releases')+'/'))throw Error('Prepared release directory required');
const manifest=JSON.parse(fs.readFileSync(path.join(dir,'manifest.unsigned.json'),'utf8'));
if(!/^\d+\.\d+\.\d+$/.test(manifest.version)||manifest.signature)throw Error('Invalid unsigned manifest');
const zip=path.join(dir,'NODO-'+manifest.version+'.zip');
if(fs.statSync(zip).size!==manifest.bytes||sha256(zip)!==manifest.sha256)throw Error('Prepared ZIP changed');
for(const [index,part] of manifest.parts.entries()){const f=path.join(dir,'parts','part-'+String(index).padStart(3,'0'));if(fs.statSync(f).size!==part.bytes||sha256(f)!==part.sha256)throw Error('Prepared part changed');}
if(fs.existsSync(path.join(dir,'manifest.json')))throw Error('Signed manifest already exists');
let key;
try{key=cp.execFileSync('/usr/bin/security',['find-generic-password','-s','NODO Release Signing','-a','ed25519-v1','-w'],{encoding:'utf8',stdio:['ignore','pipe','ignore'],timeout:60000}).trim();}catch{throw Error('Release signing requires Keychain approval; prepared files are unchanged.');}
manifest.issuedAt=Date.now();manifest.expiresAt=manifest.issuedAt+30*86400000;manifest.signature=sign(manifest,key);
const trust=JSON.parse(fs.readFileSync(path.join(root,'config/release-trust.json'),'utf8'));
const {signature,...signedBody}=manifest;
if(!verify(signedBody,signature,trust.publicKey))throw Error('Signing key does not match pinned trust');
fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{mode:0o600});console.log('Prepared release signed and verified. No install or publication performed.');
