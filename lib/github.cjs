'use strict';
// Public release channel on GitHub.
//
// Update side: read, validate and stage the signed release that the repository
// publishes, without any credential (the repository and its releases are public).
// Release side: publish a prepared release (git tag + GitHub Release + asset)
// when a token is available; the release command reports clearly when it is not.
const fs=require('node:fs'),path=require('node:path'),https=require('node:https'),cp=require('node:child_process');
const REPO='stgavs77-ctrl/NODO';
const FEED_BRANCH='feed';
const KEYCHAIN={service:'NODO GitHub Token',account:'github-token'};
function fail(message){const e=Error(message);e.code='NODO_GITHUB_REJECTED';throw e;}
function request(url,{method='GET',token,headers={},body,save,progress,maxBytes=2*1024*1024*1024}={}){
 return new Promise((resolve,reject)=>{
  const u=new URL(url);if(u.protocol!=='https:')return reject(Error('GitHub requests must use HTTPS'));
  const requestHeaders={'user-agent':'nodo-updater','accept':'application/vnd.github+json','x-github-api-version':'2022-11-28',...headers};
  if(token)requestHeaders.authorization='Bearer '+token;
  const send=payload=>{const req=https.request(u,{method,headers:requestHeaders,timeout:120000},r=>{
   if(r.statusCode>=300&&r.statusCode<400&&r.headers.location)return resolve(request(new URL(r.headers.location,u).toString(),{method:'GET',token,headers,save,progress,maxBytes}));
   if(r.statusCode<200||r.statusCode>=300){let text='';r.setEncoding('utf8');r.on('data',c=>{if(text.length<2000)text+=c;});r.on('end',()=>reject(Error('GitHub HTTP '+r.statusCode+(text?' '+text.slice(0,300):''))));return;}
   if(save){const out=fs.createWriteStream(save,{flags:'wx',mode:0o600});let bytes=0;r.on('data',c=>{bytes+=c.length;if(bytes>maxBytes){r.destroy(Error('Release asset too large'));return;}progress?.(bytes);});r.on('error',reject);r.pipe(out);out.on('finish',()=>out.close(()=>resolve({bytes})));out.on('error',reject);return;}
   let text='';r.setEncoding('utf8');r.on('data',c=>{text+=c;});r.on('end',()=>{try{resolve(text?JSON.parse(text):{});}catch{reject(Error('Invalid GitHub response'));}});
  });req.on('timeout',()=>req.destroy(Error('GitHub timeout')));req.on('error',reject);if(payload)req.write(payload);req.end();};
  send(body);
 });
}
// Streaming binary upload, used for release assets (too large to buffer twice).
function upload(url,file,{token:credential,headers={}}={}){
 return new Promise((resolve,reject)=>{const u=new URL(url);if(u.protocol!=='https:')return reject(Error('GitHub requests must use HTTPS'));
  const size=fs.statSync(file).size;
  const requestHeaders={'user-agent':'nodo-release','accept':'application/vnd.github+json','x-github-api-version':'2022-11-28','content-type':'application/octet-stream','content-length':String(size),...headers};
  if(credential)requestHeaders.authorization='Bearer '+credential;
  const req=https.request(u,{method:'POST',headers:requestHeaders,timeout:0},r=>{let text='';r.setEncoding('utf8');r.on('data',c=>{if(text.length<4000)text+=c;});r.on('end',()=>{if(r.statusCode<200||r.statusCode>=300)return reject(Error('GitHub asset upload HTTP '+r.statusCode+' '+text.slice(0,300)));try{resolve(JSON.parse(text));}catch{resolve({});}});});
  req.on('error',reject);
  const input=fs.createReadStream(file);input.on('error',reject);input.pipe(req);
 });
}
async function requestBuffer(url,{token,headers}={}){
 return new Promise((resolve,reject)=>{const u=new URL(url);if(u.protocol!=='https:')return reject(Error('GitHub requests must use HTTPS'));
  const requestHeaders={'user-agent':'nodo-release','accept':'application/vnd.github+json','x-github-api-version':'2022-11-28',...headers};if(token)requestHeaders.authorization='Bearer '+token;
  const req=https.request(u,{method:'GET',headers:requestHeaders,timeout:120000},r=>{const chunks=[];r.on('data',c=>chunks.push(c));r.on('end',()=>r.statusCode===200?resolve(Buffer.concat(chunks)):reject(Error('GitHub HTTP '+r.statusCode)));});
  req.on('timeout',()=>req.destroy(Error('GitHub timeout')));req.on('error',reject);req.end();});
}
// Token lookup order: explicit argument, environment, macOS Keychain. The value
// never reaches a log, a config file or the repository.
function token(explicit){
 if(explicit)return explicit;
 for(const name of ['NODO_GITHUB_TOKEN','GH_TOKEN','GITHUB_TOKEN'])if(process.env[name])return process.env[name].trim();
 try{const value=cp.execFileSync('/usr/bin/security',['find-generic-password','-s',KEYCHAIN.service,'-a',KEYCHAIN.account,'-w'],{encoding:'utf8',stdio:['ignore','pipe','ignore'],timeout:30000}).trim();if(value)return value;}catch{}
 return null;
}
async function latestRelease({repo=REPO,token:credential}={}){
 const data=await request(`https://api.github.com/repos/${repo}/releases?per_page=20`,{token:credential});
 if(!Array.isArray(data))fail('Unexpected GitHub releases response');
 const release=data.find(r=>r&&r.draft!==true&&Array.isArray(r.assets)&&r.assets.some(a=>a.name==='latest.json'));
 return release?{tag:release.tag_name,name:release.name,url:release.html_url,asset:release.assets.find(a=>a.name==='latest.json'),zip:release.assets.find(a=>a.name.endsWith('.zip'))||null}:null;
}
// Read the signed manifest published with the newest release, then verify it:
// the signature is checked here, so a compromised host cannot push code.
async function readFeed({repo=REPO,publicKey,currentVersion,channel='stable',token:credential,now=Date.now(),allowEqual=false}={}){
 const {validateManifest}=require('./updater.cjs');
 const release=await latestRelease({repo,token:credential});
 if(!release)fail('No published release with update metadata was found in '+repo);
 const raw=await requestBuffer(release.asset.url,{token:credential,headers:{accept:'application/octet-stream'}});
 let manifest;try{manifest=JSON.parse(raw.toString('utf8'));}catch{fail('Published update metadata is not valid JSON');}
 const validated=validateManifest(manifest,{publicKey,currentVersion,channel,now,allowEqual});
 return {release,manifest:validated};
}
async function createRelease({version,tag,name,notes,repo=REPO,token:credential,prerelease=false}={}){
 // The API needs JSON text: a raw object reaches req.write() and Node rejects it.
 const data=await request(`https://api.github.com/repos/${repo}/releases`,{method:'POST',token:credential,headers:{'content-type':'application/json'},body:JSON.stringify({tag_name:tag,name,body:notes,draft:false,prerelease})});
 return data;
}
async function uploadAsset({release,file,name,repo=REPO,token:credential}={}){
 const uploadUrl=(release.upload_url||`https://uploads.github.com/repos/${repo}/releases/${release.id}/assets{?name,label}`).replace(/\{[^}]*\}$/,'');
 return upload(uploadUrl+'?name='+encodeURIComponent(name),file,{token:credential});
}
module.exports={REPO,FEED_BRANCH,KEYCHAIN,request,requestBuffer,upload,token,latestRelease,readFeed,createRelease,uploadAsset,fail};
