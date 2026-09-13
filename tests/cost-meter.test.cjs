const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const {UsageLedger}=require('../lib/usage.cjs');const {save}=require('../lib/io.cjs');const {CostMeter,PRICING,peakState,formatUsd,PAGE_SOURCE}=require('../lib/cost-meter.cjs');
// 2026-09-14 is a Monday, 2026-09-19 a Saturday; instants are built explicitly in UTC.
const utc=(day,hour)=>Date.UTC(2026,8,day,hour,0,0);
const WEEKDAY_PEAK=utc(14,2),WEEKDAY_OFF=utc(14,12),SATURDAY_PEAK_HOUR=utc(19,2);
const NOW=Date.now();
// Local midnight, so rows recorded during this test stay inside today's window.
const dayStart=stamp=>{const d=new Date(stamp);d.setHours(0,0,0,0);return d.getTime();};
const M=tokens=>({cached:0,input:0,cacheWrite:0,output:0,reasoning:0,total:0,...tokens});
const event=(seq,turn,step,usage)=>({seq,turn,type:'assistant/message',data:{turn,step,usage}});
function fixture(events){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nodo-cost-meter-'));
 const ledger=new UsageLedger(dir),meter=new CostMeter({usage:ledger,now:NOW});
 for(const [sessionId,list] of Object.entries(events))ledger.recordDeepSeek(sessionId,list);
 return{dir,ledger,meter};
}
test('Schedule prices deepseek-flash peak on weekday UTC windows and off-peak everywhere else',()=>{
 assert.deepEqual(peakState(WEEKDAY_PEAK),{peak:true,tier:'peak',utcHour:2,utcDay:1,reason:'peak-window'});
 assert.deepEqual(peakState(utc(14,7)),{peak:true,tier:'peak',utcHour:7,utcDay:1,reason:'peak-window'});
 assert.deepEqual(peakState(WEEKDAY_OFF),{peak:false,tier:'offPeak',utcHour:12,utcDay:1,reason:'off-peak-window'});
 assert.deepEqual(peakState(SATURDAY_PEAK_HOUR),{peak:false,tier:'offPeak',utcHour:2,utcDay:6,reason:'weekend'});
 assert.equal(peakState(utc(20,2)).reason,'weekend');
 assert.equal(peakState(utc(14,0)).reason,'off-peak-window');assert.equal(peakState(utc(14,4)).reason,'off-peak-window');assert.equal(peakState(utc(14,10)).reason,'off-peak-window');
 assert.equal(PRICING.unit,'USD per 1M tokens');assert.equal(PRICING.capturedAt,'2026-09-13');assert.equal(PRICING.source,PAGE_SOURCE);
 assert.match(PRICING.source,/api-docs\.deepseek\.com/);
 assert.deepEqual(PRICING.schedule.utcPeakWeekdayWindows,[[1,4],[6,10]]);assert.deepEqual(PRICING.schedule.days,[1,2,3,4,5]);
 assert.deepEqual(PRICING.models['deepseek-flash'].peak,{cacheMissInput:0.30,cacheHitInput:0.006,output:1.20});
 assert.deepEqual(PRICING.models['deepseek-flash'].offPeak,{cacheMissInput:0.15,cacheHitInput:0.003,output:0.60});
 assert.equal(PRICING.models['deepseek-flash'].deepseek,'DeepSeek-V4.1-Flash');
});
test('Cost converts disjoint buckets exactly and never prices an unknown model as zero',()=>{
 const meter=new CostMeter({now:WEEKDAY_OFF}),peakMeter=new CostMeter({now:WEEKDAY_PEAK});
 // A disjoint triple bills cache miss + cache hit + output: 0.15 + 0.003 + 0.60.
 const disjoint=M({input:1e6,cached:1e6,output:1e6});
 assert.equal(meter.cost(disjoint).value,0.603);assert.equal(peakMeter.cost(disjoint).value,1.206);
 // usage.input is the whole input side, so 1M cached + 1M written + 3M input = 2M billed misses.
 const million=M({cached:1e6,cacheWrite:1e6,input:3e6,output:1e6});
 assert.equal(meter.cost(million).value,0.903);assert.equal(meter.cost(million).tier,'offPeak');
 assert.equal(peakMeter.cost(million).value,1.806);
 assert.equal(meter.cost(M({cached:1e6})).value,0.003);
 assert.equal(meter.cost(M({input:1e6})).value,0.15);
 assert.equal(meter.cost(M({input:2e6,cacheWrite:1e6})).value,0.30);
 assert.equal(meter.cost(M({output:1e6})).value,0.60);
 // reasoning tokens are already inside output; cacheWrite alone is billed as a cache miss.
 assert.equal(meter.cost(M({output:1e6,reasoning:1e6})).value,0.60);
 assert.equal(meter.cost(M({cached:1e6,cacheWrite:1e6,input:2e6,output:1e6})).value,0.753);
 assert.deepEqual(meter.cost(disjoint),{value:0.603,exact:false,basis:'provider usage × configured pricing table',currency:'USD',source:PRICING.source,model:'deepseek-flash',tier:'offPeak'});
 const unknown=meter.cost(disjoint,{model:'gpt-5-codex'});
 assert.equal(unknown.value,null);assert.notEqual(unknown.value,0);assert.equal(unknown.unavailableReason,'unknown model "gpt-5-codex" pricing');assert.equal(unknown.exact,false);
 const status=new CostMeter().pricingStatus();
 assert.equal(status.known,true);assert.equal(status.currency,'USD');assert.equal(status.unit,PRICING.unit);
 assert.equal(status.source,PAGE_SOURCE);assert.equal(status.capturedAt,'2026-09-13');
 assert.deepEqual(status.models,[{id:'deepseek-flash',deepseek:'DeepSeek-V4.1-Flash'}]);
 assert.deepEqual(status.schedule,{utcPeakWeekdayWindows:[[1,4],[6,10]],days:[1,2,3,4,5]});
});
test('turn, session and project aggregate provider tokens while keeping money non-exact',()=>{
 const {ledger,meter}=fixture({
  s:[event(1,1,1,{inputTokens:10,cacheReadTokens:30,outputTokens:5,totalTokens:45}),event(2,1,2,{inputTokens:5,cacheReadTokens:20,cacheWriteTokens:0,outputTokens:3,totalTokens:28}),event(3,2,1,{inputTokens:1,cacheReadTokens:10,outputTokens:2,totalTokens:13})],
  s2:[event(1,1,1,{inputTokens:1,cacheReadTokens:10,outputTokens:4,totalTokens:15}),event(2,1,2,{inputTokens:2,cacheReadTokens:20,outputTokens:5,totalTokens:27}),event(3,1,3,{inputTokens:3,cacheReadTokens:30,outputTokens:6,totalTokens:39})]
 });
 assert.deepEqual(ledger.turnStats('s',1),{input:65,output:8,cached:50,cacheWrite:0,reasoning:0,total:73,steps:2,source:'provider'});
 assert.equal(ledger.turnStats('s',9),null);
 const turn=meter.turn('s',1);
 assert.equal(turn.exact,true);assert.equal(turn.turn,1);assert.equal(turn.usage.cached,50);
 assert.equal(turn.pricing.tier,'offPeak');assert.equal(turn.pricing.capturedAt,'2026-09-13');assert.equal(turn.cost.exact,false);
 assert.equal(turn.cost.value,0.000007);
 const empty=meter.turn('s',3);
 assert.equal(empty.turn,3);assert.equal(empty.exact,true);assert.equal(empty.usage,null);assert.equal(empty.cost.value,null);
 assert.equal(empty.cost.unavailableReason,'no provider usage observed for this turn');
 const session=meter.session('s');
 assert.equal(session.usage.input,76);assert.equal(session.usage.cached,60);assert.equal(session.usage.output,10);assert.equal(session.usage.total,86);
 assert.equal(session.cost.value,0.000009);assert.equal(session.cost.exact,false);assert.equal(session.codex,null);assert.equal(session.codexCost,null);
 assert.equal(CostMeter.cacheHitRate(session.usage),0.789474);assert.equal(meter.cacheHitRate(session.usage),0.789474);
 assert.equal(CostMeter.cacheHitRate(M({})),null);
 const missing=meter.session('nobody');
 assert.equal(missing.usage,null);assert.equal(missing.cost.value,null);assert.equal(missing.cost.unavailableReason,'no provider usage observed for this session');
 const project=meter.project();
 assert.equal(project.exact,true);assert.equal(project.estimated,false);
 assert.equal(project.usage.input,142);assert.equal(project.usage.cached,120);assert.equal(project.usage.output,25);assert.equal(project.usage.total,167);
 assert.equal(project.cacheHitRate,0.84507);assert.equal(project.cost.exact,false);assert.equal(project.cost.model,'deepseek-flash');
 assert.equal(project.today.usage.cached,120);assert.equal(project.today.undated,0);assert.equal(project.codex,null);
 assert.equal(meter.project({model:'gpt-5-codex'}).cost.value,null);
});
test('Codex usage is reported separately and never priced by the DeepSeek table',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nodo-cost-meter-codex-'));const ledger=new UsageLedger(dir);
 ledger.recordCodex({threadId:'t',tokenUsage:{total:{inputTokens:100,cachedInputTokens:40,outputTokens:20,totalTokens:120}}});
 const meter=new CostMeter({usage:ledger,now:NOW});
 const session=meter.session('t');
 assert.equal(session.usage,null);assert.equal(session.codex.total,120);
 assert.equal(session.cost.value,null);assert.equal(session.cost.unavailableReason,'no provider usage observed for this session');
 assert.equal(session.codexCost.value,null);assert.equal(session.codexCost.unavailableReason,'Codex usage is not priced by this table');
 const project=meter.project();
 assert.equal(project.usage,null);assert.equal(project.codex.total,120);assert.equal(project.cacheHitRate,null);
 assert.equal(project.cost.value,null);assert.equal(project.cost.unavailableReason,'no provider usage observed');
 assert.equal(project.today.codex,null);assert.equal(project.today.usage,null);assert.equal(project.today.cost,null);
 // Codex rows carry no `at` stamp, so they surface as undated instead of today's spend.
 assert.equal(project.today.undated,1);
 assert.equal(project.startsAt,null);
});
test('Real ledger events feed turnStats, dailyStats and the meter with undated rows surfaced',()=>{
 const {dir,ledger,meter}=fixture({
  s:[event(1,1,1,{inputTokens:10,cacheReadTokens:30,outputTokens:5,totalTokens:45}),event(2,2,1,{inputTokens:5,cacheReadTokens:20,outputTokens:3,totalTokens:28})],
  s2:[event(1,1,1,{inputTokens:1,cacheReadTokens:15,outputTokens:2,totalTokens:18})]
 });
 // Replaying the same seq must stay deduplicated and must not re-stamp turn data.
 ledger.recordDeepSeek('s',[event(1,1,1,{inputTokens:10,cacheReadTokens:30,outputTokens:5,totalTokens:45})]);
 assert.deepEqual(ledger.turnStats('s',2),{input:25,output:3,cached:20,cacheWrite:0,reasoning:0,total:28,steps:1,source:'provider'});
 assert.equal(ledger.turnStats('s',1).steps,1);
 const daily=ledger.dailyStats(dayStart(NOW));
 assert.equal(daily.undated,0);assert.equal(daily.DeepSeek.cached,65);assert.equal(daily.DeepSeek.input,81);assert.equal(daily.DeepSeek.total,91);
 assert.equal(daily.DeepSeek.source,'provider');assert.equal(daily.DeepSeek.money,null);assert.equal(daily.Codex,null);
 const tomorrow=ledger.dailyStats(NOW+86400000);
 assert.equal(tomorrow.DeepSeek,null);assert.equal(tomorrow.Codex,null);assert.equal(tomorrow.undated,0);
 assert.equal(meter.turn('s',1).usage.steps,1);assert.equal(meter.turn('s',1).cost.value,0.000005);
 assert.equal(formatUsd(meter.project().cost.value),'$0.0000');assert.equal(formatUsd(meter.turn('s',9).cost.value),'unavailable');
 assert.equal(formatUsd(null),'unavailable');assert.equal(formatUsd(undefined),'unavailable');
 assert.equal(formatUsd(0.753),'$0.7530');assert.equal(formatUsd(0),'$0.0000');
});
test('A persisted row without a timestamp is surfaced as undated instead of silently counted today',()=>{
 const {dir,ledger}=fixture({s:[event(1,1,1,{inputTokens:10,cacheReadTokens:30,outputTokens:5,totalTokens:45})]});
 const rows=ledger.rows;delete rows[Object.keys(rows)[0]].at;save(ledger.file,rows);
 const fresh=new UsageLedger(dir),today=fresh.dailyStats(dayStart(NOW));
 assert.equal(today.undated,1);assert.equal(today.DeepSeek,null);assert.equal(today.Codex,null);
 const meter=new CostMeter({usage:fresh,now:NOW});
 assert.equal(meter.turn('s',1).usage.steps,1);assert.equal(meter.turn('s',1).cost.value,0.000005);
 assert.equal(meter.project().today.undated,1);assert.equal(meter.project().startsAt,null);assert.equal(meter.project().usage.cached,30);
});
