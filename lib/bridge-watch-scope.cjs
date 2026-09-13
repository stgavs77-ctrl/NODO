const crypto=require('node:crypto');
// Read-only audited legacy watch.py: with telegram !== true, ping returns before
// invoking the sender. All remaining writes are diagnostic files excluded from backup.
const pinned='d4d71a902fc67bfee9299131490323e29adeeea1b7390b55d8491a13ebbf81b3';
function passiveWatch({plist,config,source,home,expectedHash=pinned}){
 const args=['/usr/bin/python3',home+'/.dsh/plugins/telegram-bridge/watch.py','--quiet'];
 return plist.Label==='com.local.dsh-bridge-watch'
  && JSON.stringify(plist.ProgramArguments)===JSON.stringify(args)
  && (!plist.EnvironmentVariables?.HOME||plist.EnvironmentVariables.HOME===home)
  && crypto.createHash('sha256').update(source).digest('hex')===expectedHash
  && config!==null && typeof config==='object' && config.telegram!==true;
}
module.exports={passiveWatch,pinned};
