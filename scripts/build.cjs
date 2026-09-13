const fs=require('fs'),path=require('path'),{execFileSync:run}=require('child_process');
const root=path.resolve(__dirname,'..'),mode=process.argv.includes('--release')?'release':'dev',name=mode==='dev'?'NODO DEV':'NODO',version=process.env.NODO_BUILD_VERSION||require(path.join(root,'package.json')).version;
const outFlag=process.argv.indexOf('--out'),out=outFlag>=0?path.resolve(process.argv[outFlag+1]||''):path.join(root,'build',name+'.app');
if(outFlag>=0&&!process.argv[outFlag+1])throw Error('--out requires an app path');
if(fs.existsSync(out))throw Error('Build output exists: move it aside before rebuilding '+out);
run(process.execPath,[path.join(root,'scripts/prepare-patches.cjs')],{stdio:'inherit'});
run(process.execPath,[path.join(root,'scripts/brand-assets.cjs')],{stdio:'inherit'});
fs.mkdirSync(path.dirname(out),{recursive:true});run('/bin/cp',['-cR',path.join(root,'vendor/Shell.app'),out]);
const res=path.join(out,'Contents/Resources'),project=path.join(res,'project');fs.mkdirSync(project);
for(const f of ['main.cjs','preload.cjs','about-preload.cjs','package.json','profile.patch.yml','codex-config.toml','dsh-plugin.mjs','lib','services','extension','ui','assets','patches','config','runtime'])run('/bin/cp',['-cR',path.join(root,f),path.join(project,f)]);
fs.mkdirSync(path.join(project,'scripts'));for(const f of ['telegram-read.py','prepare-patches.cjs','outer-sandbox-runner.cjs','apply-branding.cjs','update-preflight.cjs','start-current-nodo.command','vk-factoscope-runner.sh'])fs.copyFileSync(path.join(root,'scripts',f),path.join(project,'scripts',f));
run(process.execPath,[path.join(root,'scripts/apply-branding.cjs'),project],{stdio:'inherit'});
fs.symlinkSync('runtime/node_modules',path.join(project,'node_modules'));
fs.writeFileSync(path.join(project,'build-mode.json'),JSON.stringify({mode}));
fs.writeFileSync(path.join(project,'package.json'),JSON.stringify({...require(path.join(root,'package.json')),version},null,2));
run('/usr/bin/xcrun',['swiftc','-O',path.join(root,'scripts/qr.swift'),'-o',path.join(project,'runtime/nodo-qr')],{stdio:'inherit'});
let commit='uncommitted';try{commit=run('/usr/bin/git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();}catch{}
fs.writeFileSync(path.join(project,'build-info.json'),JSON.stringify({version,builtAt:new Date().toISOString(),commit,safeMode:true,mode}));
// Remove only copied legacy bootstrap. The application now owns its entire source/runtime.
for(const f of ['app.asar','rc-location.json'])if(fs.existsSync(path.join(res,f)))fs.unlinkSync(path.join(res,f));
fs.mkdirSync(path.join(res,'app'),{recursive:true});fs.writeFileSync(path.join(res,'app/package.json'),JSON.stringify({name:'nodo',version,main:'index.cjs'}));fs.writeFileSync(path.join(res,'app/index.cjs'),"require('../project/main.cjs');\n");
const plist=path.join(out,'Contents/Info.plist');for(const [k,v] of Object.entries({CFBundleDisplayName:name,CFBundleName:'NODO',CFBundleIdentifier:mode==='dev'?'local.nodo.harness.dev':'local.nodo.harness.rc',CFBundleShortVersionString:version,CFBundleVersion:version}))run('/usr/bin/plutil',['-replace',k,'-string',v,plist]);
fs.copyFileSync(path.join(root,'assets/NODO.icns'),path.join(res,'NODO.icns'));
run('/usr/bin/codesign',['--force','--deep','--sign','-',out],{stdio:'pipe'});
run(process.execPath,[path.join(root,'scripts/update-manifest.cjs'),'app',out],{stdio:'inherit'});
run('/usr/bin/codesign',['--force','--sign','-',out],{stdio:'pipe'});
console.log(out);
