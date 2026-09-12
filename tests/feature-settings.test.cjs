'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {FeatureSettings}=require('../lib/feature-settings.cjs');
function fixture(readCredential){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'nodo-features-'));fs.mkdirSync(path.join(root,'config'));
 fs.writeFileSync(path.join(root,'config/remote-relay.json'),JSON.stringify({url:'wss://example.invalid/relay',keychainService:'NODO Remote/Relay',keychainAccount:'nodo-remote-relay'}));
 const instance=new FeatureSettings({root,data:root,version:'1.0.0',readCredential,onChange(){},safeStorage:{isEncryptionAvailable:()=>true},power:{},call(){}});
 return {instance,clean:()=>fs.rmSync(root,{recursive:true,force:true})};
}
test('credential wait is nonblocking, deduplicated and cannot activate after shutdown',async()=>{
 let finish,calls=0;const f=fixture(()=>{calls++;return new Promise(r=>finish=r);});
 try{const a=f.instance.getRemote(),b=f.instance.getRemote();assert.equal(calls,1);assert.equal(f.instance.snapshot().remote.status,'Waiting for Keychain');
 await new Promise(r=>setImmediate(r));let stopped=false;f.instance.credentialChild={kill(signal){assert.equal(signal,'SIGTERM');stopped=true;}};await f.instance.stop();assert.ok(stopped);finish('synthetic');
 const result=await Promise.allSettled([a,b]);assert.ok(result.every(r=>r.status==='rejected'));assert.equal(f.instance.remote,undefined);
 }finally{f.clean();}
});
test('failed credential load is visible and retryable',async()=>{
 let calls=0;const f=fixture(async()=>{calls++;throw Error('Test access denied');});
 try{await assert.rejects(f.instance.getRemote(),/Test access denied/);assert.match(f.instance.snapshot().remote.status,/Test access denied/);
 await assert.rejects(f.instance.getRemote(),/Test access denied/);assert.equal(calls,2);assert.equal(f.instance.remoteLoading,null);
 }finally{f.clean();}
});
