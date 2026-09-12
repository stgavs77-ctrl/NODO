'use strict';
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),os=require('node:os');
const {sign,sha256}=require('../lib/release-signature.cjs');
const root=path.resolve(__dirname,'..'),arg=n=>{const i=process.argv.indexOf(n);return i<0?undefined:process.argv[i+1];};
const version=arg('--version')||require('../package.json').version,kind=arg('--kind')||'patch',channel=arg('--channel')||'stable';
if(!/^\d+\.\d+\.\d+$/.test(version)||!['patch','migration'].includes(kind)||!['stable','dev'].includes(channel))throw Error('Invalid release version/kind/channel');
const out=path.resolve(arg('--out')||path.join(root,'build/releases',version));
const url=arg('--url')||'https://updates.example.invalid/NODO-'+version+'.zip';
if(new URL(url).protocol!=='https:')throw Error('HTTPS package URL required');
const zip=path.join(out,'NODO-'+version+'.zip');if(fs.existsSync(zip))throw Error('Release already exists; choose a new version or output directory');
// Signing material stays in this process, never in the build environment.
const prepareOnly=process.argv.includes('--prepare-only');
const privateKey=prepareOnly?null:(process.env.NODO_RELEASE_PRIVATE_KEY||cp.execFileSync('/usr/bin/security',['find-generic-password','-s','NODO Release Signing','-a','ed25519-v1','-w'],{encoding:'utf8',stdio:['ignore','pipe','ignore'],timeout:60000}).trim());
const buildEnv={...process.env,NODO_BUILD_VERSION:version};delete buildEnv.NODO_RELEASE_PRIVATE_KEY;
const buildStage=fs.mkdtempSync(path.join(os.tmpdir(),'nodo-release-build-')),built=path.join(buildStage,'NODO.app');
try{
 cp.execFileSync(process.execPath,[path.join(root,'scripts/build.cjs'),'--release','--out',built],{stdio:'inherit',env:buildEnv});
 cp.execFileSync(process.execPath,[path.join(root,'rescue/build.cjs')],{stdio:'inherit',env:buildEnv});
 fs.mkdirSync(out,{recursive:true});const stage=fs.mkdtempSync(path.join(os.tmpdir(),'nodo-release-'));
 try{fs.cpSync(built,path.join(stage,'NODO.app'),{recursive:true,verbatimSymlinks:true});fs.cpSync(path.join(root,'build/NODO Rescue.app'),path.join(stage,'NODO Rescue.app'),{recursive:true,verbatimSymlinks:true});cp.execFileSync('/usr/bin/ditto',['-c','-k','--sequesterRsrc',stage,zip]);}
 finally{fs.rmSync(stage,{recursive:true,force:true});}
}finally{fs.rmSync(buildStage,{recursive:true,force:true});}
const releaseNotes=fs.readFileSync(path.join(root,'config/release-notes.md'),'utf8');
const now=Date.now(),manifest={schema:1,channel,kind,platform:process.platform,arch:process.arch,appSchema:3,dataSchema:1,migrationRequired:kind==='migration',rollbackPolicy:'code-only',version,url,releaseNotes,sha256:sha256(zip),bytes:fs.statSync(zip).size,issuedAt:now,expiresAt:now+30*24*60*60*1000};
const partDir=path.join(out,'parts');fs.mkdirSync(partDir);manifest.parts=[];
const fd=fs.openSync(zip,'r'),buffer=Buffer.alloc(4*1024*1024);try{let n,i=0;while((n=fs.readSync(fd,buffer,0,buffer.length,null))>0){const name='part-'+String(i++).padStart(3,'0'),file=path.join(partDir,name);fs.writeFileSync(file,buffer.subarray(0,n));manifest.parts.push({url:new URL('/parts/'+version+'/'+name,url).toString(),bytes:n,sha256:sha256(file)});}}finally{fs.closeSync(fd);}
if(privateKey)manifest.signature=sign(manifest,privateKey);
const manifestName=prepareOnly?'manifest.unsigned.json':'manifest.json';
fs.writeFileSync(path.join(out,manifestName),JSON.stringify(manifest,null,2)+'\n',{mode:0o600});
fs.writeFileSync(path.join(out,'release-notes.md'),releaseNotes);console.log(path.join(out,manifestName));
