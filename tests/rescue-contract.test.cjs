'use strict';
// One integration test for the single Rescue staging contract. Every part of
// NODO that prepares an update uses prepareUpdateForRescue, so a mismatch like
// the earlier update.json / nodo-manifest.json confusion must fail here instead
// of failing in front of a user during an install.
const test=require('node:test'),assert=require('node:assert'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process');
const root=path.resolve(__dirname,'..');
const {rescueContract,prepareUpdateForRescue,installerMetadata}=require('../lib/updater.cjs');
const {sha256}=require('../lib/release-signature.cjs');
const version=require('../package.json').version;
const zip=path.join(root,'build/releases',version,'NODO-'+version+'.zip');
const manifest=path.join(root,'build/releases',version,'latest.json');
const available=fs.existsSync(zip)&&fs.existsSync(manifest);
const work=fs.mkdtempSync(path.join(os.tmpdir(),'nodo-contract-'));

test('staging contract: a folder without update.json is rejected',{skip:!available&&'run npm run release -- --local first'},()=>{
 const manifestJson=JSON.parse(fs.readFileSync(manifest,'utf8'));
 const staged=prepareUpdateForRescue(zip,manifestJson,{stagingDir:work});
 assert.ok(fs.existsSync(path.join(staged.folder,'update.json')),'update.json is written by the helper');
 assert.equal(rescueContract(staged.folder).version,manifestJson.version);
 fs.rmSync(path.join(staged.folder,'update.json'));
 assert.throws(()=>rescueContract(staged.folder),/incomplete|metadata/);
 fs.writeFileSync(path.join(staged.folder,'update.json'),JSON.stringify(installerMetadata(manifestJson,{})));
 assert.equal(rescueContract(staged.folder).kind,'patch');
});

test('staging contract: a missing application integrity manifest is rejected',{skip:!available&&'run npm run release -- --local first'},()=>{
 const staged=prepareUpdateForRescue(zip,JSON.parse(fs.readFileSync(manifest,'utf8')),{stagingDir:work});
 const integrity=path.join(staged.folder,'NODO.app','Contents','Resources','nodo-manifest.json');
 const saved=fs.readFileSync(integrity);
 fs.rmSync(integrity);
 assert.throws(()=>rescueContract(staged.folder),/incomplete/);
 fs.writeFileSync(integrity,saved);
 assert.equal(rescueContract(staged.folder).version,staged.version);
});

test('staging contract: a tampered bundle fails signature verification',{skip:!available&&'run npm run release -- --local first'},()=>{
 const staged=prepareUpdateForRescue(zip,JSON.parse(fs.readFileSync(manifest,'utf8')),{stagingDir:work});
 const main=path.join(staged.folder,'NODO.app','Contents','Resources','project','main.cjs');
 const original=fs.readFileSync(main);
 fs.writeFileSync(main,Buffer.concat([original,Buffer.from('\n// tampered\n')]));
 assert.throws(()=>rescueContract(staged.folder));
 fs.writeFileSync(main,original);
});

test('staging contract: Rescue verify accepts exactly this folder',{skip:!available&&'run npm run release -- --local first'},()=>{
 const staged=prepareUpdateForRescue(zip,JSON.parse(fs.readFileSync(manifest,'utf8')),{stagingDir:work});
 const rescue=path.join(staged.folder,'NODO Rescue.app','Contents','MacOS','NODORescue');
 if(!fs.existsSync(rescue))return;
 const out=cp.execFileSync(rescue,['verify',staged.app],{encoding:'utf8'});
 assert.match(out,/verified/i);
});

test('staging folders are isolated per attempt and cleaned up on failure',{skip:!available&&'run npm run release -- --local first'},()=>{
 const manifestJson=JSON.parse(fs.readFileSync(manifest,'utf8'));
 const first=prepareUpdateForRescue(zip,manifestJson,{stagingDir:work});
 const second=prepareUpdateForRescue(zip,manifestJson,{stagingDir:work});
 assert.notEqual(first.folder,second.folder);
 assert.throws(()=>prepareUpdateForRescue(zip,{...manifestJson,sha256:'0'.repeat(64)},{stagingDir:work}),/changed before install/);
 const leftovers=fs.readdirSync(work).filter(name=>name.startsWith('install-')&&!fs.existsSync(path.join(work,name,'update.json')));
 assert.deepEqual(leftovers,[]);
});
test.after(()=>fs.rmSync(work,{recursive:true,force:true}));
