const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nodo-backup-acceptance-')),exe=path.join(dir,'acceptance');
cp.execFileSync('/usr/bin/xcrun',['swiftc','-O','-D','NODO_BACKUP_TESTING','-framework','Security',path.resolve(__dirname,'../rescue/UserBackup.swift'),path.join(__dirname,'rescue-user-backup.swift'),'-o',exe],{stdio:'inherit'});
if(process.argv.includes('--keychain')){
 const report=JSON.parse(cp.execFileSync(exe,['--keychain'],{encoding:'utf8',stdio:['inherit','pipe','inherit']}));
 const artifacts=path.join(__dirname,'artifacts',`keychain-backup-${report.backupID}`);fs.mkdirSync(artifacts,{recursive:true,mode:0o700});
 fs.copyFileSync(report.archivePath,path.join(artifacts,'user-state.nodobackup'));fs.copyFileSync(report.receiptPath,path.join(artifacts,'receipt.json'));
 fs.writeFileSync(path.join(artifacts,'test-result.json'),JSON.stringify({...report,retainedArchive:path.join(artifacts,'user-state.nodobackup'),syntheticOnly:true},null,2),{mode:0o600});
 console.log(JSON.stringify({...report,artifacts},null,2));
}else cp.execFileSync(exe,[],{stdio:'inherit'});
