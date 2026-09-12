// Test child only. Never invoke launchctl; leave actual ps/lsof/codesign unchanged.
const cp=require('node:child_process'),original=cp.execFileSync;
cp.execFileSync=function(file,args,...rest){
 if(file==='/bin/launchctl'){
  const expected=['print',`gui/${process.getuid()}/com.local.dsh-bridge-watch`];
  if(JSON.stringify(args)!==JSON.stringify(expected))throw Error('Unexpected fixture launchctl call');
  const error=Error('Synthetic passive watch unloaded');error.status=113;throw error;
 }
 return original.call(this,file,args,...rest);
};
