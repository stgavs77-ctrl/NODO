'use strict';

// Read-only NODO panel adapter. It has no Electron dependency and stays
// offline unless the embedding main process explicitly enables it.
const {spawn}=require('node:child_process');
const path=require('node:path');

const DEFAULT_PYTHON=path.join(require('node:os').homedir(),'Desktop/reaper-mcp/.venv/bin/python');
const MAX_TRACKS=80,MAX_SELECTED=8,MAX_FX_TRACKS=3,MAX_FX=12,MAX_REGIONS=30;

function text(value,max=160){return typeof value==='string'?value.slice(0,max):'';}
function number(value){return typeof value==='number'&&Number.isFinite(value)?value:null;}
function boolean(value){return value===true;}
function object(value){return value&&typeof value==='object'&&!Array.isArray(value)?value:{};}
function array(value,max){return Array.isArray(value)?value.slice(0,max):[];}
function data(result){const candidate=object(result);return object(candidate.data??candidate);}
function compactTrack(value){const track=object(value);return {index:Number.isInteger(track.index)?track.index:null,name:text(track.name),folderDepth:number(track.folder_depth),selected:boolean(track.selected),mute:boolean(track.mute),solo:boolean(track.solo),armed:boolean(track.armed),volumeDb:number(track.volume_db),itemCount:Number.isInteger(track.item_count)?track.item_count:null,fxCount:Number.isInteger(track.fx_count)?track.fx_count:null};}
function compactItem(value){const item=object(value);return {index:Number.isInteger(item.index)?item.index:null,trackIndex:Number.isInteger(item.track_index)?item.track_index:null,name:text(item.name),sourceFilename:text(item.source_filename),position:number(item.position),length:number(item.length),isMidi:boolean(item.is_midi),mute:boolean(item.mute),pitch:number(item.pitch),playrate:number(item.playrate)};}
function compactFx(value){const fx=object(value);return {index:Number.isInteger(fx.index)?fx.index:null,name:text(fx.name),enabled:boolean(fx.enabled),preset:text(fx.preset),paramCount:Number.isInteger(fx.param_count)?fx.param_count:null};}

function normalize(raw,now=Date.now()){
 const source=object(raw),overview=data(source.overview),selection=object(overview.selection),allTracks=data(source.tracks),selectedTracks=data(source.selectedTracks),selectedItems=data(source.selectedItems),transport=data(source.transport),chains=object(source.fxChains);
 const fx=[];
 for(const [index,chainResult] of Object.entries(chains).slice(0,MAX_FX_TRACKS)){
  const chain=data(chainResult);fx.push({trackIndex:Number.isInteger(Number(index))?Number(index):null,fxCount:Number.isInteger(chain.fx_count)?chain.fx_count:null,items:array(chain.fx_chain,MAX_FX).map(compactFx)});
 }
 return {status:'ready',fetchedAt:now,project:{name:text(overview.name),trackCount:Number.isInteger(overview.track_count)?overview.track_count:null,itemCount:Number.isInteger(overview.item_count)?overview.item_count:null,changeCount:Number.isInteger(overview.change_count)?overview.change_count:null,regions:array(overview.regions,MAX_REGIONS).map(region=>{const r=object(region);return {number:Number.isInteger(r.number)?r.number:null,name:text(r.name),start:number(r.start),end:number(r.end)};}),selection:{trackCount:Number.isInteger(selection.selected_track_count)?selection.selected_track_count:null,itemCount:Number.isInteger(selection.selected_item_count)?selection.selected_item_count:null,timeStart:number(object(selection.time_selection).start),timeEnd:number(object(selection.time_selection).end)}},transport:{playing:boolean(transport.playing),paused:boolean(transport.paused),recording:boolean(transport.recording),position:number(transport.position),bpm:number(transport.bpm),timeSigNum:number(transport.time_sig_num),timeSigDen:number(transport.time_sig_den),repeating:boolean(transport.repeating),playrate:number(transport.playrate)},tracks:array(allTracks.tracks,MAX_TRACKS).map(compactTrack),selected:{tracks:array(selectedTracks.tracks,MAX_SELECTED).map(compactTrack),items:array(selectedItems.items,MAX_SELECTED).map(compactItem),fx}};
}

function defaultRunner({pythonPath,helperPath,timeoutMs}){
 return new Promise((resolve,reject)=>{
  const child=spawn(pythonPath,[helperPath],{stdio:['ignore','pipe','pipe'],shell:false,windowsHide:true});let stdout='',stderr='',settled=false;
  const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(value);};
  const timer=setTimeout(()=>{child.kill('SIGKILL');finish(new Error('REAPER context timed out'));},timeoutMs);
  child.stdout.on('data',chunk=>{stdout+=chunk;if(stdout.length>262144)child.kill('SIGKILL');});child.stderr.on('data',chunk=>{stderr+=chunk;if(stderr.length>8192)stderr=stderr.slice(-8192);});
  child.on('error',()=>finish(new Error('REAPER context helper unavailable')));
  child.on('close',code=>{if(code!==0)return finish(new Error('REAPER context helper unavailable'));try{finish(null,JSON.parse(stdout));}catch{finish(new Error('REAPER context helper returned invalid JSON'));}});
 });
}

class ReaperContext{
 constructor({enabled=false,pythonPath=DEFAULT_PYTHON,helperPath=path.join(__dirname,'reaper-context.py'),cacheMs=3000,timeoutMs=6000,runner=defaultRunner,now=()=>Date.now()}={}){
  this.enabled=enabled===true;this.pythonPath=pythonPath;this.helperPath=helperPath;this.cacheMs=Math.max(3000,cacheMs);this.timeoutMs=Math.min(6000,Math.max(1,timeoutMs));this.runner=runner;this.now=now;this.cached=null;this.inFlight=null;
 }
 async getState({force=false}={}){
  if(!this.enabled)return {status:'offline',reason:'disabled',retryAfterMs:this.cacheMs};
  const now=this.now();if(!force&&this.cached&&now-this.cached.at<this.cacheMs)return {...this.cached.value,cached:true};
  if(this.inFlight)return this.inFlight;
  this.inFlight=(async()=>{try{const payload=await this.runner({pythonPath:this.pythonPath,helperPath:this.helperPath,timeoutMs:this.timeoutMs});const value=normalize(payload,this.now());this.cached={at:this.now(),value};return value;}catch{const value={status:'offline',reason:'unavailable',retryAfterMs:this.cacheMs};this.cached={at:this.now(),value};return value;}finally{this.inFlight=null;}})();
  return this.inFlight;
 }
 clearCache(){this.cached=null;}
}

module.exports={ReaperContext,normalize,defaultRunner,DEFAULT_PYTHON};
