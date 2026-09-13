'use strict';
// Test helper: materialize NODO.app out of a release artifact into a directory,
// optionally re-labelling its bundle version. Used only by the end-to-end update
// tests, which run against their own app directory and profile.
//
// Usage: node scripts/install-test-app.cjs <release.zip> <dest-dir> [version]
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const {unpackVerifiedZip}=require('../lib/updater.cjs');
const {sha256}=require('../lib/release-signature.cjs');
const [zip,dest,version]=process.argv.slice(2);
if(!zip||!dest)throw Error('Usage: install-test-app.cjs <release.zip> <dest-dir> [version]');
fs.mkdirSync(dest,{recursive:true,mode:0o700});
const app=unpackVerifiedZip(zip,sha256(zip),dest);
if(version){
 cp.execFileSync('/usr/libexec/PlistBuddy',['-c','Set :CFBundleShortVersionString '+version,path.join(app,'Contents','Info.plist')]);
 cp.execFileSync('/usr/libexec/PlistBuddy',['-c','Set :CFBundleVersion '+version,path.join(app,'Contents','Info.plist')]);
 cp.execFileSync('/usr/bin/codesign',['--force','--deep','--sign','-',app]);
 cp.execFileSync(process.execPath,[path.join(__dirname,'update-manifest.cjs'),'app',app]);
}
process.stdout.write(app+'\n');
