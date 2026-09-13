const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {serve,save}=require('./lib/io.cjs');
const home=os.homedir(),data=path.join(home,'Library/Application Support/NODO'),base=path.join(home,'Library/Application Support/NODO Rescue');
const version=fs.readFileSync(path.join(__dirname,'version'),'utf8');
if(version==='BROKEN')process.exit(23);
const tx=fs.readdirSync(path.join(base,'transactions')).map(x=>path.join(base,'transactions',x));
const verified=tx.some(x=>fs.existsSync(path.join(x,'user-backup/user-state.nodobackup'))&&fs.existsSync(path.join(x,'backup-receipt.json')));
if(process.env.NODO_TEST_UPDATE_KIND==='patch'){const update=JSON.parse(fs.readFileSync(path.join(base,'last-update.json')));if(!fs.existsSync(update.backup))throw Error('Fixture startup before code rollback backup');}
else if(!verified)throw Error('Fixture startup before encrypted recovery backup');
const socket=path.join(home,'fixture.sock');if(fs.existsSync(socket))fs.unlinkSync(socket);
let paused=false;
const server=serve(socket,async method=>{
 if(method==='lifecycle.quit'){setTimeout(()=>server.close(()=>process.exit(0)),20);return {quitting:true};}
 if(method==='lifecycle.pause')paused=true;
 if(method==='lifecycle.resume')paused=false;
 return {protocol:1,activeTurns:0,tasks:0,dshReady:true,codexReady:true,synthetic:true,services:['nodo-tools','telegram-bridge','sessions-observer'].map(name=>({name,paused,drained:paused,inflight:0}))};
});
server.on('listening',()=>{
 save(path.join(data,'instance.json'),{pid:process.ppid,appSocket:socket});
 save(path.join(data,'startup-status.json'),{state:'ready',pid:process.ppid,synthetic:true});
 save(path.join(home,'fixture-start-proof.json'),{version,encryptedBackupExisted:verified,parentPID:process.ppid});
});
