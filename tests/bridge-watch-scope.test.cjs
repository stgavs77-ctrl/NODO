const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {passiveWatch}=require('../lib/bridge-watch-scope.cjs');
const home='/synthetic/user',source='SYNTHETIC_WATCH_SOURCE_NO_EXECUTION';
const expectedHash=crypto.createHash('sha256').update(source).digest('hex');
const base=()=>({home,source,expectedHash,config:{telegram:false},plist:{Label:'com.local.dsh-bridge-watch',ProgramArguments:['/usr/bin/python3',home+'/.dsh/plugins/telegram-bridge/watch.py','--quiet'],EnvironmentVariables:{HOME:home}}});
test('passive watch accepts only exact pinned configured job',()=>{assert.equal(passiveWatch(base()),true);});
test('Telegram alerts enabled or config unavailable rejects passive classification',()=>{
 for(const config of [{telegram:true},null])assert.equal(passiveWatch({...base(),config}),false);
});
test('changed source hash is rejected',()=>{assert.equal(passiveWatch({...base(),source:source+'changed'}),false);});
test('label, command, arguments, and HOME drift are rejected without launchctl',()=>{
 for(const patch of [{Label:'another.job'},{ProgramArguments:['/bin/sh','-c','anything']},{ProgramArguments:[...base().plist.ProgramArguments,'--send']},{EnvironmentVariables:{HOME:'/another/home'}}]){
  const fixture=base();fixture.plist={...fixture.plist,...patch};assert.equal(passiveWatch(fixture),false);
 }
 assert.equal(passiveWatch({...base(),home:'/other/user'}),false);
});
