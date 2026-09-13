'use strict';
// Explicit synthetic public-relay probe; never reads the NODO profile or calls DSH.
const assert=require('node:assert/strict'),crypto=require('node:crypto'),cp=require('node:child_process');
const WS=require('../runtime/node_modules/ws');
const {RemoteHost}=require('../lib/remote-host.cjs');
const {seal,open}=require('../lib/remote-pairing.cjs');
const config=require('../config/remote-relay.json');
const encode=v=>Buffer.from(JSON.stringify(v)).toString('base64url');
const decode=v=>JSON.parse(Buffer.from(v,'base64url').toString());
const next=ws=>new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(Error('Relay response timeout')),15000);ws.once('message',b=>{clearTimeout(t);resolve(JSON.parse(b));});});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let stage='health';
(async()=>{
 const health=await fetch(config.webURL+'/health');assert.equal(health.status,200);assert.equal((await health.json()).configured,true);
 const page=await fetch(config.webURL);assert.equal(page.status,200);assert.ok(page.headers.get('content-security-policy').includes("frame-ancestors 'none'"));
 const hostCredential=cp.execFileSync('/usr/bin/security',['find-generic-password','-s',config.keychainService,'-a',config.keychainAccount,'-w'],{encoding:'utf8',stdio:['ignore','pipe','ignore'],timeout:15000}).trim();
 const roomId='test_'+crypto.randomBytes(20).toString('base64url');let devices=[];let phone;
 let browser,sends=0;const calls=[];const sessionId='session-synthetic-test',workspaceId='workspace-synthetic-test';
 const host=new RemoteHost({config:{...config,roomId,hostCredential},store:{read:()=>devices,write:v=>{devices=v;}},power:{start:()=>1,stop:()=>{}},call:async(method)=>{calls.push(method);
  if(method==='workspaces')return {value:{items:[{workspaceId,title:'Test workspace',sessionIds:[sessionId]}]}};
  if(method==='sessions')return {items:[{sessionId,title:'Test session'}]};
  if(method==='interactions')return [];
  if(method==='send'){sends++;return {accepted:true};}
  return {synthetic:true,records:[{event:{type:'user/message',data:{content:[{type:'text',text:'Public relay synthetic history'}]}}}],assistantStream:{activeAttempt:{stream:[['text',sends?'Synthetic reply':'Synthetic stream']]}}};
 }});
 const connect=async()=>{phone=new WS(config.url,{headers:{Origin:config.webURL}});await new Promise((r,j)=>{phone.once('open',r);phone.once('error',j);});const p=next(phone);phone.send(JSON.stringify({type:'attach',roomId}));return (await p).connectionId;};
 let id;const exchange=async frame=>{const p=next(phone);phone.send(JSON.stringify({type:'to_host',connectionId:id,frame:encode(frame)}));return decode((await p).frame);};
 try{
  stage='host connect';host.enable();for(let i=0;i<150&&!host.connected;i++)await sleep(100);assert.equal(host.connected,true);
  stage='wire pairing';id=await connect();const pair=new URLSearchParams(new URL(host.beginPairing().url).hash.slice(1));
  const reply=await exchange({type:'pair',pairingId:pair.get('pair'),box:seal(pair.get('secret'),{name:'Temporary synthetic test'},'nodo-pair-v1:'+pair.get('pair'))});
  const device=open(pair.get('secret'),reply.box,'nodo-pair-result-v1:'+pair.get('pair'));
  async function request(){const challenge=(await exchange({type:'hello',deviceId:device.deviceId})).challenge;const r=await exchange({type:'request',box:seal(device.key,{seq:1,method:'session',params:{}},'nodo-request-v1:'+id+':'+challenge)});assert.equal(open(device.key,r.box,'nodo-response-v1:'+id+':'+challenge).result.synthetic,true);}
  stage='wire reconnect';await request();const old=id;phone.close();await sleep(300);id=await connect();assert.notEqual(id,old);await request();
  host.revoke(device.deviceId);assert.equal((await exchange({type:'hello',deviceId:device.deviceId})).type,'rejected');assert.deepEqual(calls,['session','session']);
  phone.close();await sleep(300);
  stage='browser launch';const {chromium}=require('../runtime/playwright/node_modules/playwright');
  browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});const page=await context.newPage();
  stage='browser pairing';await page.goto(host.beginPairing().url);await page.locator('#confirm-pair').click();await page.getByText('Public relay synthetic history',{exact:true}).waitFor();assert.equal(new URL(page.url()).hash,'');assert.equal(await page.evaluate(()=>typeof window.rc),'undefined');
  await page.locator('#draft').fill('Synthetic public test');await page.locator('#send').click();await page.getByText('Synthetic reply',{exact:true}).waitFor();assert.equal(sends,1);
  await page.reload();await page.getByText('Public relay synthetic history',{exact:true}).waitFor();assert.equal(sends,1);assert.equal(await page.locator('#sessions').inputValue(),sessionId);
  host.revoke(devices[0].id);await page.reload();await page.locator('#error').filter({hasText:'отклонён'}).waitFor();assert.equal(sends,1);
  console.log('PASS public TLS/WSS relay: synthetic pairing, encrypted request, reconnect, revoke; no production profile or model turn');
  console.log('PASS public mobile Chromium: fragment cleared, no window.rc, history/stream/send/reload/revoke, exactly one synthetic send');
 }finally{await browser?.close();phone?.close();await host.disable();}
})().catch(e=>{console.error('FAIL public synthetic relay probe at '+stage+' ('+e.name+'; credentials omitted)');process.exitCode=1;});
