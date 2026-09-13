'use strict';
// THE release command. One explicit invocation turns a finished working copy
// into a published release:
//
//   npm run release -- --version 1.3.0            # build, sign, publish
//   npm run release -- --version 1.3.0 --local     # loopback feed for E2E tests
//   npm run release -- --version 1.3.0 --dry-run   # verify, publish nothing
//
// Steps: prepare -> clean production build -> one update artifact -> integrity
// checks -> sign metadata -> publish feed -> tag and push -> GitHub Release with
// the artifact -> verify the published release is retrievable and valid.
// No manual git push, no manual zip, no manual manifest, no per-version watcher.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process');
const root=path.resolve(__dirname,'..');
const {sign,sha256}=require('../lib/release-signature.cjs');
const {validateManifest,unpackVerifiedZip,getJson}=require('../lib/updater.cjs');
const arg=n=>{const i=process.argv.indexOf(n);return i<0?undefined:process.argv[i+1];};
const flag=n=>process.argv.includes(n);
const say=line=>process.stdout.write(line+'\n');
const run=(file,args,options={})=>{say('  $ '+[path.basename(file)].concat(args).join(' '));return cp.execFileSync(file,args,{stdio:'inherit',...options});};
const step=name=>say('\n['+name+']');

const version=arg('--version')||require('../package.json').version;
const kind=arg('--kind')||'patch';
const local=flag('--local');
const dryRun=flag('--dry-run');
const skipChecks=flag('--skip-checks');
const channel=arg('--channel')||'stable';
if(!/^\d+\.\d+\.\d+$/.test(version))throw Error('Invalid release version: '+version);
if(!['patch','migration'].includes(kind))throw Error('Release kind must be patch or migration');
if(!['stable','beta'].includes(channel))throw Error('Channel must be stable or beta');

const trust=require('../config/release-trust.json');
const releaseDir=path.join(root,'build/releases',version);
const zipName='NODO-'+version+'.zip';
const zip=path.join(releaseDir,zipName);
const manifestName=channel==='beta'?'beta.json':'latest.json';

async function main(){
 step('1/9 prepare');
 const packageFile=path.join(root,'package.json');
 const pkg=JSON.parse(fs.readFileSync(packageFile,'utf8'));
 if(pkg.version!==version){
  if(dryRun)say('  package.json is '+pkg.version+', release is '+version+' (dry run: not rewritten)');
  else{pkg.version=version;fs.writeFileSync(packageFile,JSON.stringify(pkg,null,2)+'\n');say('  package.json -> '+version);}
 }
 const notes=fs.readFileSync(path.join(root,'config/release-notes.md'),'utf8');
 const notesForRelease=notes.split(/\n(?=# )/)[0].trim();
 const privateKey=process.env.NODO_RELEASE_PRIVATE_KEY||cp.execFileSync('/usr/bin/security',['find-generic-password','-s','NODO Release Signing','-a','ed25519-v1','-w'],{encoding:'utf8',stdio:['ignore','pipe','ignore'],timeout:60000}).trim();

 step('2/9 build clean production app');
 if(fs.existsSync(releaseDir)&&flag('--fresh'))fs.rmSync(releaseDir,{recursive:true,force:true});
 fs.mkdirSync(releaseDir,{recursive:true});
 const buildEnv={...process.env,NODO_BUILD_VERSION:version};delete buildEnv.NODO_RELEASE_PRIVATE_KEY;
 const buildStage=fs.mkdtempSync(path.join(os.tmpdir(),'nodo-release-build-'));
 try{
  run(process.execPath,[path.join(root,'scripts/build.cjs'),'--release','--out',path.join(buildStage,'NODO.app')],{env:buildEnv});
  run(process.execPath,[path.join(root,'rescue/build.cjs')],{env:buildEnv});
 }catch(error){fs.rmSync(buildStage,{recursive:true,force:true});throw error;}

 step('3/9 pack the single update artifact');
 {
  const stage=fs.mkdtempSync(path.join(os.tmpdir(),'nodo-release-'));
  try{
   fs.cpSync(path.join(buildStage,'NODO.app'),path.join(stage,'NODO.app'),{recursive:true,verbatimSymlinks:true});
   fs.cpSync(path.join(root,'build/NODO Rescue.app'),path.join(stage,'NODO Rescue.app'),{recursive:true,verbatimSymlinks:true});
   run('/usr/bin/ditto',['-c','-k','--sequesterRsrc',stage,zip]);
  }finally{fs.rmSync(stage,{recursive:true,force:true});}
 }
 fs.rmSync(buildStage,{recursive:true,force:true});
 const bytes=fs.statSync(zip).size,digest=sha256(zip);
 say('  '+zipName+' '+bytes+' bytes sha256 '+digest.slice(0,16)+'...');

 step('4/9 release checks');
 if(!skipChecks){
  const probe=fs.mkdtempSync(path.join(os.tmpdir(),'nodo-release-verify-'));
  try{
   const app=unpackVerifiedZip(zip,digest,probe);
   const project=path.join(app,'Contents/Resources/project');
   for(const required of ['main.cjs','preload.cjs','lib/updater.cjs','lib/github.cjs','ui/about.html','extension/client.js'])if(!fs.existsSync(path.join(project,required)))throw Error('Release is missing '+required);
   const client=fs.readFileSync(path.join(project,'extension/client.js'),'utf8');
   if(/RULE-OK|ORBIT-731/.test(client))throw Error('Release contains DEV test fixtures');
   if(!fs.existsSync(path.join(app,'Contents/Resources/nodo-manifest.json')))throw Error('Release has no integrity manifest');
   const built=String(cp.execFileSync('/usr/libexec/PlistBuddy',['-c','Print :CFBundleShortVersionString',path.join(app,'Contents/Info.plist')],{encoding:'utf8',stdio:['ignore','pipe','ignore']})).trim();
   if(built!==version)throw Error('Built bundle version is '+built+', expected '+version);
   say('  bundle version, integrity manifest, no DEV fixtures: ok');
  }finally{fs.rmSync(probe,{recursive:true,force:true});}
 }

 step('5/9 sign release metadata');
 const port=arg('--port')||0;
 const downloadUrl=local?'http://127.0.0.1:'+port+'/'+version+'/'+zipName
  :'https://github.com/'+trust.repo+'/releases/download/v'+version+'/'+zipName;
 const now=Date.now();
 const manifest={schema:1,channel,kind,platform:'darwin',arch:'arm64',appSchema:3,dataSchema:1,migrationRequired:kind==='migration',rollbackPolicy:'code-only',version,url:downloadUrl,releaseNotes:notesForRelease,sha256:digest,bytes,issuedAt:now,expiresAt:now+30*24*60*60*1000};
 manifest.signature=sign(manifest,privateKey);
 fs.writeFileSync(path.join(releaseDir,manifestName),JSON.stringify(manifest,null,2)+'\n',{mode:0o600});
 fs.writeFileSync(path.join(releaseDir,'release-notes.md'),notesForRelease);
 fs.writeFileSync(path.join(releaseDir,'sha256.txt'),digest+'  '+zipName+'\n');
 say('  signed '+manifestName+(local?' (loopback feed, test only)':''));

 step('6/9 publish feed');
 const feedDir=path.join(releaseDir,'feed',version);
 fs.mkdirSync(feedDir,{recursive:true});
 fs.copyFileSync(zip,path.join(feedDir,zipName));
 fs.copyFileSync(path.join(releaseDir,manifestName),path.join(feedDir,manifestName));
 fs.copyFileSync(path.join(releaseDir,'release-notes.md'),path.join(feedDir,'release-notes.md'));
 say('  feed payload ready at '+feedDir);

 if(dryRun){
  step('7/9 tag (dry run)');say('  would tag v'+version);
  step('8/9 GitHub release (dry run)');say('  would create release v'+version+' with '+zipName);
  step('9/9 verify (dry run)');
  const checked=validateManifest(manifest,{publicKey:trust.publicKey,currentVersion:arg('--from')||'0.0.1',channel});
  say('  manifest validates: '+checked.version+' '+checked.kind+' '+checked.channel+' '+bytes+' bytes');
  say('\nDRY RUN complete, nothing published.');
  return;
 }
 if(local){
  step('7/9 tag');say('  local mode: repository untouched');
  step('8/9 GitHub release');say('  local mode: nothing uploaded');
  step('9/9 verify');say('  serve '+path.join(releaseDir,'feed')+' with scripts/release-feed-server.cjs --port '+port);
  say('\nLOCAL release prepared for end-to-end testing: '+feedDir);
  return;
 }

 const {REPO,token,createRelease,uploadAsset,request}=require('../lib/github.cjs');
 const ghToken=token();
 step('7/9 commit, tag, push source');
 const tag='v'+version;
 {
  const changed=cp.execFileSync('/usr/bin/git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim().split('\n').filter(line=>line&&!line.startsWith('?? build/'));
  if(changed.length){
   // build/ is gitignored, so a plain worktree add never stages it. The old
   // ':!build/' exclude pathspec makes git 2.39 abort with 'paths are ignored'.
   run('/usr/bin/git',['add','-A','--','.'],{cwd:root});
   run('/usr/bin/git',['-c','user.name=NODO Release','-c','user.email=user@example.invalid','commit','-m','release: NODO '+version],{cwd:root});
  }
  if(!cp.execFileSync('/usr/bin/git',['tag','--list',tag],{cwd:root,encoding:'utf8'}).trim())run('/usr/bin/git',['-c','user.name=NODO Release','-c','user.email=user@example.invalid','tag','-a',tag,'-m','NODO '+version],{cwd:root});
  // Repository writes use the SSH remote: publishing source needs no token.
  // A private upstream may be a working clone with main checked out, where git
  // refuses to advance the branch; that must not block the release itself.
  try{run('/usr/bin/git',['push','origin','HEAD:refs/heads/main'],{cwd:root});}
  catch(error){say('  source branch not pushed: '+String(error.message||error).split('\n')[0]);}
  run('/usr/bin/git',['push','origin','refs/tags/'+tag],{cwd:root});
 }

 step('8/9 GitHub release and update feed');
 if(!ghToken){
  say('  NO GITHUB TOKEN: source is pushed, the release asset was NOT uploaded.');
  say('  Add a token to the "NODO GitHub Token" Keychain item or GH_TOKEN, then re-run:');
  say('  npm run release -- --version '+version+' --publish-only');
  process.exitCode=3;
  return;
 }
 const existing=await request('https://api.github.com/repos/'+REPO+'/releases/tags/'+tag,{token:ghToken}).catch(()=>null);
 const release=existing&&existing.id?existing:await createRelease({version,tag,name:'NODO '+version,notes:notesForRelease,token:ghToken,prerelease:channel==='beta'});
 say('  release: '+release.html_url);
 const assets=await request(release.assets_url,{token:ghToken});
 for(const asset of Array.isArray(assets)?assets:[])if([zipName,manifestName,'release-notes.md'].includes(asset.name)){await request(asset.url,{method:'DELETE',token:ghToken});say('  replaced previous asset '+asset.name);}
 await uploadAsset({release,file:zip,name:zipName,token:ghToken});
 say('  uploaded '+zipName);
 await uploadAsset({release,file:path.join(releaseDir,manifestName),name:manifestName,token:ghToken});
 await uploadAsset({release,file:path.join(releaseDir,'release-notes.md'),name:'release-notes.md',token:ghToken});
 say('  uploaded '+manifestName+' and release-notes.md');

 step('9/9 verify the published release');
 const liveUrl='https://github.com/'+REPO+'/releases/latest/download/'+manifestName;
 // The published redirect target is occasionally slow right after an asset is
 // replaced; retry a transient network hang instead of failing a live release.
 let liveManifest;
 for(let attempt=0;attempt<3;attempt++){try{liveManifest=await getJson(liveUrl);break;}catch(error){if(attempt===2)throw error;await new Promise(r=>setTimeout(r,5000*(attempt+1)));}}
 const live=validateManifest(liveManifest,{publicKey:trust.publicKey,currentVersion:arg('--from')||'0.0.1',channel});
 if(live.version!==version||live.sha256!==digest)throw Error('Published manifest does not match the built release');
 const status=cp.execFileSync('/usr/bin/curl',['-sIL','-o','/dev/null','-w','%{http_code}','https://github.com/'+REPO+'/releases/download/v'+version+'/'+zipName],{encoding:'utf8'}).trim();
 say('  live manifest verified, asset HTTP '+status);
 say('\nRELEASED NODO '+version+' ('+channel+') https://github.com/'+REPO+'/releases/tag/'+tag);
}
main().catch(error=>{process.stderr.write('\nRELEASE FAILED: '+error.message+'\n');process.exit(1);});
