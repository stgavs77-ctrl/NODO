'use strict';
// Smart Context + modes: mandatory rules, tier scaling, adaptive step, honest
// metrics and the stable cacheable prefix.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {ContextModes,MODES,DEFAULT_MODE,TIERS}=require('../lib/context-modes.cjs');
const engine=require('../lib/context-engine.cjs');
const {ProjectBrain}=require('../lib/project-brain.cjs');

function fixture(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'nodo-ctx-')),workspace=path.join(root,'workspace');
 fs.mkdirSync(workspace);
 const brain=new ProjectBrain(root);
 for(let i=0;i<40;i++)brain.mutate(workspace,'entries','save',{text:`parser module detail ${i}: rounding rule ${i*13} for bench-src/parser.cjs row ${i}`,type:'technical',pinned:i===0});
 brain.mutate(workspace,'entries','save',{text:'file reference: bench-src/parser.cjs',type:'file'});
 for(const [text,scope,priority] of [['Answer in the request language.','Project',95],['Never modify original audio files.','REAPER',80],['Checkpoint before code edits.','Coding',85],['No prices outside approved templates.','Telegram',80],['Keep production untouched.','Project',90]])brain.mutate(workspace,'rules','save',{text,scope,priority,enabled:true});
 return {root,workspace,store:brain.get(workspace)};
}

test('modes persist globally, per workspace and per session with a documented default',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'nodo-modes-'));const modes=new ContextModes({data:root});
 assert.equal(modes.resolve('/w','s1').mode,DEFAULT_MODE);
 assert.equal(modes.resolve('/w','s1').source,'global');
 assert.equal(modes.setGlobal('economy').global,'economy');
 assert.equal(modes.resolve('/w','s1').source,'global');
 modes.setWorkspace('/w','full');
 assert.equal(modes.resolve('/w','s1').mode,'full');
 assert.equal(modes.resolve('/w','s1').source,'workspace');
 modes.setWorkspace('/w',null);
 assert.equal(modes.resolve('/w','s1').mode,'economy');
 modes.setSession('s1','full');
 assert.equal(modes.resolve('/w','s1').source,'session');
 assert.equal(modes.resolve('/w','s2').mode,'economy','a session override must not leak to another session');
 // The switch reads the active mode from the snapshot, so the snapshot has to
 // resolve with the session and report that session's override.
 assert.equal(modes.snapshot('/w','s1').mode,'full','snapshot must report the session override');
 assert.equal(modes.snapshot('/w','s1').source,'session');
 assert.equal(modes.snapshot('/w','s2').mode,'economy');
 assert.equal(modes.snapshot('/w').mode,'economy','without a session the snapshot stays on the workspace/global mode');
 assert.throws(()=>modes.setGlobal('cheap'),/mode/i);
 // Reload from disk: the global choice survives, session overrides do not.
 const reloaded=new ContextModes({data:root});
 assert.equal(reloaded.resolve('/w','s9').mode,'economy');
 assert.equal(reloaded.resolve('/w','s1').source,'global');
 for(const mode of MODES)assert.ok(TIERS[mode],mode+' must define a tier');
});

test('Smart Context keeps mandatory rules, scales with mode and reports honest metrics',async()=>{
 const {root,workspace,store}=fixture();
 try{
  const text='Read bench-src/parser.cjs and fix the rounding bug in the parser row handling';
  const sizes=[];
  for(const mode of MODES){
   const result=await engine.select({store,text,mode,fileText:()=>'module.exports={parse(){}};'.repeat(30)});
   const rules=result.included.filter(x=>x.kind==='rule');
   assert.ok(rules.some(r=>r.scope==='Project'),mode+': mandatory Project rules must survive selection');
   assert.ok(result.metrics.injectedChars<=result.metrics.candidateChars,mode+': cannot send more than the candidate pool');
   assert.equal(result.metrics.injectedChars,result.included.reduce((n,x)=>n+x.text.length,0),mode+': metrics must match the payload');
   assert.equal(result.metrics.requestedMode,mode);
   sizes.push(result.metrics.injectedChars);
  }
  assert.ok(sizes[0]<sizes[1]&&sizes[1]<sizes[2],'economy < balanced < full, got '+sizes.join(','));
  const result=await engine.select({store,text,mode:'balanced',fileText:()=>'CONTENT-OF-FILE'});
  assert.ok(result.included.some(x=>x.kind==='file'&&x.text==='CONTENT-OF-FILE'),'a referenced file must arrive as its content, not as a bare path');
  assert.equal(result.included.filter(x=>x.kind==='file-reference').length,0,'a resolved reference must not be left in the payload as a bare path');
  assert.ok(result.metrics.byKind.files>=1);
  assert.ok(result.metrics.candidateCount>result.metrics.injectedCount,'reduction must be visible in the metrics');
  assert.ok(result.metrics.savedRatio>0&&result.metrics.savedRatio<1);
  assert.ok(Number.isFinite(result.metrics.ts)&&result.metrics.ts>0,'metrics carry the moment they were computed');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('ECONOMY expands step by step on low confidence and never silently becomes FULL',async()=>{
 const {root,workspace,store}=fixture();
 try{
  const unrelated='Совершенно посторонняя тема про акустику комнаты и моды помещения';
  const result=await engine.select({store,text:unrelated,mode:'economy',fileText:()=>'x'});
  if(result.metrics.adaptive){
   // Expansion widens which sources travel, never the mode the user picked.
   assert.equal(result.metrics.adaptive.requested,'economy');
   assert.equal(result.metrics.adaptive.effective,'economy','ECONOMY must stay ECONOMY while it expands');
   assert.ok(Array.isArray(result.metrics.adaptive.steps),'expansion is reported as a ladder of steps');
   assert.ok(result.metrics.adaptive.initial.tokens<=result.metrics.adaptive.tokens,'expansion can only add context');
  }
  assert.equal(result.metrics.mode,'economy','the budget and label stay economy');
  assert.notEqual(result.metrics.mode,'full','ECONOMY must never widen straight to FULL');
  assert.equal(result.metrics.requestedMode,'economy','the requested mode stays visible in the metrics');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('ECONOMY reaches project documents when the request asks about project state',async()=>{
 const {root,workspace,store}=fixture();
 try{
  const question='Посмотри по всей истории проекта: какие три самые важные нерешённые проблемы сейчас остались и что ты бы делал первым?';
  const docs=[{path:'STATUS.md',at:'2026-09-13T00:00:00.000Z',excerpt:'Open problems: runtime watchdog restart loop unresolved. Remote transport was restored and verified later.'},
   {path:'CHANGELOG.md',at:'2026-09-10T00:00:00.000Z',excerpt:'History of releases and fixes.'}];
  const result=await engine.select({store,text:question,mode:'economy',fileText:()=>'x',docs,git:['branch main, clean tree, last commits: economy work'],env:['NODO DEV workspace']});
  assert.equal(result.metrics.mode,'economy');
  assert.ok(result.included.some(x=>x.kind==='doc'&&x.text.includes('STATUS.md')),'a state question must reach project status documents');
  assert.ok(result.metrics.adaptive&&result.metrics.adaptive.addedGroups.includes('status-docs'),'the ladder reports the status/docs step');
  assert.ok(result.metrics.confidence.value>0,'the expanded selection covers more of the request');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('a resolved problem is marked and ranked behind a live one',async()=>{
 const {root,workspace,store}=fixture();
 try{
  store.entries.push({id:'old',text:'Blocker: Remote pairing was broken after the update',type:'technical',source:'note',createdAt:'2026-09-01T00:00:00.000Z',updatedAt:'2026-09-01T00:00:00.000Z',pinned:false});
  store.entries.push({id:'new',text:'Blocker: Remote pairing is restored and verified by the user',type:'technical',source:'note',createdAt:'2026-09-12T00:00:00.000Z',updatedAt:'2026-09-12T00:00:00.000Z',pinned:false});
  store.entries.push({id:'open',text:'Known issue: watchdog restarts the DEV server on exit',type:'technical',source:'note',createdAt:'2026-09-11T00:00:00.000Z',updatedAt:'2026-09-11T00:00:00.000Z',pinned:false});
  const result=await engine.select({store,text:'Какие нерешённые проблемы остались по Remote и watchdog?',mode:'economy',fileText:()=>'x'});
  const byId=id=>result.included.find(x=>x.id===id);
  assert.ok(byId('new'),'the newest statement about Remote must be selected');
  assert.equal(byId('new').state,'resolved','a restored problem is labelled as resolved');
  assert.equal(byId('open').state,'open');
  assert.ok(byId('new').text.includes('RESOLVED'),'the payload states the resolved status so stale notes cannot read as current');
  assert.ok(byId('new').text.startsWith('[2026-09-12'),'the payload carries the freshness date');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('A reference message is not required to carry rule text and the stable prefix stays byte-identical',async()=>{
 const {root,workspace,store}=fixture();
 try{
  const first=engine.stableBlock({store,mode:'balanced'}),second=engine.stableBlock({store,mode:'balanced'});
  assert.equal(first,second,'the cacheable prefix must not change between requests');
  assert.ok(first.includes('Project Rules'),'the stable prefix carries the rules');
  assert.equal(engine.stableBlock({store,mode:'economy'}),first,'rules and pinned facts are identical across modes so the cacheable prefix survives a mode switch');
  const other=engine.stableBlock({store,mode:'balanced'});
  assert.ok(other.includes('marked as stable'),'pinned facts are marked as stable in the prefix');
  assert.ok(other.includes('always apply'),'the prefix states that project instructions always apply');
  assert.ok(other.includes('[Project] Answer in the request language.'),'always-on Project rules travel in the cached prefix');
  assert.ok(!other.includes('[Coding] Checkpoint before code edits.'),'narrow-scope rules stay out of the cached prefix so it stays small');
  const scoped=await engine.select({store,text:'Checkpoint before code edits in this repo',mode:'balanced'});
  assert.ok(scoped.included.some(x=>x.kind==='rule'&&x.scope==='Coding'),'a scoped rule still travels when the request is in its scope');
  const unknown=engine.estimateTokens(400);
  assert.ok(Number.isSafeInteger(unknown)&&unknown>0);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('CURRENT STATE: live runtime version beats an older status document',async()=>{
 const {root,workspace,store}=fixture();
 try{
  const current=require('../lib/current-state.cjs');
  const live=current.liveState({appName:'NODO DEV',appVersion:'1.2.0',channel:'dev',dataDir:'/tmp/profile',workspaceVersion:'1.2.0'});
  const docs=[{path:'NEXT-STAGE-STATUS.md',at:'2026-01-05T00:00:00.000Z',excerpt:'Установлена версия 0.2.5, Remote не восстановлен, Keychain виснет.'},
   {path:'CHANGELOG.md',at:'2026-02-01T00:00:00.000Z',excerpt:'Released 0.2.0 and 0.2.5.'}];
  const result=await engine.select({store,text:'какие три самые важные нерешённые проблемы сейчас остались?',mode:'economy',fileText:()=>null,docs,live});
  const state=result.metrics.currentState;
  assert.ok(state&&state.live.length,'the live runtime block travels with the selection');
  assert.equal(state.live[0].state,'CURRENT');
  assert.equal(state.live[0].authority,'live-runtime');
  assert.ok(result.included.some(x=>x.kind==='live'&&x.text.includes('1.2.0')),'the model is told the installed version');
  assert.ok(state.conflicts.length&&state.conflicts[0].winner.value==='1.2.0','live state wins the version conflict');
  assert.equal(state.conflicts[0].loser.value,'0.2.5');
  assert.ok(state.superseded.includes('doc:NEXT-STAGE-STATUS.md'),'the document that lost is marked as superseded');
  assert.ok(/установлен/i.test(require('../lib/context-engine.cjs').rankDocs(docs,'нерешённые проблемы',1,engine.intentOf('нерешённые проблемы'),new Set(state.superseded))[0]?docs[0].excerpt:''),'fixture sanity');
  const block=(result.included.find(x=>x.kind==='doc')||{}).text||'';
  const stale=block.split(/\n(?=- \[)/).find(part=>part.includes('Установлена версия 0.2.5'))||'';
  assert.ok(/SUPERSEDED/.test(stale.split('\n')[0]),'the stale document travels labelled as superseded, not as current truth');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('CURRENT STATE: a document that matches live state is not called superseded',async()=>{
 const {root,workspace,store}=fixture();
 try{
  const current=require('../lib/current-state.cjs');
  const live=current.liveState({appName:'NODO DEV',appVersion:'1.1.0',workspaceVersion:'1.1.0'});
  const docs=[{path:'NEXT-STAGE-STATUS.md',at:'2026-09-13T00:00:00.000Z',excerpt:'Установлена версия 1.1.0, открыт вопрос подписи релиза.'}];
  const result=await engine.select({store,text:'какие нерешённые проблемы проекта установлены сейчас?',mode:'balanced',fileText:()=>null,docs,live});
  assert.equal(result.metrics.currentState.conflicts.length,0,'no conflict when the document agrees with live state');
  assert.equal(result.metrics.currentState.superseded.length,0);
  const block=(result.included.find(x=>x.kind==='doc')||{}).text||'';
  const agrees=block.split(/\n(?=- \[)/).find(part=>part.includes('Установлена версия 1.1.0'))||'';
  assert.ok(agrees,'the agreeing document still travels');
  // The block header explains the SUPERSEDED label itself, so only the
  // document's own line may be checked for it.
  assert.ok(!/SUPERSEDED/.test(agrees.split('\n')[0]),'an agreeing document keeps its normal label');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
