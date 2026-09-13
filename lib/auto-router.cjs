'use strict';
const {scopes}=require('./project-brain.cjs');
// AUTO Router. Cost never decides which executor is correct: the DeepSeek
// context mode may only widen how much project context is offered. Capability
// (Codex configured and available) stays the single reason to leave DeepSeek.
function route({text,codexReady,choice,tools=[],rules=[],contextChars=0,balance,contextMode='balanced'}){
 const scope=scopes(text),coding=scope.includes('Coding'),reaper=scope.includes('REAPER'),web=scope.includes('Browser');
 const large=contextChars>24000||text.length>8000||/repo|рефактор|несколько файлов|multi.file|implement|исправь.*код/i.test(text);
 const available=!!codexReady&&!!choice?.model&&!!choice?.effort;
 const agent=coding&&available?'Codex':'DeepSeek';
 const reaperAvailable=tools.some(t=>/^mcp__reaper__/.test(t));
 const contextNote=contextMode==='economy'?(large?'ECONOMY keeps this task on the cheapest retrieval tier; a repository-wide task may need BALANCED':'ECONOMY: smallest sufficient context tier; mandatory rules are never trimmed'):contextMode==='full'?'FULL CONTEXT: widest retrieval tier for this workspace':'BALANCED: standard retrieval tier';
 return {agent,label:agent==='Codex'?'AUTO → Codex':reaper&&reaperAvailable?'AUTO → REAPER':web?'AUTO → DeepSeek + Browser':'AUTO → DeepSeek',reason:coding?(available?(large?'Repository/code task; configured Codex is available':'Coding capability; configured Codex'):'Coding task, but Codex is not configured; using existing DeepSeek tools'):reaper?(reaperAvailable?'REAPER tools are already enabled':'REAPER tools offline; no tools were enabled'):web?'Web task with existing isolated Browser':'General task; low-latency DeepSeek',contextNote,inputs:{scopes:scope,contextChars,contextMode,relevantRules:rules.filter(r=>r.enabled&&scope.includes(r.scope)).length,codexAvailable:available,balanceKnown:balance!=null},permissionChange:false};
}
module.exports={route};
