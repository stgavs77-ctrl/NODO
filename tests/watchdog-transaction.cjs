'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
test('actual Swift WatchdogTransaction with fake launchctl backend',{timeout:60000},()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'nodo-watchdog-test-'));
 try{
  const exe=path.join(root,'fixture'),moduleCache=path.join(root,'modules');
  const build=spawnSync('/usr/bin/swiftc',['-module-cache-path',moduleCache,path.resolve(__dirname,'../rescue/UpdateLifecycle.swift'),path.resolve(__dirname,'../rescue/BackupScope.swift'),path.join(__dirname,'watchdog-fixture.swift'),'-o',exe],{encoding:'utf8',timeout:45000});
  assert.equal(build.status,0,build.stderr);
  const run=spawnSync(exe,[root],{encoding:'utf8',timeout:5000});
  assert.equal(run.status,0,run.stderr);assert.match(run.stdout,/PASS loaded\/unloaded/);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
