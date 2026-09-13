'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const test=require('node:test');
const {Checkpoints}=require('../lib/checkpoints.cjs');
const {ABActions,ABActionsError}=require('../lib/ab-actions.cjs');

function fixture(){const base=fs.mkdtempSync(path.join(os.tmpdir(),'nodo-ab-actions-')),root=path.join(base,'workspace'),dir=path.join(base,'checkpoints');fs.mkdirSync(root,{recursive:true});return {base,root,dir,checkpoints:new Checkpoints(base,{root,dir}),close(){fs.rmSync(base,{recursive:true,force:true});}};}

test('captures original, A and B; restores original for B and keeps a selected version',()=>{
 const f=fixture();try{
  const file=path.join(f.root,'mix.txt');fs.writeFileSync(file,'original');const actions=new ABActions({checkpoints:f.checkpoints,storeFile:path.join(f.dir,'ab-state.json')});
  const created=actions.create(['mix.txt']);assert.equal(created.files[0],'mix.txt');fs.writeFileSync(file,'version A');const A=actions.capture('A');assert.ok(A.snapshot);
  assert.deepEqual(actions.startB().restored,['mix.txt']);assert.equal(fs.readFileSync(file,'utf8'),'original');fs.writeFileSync(file,'version B');actions.capture('B');
  const comparison=actions.compare().files[0];assert.equal(comparison.status.A,'changed');assert.equal(comparison.status.B,'changed');assert.equal(comparison.status.AtoB,'different');assert.equal(comparison.A.size,9);assert.match(comparison.A.sha256,/^[a-f0-9]{64}$/);
  actions.keep('A');assert.equal(fs.readFileSync(file,'utf8'),'version A');const state=JSON.parse(fs.readFileSync(path.join(f.dir,'ab-state.json'),'utf8'));assert.equal(state.actions.length,1);
 }finally{f.close();}
});

test('requires create and A before B, and delegates unsafe paths to Checkpoints scope',()=>{
 const f=fixture();try{
  const actions=new ABActions({checkpoints:f.checkpoints,storeFile:path.join(f.dir,'ab-state.json')});
  assert.throws(()=>actions.capture('A'),error=>error instanceof ABActionsError&&error.code==='CREATE_REQUIRED');assert.throws(()=>actions.create(['../escape.txt']),error=>error instanceof ABActionsError&&error.code==='PATH_INVALID');
  fs.writeFileSync(path.join(f.root,'safe.txt'),'safe');actions.create(['safe.txt']);assert.throws(()=>actions.capture('B'),error=>error instanceof ABActionsError&&error.code==='CAPTURE_A_REQUIRED');assert.throws(()=>actions.startB(),error=>error instanceof ABActionsError&&error.code==='CAPTURE_A_REQUIRED');
 }finally{f.close();}
});
test('compare exposes bounded inert UTF-8 previews and Keep Both never overwrites the source or variants',()=>{
 const f=fixture();try{
  const file=path.join(f.root,'mix.txt'),large='A'.repeat(5000);fs.writeFileSync(file,'original');const actions=new ABActions({checkpoints:f.checkpoints,storeFile:path.join(f.dir,'ab-state.json')});
  actions.create(['mix.txt']);fs.writeFileSync(file,large);actions.capture('A');actions.startB();fs.writeFileSync(file,'version B');actions.capture('B');
  const compared=actions.compare().files[0];assert.equal(compared.A.preview.encoding,'utf8');assert.equal(compared.A.preview.text.length,4000);assert.equal(compared.A.preview.truncated,true);assert.equal(compared.B.preview.text,'version B');
  const variantA=path.join(f.root,'mix.txt.nodo-A');fs.writeFileSync(variantA,'do not replace');assert.throws(()=>actions.keep('both'),error=>error instanceof ABActionsError&&error.code==='VARIANT_EXISTS');assert.equal(fs.readFileSync(variantA,'utf8'),'do not replace');assert.equal(fs.readFileSync(file,'utf8'),'version B');
  fs.unlinkSync(variantA);const kept=actions.keepBoth(),variants=kept.variants[0];assert.equal(fs.readFileSync(file,'utf8'),'version B');assert.equal(fs.readFileSync(path.join(f.root,variants.A.path),'utf8'),large);assert.equal(fs.readFileSync(path.join(f.root,variants.B.path),'utf8'),'version B');
  f.checkpoints.restore(variants.A.checkpoint);f.checkpoints.restore(variants.B.checkpoint);assert.equal(fs.existsSync(path.join(f.root,variants.A.path)),false);assert.equal(fs.existsSync(path.join(f.root,variants.B.path)),false);
 }finally{f.close();}
});
