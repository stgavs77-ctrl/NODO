'use strict';
// CURRENT STATE: the layer that decides which fact about "now" wins.
//
// Smart Context can reach documents, git history and old session fragments. All
// of them are dated snapshots, and a status document from an earlier release
// keeps claiming the version and the problems of that release. This module adds
// one ordered authority scale, one state vocabulary and a conflict resolver, so
// a live runtime fact always beats a document that is merely old, and the user
// can see in the context inspector which source won.
//
// No storage schema is changed: the state is derived from the source kinds, the
// timestamps and explicit CURRENT/RESOLVED/SUPERSEDED wording.
const STATES=['CURRENT','RESOLVED','SUPERSEDED','OPEN','INFO'];
const AUTHORITY_ORDER=['live-runtime','brain-current','version-metadata','status-doc','git-history','session-fragment'];
const AUTHORITY={};
AUTHORITY_ORDER.forEach((id,index)=>{AUTHORITY[id]={id,rank:AUTHORITY_ORDER.length-index,label:id.replace(/-/g,' ')};});
// Source kinds map onto that scale. Brain facts that are explicitly marked as
// current sit right below live runtime state; plain notes stay informational.
const KIND_AUTHORITY={live:'live-runtime','version':"version-metadata",doc:'status-doc',git:'git-history','past-session':'session-fragment',brain:'brain-current'};
const CURRENT=/^\s*(?:CURRENT|АКТУАЛЬНО|ТЕКУЩЕЕ)\b[:\-—]?|\b(?:currently installed|as of now|actual now)\b/i;
const RESOLVED=/^\s*(?:RESOLVED|FIXED|DONE|CLOSED)\b[:\-—]?|\b(?:РЕШЕНО|ИСПРАВЛЕНО|ВОССТАНОВЛЕНО|ЗАКРЫТО)\b/i;
const SUPERSEDED=/^\s*(?:SUPERSEDED|OBSOLETE)\b[:\-—]?|\b(?:УСТАРЕЛО|НЕАКТУАЛЬНО)\b/i;
const PROBLEM=/проблем|блокер|не работает|сломан|падает|ошибк|баг|bug|broken|fails?|blocker|outstanding|unresolved|issue/i;
const INSTALL_CLAIM=/(?:установлен\w*|стоит|версия|выпущен\w*|released|installed|version|running|работает)\s*(?:nodo\s*)?v?(\d+\.\d+\.\d+)/gi;
const VERSION_RE=/\b(\d+\.\d+\.\d+)\b/g;
const parseVersion=value=>String(value||'').split('.').map(part=>Number.parseInt(part,10)||0);
// -1 when a is older than b, 1 when newer, 0 when equal or not comparable.
function compareVersions(a,b){
 const left=parseVersion(a),right=parseVersion(b);
 if(!left.length||!right.length)return 0;
 for(let i=0;i<Math.max(left.length,right.length);i++){
  const x=left[i]||0,y=right[i]||0;
  if(x!==y)return x<y?-1:1;
 }
 return 0;
}
// The version a text claims is installed or current, if it claims one at all.
// A changelog listing several old releases therefore does not look like a claim.
function versionClaim(text){
 const t=String(text||'');
 INSTALL_CLAIM.lastIndex=0;
 const claimed=[];
 let match;
 while((match=INSTALL_CLAIM.exec(t)))claimed.push(match[1]);
 if(!claimed.length)return null;
 return claimed.reduce((best,value)=>compareVersions(value,best)>0?value:best,claimed[0]);
}
function stateOf(text){
 const t=String(text||'');
 if(CURRENT.test(t))return {id:'CURRENT',label:'CURRENT — live or explicitly current'};
 if(RESOLVED.test(t))return {id:'RESOLVED',label:'RESOLVED — confirmed later, not open'};
 if(SUPERSEDED.test(t))return {id:'SUPERSEDED',label:'SUPERSEDED — replaced by newer state'};
 if(PROBLEM.test(t))return {id:'OPEN',label:'OPEN'};
 return {id:'INFO',label:'INFO'};
}
function authorityOf(kind,state){
 if(kind==='resolved')return AUTHORITY['brain-current'];
 const base=KIND_AUTHORITY[kind]||'status-doc';
 // A document that is explicitly superseded loses its rank: it describes a
 // state that a newer source has already replaced.
 return state==='SUPERSEDED'?AUTHORITY['session-fragment']:AUTHORITY[base];
}
function ageDays(at,now=Date.now()){
 const time=Date.parse(at||'')||0;
 return time?Math.max(0,(now-time)/86400000):null;
}
// Live runtime state of the NODO instance that is asking the question. It is
// read-only, tiny, and always ranked first, so no document can override it.
function liveState({appName,appVersion,channel,dataDir,workspaceVersion,at}={}){
 const lines=[];
 if(appVersion)lines.push(`installed NODO application version: ${appVersion}${appName?' ('+appName+')':''}`);
 if(channel)lines.push(`release channel: ${channel}`);
 if(workspaceVersion)lines.push(`source tree version (package.json in this workspace): ${workspaceVersion}`);
 if(appVersion&&workspaceVersion&&compareVersions(workspaceVersion,appVersion)!==0)lines.push(`source tree differs from the installed application: installed ${appVersion}, tree ${workspaceVersion}`);
 if(dataDir)lines.push(`active profile: ${dataDir}`);
 if(!lines.length)return [];
 const text=['CURRENT runtime state. This is live data from the running application and it outranks every document, changelog or memory below. Do not report a version or a status that contradicts it.','- '+lines.join('\n- ')].join('\n');
 return [{id:'live:runtime',kind:'live',version:appVersion||null,source:'live runtime state',authority:'live-runtime',state:'CURRENT',at:at||new Date().toISOString(),text}];
}
// Version metadata that the runtime can read from the workspace itself: the
// source tree's own version file. Still read-only, still ahead of documents.
function versionMetadata({workspace,workspaceVersion,at}={}){
 if(!workspaceVersion)return [];
 return [{id:'version:workspace',kind:'version',version:workspaceVersion,source:'version metadata'+(workspace?' ('+workspace+')':''),authority:'version-metadata',state:'CURRENT',at:at||new Date().toISOString(),text:`CURRENT version metadata read from the source tree: package.json version ${workspaceVersion}. Ranked above status documents, changelogs and old session fragments.`}];
}
// Docs may still claim an installed version. When the claim is older than live
// state, the document loses and is labelled as superseded instead of trusted.
function docVersionClaims(docs){
 const out=[];
 for(const doc of Array.isArray(docs)?docs:[]){
  const claimed=versionClaim(doc.excerpt||doc.head||'');
  if(claimed)out.push({path:doc.path,at:doc.at||'',claimed});
 }
 return out;
}
// One conflict report: which source won, which lost and why. The inspector shows
// the winner, the engine uses the same resolution when ordering items.
function resolveConflicts({live,version,docs}={}){
 const conflicts=[];
 const liveVersion=(live&&live.version)||(version&&version.version)||null;
 const liveSource=(live&&live.source)||(version&&version.source)||null;
 if(liveVersion){
  for(const claim of docVersionClaims(docs)){
   const order=compareVersions(claim.claimed,liveVersion);
   if(order>=0)continue;
   const age=ageDays(claim.at);
   conflicts.push({
    subject:'installed NODO version',
    winner:{source:liveSource||'live runtime state',value:liveVersion,authority:(live&&live.authority)||'live-runtime'},
    loser:{source:claim.path,value:claim.claimed,authority:'status-doc'},
    reason:`live state is newer (${liveVersion} > ${claim.claimed}) and ranks above documents${age!=null?`; the document is ${Math.round(age)} day(s) old`:''}`,
    resolved:'winner'
   });
  }
 }
 // Two documents that disagree: the newer one wins, the older one is superseded.
 const claims=docVersionClaims(docs).sort((a,b)=>String(b.at||'').localeCompare(String(a.at||'')));
 for(let i=1;i<claims.length;i++){
  const newer=claims[0],older=claims[i];
  if(compareVersions(older.claimed,newer.claimed)>=0)continue;
  conflicts.push({
   subject:'documented project version',
   winner:{source:newer.path,value:newer.claimed,authority:'status-doc'},
   loser:{source:older.path,value:older.claimed,authority:'status-doc'},
   reason:`newer document (${String(newer.at||'').slice(0,10)}) outranks an older one (${String(older.at||'').slice(0,10)})`,
   resolved:'winner'
  });
 }
 return conflicts;
}
// Items that lost a conflict travel anyway, but marked, so the model can see
// that the value is historical rather than current.
function supersededIds(conflicts,docs){
 const ids=new Set();
 for(const conflict of conflicts||[]){
  for(const doc of Array.isArray(docs)?docs:[])if(doc.path===conflict.loser.source)ids.add('doc:'+doc.path);
 }
 return ids;
}
module.exports={STATES,AUTHORITY,AUTHORITY_ORDER,stateOf,authorityOf,ageDays,liveState,versionMetadata,versionClaim,compareVersions,docVersionClaims,resolveConflicts,supersededIds};
