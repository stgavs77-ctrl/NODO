'use strict';
// Needs remote-relay/cloudflare (not in the public tree) and the miniflare package.
{let ready=require('node:fs').existsSync(require('node:path').join(__dirname,'../remote-relay/cloudflare'));try{require.resolve(process.env.NODO_MINIFLARE_MODULE||'miniflare');}catch{ready=false;}if(!ready){require('node:test')('remote cloudflare relay suite',{skip:'remote-relay/cloudflare or miniflare unavailable'},()=>{});return;}}
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),crypto=require('node:crypto');
const {Miniflare,convertV4MiniflareOptions}=require(process.env.NODO_MINIFLARE_MODULE || 'miniflare');
const root=path.resolve(__dirname,'..');
const token='synthetic_'.padEnd(48,'x'),room='synthetic_room_1234567890';
const next=ws=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('message timeout')),5000);ws.addEventListener('message',e=>{clearTimeout(timer);resolve(JSON.parse(e.data));},{once:true});});
test('actual workerd: fail closed, opaque routing, replacement and stale connection rejection',async()=>{
 const options={modules:true,scriptPath:path.join(root,'remote-relay/cloudflare/worker.mjs'),compatibilityDate:'2026-09-12',durableObjects:{RELAY:{className:'RelayHub',useSQLite:true}},bindings:{RELAY_OWNER_TOKEN_SHA256:crypto.createHash('sha256').update(token).digest('hex')},assets:{directory:path.join(root,'remote-web'),binding:'ASSETS',routerConfig:{has_user_worker:true,invoke_user_worker_ahead_of_assets:true}}};
 const mf=new Miniflare(convertV4MiniflareOptions?convertV4MiniflareOptions(options):options);
 const connect=async(auth,origin='https://relay.test')=>{const r=await mf.dispatchFetch('https://relay.test/relay',{headers:{Upgrade:'websocket',Origin:origin,...(auth===undefined?{}:{Authorization:'Bearer '+auth})}});if(r.status!==101)return r;const ws=r.webSocket;ws.accept();return ws;};
 try{
  assert.equal((await connect('invalid')).status,403);assert.equal((await connect(token,'https://evil.test')).status,403);
  const host=await connect(token);let p=next(host);host.send(JSON.stringify({type:'register',roomId:room}));assert.equal((await p).type,'ready');
  const phone=await connect();const notice=next(host);p=next(phone);phone.send(JSON.stringify({type:'attach',roomId:room}));const c=await p;assert.equal((await notice).type,'phone_connected');
  p=next(host);phone.send(JSON.stringify({type:'to_host',connectionId:c.connectionId,frame:'YWJj'}));assert.equal((await p).frame,'YWJj');
  p=next(phone);host.send(JSON.stringify({type:'to_phone',connectionId:c.connectionId,frame:'eHl6'}));assert.equal((await p).frame,'eHl6');
  // Namespace presence is not proof of runtime eviction/hibernation.
  const ns=await mf.getDurableObjectNamespace('RELAY');assert.ok(ns.idFromName('nodo-relay-v1'));
  const replacement=await connect(token);p=next(replacement);replacement.send(JSON.stringify({type:'register',roomId:room}));assert.equal((await p).type,'ready');
  const newPhone=await connect();const noticed=next(replacement);p=next(newPhone);newPhone.send(JSON.stringify({type:'attach',roomId:room}));const c2=await p;await noticed;assert.notEqual(c2.connectionId,c.connectionId);
  const closed=new Promise(resolve=>newPhone.addEventListener('close',resolve,{once:true}));newPhone.send(JSON.stringify({type:'to_host',connectionId:c.connectionId,frame:'YWJj'}));await closed;
  host.close();phone.close();replacement.close();
 }finally{await mf.dispose();}
});
