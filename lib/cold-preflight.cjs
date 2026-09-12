const fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib');
// The installer calls this only after verifying that the old main process and
// children have exited. This is a closed-profile path, never a pretend drain.
function coldPreflight(root,bridge){
 const parse=file=>{try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{throw Error('Persistent JSON unreadable: '+path.basename(file));}};
 const tasks=parse(path.join(root,'tasks.json')),rows=Array.isArray(tasks)?tasks:tasks.items;
 if(!Array.isArray(rows)||rows.some(t=>!['done','failed','cancelled','canceled'].includes(String(t.status).toLowerCase())))throw Error('Finish saved Tasks before updating');
 let sessions=0;
 function walk(dir){for(const item of fs.readdirSync(dir,{withFileTypes:true})){
  const file=path.join(dir,item.name);if(item.isDirectory())walk(file);
  else if(file.endsWith('.zstd')){
   let open=false;const bytes=zlib.zstdDecompressSync(fs.readFileSync(file));
   for(const line of bytes.toString('utf8').split('\n').filter(Boolean)){
    const row=JSON.parse(line);if(row.type==='turn/start')open=true;if(row.type==='turn/end')open=false;
   }
   if(open)throw Error('Saved DSH turn is unfinished; finish/recover it in NODO before updating');sessions++;
  }
 }}
 try{walk(path.join(root,'dsh/sessions'));}catch(error){if(error.message.startsWith('Saved DSH'))throw error;throw Error('DSH history is incomplete or unreadable; no files replaced');}
 for(const name of ['workstation.json'])parse(path.join(root,name));
 const state=parse(path.join(bridge,'state.json'));
 if(!Array.isArray(state.pending)||!Number.isFinite(state.cursor))throw Error('Telegram queue/cursor schema cannot be verified');
 for(const name of ['chat-sessions.json','allowed-chats.json','bridge-config.json'])parse(path.join(bridge,name));
 const ledger=path.join(bridge,'send-ledger.jsonl');
 if(fs.existsSync(ledger)){try{for(const line of fs.readFileSync(ledger,'utf8').split('\n').filter(Boolean))JSON.parse(line);}catch{throw Error('Telegram ledger is incomplete or unreadable; no data replaced');}}
 if(fs.existsSync(path.join(bridge,'selftest.txt')))throw Error('Pending legacy sender self-test; update refused');
 return {protocol:1,mode:'closed-profile',activeTurns:0,tasks:0,sessions,queuePreserved:true};
}
module.exports={coldPreflight};
