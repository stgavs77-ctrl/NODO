// NODO adapter only. Never mounts the production bridge or starts a receiver.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {execFile}=require('node:child_process');
// The desktop host can run under Rosetta, while the installed crypto wheels
// are arm64. Pin the existing system Python architecture on this Mac.
function run(args){return new Promise((resolve,reject)=>execFile('/usr/bin/arch',['-arm64','/usr/bin/python3','-B',...args],{timeout:60000,maxBuffer:2*1024*1024,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}},(error,stdout)=>{
 // Do not expose execFile's command/error (it can contain private message text).
 if(error)return reject(Error('Telegram helper failed or timed out. If sending, outcome is UNKNOWN: verify Telegram; never retry automatically.'));
 try{resolve(JSON.parse(stdout));}catch{reject(Error('Invalid Telegram helper response; if sending, outcome is UNKNOWN. Do not retry automatically.'));}
}));}
function createTelegram({bridge=path.join(os.homedir(),'.dsh/plugins/telegram-bridge'),runner=run}={}){
 const read=name=>JSON.parse(fs.readFileSync(path.join(bridge,name),'utf8'));
 function chatForSession(sessionId){
  if(!sessionId)throw Error('Telegram requires an existing client session.');
  const registry=read('chat-sessions.json'),state=read('state.json');
  const candidates=[...new Set([...Object.entries(registry),...Object.entries(state.chats||{})].filter(([,v])=>v?.session===sessionId).map(([id])=>Number(id)))];
  if(candidates.length!==1||!Number.isSafeInteger(candidates[0]))throw Error('No unambiguous Telegram chat bound to this session ID. No title-based guessing.');
  const allowed=read('allowed-chats.json');
  if(!(allowed.allow||[]).map(Number).includes(candidates[0]))throw Error('Bound Telegram chat is not on the existing allowlist.');
  return candidates[0];
 }
 const pending=new Set();
 return {
  chatForSession,
  async read(sessionId,{limit=20,before}={}){
   const chat=chatForSession(sessionId);
   if(!Number.isInteger(limit)||limit<1||limit>100)throw Error('limit must be 1–100');
   if(before!==undefined&&(!Number.isSafeInteger(before)||before<0))throw Error('Invalid before update ID');
   return runner([path.resolve(__dirname,'../scripts/telegram-read.py'),'--chat',String(chat),'--limit',String(limit),...(before===undefined?[]:['--before',String(before)])]);
  },
  async reply(sessionId,args,lastUserMessage){
   const chat=chatForSession(sessionId),text=args.text;
   if(typeof lastUserMessage!=='string'||!lastUserMessage.trim()||lastUserMessage.trimStart().startsWith('[мост]'))throw Error('Sending requires an owner request in this session, not an automatic bridge draft.');
   if(typeof text!=='string'||!text.trim()||Array.from(text).length>4000)throw Error('Telegram text must contain 1–4000 characters.');
   // Serialize NODO sends per chat. The legacy sender owns the shared durable
   // dedup ledger; production is deliberately not modified here.
   if(pending.has(chat))throw Error('A send is already in progress for this chat. Check its result before retrying.');
   pending.add(chat);
   try{
    const answer=await runner([path.join(bridge,'send_message.py'),'--chat',String(chat),'--text',text,...(args.repeat===true?['--force']:[])]);
    if(answer.ok!==true)throw Error(answer.outcome==='not_sent'?'Telegram explicitly rejected the message; not sent.':'Telegram delivery is UNKNOWN or blocked. Verify the chat; no automatic retry.');
    return {chat_id:answer.chat_id,message_id:answer.message_id,readback:answer.readback,deduplicated:answer.deduplicated===true,note:answer.deduplicated?'Already sent: duplicate suppressed by the shared sender ledger.':answer.readback===true?null:'Recipient/text readback not confirmed; verify Telegram before any retry.'};
   }finally{pending.delete(chat);}
  }
 };
}
module.exports={createTelegram};
