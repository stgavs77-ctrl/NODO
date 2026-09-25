const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {installSupervisor,classify,normalize}=require('../lib/supervisor.cjs');

const pass=(text='ok')=>({isError:false,value:{exitCode:0,stdout:{text},stderr:{text:''}},content:[{type:'text',text}]});
const fail=(code,text)=>({isError:false,value:{exitCode:code,stdout:{text:''},stderr:{text}},content:[{type:'text',text:text+'\n[exit code: '+code+']'}]});

// Practical scenarios for the Supervisor / Anti-loop Governor. The harness below
// is the real harness pipeline reduced to what the supervisor uses: the guard is
// asked first, a settled execution is reported second, session events carry the
// turn boundaries. No model is involved and nothing is mocked inside the
// supervisor itself.
function harness(options={}){
 const handlers=new Map(),cancelled=[],published=[],root=fs.mkdtempSync(path.join(os.tmpdir(),'nodo-supervisor-'));
 const ctx={
  tools:{guard(guard){handlers.set('guard',guard);return()=>{};}},
  on(name,handler){handlers.set(name,handler);return()=>{};},
  agents:{get:()=>undefined},
  sessionController:{cancel:async({sessionId})=>{cancelled.push(sessionId);return{accepted:true};}}
 };
 const api=installSupervisor(ctx,{dataDir:root,logFile:path.join(root,'supervisor.jsonl'),bridge:async(_m,p)=>{published.push(p);},thresholds:{graceMs:20,...(options.thresholds||{})}});
 const sessionId=options.sessionId||'s1';
 const start=()=>handlers.get('session/event')({id:sessionId},{type:'turn/start',data:{}});
 const end=()=>handlers.get('session/event')({id:sessionId},{type:'turn/end',data:{}});
 const exec=(name,args)=>({name,arguments:args,callId:'call-'+Math.random().toString(16).slice(2),agent:{session:{id:sessionId,header:{cwd:'/work'}}}});
 const run=async(name,args,result)=>{const call=exec(name,args);const reason=handlers.get('guard')(call);if(reason)return{denied:reason};const value=await handlers.get('tools/execute')(call,async()=>result);return{result:value};};
 return {api,handlers,state:()=>api.supervisor.state(sessionId,true),start,end,run,cancelled,published,root,sessionId};
}

const VERIFY={command:'node --test tests/slow.test.cjs'};

test('A. the same failing command repeated stops the loop and cancels safely',async()=>{
 const h=harness();
 h.start();
 const outcomes=[];
 for(let i=0;i<6;i++)outcomes.push(await h.run('bash',VERIFY,fail(1,'Cannot find module tests/slow.test.cjs')));
 const denied=outcomes.filter(o=>o.denied);
 assert.equal(outcomes.filter(o=>o.result).length,3,'three attempts run, the loop is confirmed at three repeats');
 assert.equal(denied.length,3,'every later attempt is refused, never silently executed');
 assert.equal(h.state().phase,'intervened');
 assert.equal(h.state().intervention.code,'repeated-operation');
 assert.match(denied[0].denied,/NODO Supervisor stopped a loop/);
 assert.match(denied[0].denied,/Attempts: 3/);
 await new Promise(r=>setTimeout(r,60));
 assert.deepEqual(h.cancelled,[h.sessionId],'the turn is cancelled the standard way, after the grace window');
 assert.ok(fs.readFileSync(path.join(h.root,'supervisor.jsonl'),'utf8').includes('repeated-command'),'the event is written to the supervisor log');
});

test('B. a check that already passed is not run again while its code is unchanged',async()=>{
 const h=harness();
 h.start();
 assert.equal((await h.run('bash',VERIFY,pass('PASS 3 tests'))).denied,undefined);
 const second=await h.run('bash',VERIFY,pass('PASS 3 tests'));
 assert.match(second.denied||'',/already passed/i);
 assert.equal(h.state().intervention.code,'pass-no-change');
});

test('C. one concrete fix allows exactly one re-run of the related check',async()=>{
 const h=harness();
 h.start();
 await h.run('bash',VERIFY,fail(1,'assertion failed'));
 await h.run('edit',{file_path:'/work/src/thing.cjs',old_string:'a',new_string:'b'},{isError:false,value:{},content:[{type:'text',text:'ok'}]});
 const rerun=await h.run('bash',VERIFY,fail(1,'assertion failed'));
 assert.equal(rerun.denied,undefined,'the first re-run after the fix is allowed');
 const again=await h.run('bash',VERIFY,fail(1,'assertion failed'));
 assert.match(again.denied||'',/re-run after a fix|stopped a loop/i);
 assert.equal(h.state().intervention.code,'post-fix-repeat');
});

test('C2. after a passing fix the check may run again and then dedups',async()=>{
 const h=harness();
 h.start();
 await h.run('bash',VERIFY,fail(1,'assertion failed'));
 await h.run('edit',{file_path:'/work/src/thing.cjs',old_string:'a',new_string:'b'},{isError:false,value:{},content:[{type:'text',text:'ok'}]});
 assert.equal((await h.run('bash',VERIFY,pass('PASS 3 tests'))).denied,undefined);
 assert.match((await h.run('bash',VERIFY,pass('PASS 3 tests'))).denied||'',/already passed/i);
});

test('D. different actions with real progress are never treated as a loop',async()=>{
 const h=harness();
 h.start();
 for(const name of ['one','two','three','four','five']){
  assert.equal((await h.run('edit',{file_path:'/work/docs/'+name+'.md',old_string:'x',new_string:'y-'+name},{isError:false,value:{},content:[{type:'text',text:'ok'}]})).denied,undefined);
  assert.equal((await h.run('bash',{command:'git status'},pass('nothing to commit'))).denied,undefined);
 }
 assert.equal(h.state().phase,'active');
 assert.equal(h.state().intervention,null);
 assert.ok(h.state().progressCount>=5,'every real change counts as progress');
 assert.equal(h.cancelled.length,0);
});

test('E. Continue once grants exactly one further attempt',async()=>{
 const h=harness();
 h.start();
 for(let i=0;i<4;i++)await h.run('bash',VERIFY,fail(1,'boom'));
 assert.equal(h.state().phase,'intervened');
 const granted=h.api.act({sessionId:h.sessionId,action:'continue-once'});
 assert.equal(granted.accepted,true);
 assert.equal(h.state().phase,'active');
 // The user's resume message opens a fresh turn, exactly like the real runtime:
 // the grant must survive it, and only the granted attempt may run there.
 h.start();
 assert.equal((await h.run('bash',VERIFY,fail(1,'boom'))).denied,undefined,'the one granted attempt runs');
 assert.match((await h.run('bash',VERIFY,fail(1,'boom'))).denied||'',/Continue once|stopped a loop/i,'the next identical repeat is stopped again');
 assert.match((await h.run('bash',VERIFY,fail(1,'boom'))).denied||'',/Continue once|stopped a loop/i,'and every later one as well');
 assert.ok(h.state().events.some(e=>e.type==='manual-continue'),'the manual continue is recorded');
 // An unused grant lapses with the turn it was meant for.
 const h2=harness();
 h2.start();
 for(let i=0;i<4;i++)await h2.run('bash',VERIFY,fail(1,'boom'));
 h2.api.act({sessionId:h2.sessionId,action:'continue-once'});
 h2.start();
 assert.equal((h2.state().oneShot&&h2.state().oneShot.used),false,'the grant is open in the resumed turn');
 h2.end();
 assert.equal(h2.state().oneShot,null,'an unused grant does not stay open after that turn');
});

test('F. a turn with no objective progress is stopped by the timeout',async()=>{
 const h=harness({thresholds:{noProgressMs:30,stepWarnMs:100000}});
 h.start();
 h.state().lastProgressAt=Date.now()-5000;
 h.api.supervisor.tick();
 assert.equal(h.state().phase,'intervened');
 assert.equal(h.state().intervention.code,'no-progress');
 await new Promise(r=>setTimeout(r,60));
 assert.deepEqual(h.cancelled,[h.sessionId]);
});

test('G. equivalent commands collapse, different commands stay apart',async()=>{
 const h=harness();
 h.start();
 await h.run('bash',{command:'cd /var/folders/jl/abc/T/nodo-x1 && node --test tests/a.test.cjs'},fail(1,'boom'));
 await h.run('bash',{command:'cd /tmp/nodo-y2 && node --test tests/a.test.cjs'},fail(1,'boom'));
 assert.equal(h.state().ops.size,1,'the same operation behind a different cd prefix and temp path is one operation');
 await h.run('bash',{command:'node --test tests/b.test.cjs'},fail(1,'boom'));
 assert.equal(h.state().ops.size,2,'a different target is a different operation');
 assert.equal(normalize('node --test x.test.cjs  1700000000'),'node --test x.test.cjs <TS>');
 assert.equal(classify('npm test'),'verify');
 assert.equal(classify('npm run build'),'mutate');
 assert.equal(classify('open -a REAPER'),'launch');
 assert.equal(classify('cat README.md'),'inspect');
});

test('H. the user interrupt pauses new work and keeps the answer for the safe point',async()=>{
 const h=harness();
 h.start();
 const answer=h.api.userMessage({sessionId:h.sessionId,text:'Почему ты выбрал этот вариант?'});
 assert.equal(answer.received,true);
 assert.equal(answer.mode,'question');
 assert.equal(h.state().phase,'pausing');
 const blocked=await h.run('bash',{command:'node --test tests/a.test.cjs'},pass());
 assert.match(blocked.denied||'',/the user sent a message/i);
 assert.ok(h.state().events.some(e=>e.type==='user-interrupt'));
 const action=h.api.userMessage({sessionId:h.sessionId,text:'Поправь файл README и запушь'});
 assert.equal(action.mode,'action');
 assert.equal(action.paused,false);
});

test('I. acceptance met stops optional extra audits',async()=>{
 const h=harness({thresholds:{optionalAuditLimit:1}});
 h.start();
 await h.run('bash',{command:'npm test'},pass('PASS'));
 assert.equal(h.state().acceptance.met,true);
 await h.run('bash',{command:'npm run validate'},pass('ok'));
 const extra=await h.run('bash',{command:'npm run audit:extra'},pass('ok'));
 assert.match(extra.denied||'',/optional extra tests or audits/i);
 assert.equal(h.state().intervention.code,'success-stop');
});

test('user message classifier handles Cyrillic word boundaries and URL query strings', () => {
  const { classifyUserMessage } = require('../lib/supervisor.cjs');
  assert.equal(classifyUserMessage('что делаешь'), 'question');
  assert.equal(classifyUserMessage('какой статус'), 'question');
  assert.equal(classifyUserMessage('как дела?'), 'question');
  assert.equal(classifyUserMessage('каталог почисти'), 'action');
  assert.equal(classifyUserMessage('что-то сломалось, почини'), 'action');
  assert.equal(classifyUserMessage('открой https://example.com/page?id=1 и проверь'), 'action');
  assert.equal(classifyUserMessage('whatever, just do it'), 'action');
});

test('a hung tool cannot keep an intervened turn alive forever',async()=>{
 const h=harness();
 h.start();
 // An operation that never settles stays in flight while the loop is detected.
 void h.run('bash',{command:'node scripts/hang.cjs'},new Promise(()=>{}));
 for(let i=0;i<6;i++)await h.run('bash',VERIFY,fail(1,'Cannot find module tests/slow.test.cjs'));
 assert.equal(h.state().phase,'intervened');assert.equal(h.cancelled.length,0);
 // Five grace periods of 20 ms; poll so a slow CI runner does not flake.
 for(const until=Date.now()+2000;!h.cancelled.length&&Date.now()<until;)await new Promise(r=>setTimeout(r,20));
 assert.deepEqual(h.cancelled,['s1']);
});
