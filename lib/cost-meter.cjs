// Cost Meter: turns provider-observed token usage into money estimates only.
// Pricing source: https://api-docs.deepseek.com/quick_start/pricing
// Tariff captured 2026-09-13 (deepseek-flash). NODO never guesses and never bills:
// every amount is an estimate over a configured table, never a provider invoice.
const PAGE_SOURCE='https://api-docs.deepseek.com/quick_start/pricing';
const PRICING={
 unit:'USD per 1M tokens',
 source:PAGE_SOURCE,
 capturedAt:'2026-09-13',
 models:{
  'deepseek-flash':{
   deepseek:'DeepSeek-V4.1-Flash',
   peak:{cacheMissInput:0.30,cacheHitInput:0.006,output:1.20},
   offPeak:{cacheMissInput:0.15,cacheHitInput:0.003,output:0.60}
  }
 },
 // [fromHour,toHour) UTC on days listed; everything else is off-peak.
 schedule:{utcPeakWeekdayWindows:[[1,4],[6,10]],days:[1,2,3,4,5]}
};
const DEFAULT_MODEL='deepseek-flash';
const BASIS='provider usage × configured pricing table';
const CODEX_REASON='Codex usage is not priced by this table';
const COUNTED=['input','output','cached','cacheWrite','reasoning','total'];
const count=x=>Number.isSafeInteger(x)&&x>=0?x:0;
const round6=x=>Math.round(x*1e6)/1e6;
// Peak = weekday and UTC hour inside [1,4) or [6,10); weekends are off-peak all day.
function peakState(nowMs){
 const d=new Date(nowMs==null?Date.now():nowMs);
 const utcHour=d.getUTCHours(),utcDay=d.getUTCDay();
 const weekday=PRICING.schedule.days.includes(utcDay);
 if(!weekday)return{peak:false,tier:'offPeak',utcHour,utcDay,reason:'weekend'};
 const inWindow=PRICING.schedule.utcPeakWeekdayWindows.some(([from,to])=>utcHour>=from&&utcHour<to);
 return{peak:inWindow,tier:inWindow?'peak':'offPeak',utcHour,utcDay,reason:inWindow?'peak-window':'off-peak-window'};
}
function formatUsd(value){return Number.isFinite(value)?'$'+value.toFixed(4):'unavailable';}
function priceFor(model){return PRICING.models[model]||null;}
function modelNames(){return Object.keys(PRICING.models);}
// Ledger rows keep `input` as the whole input side (raw prompt tokens plus cached plus
// written), while the tariff bills three disjoint buckets. `priced` is that disjoint
// view: raw cache-miss input, cache hits, cache writes and output.
function priced(tokens){return{input:cacheMissInput(tokens),cached:count(tokens?.cached),cacheWrite:count(tokens?.cacheWrite),output:count(tokens?.output)};}
function cacheMissInput(tokens){const miss=count(tokens?.input)-count(tokens?.cached)-count(tokens?.cacheWrite);return miss>0?miss:0;}
// cacheWrite is billed as a cache miss; reasoning tokens are already inside output.
function cost(tokens,{model=DEFAULT_MODEL,nowMs=Date.now()}={}){
 const tier=peakState(nowMs);
 const entry=priceFor(model);
 if(!entry)return{value:null,exact:false,basis:BASIS,currency:'USD',source:PRICING.source,model,tier:tier.tier,unavailableReason:'unknown model "'+model+'" pricing'};
 const rates=entry[tier.tier==='peak'?'peak':'offPeak']||{};
 return{value:round6(rawCost(tokens,rates)),exact:false,basis:BASIS,currency:'USD',source:PRICING.source,model,tier:tier.tier};
}
// Sum of per-row costs, each row priced with the tier of its own timestamp (undated rows use nowMs).
function costRows(rows,{model=DEFAULT_MODEL,nowMs=Date.now()}={}){
 if(!priceFor(model))return cost(sumRows(rows),{model,nowMs});
 let value=0;const tiers=new Set();
 // Round once over the unrounded sum so per-row pricing matches pricing the aggregate.
 for(const row of rows){const tier=peakState(Number.isFinite(row.at)?row.at:nowMs).tier;value+=rawCost(row,priceFor(model)[tier]);tiers.add(tier);}
 return{value:round6(value),exact:false,basis:BASIS,currency:'USD',source:PRICING.source,model,tier:tiers.size===1?[...tiers][0]:'mixed'};
}
function rawCost(tokens,rates){const r=x=>Number.isFinite(x)?x:0,b=priced(tokens);return(b.cached*r(rates.cacheHitInput)+(b.input+b.cacheWrite)*r(rates.cacheMissInput)+b.output*r(rates.output))/1e6;}
function unavailable(reason,extra={}){return{value:null,exact:false,basis:BASIS,currency:'USD',source:PRICING.source,unavailableReason:reason,...extra};}
class CostMeter{
 constructor({usage,now}={}){this.usage=usage;this.now=now;}
 nowMs(){if(typeof this.now==='function')return this.now();return Number.isFinite(this.now)?this.now:Date.now();}
 // Most recent session that has provider rows: keeps the header meter useful
 // right after the app starts, before the open session has reported anything.
 latest(){const rows=this.rows('DeepSeek').filter(r=>Number.isFinite(r.at));if(!rows.length)return null;const row=rows.reduce((a,b)=>b.at>a.at?b:a);return this.session(row.sessionId);}
 pricingStatus(){return{known:true,currency:'USD',unit:PRICING.unit,source:PRICING.source,capturedAt:PRICING.capturedAt,models:modelNames().map(name=>({id:name,deepseek:PRICING.models[name].deepseek})),schedule:{utcPeakWeekdayWindows:PRICING.schedule.utcPeakWeekdayWindows.map(w=>[...w]),days:[...PRICING.schedule.days]}};}
 cost(tokens,{model=DEFAULT_MODEL,nowMs=this.nowMs()}={}){return cost(tokens,{model,nowMs});}
 static cacheHitRate(usage){const b=priced(usage),den=b.cached+b.input+b.cacheWrite;return den?round6(b.cached/den):null;}
 cacheHitRate(usage){return CostMeter.cacheHitRate(usage);}
 rows(provider){return Object.values(this.usage?.rows||{}).filter(x=>x.provider===provider);}
 turn(sessionId,turn){const usage=this.usage?.turnStats?.(sessionId,turn);if(!usage)return{turn,exact:true,usage:null,cost:{value:null,unavailableReason:'no provider usage observed for this turn'},pricing:{...this.pricingStatus(),tier:peakState(this.nowMs()).tier}};const rows=this.rows('DeepSeek').filter(x=>x.sessionId===sessionId&&x.turn===turn);return{turn,exact:true,usage,pricing:{...this.pricingStatus(),tier:peakState(this.nowMs()).tier},cost:costRows(rows,{nowMs:this.nowMs()})};}
 session(sessionId){const own=this.rows('DeepSeek').filter(x=>x.sessionId===sessionId),usage=sumRows(own),codex=sumRows(this.rows('Codex').filter(x=>x.sessionId===sessionId));return{sessionId,exact:true,usage,cost:usage?costRows(own,{nowMs:this.nowMs()}):unavailable('no provider usage observed for this session'),codex,codexCost:codex?unavailable(CODEX_REASON):null};}
 project({model=DEFAULT_MODEL,nowMs=this.nowMs()}={}){const rows=this.rows('DeepSeek'),usage=sumRows(rows),today=this.usage?.dailyStats?.(localDayStart(nowMs));return{exact:true,estimated:false,usage,cacheHitRate:CostMeter.cacheHitRate(usage),cost:usage?costRows(rows,{model,nowMs}):unavailable('no provider usage observed'),codex:sumRows(this.rows('Codex')),startsAt:today?.undated?null:rows.reduce((a,x)=>Number.isFinite(x.at)&&(a===null||x.at<a)?x.at:a,null),today:today?{usage:today.DeepSeek,cost:today.DeepSeek?costRows(rows.filter(x=>Number.isFinite(x.at)&&x.at>=localDayStart(nowMs)),{model,nowMs}):null,codex:today.Codex,undated:today.undated}:null};}
}
function localDayStart(stamp){const d=new Date(stamp);d.setHours(0,0,0,0);return d.getTime();}
// Local clone of usage.sum: rows here are plain ledger records, not tokens.
function sumRows(rows){if(!rows.length)return null;return rows.reduce((a,u)=>{for(const k of COUNTED)a[k]+=count(u[k]);return a;},{input:0,output:0,cached:0,cacheWrite:0,reasoning:0,total:0,source:'provider',money:null});}
module.exports={CostMeter,PRICING,peakState,formatUsd,PAGE_SOURCE,costRows};
