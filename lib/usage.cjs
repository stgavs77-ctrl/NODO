const path=require('node:path');
const {read,save}=require('./io.cjs');
const count=x=>Number.isSafeInteger(x)&&x>=0?x:0;
// Local midnight of the day containing stamp; default lower bound for dailyStats.
function localDayStart(stamp){const d=new Date(stamp==null?Date.now():stamp);d.setHours(0,0,0,0);return d.getTime();}
// DSH counters are disjoint. Codex inputTokens includes cachedInputTokens.
function deepseekUsage(u){if(!u||!Number.isFinite(u.inputTokens)||!Number.isFinite(u.outputTokens))return null;const cached=count(u.cacheReadTokens),written=count(u.cacheWriteTokens),input=count(u.inputTokens)+cached+written,output=count(u.outputTokens);return{input,output,cached,cacheWrite:written,reasoning:count(u.reasoningTokens),total:count(u.totalTokens)||input+output,source:'provider',money:null};}
function codexUsage(u){if(!u||!Number.isFinite(u.inputTokens)||!Number.isFinite(u.outputTokens))return null;const input=count(u.inputTokens),output=count(u.outputTokens);return{input,output,cached:count(u.cachedInputTokens),cacheWrite:0,reasoning:count(u.reasoningOutputTokens),total:count(u.totalTokens)||input+output,source:'provider',money:null};}
function sum(rows){if(!rows.length)return null;return rows.reduce((a,u)=>{for(const k of ['input','output','cached','cacheWrite','reasoning','total'])a[k]+=u[k];return a;},{input:0,output:0,cached:0,cacheWrite:0,reasoning:0,total:0,source:'provider',money:null});}
class UsageLedger{
 constructor(data,{now=Date.now}={}){this.file=path.join(data,'usage.json');this.rows=read(this.file,{});this.now=now;}
 recordDeepSeek(sessionId,events){let changed=false;for(const e of events||[]){if(e.type!=='assistant/message')continue;const u=deepseekUsage(e.data?.usage);if(u&&Number.isSafeInteger(e.seq)){const key='deepseek:'+sessionId+':'+e.seq;if(!this.rows[key]){this.rows[key]={provider:'DeepSeek',sessionId,...u,turn:e.data?.turn,step:e.data?.step,at:this.now()};changed=true;}}}if(changed)save(this.file,this.rows);return this.forSession(sessionId);}
 recordCodex(params){const u=codexUsage(params.tokenUsage?.total);if(!u||!params.threadId)return null;const key='codex:'+params.threadId;const prior=this.rows[key];if(!prior||u.total>=prior.total){this.rows[key]={provider:'Codex',sessionId:params.threadId,...u,at:prior?.at??this.now()};save(this.file,this.rows);}return this.forSession(params.threadId);}
 forSession(id){return sum(Object.values(this.rows).filter(x=>x.sessionId===id));}
 turnStats(sessionId,turn){if(!Number.isSafeInteger(turn))return null;const rows=Object.values(this.rows).filter(x=>x.provider==='DeepSeek'&&x.sessionId===sessionId&&x.turn===turn);const s=sum(rows);return s&&{input:s.input,output:s.output,cached:s.cached,cacheWrite:s.cacheWrite,reasoning:s.reasoning,total:s.total,steps:rows.length,source:'provider'};}
 dailyStats(dayStartMs=localDayStart()){const rows=Object.values(this.rows).filter(x=>x.at>=dayStartMs);const of=p=>sum(rows.filter(x=>x.provider===p));return{DeepSeek:of('DeepSeek'),Codex:of('Codex'),undated:Object.values(this.rows).filter(x=>x.at===undefined).length};}
 snapshot(){return{DeepSeek:sum(Object.values(this.rows).filter(x=>x.provider==='DeepSeek')),Codex:sum(Object.values(this.rows).filter(x=>x.provider==='Codex')),scope:'Provider events observed by NODO; no historical backfill',money:null};}
}
module.exports={UsageLedger,deepseekUsage,codexUsage,sum};
