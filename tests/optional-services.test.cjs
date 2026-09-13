'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {prepare}=require('../lib/environment.cjs');
test('fresh release does not start personal adapters; existing configured services are preserved',()=>{
 const data=fs.mkdtempSync(path.join(os.tmpdir(),'nodo-optional-services-')),root=path.resolve(__dirname,'..'),c={data,isolated:false,ports:{dsh:4180}};
 try{
  let overlay=JSON.parse(fs.readFileSync(prepare(root,c)));assert.deepEqual(c.requiredServices,[]);assert.ok(!overlay.some(x=>x.insert?.some(y=>y.id==='nodo-telegram-bridge')));
  const profile=path.join(data,'dsh/profiles/web/cordis.patch.yml');
  fs.writeFileSync(profile,JSON.stringify([{insert:[{id:'telegram-bridge',name:'synthetic-bridge',config:{intervalMs:1234}},{id:'sessions-observer',name:'synthetic-observer'}]}]));
  overlay=JSON.parse(fs.readFileSync(prepare(root,c)));assert.deepEqual(c.requiredServices,['telegram-bridge','sessions-observer']);assert.equal(overlay.flatMap(x=>x.insert||[]).find(x=>x.id==='nodo-telegram-bridge').config.intervalMs,1234);
  fs.writeFileSync(profile,JSON.stringify([{insert:[{id:'telegram-bridge',name:'synthetic-bridge'}]},{id:'telegram-bridge',disabled:true}]));prepare(root,c);assert.deepEqual(c.requiredServices,[]);
 }finally{fs.rmSync(data,{recursive:true,force:true});}
});
