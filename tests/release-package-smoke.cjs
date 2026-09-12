'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {validateManifest,unpackVerifiedZip}=require('../lib/updater.cjs');
const root=path.resolve(__dirname,'..'),out=fs.mkdtempSync(path.join(os.tmpdir(),'nodo-release-package-test-'));
const keys=crypto.generateKeyPairSync('ed25519');
const publicKey=keys.publicKey.export({format:'der',type:'spki'}).toString('base64');
// Synthetic private key exists only in process memory/env, never in package or disk.
const env={...process.env,NODO_RELEASE_PRIVATE_KEY:keys.privateKey.export({format:'der',type:'pkcs8'}).toString('base64')};
try{
 cp.execFileSync(process.execPath,[path.join(root,'scripts/release.cjs'),'--out',out,'--url','https://release.invalid/NODO.zip','--version','0.2.1'],{env,stdio:'inherit',timeout:600000});
 const manifest=JSON.parse(fs.readFileSync(path.join(out,'manifest.json')));validateManifest(manifest,{publicKey,currentVersion:'0.2.0',channel:'stable'});
 const stage=path.join(out,'verified'),app=unpackVerifiedZip(path.join(out,'NODO-0.2.1.zip'),manifest.sha256,stage);
 const project=path.join(app,'Contents/Resources/project');
 assert.equal(JSON.parse(fs.readFileSync(path.join(project,'build-mode.json'))).mode,'release');
 assert.equal(JSON.parse(fs.readFileSync(path.join(project,'package.json'))).version,'0.2.1');
 cp.execFileSync(path.join(stage,'NODO Rescue.app/Contents/MacOS/NODORescue'),['verify',app],{stdio:'inherit',timeout:120000});
 console.log('PASS actual release build -> signed manifest -> safe unzip -> release profile/version -> native integrity; not installed');
}finally{delete env.NODO_RELEASE_PRIVATE_KEY;fs.rmSync(out,{recursive:true,force:true});}
