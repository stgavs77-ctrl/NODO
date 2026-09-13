const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process'),https=require('node:https'),crypto=require('node:crypto');
const {checkAndStage}=require('../lib/updater.cjs'),{sign,sha256}=require('../lib/release-signature.cjs');
test('TLS signed parts reassemble exact bytes; corrupt part is rejected',{timeout:30000},async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nodo-parts-')),key=path.join(dir,'tls-key'),cert=path.join(dir,'tls-cert');
 cp.execFileSync('/usr/bin/openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=localhost'],{stdio:'ignore'});
 const chunks=[Buffer.from('first synthetic package bytes'),Buffer.from('second synthetic package bytes')],all=Buffer.concat(chunks),hash=b=>crypto.createHash('sha256').update(b).digest('hex');let manifest,bad=false;
 const server=https.createServer({key:fs.readFileSync(key),cert:fs.readFileSync(cert)},(q,r)=>{if(q.url==='/manifest'){r.end(JSON.stringify(manifest));return;}const i=Number(q.url.slice(1));const body=bad&&i===1?Buffer.from('tampered'):chunks[i];if(!body){r.writeHead(404);r.end();return;}r.setHeader('Content-Length',body.length);r.end(body);});
 await new Promise(r=>server.listen(0,r));const origin='https://localhost:'+server.address().port;
 const pair=crypto.generateKeyPairSync('ed25519'),priv=pair.privateKey.export({type:'pkcs8',format:'der'}),pub=pair.publicKey.export({type:'spki',format:'der'}).toString('base64'),now=Date.now();
 manifest={schema:1,channel:'stable',kind:'patch',platform:process.platform,arch:process.arch,appSchema:3,rollbackPolicy:'code-only',version:'0.2.2',url:origin+'/package',sha256:hash(all),bytes:all.length,issuedAt:now,expiresAt:now+60000,parts:chunks.map((b,i)=>({url:origin+'/'+i,bytes:b.length,sha256:hash(b)}))};manifest.signature=sign(manifest,priv);
 const previousCA=https.globalAgent.options.ca;https.globalAgent.options.ca=fs.readFileSync(cert);
 try{
  const options={manifestUrl:origin+'/manifest',publicKey:pub,channel:'stable',currentVersion:'0.2.0',stagingDir:path.join(dir,'valid')};
  const staged=await checkAndStage(options);assert.equal(sha256(staged.package),hash(all));assert.deepEqual(fs.readFileSync(staged.package),all);
  bad=true;await assert.rejects(checkAndStage({...options,stagingDir:path.join(dir,'bad')}),/digest/);assert.equal(fs.existsSync(path.join(dir,'bad/0.2.2.zip')),false);
 }finally{https.globalAgent.options.ca=previousCA;await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});}
});
