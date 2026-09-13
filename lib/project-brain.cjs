'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {randomUUID,createHash}=require('node:crypto');
const {save,read}=require('./io.cjs');
const TYPES=['description','goal','decision','preference','file','task','problem','milestone','entity','link','technical','integration','note'];
const SCOPES=['Project','Browser','Files','REAPER','Telegram','Coding'];
const tokens=text=>new Set(String(text).toLowerCase().match(/[\p{L}\p{N}_-]{3,}/gu)||[]);
function score(text,query){const words=tokens(text);let n=0;for(const word of query)if(words.has(word))n++;return n;}
function scopes(text){const s=['Project'];for(const [scope,re] of [['Browser',/https?:|сайт|браузер|\bweb\b|browser/i],['Files',/файл|file|папк|folder/i],['REAPER',/reaper|бас|вокал|куплет|трек|midi/i],['Telegram',/telegram|телеграм|клиент|сообщени/i],['Coding',/код|\bcode|repo|рефактор|bug|тест|implement/i]])if(re.test(text))s.push(scope);return s;}
class ProjectBrain{
 constructor(data){this.dir=path.join(data,'project-brain');this.cache=new Map();}
 key(workspace){if(typeof workspace!=='string'||!workspace.trim()||workspace.length>4096)throw Error('Native workspace identity required');return createHash('sha256').update(workspace).digest('hex');}
 get(workspace){const key=this.key(workspace);if(!this.cache.has(key)){const value=read(path.join(this.dir,key+'.json'),{schema:1,workspace,entries:[],rules:[],timeline:[],contexts:{}});if(value.schema!==1||value.workspace!==workspace)throw Error('Unsupported Brain schema');this.cache.set(key,value);}return this.cache.get(key);}
 persist(workspace){fs.mkdirSync(this.dir,{recursive:true,mode:0o700});save(path.join(this.dir,this.key(workspace)+'.json'),this.get(workspace));}
 list(workspace,{query='',type}={}){const b=this.get(workspace),q=tokens(query);return {entries:b.entries.filter(e=>(!type||e.type===type)&&(!q.size||score(e.text,q)>0)).sort((a,b)=>Number(b.pinned)-Number(a.pinned)||b.updatedAt.localeCompare(a.updatedAt)),rules:b.rules,timeline:b.timeline.slice(0,200)};}
 event(workspace,type,detail,before){const b=this.get(workspace),e={id:randomUUID(),at:new Date().toISOString(),type,detail,...before?{before}:{}};b.timeline.unshift(e);b.timeline=b.timeline.slice(0,1000);this.persist(workspace);return e;}
 mutate(workspace,kind,action,p,actor='user'){
  if(!['entries','rules'].includes(kind))throw Error('Invalid collection');
  const b=this.get(workspace),rows=b[kind],index=rows.findIndex(e=>e.id===p.id),old=index<0?null:rows[index];
  if(action==='delete'){if(!old)throw Error('Entry not found');rows.splice(index,1);this.event(workspace,kind+'.delete',{id:p.id},{kind,item:old});return {deleted:p.id};}
  if(action!=='save')throw Error('Invalid action');
  if(p.id&&!old)throw Error('Entry not found');
  if(rows.length>=5000&&!old)throw Error('Project entry limit reached');
  if(typeof p.text!=='string'||!p.text.trim()||p.text.length>12000)throw Error('Text must contain 1-12000 characters');
  const item={id:old?.id||randomUUID(),text:p.text.trim(),source:old?.source||String(p.source||actor).slice(0,500),createdAt:old?.createdAt||new Date().toISOString(),updatedAt:new Date().toISOString()};
  if(kind==='entries'){if(!TYPES.includes(p.type))throw Error('Invalid Brain type');Object.assign(item,{type:p.type,pinned:!!p.pinned});}
  else{if(!SCOPES.includes(p.scope))throw Error('Invalid rule scope');Object.assign(item,{scope:p.scope,enabled:p.enabled!==false,priority:Math.max(0,Math.min(100,Number(p.priority)||0)),createdBy:old?.createdBy||(actor==='user'?'user':'suggested by NODO')});}
  if(old)rows[index]=item;else rows.push(item);
  this.event(workspace,kind+'.save',{id:item.id},{kind,item:old,id:item.id});return item;
 }
 undo(workspace,id){const e=this.get(workspace).timeline.find(e=>e.id===id);if(!e?.before)throw Error('This action has no reversible project state');const {kind,item,id:created}=e.before;const rows=this.get(workspace)[kind],target=item?.id||created,index=rows.findIndex(x=>x.id===target),current=index<0?null:rows[index];if(index>=0)rows.splice(index,1);if(item)rows.push(item);return this.event(workspace,'undo',{target:id},{kind,item:current,id:target});}
 select(workspace,sessionId,text,{exclude=[],manual=[]}={}){
  const b=this.get(workspace),query=tokens(text),scope=scopes(text),excluded=new Set(exclude);
  const ranked=b.entries.map(e=>({...e,score:score(e.text,query)+(e.pinned?3:0)})).filter(e=>e.score>0||manual.includes(e.id)).sort((a,b)=>Number(manual.includes(b.id))-Number(manual.includes(a.id))||b.score-a.score).slice(0,12);
  const rules=b.rules.filter(r=>r.enabled&&scope.includes(r.scope)).sort((a,b)=>b.priority-a.priority).slice(0,20);
  const candidates=[...rules.map(r=>({id:r.id,kind:'rule',text:r.text,scope:r.scope,source:r.source})),...ranked.map(e=>({id:e.id,kind:e.type==='file'?'file-reference':'brain',text:e.text,source:e.source}))].filter(e=>!excluded.has(e.id));
  let budget=14000;const included=[];for(const c of candidates){if(c.text.length>budget)continue;budget-=c.text.length;included.push(c);}
  const selection={at:new Date().toISOString(),sessionId,workspace,scopes:scope,included,excluded:[...excluded],manual,chars:14000-budget};
  b.contexts[sessionId]=selection;const keys=Object.keys(b.contexts);for(const key of keys.slice(0,Math.max(0,keys.length-200)))delete b.contexts[key];this.persist(workspace);return selection;
 }
 context(workspace,sessionId){return this.get(workspace).contexts[sessionId]||{included:[],excluded:[],manual:[]};}
 correction(text){if(typeof text!=='string'||!/(так больше не|не делай|в следующий раз|запомни.*правил|когда я говорю|from now on|don't do that)/i.test(text))return null;return {text:text.slice(0,2000),scope:scopes(text).at(-1),source:'user correction',requiresConfirmation:true};}
}
module.exports={ProjectBrain,TYPES,SCOPES,scopes,tokens,score};
