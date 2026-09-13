'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const test=require('node:test');
const {MediaPreview,MediaPreviewError,parseRange,sniff}=require('../lib/media-preview.cjs');

async function fixture(){const root=await fs.mkdtemp(path.join(os.tmpdir(),'nodo-media-preview-'));return {root,async write(name,data){const target=path.join(root,name);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,data);return target;},async close(){await fs.rm(root,{recursive:true,force:true});}};}
async function read(stream){const chunks=[];for await(const chunk of stream)chunks.push(chunk);return Buffer.concat(chunks);}

test('text preview returns inert source and rejects binary, oversize and symlinks',async()=>{
 const f=await fixture();try{const p=new MediaPreview({workspaceRoots:[f.root]}),html=await f.write('text.html','<script>not executed</script>');assert.equal(await p.readText(html),'<script>not executed</script>');await assert.rejects(()=>p.readText(html,3));const binary=await f.write('binary',Buffer.from([0,1,2]));await assert.rejects(()=>p.readText(binary));await fs.symlink(html,path.join(f.root,'linked'));await assert.rejects(()=>p.readText(path.join(f.root,'linked')));}finally{await f.close();}
});

test('sniff accepts only explicit binary signatures',()=>{
 assert.deepEqual(sniff(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])),{kind:'image',format:'png'});
 assert.deepEqual(sniff(Buffer.from('%PDF-1.7')),{kind:'pdf',format:'pdf'});
 assert.deepEqual(sniff(Buffer.from('<svg onload=alert(1)>')),{kind:'unknown',format:'unknown'});
});

test('issues trusted token descriptor and streams a bounded range',async()=>{
 const f=await fixture();try{
  const file=await f.write('clip.mp3',Buffer.from([0x49,0x44,0x33,1,2,3,4,5]));const preview=new MediaPreview({workspaceRoots:[f.root]});
  const descriptor=await preview.issue(file);assert.equal(descriptor.status,'ready');assert.equal(descriptor.kind,'audio');assert.equal(descriptor.mime,'audio/mpeg');assert.match(descriptor.url,/^nodo-media:\/\/preview\//);
  const response=await preview.openUrl(descriptor.url,'bytes=3-5');assert.equal(response.status,206);assert.equal(response.headers['Content-Range'],'bytes 3-5/8');assert.deepEqual(await read(response.stream),Buffer.from([1,2,3]));
 }finally{await f.close();}
});

test('pending missing paths are retryable while untrusted formats are never tokenized',async()=>{
 const f=await fixture();try{
  const preview=new MediaPreview({workspaceRoots:[f.root]});const pending=await preview.issue(path.join(f.root,'later.png'));assert.deepEqual(pending,{status:'pending',retryable:true,path:path.join(f.root,'later.png')});
  const html=await f.write('attack.html','<script>alert(1)</script>');const unsafe=await preview.issue(html);assert.equal(unsafe.status,'unsupported');assert.equal(unsafe.playable,false);assert.equal(unsafe.token,undefined);
 }finally{await f.close();}
});

test('realpath scope rejects outside files and symlinks escaping a workspace',async()=>{
 const f=await fixture();const outside=await fixture();try{
  const bad=await outside.write('secret.png',Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]));await fs.symlink(bad,path.join(f.root,'escape.png'));
  const preview=new MediaPreview({workspaceRoots:[f.root]});await assert.rejects(()=>preview.inspect(bad),error=>error instanceof MediaPreviewError&&error.code==='OUTSIDE_WORKSPACE');await assert.rejects(()=>preview.inspect(path.join(f.root,'escape.png')),error=>['OUTSIDE_WORKSPACE','SYMLINK_DISALLOWED'].includes(error.code));
 }finally{await f.close();await outside.close();}
});

test('rejects any symlink component beneath the workspace root, even if it returns inside',async()=>{
 const f=await fixture();try{
  const file=await f.write('actual/safe.png',Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]));await fs.symlink(path.dirname(file),path.join(f.root,'linked'));
  const preview=new MediaPreview({workspaceRoots:[f.root]});await assert.rejects(()=>preview.inspect(path.join(f.root,'linked','safe.png')),error=>error.code==='SYMLINK_DISALLOWED');
 }finally{await f.close();}
});

test('stream holds a verified descriptor rather than following a replacement symlink',async()=>{
 const f=await fixture();const outside=await fixture();try{
  const file=await f.write('clip.gif',Buffer.from('GIF89a-safe'));const replacement=await outside.write('outside.gif',Buffer.from('GIF89a-evil'));const preview=new MediaPreview({workspaceRoots:[f.root]});const descriptor=await preview.issue(file);
  await fs.unlink(file);await fs.symlink(replacement,file);await assert.rejects(()=>preview.openToken(descriptor.token),error=>['OUTSIDE_WORKSPACE','SYMLINK_DISALLOWED','PATH_UNREADABLE','PREVIEW_CHANGED'].includes(error.code));
 }finally{await f.close();await outside.close();}
});

test('rejects oversized known media and protects range parser',async()=>{
 const f=await fixture();try{
  const file=await f.write('large.png',Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),Buffer.alloc(20)]));const preview=new MediaPreview({workspaceRoots:[f.root],maxBytesByKind:{image:10}});const result=await preview.inspect(file);assert.equal(result.status,'rejected');assert.equal(result.reason,'too_large');
  assert.deepEqual(parseRange('bytes=-3',10),{start:7,end:9,partial:true});assert.throws(()=>parseRange('bytes=20-21',10),error=>error.code==='RANGE_NOT_SATISFIABLE');
 }finally{await f.close();}
});

test('PDF descriptor honestly asks the renderer for page one and token expiry fails closed',async()=>{
 const f=await fixture();try{
  let now=100;const file=await f.write('manual.pdf',Buffer.from('%PDF-1.7\n'));const preview=new MediaPreview({workspaceRoots:[f.root],tokenTtlMs:10,clock:()=>now});const descriptor=await preview.issue(file);assert.deepEqual(descriptor.preview,{mode:'pdf',initialPage:1,backendEnforcesFirstPage:false});now=111;await assert.rejects(()=>preview.openToken(descriptor.token),error=>error.code==='TOKEN_INVALID');
 }finally{await f.close();}
});

test('token cache prunes expiry and stays bounded',async()=>{
 const f=await fixture();try{
  let now=1;const file=await f.write('clip.mp3',Buffer.from([0x49,0x44,0x33,1]));const preview=new MediaPreview({workspaceRoots:[f.root],tokenMax:2,tokenTtlMs:10,clock:()=>now});const first=await preview.issue(file),second=await preview.issue(file),third=await preview.issue(file);
  await assert.rejects(()=>preview.openToken(first.token),error=>error.code==='TOKEN_INVALID');assert.equal((await preview.openToken(second.token)).status,200);assert.equal((await preview.openToken(third.token)).status,200);
  now=12;await preview.issue(file);await assert.rejects(()=>preview.openToken(second.token),error=>error.code==='TOKEN_INVALID');
 }finally{await f.close();}
});
test('an unconsumed token response owns no eager FileHandle and may be destroyed safely',async()=>{
 const f=await fixture();try{
  const file=await f.write('clip.mp3',Buffer.from([0x49,0x44,0x33,1,2,3]));const preview=new MediaPreview({workspaceRoots:[f.root]});const descriptor=await preview.issue(file);
  const response=await preview.openToken(descriptor.token);response.stream.destroy();await new Promise(resolve=>response.stream.once('close',resolve));
 }finally{await f.close();}
});
