const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process'),https=require('node:https');
const {chromium}=require('../runtime/playwright/node_modules/playwright');
const WS=require('../runtime/node_modules/ws');
const {createRelay,sha256}=require('../remote-relay/server.cjs');
const {RemoteHost}=require('../lib/remote-host.cjs');
test('mobile browser pairs over TLS, shows same session, sends, reconnects and loses access on revoke',{timeout:60000},async()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'nodo-mobile-test-')),key=path.join(temp,'key'),cert=path.join(temp,'cert');
 cp.execFileSync('/usr/bin/openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=localhost'],{stdio:'ignore'});
 const secure=https.createServer({key:fs.readFileSync(key),cert:fs.readFileSync(cert)});await new Promise(r=>secure.listen(0,'127.0.0.1',r));
 const origin='https://127.0.0.1:'+secure.address().port,token='T'.repeat(64),relay=createRelay({ownerTokenHash:sha256(token),allowedOrigins:[origin]});secure.on('request',(q,r)=>relay.server.emit('request',q,r));secure.on('upgrade',(q,s,h)=>relay.server.emit('upgrade',q,s,h));
 class TestWS extends WS{constructor(url,o){super(url,{...o,rejectUnauthorized:false});}}
 const workspaceId='08e6e315-92b3-425e-8c94-47e0a42c335d',sessionId='18e6e315-92b3-425e-8c94-47e0a42c335d';let saved=[],sends=0,stream='Synthetic stream';
 const host=new RemoteHost({config:{url:origin.replace('https:','wss:')+'/relay',webURL:origin,roomId:'synthetic-room-123456789',hostCredential:token},store:{read:()=>saved,write:v=>saved=v},power:{start:()=>1,stop:()=>{}},WebSocket:TestWS,call:async(m,p)=>{
  if(m==='workspaces')return {type:'baseline',value:{items:[{workspaceId,title:'Synthetic Workspace',sessionIds:[sessionId]}]}};
  if(m==='sessions')return {items:[{sessionId,title:'Synthetic Session'}]};
  if(m==='session'){assert.equal(p.sessionId,sessionId);return {records:[{event:{type:'user/message',data:{content:[{type:'text',text:'Existing synthetic history'}]}}}],assistantStream:{activeAttempt:{stream:[['text',stream]]}}};}
  if(m==='send'){assert.equal(p.sessionId,sessionId);assert.equal(p.text,'Synthetic send');sends++;stream='Synthetic response';return {accepted:true};}
  if(m==='interactions')return [];if(m==='stop')return {accepted:true};throw Error('Forbidden');
 }});let browser;
 try{
  host.enable();for(let i=0;!host.connected&&i<50;i++)await new Promise(r=>setTimeout(r,20));assert(host.connected);
  browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:390,height:844},isMobile:true,hasTouch:true});const page=await context.newPage();
  await page.goto(host.beginPairing().url);await page.locator('#confirm-pair').waitFor();assert.equal(saved.length,0);assert(new URL(page.url()).hash.includes('secret='));
  // Code Scanner -> Safari uses a different storage context and the still-unused URL.
  const safariContext=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:390,height:844}}),safari=await safariContext.newPage();await safari.goto(page.url());await page.close();
  await safari.locator('#confirm-pair').click();await safari.getByText('Existing synthetic history',{exact:true}).waitFor();assert.equal(new URL(safari.url()).hash,'');assert.equal(await safari.evaluate(()=>typeof window.rc),'undefined');
  return await (async(page)=>{
  await page.locator('#draft').fill('Synthetic send');await page.locator('#send').click();await page.getByText('Synthetic response',{exact:true}).waitFor();assert.equal(sends,1);
  await page.reload();await page.getByText('Existing synthetic history',{exact:true}).waitFor();assert.equal(sends,1);assert.equal(await page.locator('#sessions').inputValue(),sessionId);
  host.revoke(saved[0].id);await page.reload();await page.locator('#error').filter({hasText:'отклонён'}).waitFor();assert.equal(sends,1);
  })(safari);
 }finally{await browser?.close();await host.disable();await relay.close();await new Promise(r=>secure.close(r));fs.rmSync(temp,{recursive:true,force:true});}
});
