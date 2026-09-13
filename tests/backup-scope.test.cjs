const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
test('actual Swift scoped encrypted backup while excluded synthetic writers continue',{timeout:60000},()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'nodo-scope-test-'));
 try{
  const exe=path.join(root,'fixture');
  const build=spawnSync('/usr/bin/swiftc',['-D','NODO_BACKUP_TESTING','-module-cache-path',path.join(root,'modules'),path.resolve(__dirname,'../rescue/BackupScope.swift'),path.resolve(__dirname,'../rescue/UserBackup.swift'),path.join(__dirname,'backup-scope-fixture.swift'),'-o',exe],{encoding:'utf8',timeout:45000});
  assert.equal(build.status,0,build.stderr);
  const result=spawnSync(exe,[root],{encoding:'utf8',timeout:10000});
  assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/PASS exact scope/);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
