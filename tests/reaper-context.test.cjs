'use strict';
const assert=require('node:assert/strict');
const test=require('node:test');
const {ReaperContext,normalize,DEFAULT_PYTHON}=require('../lib/reaper-context.cjs');

const fixture={overview:{data:{name:'Song',track_count:2,item_count:3,change_count:9,regions:[{number:1,name:'Verse',start:0,end:12}],selection:{selected_track_count:1,selected_item_count:1,time_selection:{start:1,end:2}}}},tracks:{data:{tracks:[{index:0,name:'Vox',folder_depth:1,selected:true,mute:false,solo:false,armed:true,volume_db:-3,item_count:2,fx_count:2,guid:'private'}]}},selectedTracks:{data:{tracks:[{index:0,name:'Vox',selected:true,fx_count:2}]}},selectedItems:{data:{items:[{index:2,track_index:0,name:'Lead',source_filename:'lead.wav',source_file:'/private/source.wav',position:1,length:2,is_midi:false,mute:false,pitch:0,playrate:1}]}},transport:{data:{playing:true,paused:false,recording:false,position:1.5,bpm:120,time_sig_num:4,time_sig_den:4,repeating:false,playrate:1}},fxChains:{'0':{data:{fx_count:2,fx_chain:[{index:0,name:'ReaEQ',enabled:true,preset:'',param_count:10}]}}}};

test('offline is the default and invokes no runner',async()=>{
 let calls=0;const context=new ReaperContext({runner:async()=>{calls++;return fixture;}});assert.deepEqual(await context.getState(),{status:'offline',reason:'disabled',retryAfterMs:3000});assert.equal(calls,0);
});

test('normalizes only bounded readable state from injected read-only helper output',async()=>{
 const context=new ReaperContext({enabled:true,runner:async options=>{assert.equal(options.pythonPath,DEFAULT_PYTHON);assert.equal(options.timeoutMs,6000);return fixture;},now:()=>100});const state=await context.getState();assert.equal(state.status,'ready');assert.equal(state.project.name,'Song');assert.equal(state.tracks[0].guid,undefined);assert.equal(state.selected.items[0].sourceFile,undefined);assert.equal(state.selected.items[0].sourceFilename,'lead.wav');assert.deepEqual(state.selected.fx[0].items,[{index:0,name:'ReaEQ',enabled:true,preset:'',paramCount:10}]);
});

test('caches state for at least three seconds and coalesces calls',async()=>{
 let now=0,calls=0;let release;const pending=new Promise(resolve=>{release=resolve;});const context=new ReaperContext({enabled:true,cacheMs:1,now:()=>now,runner:async()=>{calls++;await pending;return fixture;}});const first=context.getState(),second=context.getState();assert.equal(calls,1);release();await first;const cached=await second;assert.equal(cached.status,'ready');now=2999;await context.getState();assert.equal(calls,1);now=3000;await context.getState();assert.equal(calls,2);
});

test('helper errors surface a clear offline state without leaking internals',async()=>{
 const context=new ReaperContext({enabled:true,runner:async()=>{throw new Error('/secret/path');}});assert.deepEqual(await context.getState(),{status:'offline',reason:'unavailable',retryAfterMs:3000});
});

test('normalizer tolerates malformed fields and does not expose raw payloads',()=>{
 const value=normalize({overview:{data:{name:'x'.repeat(500),regions:'bad'}},tracks:{data:{tracks:[{name:9}]}},selectedTracks:{},selectedItems:{},transport:{},fxChains:{}},7);assert.equal(value.project.name.length,160);assert.deepEqual(value.project.regions,[]);assert.equal(value.tracks[0].name,'');assert.equal(value.raw,undefined);
});
