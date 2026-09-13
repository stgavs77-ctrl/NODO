'use strict';
const path=require('node:path');
const {read,save}=require('./io.cjs');
// Three working modes. They only ever change how much context NODO selects;
// they never remove mandatory rules and never change provider/tool behaviour.
const MODES=['economy','balanced','full'];
const DEFAULT_MODE='balanced';
const LABELS={economy:'ECONOMY',balanced:'BALANCED',full:'FULL CONTEXT'};
// Tier knobs per mode: how many candidates of each source may enter the request
// and the character budget for the dynamic part. Mandatory rules are exempt
// from the budget (see context-engine.cjs). `docs` counts project status and
// history documents (status/todo/changelog/release notes), which are small and
// carry the current project state; economy still gets them when the request
// asks about project state or history, because that is what the request needs.
const TIERS={
 economy:{brain:6,rules:12,suggestions:2,files:1,docs:2,fragments:0,firstMessageFragments:1,maxChars:7000,fileChars:2000,fragmentChars:700,maxFragments:1,minConfidence:0.6},
 balanced:{brain:12,rules:20,suggestions:3,files:2,docs:3,fragments:1,firstMessageFragments:2,maxChars:14000,fileChars:4000,fragmentChars:1000,maxFragments:2,minConfidence:0.5},
 full:{brain:24,rules:40,suggestions:5,files:4,docs:4,fragments:3,firstMessageFragments:3,maxChars:30000,fileChars:8000,fragmentChars:1600,maxFragments:4,minConfidence:0}
};
// The selected mode is always honoured exactly, including ECONOMY: the adaptive
// step widens which sources travel inside the same mode, it never switches the
// mode the user picked. Kept for compatibility with callers reading the map.
const NEXT_MODE={economy:null,balanced:null,full:null};
function normalize(mode){return MODES.includes(mode)?mode:null;}
class ContextModes{
 constructor({data}={}){
  this.file=path.join(data,'context-modes.json');
  const stored=read(this.file,{});
  this.state={global:normalize(stored.global)||DEFAULT_MODE,workspaces:stored.workspaces&&typeof stored.workspaces==='object'?stored.workspaces:{},updatedAt:stored.updatedAt||null};
  // A session override lives only in memory: it is a deliberate per-chat
  // experiment and must never survive a restart as a hidden setting.
  this.sessionOverrides=new Map();
 }
 resolve(workspace,sessionId){
  const override=sessionId?normalize(this.sessionOverrides.get(sessionId)):null;
  const scoped=workspace?normalize(this.state.workspaces[workspace]):null;
  const mode=override||scoped||this.state.global;
  return {mode,source:override?'session':scoped?'workspace':'global',tier:TIERS[mode],label:LABELS[mode]};
 }
 setGlobal(mode){const m=normalize(mode);if(!m)throw Error('Unknown context mode');this.state.global=m;this.touch();return this.snapshot();}
 setWorkspace(workspace,mode){
  if(typeof workspace!=='string'||!workspace.trim()||workspace.length>4096)throw Error('Workspace path required');
  if(mode===null||mode===undefined||mode==='default'||mode==='inherit')delete this.state.workspaces[workspace];
  else {const m=normalize(mode);if(!m)throw Error('Unknown context mode');this.state.workspaces[workspace]=m;}
  this.touch();return this.snapshot(workspace);
 }
 setSession(sessionId,mode){
  if(typeof sessionId!=='string'||!sessionId)throw Error('Session required');
  if(mode===null||mode===undefined||mode==='default'||mode==='inherit')this.sessionOverrides.delete(sessionId);
  else {const m=normalize(mode);if(!m)throw Error('Unknown context mode');this.sessionOverrides.set(sessionId,m);}
  return {ok:true};
 } touch(){this.state.updatedAt=new Date().toISOString();save(this.file,this.state);}
 snapshot(workspace,sessionId){
  // The session override must be part of the snapshot: the UI reads the active
  // mode from here, so resolving without the session id would always report the
  // global/workspace mode and make the switch look dead.
  const current=this.resolve(workspace,sessionId);
  return {modes:MODES.map(id=>({id,label:LABELS[id],budget:TIERS[id].maxChars,minConfidence:TIERS[id].minConfidence})),defaultMode:DEFAULT_MODE,global:this.state.global,workspaces:{...this.state.workspaces},updatedAt:this.state.updatedAt,...current};
 }
}
module.exports={ContextModes,MODES,TIERS,NEXT_MODE,DEFAULT_MODE,LABELS};
