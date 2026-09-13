'use strict';
// DEV benchmark runner for the three context modes. Talks to the running DEV
// app over its own sockets only; never touches production profile or ports.
//
//   node tests/bench-economy.cjs --label baseline [--mode economy|balanced|full] [--scenario N]
//
// Reads provider-reported usage straight from the session log, so every number
// in the report is observed, not estimated.
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {rpc}=require(path.join(__dirname,'..','lib','io.cjs'));

const DATA=path.join(os.homedir(),'Library/Application Support/NODO DEV');
const WORKSPACE=path.join(DATA,'workspace');
const OUT=path.join(__dirname,'artifacts/economy-bench.jsonl');

const SCENARIOS=[
 {id:'simple',tier:'plain question',messages:['Answer in one sentence: what is 17*23?']},
 {id:'brain',tier:'project brain question',messages:['Using the selected project context only, name the two folders that hold the DEV and production profiles of this project. One short sentence.']},
 {id:'rules',tier:'rules-driven task',messages:['I am about to edit a REAPER project file in place. State whether that is allowed here and what the rule requires instead. Two sentences maximum.']},
 {id:'files',tier:'code task across files',messages:['Read bench-src/parser.cjs and bench-src/report.cjs in this workspace, find the concrete bug in total(), and give the minimal fix as a two-line diff. No other commentary.']},
 {id:'mission',tier:'multi-step mission',messages:['In this workspace: (1) read BENCH-NOTES.md and both files in bench-src/, (2) list the two modules and their single responsibility, (3) name the bug in total() and its user-visible effect, (4) write the corrected function to bench-src/report.fixed.cjs, (5) confirm the file exists. Finish with the single word DONE.']},
 // Same question three times inside one session: isolates the per-step cost of
 // the stable prefix from the one-time cost of opening a session.
 {id:'history',tier:'project history question',messages:['\u041f\u043e\u0441\u043c\u043e\u0442\u0440\u0438 \u043f\u043e \u0432\u0441\u0435\u0439 \u0438\u0441\u0442\u043e\u0440\u0438\u0438 \u043f\u0440\u043e\u0435\u043a\u0442\u0430 NODO: \u043a\u0430\u043a\u0438\u0435 \u0442\u0440\u0438 \u0441\u0430\u043c\u044b\u0435 \u0432\u0430\u0436\u043d\u044b\u0435 \u043d\u0435\u0440\u0435\u0448\u0451\u043d\u043d\u044b\u0435 \u043f\u0440\u043e\u0431\u043b\u0435\u043c\u044b \u0441\u0435\u0439\u0447\u0430\u0441 \u043e\u0441\u0442\u0430\u043b\u0438\u0441\u044c, \u043f\u043e\u0447\u0435\u043c\u0443 \u043e\u043d\u0438 \u0432\u043e\u0437\u043d\u0438\u043a\u043b\u0438 \u0438 \u0447\u0442\u043e \u0442\u044b \u0431\u044b \u0434\u0435\u043b\u0430\u043b \u043f\u0435\u0440\u0432\u044b\u043c? \u041d\u0438\u0447\u0435\u0433\u043e \u043d\u0435 \u043c\u0435\u043d\u044f\u0439, \u0442\u043e\u043b\u044c\u043a\u043e \u043e\u0442\u0432\u0435\u0442\u044c.']},
 {id:'repeat',tier:'three identical steps',messages:['Answer in three words: which module parses CSV rows here?','Same question again, three words.','Again, three words.']}
];

function instance(){return JSON.parse(fs.readFileSync(path.join(DATA,'instance.json'),'utf8'));}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function call(method,params={},timeout=600000){const sock=instance();return await rpc(sock.dshSocket,method,params,timeout);}

function usageOf(events){
 const rows=events.filter(e=>e.type==='assistant/message'&&e.data?.usage).map(e=>({seq:e.seq,turn:e.data.turn,usage:e.data.usage}));
 const sum=rows.reduce((a,r)=>{const u=r.usage;a.input+=u.inputTokens||0;a.cached+=u.cacheReadTokens||0;a.write+=u.cacheWriteTokens||0;a.output+=u.outputTokens||0;a.reasoning+=u.reasoningTokens||0;a.steps+=1;return a;},{input:0,cached:0,write:0,output:0,reasoning:0,steps:0});
 const last=rows.at(-1)?.usage||null;
 return {rows:rows.map(r=>({seq:r.seq,turn:r.turn,input:r.usage.inputTokens,cached:r.usage.cacheReadTokens||0,output:r.usage.outputTokens})),sum,peakInput:rows.reduce((m,r)=>Math.max(m,r.usage.inputTokens+(r.usage.cacheReadTokens||0)),0),last};
}
const lastAssistant=events=>events.filter(e=>e.type==='assistant/message').at(-1);
const assistantText=e=>(e?.data?.message?.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('\n');
const hasToolCalls=e=>(e?.data?.message?.content||[]).some(b=>b.type==='tool-call');

async function runScenario(scenario,mode){
 const created=await call('create',{cwd:WORKSPACE},60000);
 const sessionId=created.sessionId||created.id;
 if(mode)await call('project.call',{action:'mode.set',sessionId,scope:'session',mode},30000).catch(()=>{});
 const started=Date.now();
 for(const text of scenario.messages){
  await call('prompt',{sessionId,requestId:'bench-'+scenario.id+'-'+Date.now(),text},900000);
 }
 // Wait for the session to be idle again (no assistant message with pending tools).
 let idle=false;
 for(let i=0;i<60&&!idle;i++){
  const view=await call('inspect',{sessionId},60000).catch(()=>null);
  const events=view?.events||view||[];
  const last=lastAssistant(events);
  idle=!!last&&!hasToolCalls(last);
  if(!idle)await sleep(2000);
 }
 const view=await call('inspect',{sessionId},60000).catch(()=>null);
 const events=view?.events||view||[];
 const usage=usageOf(events);
 const answer=assistantText(lastAssistant(events));
 return {scenario:scenario.id,tier:scenario.tier,mode:mode||'baseline',sessionId,ms:Date.now()-started,tools:events.filter(e=>e.type==='tool/call').length,turns:new Set(events.filter(e=>e.type==='turn/start').map(e=>e.seq)).size,usage,answer:answer.slice(0,1200)};
}
async function projectStatus(sessionId){try{return await call('project.call',{action:'context.status',sessionId},30000);}catch{return null;}}

(async()=>{
 const arg=n=>{const i=process.argv.indexOf(n);return i<0?null:process.argv[i+1];};
 const label=arg('--label')||('run-'+Date.now());
 const mode=arg('--mode')||null;
 const only=arg('--scenario');
 fs.mkdirSync(path.dirname(OUT),{recursive:true});
 for(const scenario of SCENARIOS){
  if(only&&scenario.id!==only)continue;
  process.stdout.write(`${label} · ${scenario.id} · ${mode||'baseline'} … `);
  try{
   const result=await runScenario(scenario,mode);
   const metrics=(await projectStatus(result.sessionId))?.metrics||null;
   const line={label,at:new Date().toISOString(),...result,metrics};
   fs.appendFileSync(OUT,JSON.stringify(line)+'\n');
   const u=result.usage.sum;
   console.log(`ok in=${u.input} hit=${u.cached} out=${u.output} steps=${u.steps} tools=${result.tools}${metrics?` ctx=${metrics.injectedTokens}/${metrics.candidateTokens}`:''}`);
  }catch(error){console.log('FAILED',error.message);fs.appendFileSync(OUT,JSON.stringify({label,scenario:scenario.id,mode:mode||'baseline',error:error.message})+'\n');}
 }
})();
