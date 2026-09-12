'use strict';
// Public, pinned bootstrap. Never reads an installed NODO profile or Keychain.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),runtime=path.join(root,'runtime'),vendor=path.join(root,'vendor');
if(process.platform!=='darwin'||process.arch!=='arm64')throw Error('macOS arm64 required');
if(fs.existsSync(runtime)||fs.existsSync(vendor))throw Error('Runtime/vendor already exist. Use a fresh source checkout; nothing was removed.');
const stage=fs.mkdtempSync(path.join(root,'build-bootstrap-'));
const run=(bin,args,options={})=>cp.execFileSync(bin,args,{stdio:'inherit',timeout:600000,...options});
function copy(a,b){fs.mkdirSync(path.dirname(b),{recursive:true});fs.cpSync(a,b,{recursive:true,verbatimSymlinks:true});}
function seed(name,to){fs.mkdirSync(to,{recursive:true});for(const f of ['package.json','package-lock.json'])copy(path.join(root,name,f),path.join(to,f));run('npm',['ci','--ignore-scripts','--no-audit','--no-fund'],{cwd:to});}
try{
 seed('runtime-seed',runtime);const tools=path.join(stage,'tools');seed('tools-seed',tools);
 const archive=path.join(stage,'node.tar.xz');
 run('/usr/bin/curl',['--fail','--silent','--show-error','--location','--max-time','120','-o',archive,'https://nodejs.org/dist/v26.8.2/node-v26.8.2-darwin-arm64.tar.xz']);
 const digest=crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
 if(digest!=='f58e5044b938a3174184de4aaf1d2bbfcfff812e88220ff08e9221c09f5c8677')throw Error('Official Node archive integrity mismatch');
 run('/usr/bin/tar',['-xf',archive,'-C',stage]);const nodeDir=path.join(stage,'node-v26.8.2-darwin-arm64');copy(path.join(nodeDir,'bin/node'),path.join(runtime,'node'));copy(path.join(nodeDir,'LICENSE'),path.join(runtime,'licenses/node-LICENSE'));
 const electron=path.join(tools,'node_modules/electron'),env={...process.env};
 for(const key of Object.keys(env))if(/^(electron_|ELECTRON_|npm_config_electron_)/.test(key))delete env[key];
 env.ELECTRON_MIRROR='https://github.com/electron/electron/releases/download/';
 run(process.execPath,[path.join(electron,'install.js')],{env});
 const shell=path.join(vendor,'Shell.app');copy(path.join(electron,'dist/Electron.app'),shell);
 fs.renameSync(path.join(shell,'Contents/MacOS/Electron'),path.join(shell,'Contents/MacOS/NODO'));
 run('/usr/bin/plutil',['-replace','CFBundleExecutable','-string','NODO',path.join(shell,'Contents/Info.plist')]);
 for(const f of ['LICENSE','LICENSES.chromium.html'])copy(path.join(electron,'dist',f),path.join(shell,'Contents/Resources/licenses/electron',f));
 const codex=path.join(tools,'node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin');
 for(const f of ['codex','codex-code-mode-host'])copy(path.join(codex,f),path.join(runtime,f));
 copy(path.join(tools,'node_modules/@openai/codex/README.md'),path.join(runtime,'licenses/codex-README.md'));
 copy(path.join(root,'third-party/Codex-LICENSE'),path.join(runtime,'licenses/codex-LICENSE'));
 const pw=path.join(runtime,'playwright/node_modules');for(const name of ['playwright','playwright-core'])copy(path.join(tools,'node_modules',name),path.join(pw,name));
 if(!fs.existsSync(path.join(root,'node_modules')))fs.symlinkSync('runtime/node_modules',path.join(root,'node_modules'));
 run(process.execPath,[path.join(root,'scripts/normalize-runtime.cjs'),runtime]);
 run(process.execPath,[path.join(root,'scripts/prepare-patches.cjs'),'--check']);
 run(path.join(runtime,'node'),['--version']);run(path.join(runtime,'codex'),['--version']);
 console.log('Pinned runtime prepared. No application installed, provider key read, service started or relay configured.');
}catch(error){console.error('Bootstrap stopped safely; partial data remain only in this checkout for inspection.');throw error;}
// Keep only a bounded local build cache; no credentials are stored there.
