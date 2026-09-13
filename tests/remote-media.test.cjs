'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const test=require('node:test');
const {MediaPreview}=require('../lib/media-preview.cjs');
const {RemoteMedia,RemoteMediaError}=require('../lib/remote-media.cjs');

async function fixture(){const root=await fs.mkdtemp(path.join(os.tmpdir(),'nodo-remote-media-'));return {root,async write(name,data){const target=path.join(root,name);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,data);return target;},async close(){await fs.rm(root,{recursive:true,force:true});}};}

test('refuses an arbitrary workspace/path and HTML has card metadata only',async()=>{
 const f=await fixture();const other=await fixture();try{
  const preview=new MediaPreview({workspaceRoots:[f.root]});const remote=new RemoteMedia({workspace:f.root,mediaPreview:preview});
  const html=await f.write('attack.html','<script>alert(1)</script>');
  const unsupported=await remote.readRemoteMedia({workspace:f.root,path:html});assert.equal(unsupported.status,'unsupported');assert.equal(unsupported.card.kind,'unknown');assert.equal(unsupported.content,undefined);assert.equal(unsupported.card.active,false);
  await assert.rejects(()=>remote.readRemoteMedia({workspace:other.root,path:html}),error=>error instanceof RemoteMediaError&&error.code==='WORKSPACE_MISMATCH');
  await assert.rejects(()=>remote.readRemoteMedia({workspace:f.root,path:path.join(other.root,'outside.png')}),error=>error instanceof RemoteMediaError&&error.code==='OUTSIDE_SELECTED_WORKSPACE');
 }finally{await f.close();await other.close();}
});

test('returns only bounded base64 inline content for a verified safe image',async()=>{
 const f=await fixture();try{
  const png=Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,1,2,3]);const file=await f.write('image.png',png);
  const remote=new RemoteMedia({workspace:f.root,mediaPreview:new MediaPreview({workspaceRoots:[f.root]}),maxInlineBytes:32});
  const result=await remote.readRemoteMedia({workspace:f.root,path:file});assert.equal(result.status,'ready');assert.deepEqual(result.card,{name:'image.png',mime:'image/png',size:png.length,path:await fs.realpath(file),kind:'image',format:'png',status:'ready',active:false});assert.equal(result.content.mime,'image/png');assert.equal(result.content.base64,png.toString('base64'));assert.equal(result.url,undefined);assert.equal(result.token,undefined);
 }finally{await f.close();}
});

test('keeps safe media above inline limit as an inactive metadata card',async()=>{
 const f=await fixture();try{
  const file=await f.write('large.mp3',Buffer.concat([Buffer.from([0x49,0x44,0x33]),Buffer.alloc(20)]));
  const remote=new RemoteMedia({workspace:f.root,mediaPreview:new MediaPreview({workspaceRoots:[f.root]}),maxInlineBytes:10});
  const result=await remote.readRemoteMedia({workspace:f.root,path:file});assert.equal(result.status,'ready');assert.equal(result.card.kind,'audio');assert.equal(result.card.active,false);assert.equal(result.content,undefined);
 }finally{await f.close();}
});
