'use strict';
// Smart Context: one relevance-ranked selection over every context source.
// The engine never drops mandatory Project Rules; economy only narrows the
// optional sources (brain entries, project documents, git metadata, files,
// past-session fragments).
//
// ECONOMY does not give up when the first cheap slice is too thin. It walks a
// ladder of source tiers (brain, rules, project status/docs, git state,
// workspace files, past sessions) and stops as soon as the selected context
// covers the request. A local model may still read anything it needs with its
// own tools; expansion only decides what NODO pre-selects for it.
const {tokens,scopes}=require('./project-brain.cjs');
const {TIERS,NEXT_MODE}=require('./context-modes.cjs');
const current=require('./current-state.cjs');
// Rough display-only estimate. Provider-reported usage stays the authority for
// money; this number exists so the UI can compare candidates with what was sent.
const estimateTokens=chars=>chars>0?Math.max(1,Math.round(chars/4)):0;
const sumChars=items=>items.reduce((n,x)=>n+String(x.text||'').length,0);
const scoreOf=(text,query)=>{const words=tokens(text);let n=0;for(const word of query)if(words.has(word))n++;return n;};
// One order for "everything that could travel": the candidate pool and the
// ranker must agree, otherwise the reported before/after would be dishonest.
function orderBrain(store,text){
 const query=[...tokens(text)];
 return store.entries.filter(e=>e.type!=='file')
  .map(e=>({id:e.id,kind:'brain',source:e.source,at:e.updatedAt,pinned:e.pinned,text:e.text}))
  .map(item=>({item,score:scoreOf(item.text,query)+(item.pinned?3:0)}))
  .filter(row=>row.score>0)
  .sort((a,b)=>b.score-a.score||Number(b.item.pinned)-Number(a.item.pinned)||String(b.item.at||'').localeCompare(String(a.item.at||'')))
  .map(row=>row.item);
}

// ---------------------------------------------------------------------------
// What the request is about. Coverage by request terms alone is not enough:
// "what is still unresolved in this project" can be answered only by state or
// history sources, and the engine has to notice when none of them travelled.
// ---------------------------------------------------------------------------
function intentOf(text){
 const t=String(text||'');
 return {
  state:/нерешённ|нерешенн|не закрыт|открыт(ые|ых)?\s+(проблем|вопрос)|остал(ось|ись|ась)|текущ(ее|ий) состояни|что\s+(сейчас|осталось)|статус|status|unresolved|still open|outstanding|remaining|known issues|current state/i.test(t),
  history:/истори|что мы (уже )?делали|что было сделано|предыстори|раньше|ранее|прошл(ые|ых) (сесси|шаг)|changelog|changes|history|timeline|since (the )?(last|start)|release|релиз|версии|что изменилось/i.test(t),
  environment:/репозитор|git|репозиторий|ветк|commit|коммит|рабочее дерево|worktree|branch|repo\b|сборк|build|установлен|version|версия/i.test(t)
 };
}
const wantsAny=i=>i.state||i.history||i.environment;

// ---------------------------------------------------------------------------
// Freshness. A problem that was resolved later must not be presented as the
// current state; it stays available, but marked and ranked behind live items.
// ---------------------------------------------------------------------------
// State vocabulary (CURRENT / RESOLVED / SUPERSEDED / OPEN / INFO) lives in
// current-state.cjs so the ranking, the injected text and the inspector cannot
// disagree about what a source claims.
// Resolution markers come in two strengths. An explicit prefix or an explicit
// CURRENT/SUPERSEDED word is authoritative for the conflict layer. Everyday
// wording ("pairing is restored and verified") still means the problem is no
// longer open, so it is labelled as superseded by newer state instead of OPEN.
const RESOLVED_WORD=/(?<!не )\b(?:resolved|fixed|restored|superseded|closed|already done|no longer (?:an issue|broken|fails?))\b|решено|исправлено|восстановлен|закрыт|устранено|больше не (?:проблема|актуально|ломается)/i;
function stateOf(text){
 const t=String(text||'');
 const derived=current.stateOf(t).id;
 if(derived==='RESOLVED')return {id:'resolved',label:'RESOLVED - confirmed later, not open'};
 if(derived==='SUPERSEDED')return {id:'superseded',label:'SUPERSEDED - replaced by newer state'};
 if(derived==='CURRENT')return {id:'current',label:'CURRENT - live or explicitly current'};
 if(RESOLVED_WORD.test(t))return {id:'resolved',label:'RESOLVED - confirmed later, not open'};
 if(derived==='OPEN')return {id:'open',label:'OPEN'};
 return {id:'info',label:'INFO'};
}
// A question about open problems wants live items first; a question about
// history wants the timeline. Resolved material is never deleted.
function stateWeight(state,intent){
 if(state==='superseded')return -6;
 if(intent.state&&!intent.history)return state==='resolved'?-2:state==='open'?1:state==='current'?2:0;
 if(intent.history&&!intent.state)return 0;
 return state==='resolved'?-1:state==='current'?1:0;
}
const recencyOf=(item,newest)=>{
 const at=Date.parse(item.at||'')||0;
 if(!at||!newest)return 0;
 const days=(newest-at)/86400000;
 return days<=1?2:days<=7?1:0;
};
const stamp=item=>{const at=(item.at||'').slice(0,10),s=stateOf(item.text);return `[${at||'undated'} · ${s.label}] `;};

// ---------------------------------------------------------------------------
// Ranking. One ranker for every prose source (brain entries and project
// documents), so a fresh status document can outrank a stale brain note.
// ---------------------------------------------------------------------------
function rankMaterial(items,text,{limit,kind,intent,superseded=null}={}){
 const query=[...tokens(text)];
 if(!query.length||!items.length)return [];
 const newest=Math.max(0,...items.map(x=>Date.parse(x.at||'')||0))||0;
 return items
  .map(item=>{
   const lost=superseded?superseded.has(item.id):false;
   const state=lost?{id:'superseded',label:'SUPERSEDED - replaced by newer state'}:stateOf(item.text);
   const relevance=scoreOf(item.text,query)+(item.pinned?3:0);
   const freshness=recencyOf(item,newest);
   // Authority comes first, then relevance, then freshness and the state
   // adjustment. That ordering is the whole point of the layer: a live fact or
   // an explicitly current fact outranks a document that merely repeats an older
   // release, whatever the wording of the request.
   const authority=current.authorityOf(kind,state.id==='superseded'?'SUPERSEDED':'INFO').rank;
   const score=authority*100+relevance*10+freshness*4+stateWeight(state.id,intent||{});
   return {item,state,score,bonus:freshness,authority};
  })
  .filter(row=>row.score>0)
  .sort((a,b)=>b.score-a.score||b.bonus-a.bonus||String(b.item.at||'').localeCompare(String(a.item.at||'')))
  .slice(0,limit||0)
  .map(({item,state,authority})=>({id:item.id,kind:item.kind||kind,source:item.source||kind,state:state.id,authority:state.id==='superseded'?'session-fragment':authority.id,at:item.at||'',text:`[${(item.at||'').slice(0,10)||'undated'} · ${state.label}] `+item.text,expandable:item.expandable===true}));
}
function rankBrain(store,text,limit,intent){
 return rankMaterial(orderBrain(store,text),text,{limit,kind:'brain',intent});
}
// Project documents ranked by name, content excerpt and freshness. A status
// document that mentions the request terms beats an unrelated old note.
function rankDocs(docs,text,limit,intent,superseded=null){
 const entries=(Array.isArray(docs)?docs:[]).map(d=>({id:'doc:'+d.path,kind:'doc',source:d.path,at:d.at,text:`${d.path}\n${d.excerpt||''}`}));
 const ranked=rankMaterial(entries,text,{limit:entries.length,kind:'doc',intent,superseded});
 // A request about project state or history needs the newest status documents
 // even when it is phrased in another language than the document: term overlap
 // alone cannot decide relevance there. Everything else still needs overlap.
 const wanted=wantsAny(intent);
 return (wanted?[...ranked,...entries.filter(e=>!ranked.some(r=>r.id===e.id)).sort((a,b)=>String(b.at||'').localeCompare(String(a.at||'')))]:ranked).slice(0,limit||0);
}
// Referenced files are an explicit user pointer, not prose to rank: each mode
// resolves as many as its own file budget allows, regardless of brain volume.
function rankFiles(store,text,limit){
 const query=[...tokens(text)];
 return store.entries.filter(e=>e.type==='file')
  .map(e=>({entry:e,score:scoreOf(e.text,query)}))
  .sort((a,b)=>b.score-a.score||b.entry.updatedAt.localeCompare(a.entry.updatedAt))
  .slice(0,limit)
  .map(({entry:e})=>({id:e.id,kind:'file-reference',source:e.source,text:e.text}));
}
function rankRules(store,text,limit){
 const scope=scopes(text);
 return store.rules.filter(r=>r.enabled&&scope.includes(r.scope))
  .sort((a,b)=>b.priority-a.priority)
  .slice(0,limit)
  .map(r=>({id:r.id,kind:'rule',source:r.source,scope:r.scope,text:r.text}));
}
// Confidence answers "did retrieval actually find material for this task?".
function confidence(text,included){
 const query=[...tokens(text)];
 if(!query.length)return {value:1,reason:'no meaningful terms in request'};
 const covered=new Set();
 for(const item of included)for(const word of tokens(item.text))covered.add(word);
 const hits=query.filter(w=>covered.has(w)).length;
 const ratio=hits/query.length;
 // Coverage of the request's own terms, nudged up when retrieval found any
 // non-rule material at all. Rules do not raise confidence: they are always
 // present and say nothing about whether this task was understood.
 const material=included.filter(x=>x.kind!=='rule').length;
 return {value:Math.min(1,ratio*0.8+(material?0.2:0)),reason:`${hits}/${query.length} request terms covered by ${included.length} selected sources (${material} non-rule)`};
}
// Is the selection good enough to stop expanding? Two ways to say no: the
// request terms are barely covered, or the question is about state/history/
// environment and no source of that kind travelled at all.
function sufficiency(included,conf,floor,intent){
 const kinds=new Set(included.map(x=>x.kind));
 const hasStateSource=[...kinds].some(k=>k==='doc'||k==='git'||k==='env'||k==='past-session'||k==='file');
 if(conf.value<(floor||0))return {ok:false,reason:`request-term coverage ${conf.value.toFixed(2)} is below the mode floor ${floor}`};
 if(intent.state&&!hasStateSource)return {ok:false,reason:'the request asks about the current state/unresolved work and no status, git or file source was selected'};
 if(intent.history&&!kinds.has('past-session')&&!kinds.has('doc')&&!kinds.has('git'))return {ok:false,reason:'the request asks about project history and no history or document source was selected'};
 if(intent.environment&&!kinds.has('env')&&!kinds.has('git'))return {ok:false,reason:'the request asks about the repository state and no environment or git source was selected'};
 return {ok:true,reason:'selected context covers the request'};
}
function trimToBudget(items,budget){
 const kept=[];let used=0;
 for(const item of items){
  const text=String(item.text||'');
  if(used+text.length<=budget){kept.push(item);used+=text.length;continue;}
  const room=budget-used;
  if(room>240){kept.push({...item,text:text.slice(0,room)+'\n…[truncated to fit the selected mode]'});used=budget;}
  break;
 }
 return kept;
}
// Mandatory rules always travel; optional sources share the mode budget. File
// references are resolved by the caller, which owns filesystem access.
async function selectForTier({store,text,tier,fileText,fragments=[],suggestions=0,groups=null,intent}={}){
 const active=intent||intentOf(text);
 const enabled=store.rules.filter(r=>r.enabled),scoped=scopes(text);
 // Mandatory: enabled Project rules first (highest priority order), then the
 // rules whose scope matches this request until the mode's rule budget is met.
 // Economy narrows which optional rules travel, never which mandatory ones do.
 const byPriority=[...enabled].sort((a,b)=>b.priority-a.priority);
 const projectRules=byPriority.filter(r=>r.scope==='Project');
 const scopedRules=byPriority.filter(r=>r.scope!=='Project'&&scoped.includes(r.scope));
 const capacity=Math.max(tier.rules,projectRules.length);
 const mandatory=[...projectRules,...scopedRules].slice(0,capacity).map(r=>({id:r.id,kind:'rule',source:r.source,scope:r.scope,text:r.text}));
 const unusedRules=scopedRules.slice(Math.max(0,capacity-projectRules.length)).map(r=>({id:r.id,kind:'rule',source:r.source,scope:r.scope,text:r.text}));
 // Referenced files lead the optional budget: they are explicit pointers the
 // request asked to read, not prose competing with brain entries.
 const referenced=rankFiles(store,text,tier.files);
 const rankedBrain=groups&&groups.brain===false?[]:rankBrain(store,text,tier.brain,active);
 const optional=[...referenced,...unusedRules,...rankedBrain];
 const budget=Math.max(tier.maxChars,sumChars(mandatory));
 const optionalKept=trimToBudget(optional,budget-sumChars(mandatory));
 const files=[];
 for(const ref of optionalKept.filter(x=>x.kind==='file-reference').slice(0,tier.files)){
  if(!fileText)continue;
  // Readers can be synchronous (tests, plain fs) or asynchronous (MediaPreview
  // resolves the file through the workspace root). A rejected read is not fatal:
  // the reference simply does not travel.
  let content;
  try{content=fileText(ref);if(content&&typeof content.then==='function')content=await content;}catch{continue;}
  if(content)files.push({...ref,kind:'file',text:String(content).slice(0,tier.fileChars)});
 }
 const withoutFiles=optionalKept.filter(x=>x.kind!=='file-reference');
 const fragmentsKept=groups&&groups.history===false?[]:fragments.slice(0,Math.min(tier.maxFragments,tier.fragments));
 const suggestionsKept=(store.suggestions||[]).slice(-suggestions);
 const included=[...suggestionsKept.map(s=>({id:s.id,kind:'brain-suggestion',source:'NODO suggestion · awaiting user confirmation',text:s.text})),...mandatory,...withoutFiles,...files,...fragmentsKept];
 return {included,rules:mandatory.length,optional:withoutFiles.length,files:files.length,budget};
}
// Candidate pool = everything that could have been sent, so the UI can show an
// honest before/after instead of an invented saving.
function candidatePool(store,text,fragments=[],extras=[],tier=null){
 const enabled=store.rules.filter(r=>r.enabled),scope=scopes(text);
 const rules=[...enabled.filter(r=>r.scope==='Project'),...enabled.filter(r=>r.scope!=='Project'&&scope.includes(r.scope))];
 // File references count as the content they resolve to, not as a bare path:
 // otherwise the pool would understate what a request can actually send.
 const queries=[...tokens(text)];
 const refs=store.entries.filter(e=>e.type==='file').map(e=>({text:e.text,score:scoreOf(e.text,queries)})).sort((a,b)=>b.score-a.score);
 const filesAsSent=refs.map((r,i)=>tier&&i<tier.files?{text:'x'.repeat(Math.min(800,r.text.length*4))+((tier.fileChars||0)?'':''),score:r.score}:r);
 const entries=[...orderBrain(store,text),...filesAsSent];
 const suggestions=store.suggestions||[];
 const blocks=Array.isArray(extras)?extras:[];
 return {chars:sumChars(rules)+sumChars(entries)+sumChars(blocks)+sumChars(fragments)+sumChars(suggestions),count:rules.length+entries.length+blocks.length+fragments.length+suggestions.length};
}

// Brain facts the user stated as current or as resolved. They travel as their
// own line in the per-request reference message, so a stale note about a
// problem cannot be read as the current state: the model sees the confirmed
// state next to it, with the date.
const STATE_PREFIX=/^\s*(?:CURRENT|RESOLVED|FIXED|DONE|CLOSED|SUPERSEDED|АКТУАЛЬНО|РЕШЕНО|ИСПРАВЛЕНО|ВОССТАНОВЛЕНО|ЗАКРЫТО)\b[:\-—]?/i;
function resolvedNotes(store,limit=4){
 return store.entries.filter(e=>STATE_PREFIX.test(String(e.text||'')))
  .sort((a,b)=>String(b.updatedAt||'').localeCompare(String(a.updatedAt||'')))
  .slice(0,limit)
  .map(e=>{
   const state=current.stateOf(e.text).id;
   const label=state==='RESOLVED'?'RESOLVED':state==='SUPERSEDED'?'SUPERSEDED':state==='CURRENT'?'CURRENT':'STATED';
   return `- [${label} · ${String(e.updatedAt||'').slice(0,10)}] ${String(e.text).replace(/\s+/g,' ').slice(0,200)}`;
  });
}
// ---------------------------------------------------------------------------
// ECONOMY ladder. Each step adds one kind of source and the walk continues
// while the selection is still not sufficient. ECONOMY never becomes FULL: it
// climbs at most to the next tier and stops there.
// ---------------------------------------------------------------------------
const LADDER=[
 {id:'brain',groups:{brain:true,docs:false,history:false,git:false,env:false},added:'more ranked Brain facts'},
 {id:'status-docs',groups:{brain:true,docs:true,history:false,git:false,env:false},added:'project status/history documents'},
 {id:'git',groups:{brain:true,docs:true,history:false,git:true,env:true},added:'git metadata and environment facts'},
 {id:'past-sessions',groups:{brain:true,docs:true,history:true,git:true,env:true},added:'older session fragments'}
];
function packDocs(items){
 const text='Project documents (dated snapshots, ranked by authority then freshness). A document that contradicts CURRENT runtime state is a historical snapshot, not the current state, and is labelled SUPERSEDED:\n'+items.map(x=>`- ${x.text}`).join('\n\n');
 return {text,count:items.length};
}
const asLine=x=>typeof x==='string'?x:String(x&&x.text||JSON.stringify(x));
// The version the live item states, used as the authority documents are judged
// against. Absent live data means no document is called superseded.
function liveVersionOf(items){
 for(const item of items||[]){
  const direct=item&&item.version;
  if(direct)return String(direct);
  const match=/installed NODO application version:\s*([\w.\-]+)/i.exec(String(item&&item.text||''));
  if(match)return match[1];
 }
 return null;
}
function packGit(items){return {text:'Repository state:\n'+items.map(x=>`- ${asLine(x)}`).join('\n'),count:items.length};}
function packEnv(lines){return {text:'Environment:\n'+lines.map(x=>`- ${asLine(x)}`).join('\n'),count:lines.length};}
async function select({store,text,mode,fileText,fragments=[],suggestions=0,docs=null,git=null,env=null,live=null,version=null}){
 const intent=intentOf(text);
 const tier=TIERS[mode]||TIERS.balanced;
 // CURRENT STATE is assembled before any ranking: live runtime facts and
 // version metadata are the authority the rest of the selection is judged
 // against, and documents that contradict them are marked as superseded.
 const resolvedLive=live&&typeof live.then==='function'?await live:live;
 const resolvedVersion=version&&typeof version.then==='function'?await version:version;
 const liveItems=[...(Array.isArray(resolvedLive)?resolvedLive:resolvedLive?[resolvedLive]:[]),...(Array.isArray(resolvedVersion)?resolvedVersion:resolvedVersion?[resolvedVersion]:[])];
 const resolvedDocs=docs&&typeof docs.then==='function'?await docs:docs;
 const conflicts=current.resolveConflicts({live:{version:liveVersionOf(liveItems),source:'live runtime state',authority:'live-runtime'},docs:resolvedDocs});
 const superseded=current.supersededIds(conflicts,resolvedDocs);
 const resolvedGit=git&&typeof git.then==='function'?await git:git;
 const resolvedEnv=env&&typeof env.then==='function'?await env:env;
 const blockCache=new Map();
 const groupItems=(group,t=tier)=>{
  if(group==='docs')return rankDocs(resolvedDocs,text,t.docs,intent,superseded);
  if(group==='git')return (resolvedGit||[]).slice(0,3).map((x,i)=>({id:'git:'+i,kind:'git',source:'git metadata',at:'',text:asLine(x)}));
  if(group==='env')return (resolvedEnv||[]).slice(0,4).map((x,i)=>({id:'env:'+i,kind:'env',source:'session environment',at:'',text:asLine(x)}));
  return [];
 };
 const extras=groups=>{
  if(!groups)return [];
  const out=[];
  if(groups.docs){const items=groupItems('docs');if(items.length)out.push(packDocs(items));}
  if(groups.git){const items=groupItems('git');if(items.length)out.push(packGit(items));}
  if(groups.env){const items=groupItems('env');if(items.length)out.push(packEnv(items));}
  return out;
 };
 const blocksOf=groups=>extras(groups).map(x=>{
  const isDoc=x.text.startsWith('Project documents'),isGit=x.text.startsWith('Repository');
  const state=isDoc&&superseded.size?'superseded':isDoc?'info':'CURRENT';
  const authority=isDoc?(superseded.size?'session-fragment':'status-doc'):isGit?'git-history':'live-runtime';
  return {id:'block:'+x.text.slice(0,24),kind:isDoc?'doc':isGit?'git':'env',source:isDoc?'project documents':isGit?'git metadata':'environment',authority,state,text:x.text};
 });
 // Every source that could travel at all, counted once, so the UI shows an
 // honest before/after instead of a pool that ignores the new source tiers.
 const unionFor=t=>{
  if(blockCache.has(t))return blockCache.get(t);
  const items=[...selectForTierDocs(t),...selectForTierGit(t),...selectForTierEnv(t)];
  blockCache.set(t,items);return items;
 };
 const selectForTierDocs=t=>groupItems('docs',{docs:Math.max(t.docs||0,TIERS.full.docs)});
 const selectForTierGit=t=>groupItems('git');
 const selectForTierEnv=t=>groupItems('env');
 const candidates=candidatePool(store,text,fragments,[...liveItems,...unionFor(tier)],tier,{liveCount:liveItems.length});
 const build=async(groups,t=null)=>{
  const useTier=t||tier;
  const result=await selectForTier({store,text,tier:useTier,fileText,fragments,suggestions,groups,intent});
  const added=blocksOf(groups);
  return {included:[...result.included,...added],result,added};
 };
 let groups=mode==='economy'
  ?{brain:true,docs:false,history:false,git:false,env:false}
  :{brain:true,docs:true,history:false,git:true,env:true};
 const withLive=result=>liveItems.length?{...result,included:[...liveItems,...result.included]}:result;
 let built=await build(groups);
 built=withLive(built);
 let conf=confidence(text,built.included);
 const floor=tier.minConfidence||0;
 let check=sufficiency(built.included,conf,floor,intent);
 // ECONOMY stays ECONOMY: the money-relevant decision is the source tier, not
 // the mode label. Expansion walks the ladder below while the selection is
 // still not sufficient, and the user's mode choice is never overwritten.
 const adaptive=mode==='economy'?{requested:'economy',effective:'economy',initial:{chars:sumChars(built.included),tokens:estimateTokens(sumChars(built.included)),items:built.included.length},steps:[],addedGroups:[],reason:[],confidenceBefore:conf.value,confidenceAfter:conf.value,widenedBy:0,sufficient:check.ok}:null;
 if(adaptive){
  for(const step of LADDER){
   if(check.ok)break;
   const nextGroups={...groups,...step.groups};
   const candidate=withLive(await build(nextGroups));
   const grew=sumChars(candidate.included)>sumChars(built.included);
   if(!grew)continue;
   const nextConf=confidence(text,candidate.included);
   const nextCheck=sufficiency(candidate.included,nextConf,floor,intent);
   const gainedItems=candidate.included.length-built.included.length;
   adaptive.steps.push({step:step.id,added:step.added,chars:sumChars(candidate.included),tokens:estimateTokens(sumChars(candidate.included)),items:candidate.included.length,gainedItems,confidence:nextConf.value,sufficient:nextCheck.ok});
   groups=nextGroups;built=candidate;conf=nextConf;check=nextCheck;
   if(!adaptive.addedGroups.includes(step.id))adaptive.addedGroups.push(step.id);
  }
  adaptive.confidenceAfter=conf.value;
  adaptive.widenedBy=built.included.length-adaptive.initial.items;
  adaptive.reason=check.ok?`context expanded step by step until it covered the request (${adaptive.addedGroups.join(' -> ')||'no step added material'})`:`no wider source tier could add material for this request: ${check.reason}`;
  adaptive.sufficient=check.ok;
  adaptive.chars=sumChars(built.included);
  adaptive.tokens=estimateTokens(sumChars(built.included));
  adaptive.savedTokens=Math.max(0,adaptive.initial.tokens-adaptive.tokens);
 }
 const injectedChars=sumChars(built.included);
 const stateVersion=liveVersionOf(liveItems);
 const currentState={live:liveItems.map(x=>({id:x.id,source:x.source,authority:x.authority,state:x.state,at:x.at,version:x.version||(/^version:/.test(String(x.id))?stateVersion:liveVersionOf([x]))})),conflicts,superseded:[...superseded],winner:conflicts.length?conflicts[0].winner:null,version:stateVersion};
 const metrics={
  requestedMode:mode,mode:mode,adaptive,currentState,
  intent,
  candidateChars:candidates.chars,candidateCount:candidates.count,candidateTokens:estimateTokens(candidates.chars),
  injectedChars,injectedCount:built.included.length,injectedTokens:estimateTokens(injectedChars),
  savedChars:Math.max(0,candidates.chars-injectedChars),
  savedRatio:candidates.chars>0?Math.max(0,1-injectedChars/candidates.chars):0,
  confidence:check.ok?conf:{...conf,sufficient:false,insufficientReason:check.reason},
  byKind:countByKind(built.included),budget:built.result.budget,ts:Date.now()
 };
 return {included:built.included,metrics};
}
function countByKind(included){
 const out={};
 for(const item of included){const key=item.kind==='rule'?'rules':item.kind==='brain'||item.kind==='brain-suggestion'?'brain':item.kind==='file'||item.kind==='file-reference'?'files':item.kind==='past-session'?'history':item.kind==='doc'||item.kind==='git'||item.kind==='env'?'project-state':'workspace';out[key]=(out[key]||0)+1;}
 return out;
}
// The cached system prefix. It carries what must never be dropped whatever the
// mode: Project-scope rules (always in force) and user-pinned facts. Rules for
// a narrower scope travel in the per-request reference message only when that
// scope is part of the request, which keeps the cached prefix small and stable.
function stableBlock({store,mode}){
 const pinned=store.entries.filter(e=>e.pinned);
 const rules=store.rules.filter(r=>r.enabled&&r.scope==='Project').sort((a,b)=>b.priority-a.priority);
 if(!pinned.length&&!rules.length)return '';
 const lines=['NODO project instructions. These are user-approved and always apply; more specific instructions take precedence over broader ones. They never override system, developer or direct user instructions.'];
 if(rules.length)lines.push('Project Rules (mandatory, priority order):\n'+rules.map(r=>`- [${r.scope}] ${r.text}`).join('\n'));
 if(pinned.length)lines.push('Project facts marked as stable:\n'+pinned.map(e=>`- [${e.type}] ${e.text}`).join('\n'));
 // The stable prefix is deliberately mode-independent: the resolved mode is
 // stated in the per-request reference message, so switching modes never
 // invalidates the provider prompt cache for rules and pinned facts.
 lines.push('The project context selected for the current request arrives as a separate reference message, which also states the current context mode.');
 return lines.join('\n\n');
}
module.exports={select,stableBlock,estimateTokens,countByKind,confidence,intentOf,stateOf,rankDocs,resolvedNotes};
