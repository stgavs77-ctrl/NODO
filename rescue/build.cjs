const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),os=require('node:os');
const out=path.resolve(process.argv[2]||path.join(__dirname,'../build/NODO Rescue.app'));
fs.mkdirSync(path.join(out,'Contents/MacOS'),{recursive:true});
const stage=fs.mkdtempSync(path.join(os.tmpdir(),'nodo-rescue-compile-'));
try {fs.copyFileSync(path.join(__dirname,'Rescue.swift'),path.join(stage,'main.swift'));cp.execFileSync('/usr/bin/xcrun',['swiftc','-O','-framework','AppKit','-framework','Security',path.join(stage,'main.swift'),path.join(__dirname,'UserBackup.swift'),path.join(__dirname,'UpdateLifecycle.swift'),path.join(__dirname,'BackupScope.swift'),'-o',path.join(out,'Contents/MacOS/NODORescue')],{stdio:'inherit'});}finally{fs.rmSync(stage,{recursive:true,force:true});}
fs.mkdirSync(path.join(out,'Contents/Resources'),{recursive:true});fs.copyFileSync(path.join(__dirname,'../assets/NODO.icns'),path.join(out,'Contents/Resources/NODO.icns'));
fs.copyFileSync(path.join(__dirname,'legacy-bootstrap.cjs'),path.join(out,'Contents/Resources/legacy-bootstrap.cjs'));
fs.writeFileSync(path.join(out,'Contents/Info.plist'),`<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>NODORescue</string><key>CFBundleIdentifier</key><string>local.nodo.rescue</string><key>CFBundleName</key><string>NODO Rescue</string><key>CFBundleIconFile</key><string>NODO.icns</string><key>CFBundleVersion</key><string>1</string><key>NSHighResolutionCapable</key><true/></dict></plist>`);
cp.execFileSync('/usr/bin/codesign',['--force','--sign','-',out],{stdio:'inherit'});console.log(out);
