'use strict';
// Standalone Safari client. No Electron preload, native IPC, or generic RPC.
const $=id=>document.getElementById(id),enc=new TextEncoder(),dec=new TextDecoder();
const b64=b=>{let s='';for(const x of new Uint8Array(b))s+=String.fromCharCode(x);return btoa(s).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');};
const un64=s=>Uint8Array.from(atob(s.replaceAll('-','+').replaceAll('_','/')),c=>c.charCodeAt(0));
const wrap=v=>b64(enc.encode(JSON.stringify(v))),unwrap=v=>JSON.parse(dec.decode(un64(v)));
const importKey=v=>crypto.subtle.importKey('raw',un64(v),'AES-GCM',false,['encrypt','decrypt']);
async function seal(key,value,aad){const iv=crypto.getRandomValues(new Uint8Array(12));const out=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:enc.encode(aad)},key,enc.encode(JSON.stringify(value))));return {iv:b64(iv),body:b64(out.slice(0,-16)),tag:b64(out.slice(-16))};}
async function open(key,box,aad){const body=un64(box.body),tag=un64(box.tag),all=new Uint8Array(body.length+tag.length);all.set(body);all.set(tag,body.length);return JSON.parse(dec.decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:un64(box.iv),additionalData:enc.encode(aad)},key,all)));}
const fragment=new URLSearchParams(location.hash.slice(1));
// Keep the unused one-time fragment on the landing page so iOS Code Scanner's
// Open in Safari transfers it. No relay connection or pairing until explicit tap.
const needsPairConfirmation=fragment.has('secret');let pairConfirmed=!needsPairConfirmation;
if(!needsPairConfirmation)history.replaceState(null,'',location.pathname);
let device,db,socket,connectionId,challenge,seq=0,ready=false,pending=new Map(),selected=localStorage.getItem('nodo.session'),room=fragment.get('room')||localStorage.getItem('nodo.room'),timer,polling=false,sessionRows=[];
const showError=e=>$('error').textContent=e.message||String(e),status=s=>$('status').textContent=s;
let lastRenderKey='';
for(const [id,label]of [['workspaces','Workspaces — ожидание подключения'],['sessions','Sessions — ожидание подключения']]){const item=document.createElement('option');item.value='';item.textContent=label;$(id).append(item);}
function vault(action,value){return new Promise((resolve,reject)=>{const tx=db.transaction('device',action==='read'?'readonly':'readwrite'),s=tx.objectStore('device'),r=action==='read'?s.get('paired'):s.put(value,'paired');tx.oncomplete=()=>resolve(r.result);tx.onabort=()=>reject(tx.error||Error('Safari storage transaction aborted'));tx.onerror=()=>reject(tx.error);});}
function send(frame){if(socket?.readyState!==1)throw Error('Reconnecting…');socket.send(JSON.stringify({type:'to_host',connectionId,frame:wrap(frame)}));}
let sendChain=Promise.resolve();
async function call(method,params={}){
 if(!ready)throw Error('NODO reconnecting…');const n=++seq;
 const channel=connectionId,nonce=challenge;
 return new Promise((resolve,reject)=>{const timeout=setTimeout(()=>{pending.delete(n);reject(Error('Нет подтверждения операции. Проверь сессию перед повторной отправкой.'));},30000);pending.set(n,{resolve,reject,timeout});sendChain=sendChain.catch(()=>{}).then(async()=>{if(!ready||channel!==connectionId||nonce!==challenge)throw Error('Connection changed');const box=await seal(device.key,{seq:n,method,params},'nodo-request-v1:'+channel+':'+nonce);send({type:'request',box});}).catch(e=>{clearTimeout(timeout);pending.delete(n);reject(e);});});
}
const interactions=document.createElement('section');interactions.id='interactions';$('composer').before(interactions);let interactionsKey='';
async function showInteractions(){if(!selected)return;const rows=await call('interactions',{sessionId:selected}),key=JSON.stringify(rows);if(key===interactionsKey)return;interactionsKey=key;interactions.replaceChildren();for(const item of rows){const box=document.createElement('article');interactions.append(box);const heading=document.createElement('p');heading.textContent=item.kind==='approval'?(item.toolName+': '+(item.reason||'Разрешить один раз?')):'Нужен твой ответ';box.append(heading);
 const answer=async value=>{try{await call('answer',{sessionId:selected,eventId:item.eventId,answer:value});interactionsKey='';await showInteractions();}catch(e){showError(e);}};
 if(item.kind==='approval'){for(const [label,value]of [['Разрешить один раз','allowed-once'],['Отклонить','rejected']]){const button=document.createElement('button');button.textContent=label;button.onclick=()=>answer(value);box.append(button);}}
 else{const inputs=[];for(const q of item.questions){const title=document.createElement('p');title.textContent=q.question+(q.detail?'\n'+q.detail:'');box.append(title);const choices=[];for(const o of q.options||[]){const label=document.createElement('label'),input=document.createElement('input');input.type=q.multiSelect?'checkbox':'radio';input.name=item.eventId+q.id;input.value=o.label;label.append(input,document.createTextNode(o.label));box.append(label);choices.push(input);}const custom=document.createElement('textarea');custom.placeholder='Свой ответ';custom.maxLength=8000;box.append(custom);inputs.push({q,choices,custom});}const submit=document.createElement('button');submit.textContent='Ответить';submit.onclick=()=>answer({answers:inputs.map(({q,choices,custom})=>({id:q.id,selected:choices.filter(i=>i.checked).map(i=>i.value),custom:custom.value}))});box.append(submit);}
 }}
function option(select,value,label){const o=document.createElement('option');o.value=value;o.textContent=label;select.append(o);}
function sessionOptions(){projectBody.replaceChildren();const workspace=$('workspaces').value;const ids=window.nodoWorkspaceRows?.find(w=>w.workspaceId===workspace)?.sessionIds;const rows=ids?sessionRows.filter(s=>ids.includes(s.sessionId)):sessionRows;const select=$('sessions');select.replaceChildren();for(const s of rows)option(select,s.sessionId,s.title||'Session');if(rows.some(s=>s.sessionId===selected))select.value=selected;else selected=select.value||null;if(selected)localStorage.setItem('nodo.session',selected);if(workspace)localStorage.setItem('nodo.workspace',workspace);}
async function refresh(){const [workspaces,sessions]=await Promise.all([call('workspaces'),call('sessions')]);const prev=$('workspaces').value||workspaces.value.items.find(w=>w.sessionIds.includes(selected))?.workspaceId||localStorage.getItem('nodo.workspace');window.nodoWorkspaceRows=workspaces.value.items;$('workspaces').replaceChildren();for(const w of workspaces.value.items)option($('workspaces'),w.workspaceId,w.title);if(workspaces.value.items.some(w=>w.workspaceId===prev))$('workspaces').value=prev;sessionRows=sessions.items;sessionOptions();await poll();}
function text(data){const content=data?.content||data?.message?.content;if(Array.isArray(content))return content.filter(v=>v.type==='text').map(v=>v.text).join('');return (data?.stream||[]).filter(v=>Array.isArray(v)&&v[0]==='text').map(v=>v[1]).join('');}
function article(label,value){if(!value)return;const row=document.createElement('article'),who=document.createElement('small'),body=document.createElement('div');who.textContent=label;
 const sessionId=selected;
 const localPaths=[...value.matchAll(/`(\/[^`\r\n]+)`/g)].map(m=>m[1]);
 for(const path of [...new Set(localPaths)].slice(0,10)){const preview=document.createElement('button');preview.textContent='Preview '+path.split('/').at(-1);preview.onclick=async()=>{try{preview.disabled=true;const result=await call('media',{sessionId,path});const card=document.createElement('div');card.textContent=result.card.name+' · '+result.card.mime+' · '+(result.card.size??'?')+' bytes';if(result.content){const player=document.createElement(result.card.kind==='image'?'img':'audio');player.src='data:'+result.content.mime+';base64,'+result.content.base64;player.style.maxWidth='100%';if(player.tagName==='IMG'){player.loading='lazy';player.alt=result.card.name;}else{player.controls=true;player.preload='none';}card.append(player);}preview.after(card);if(result.retryable)preview.disabled=false;}catch(e){preview.disabled=false;showError(e);}};row.append(preview);}
 const pattern=/https?:\/\/[^\s<>\)\]]+/g;let at=0;for(const match of value.matchAll(pattern)){body.append(document.createTextNode(value.slice(at,match.index)));const a=document.createElement('a');a.textContent=match[0];a.href=match[0];a.target='_blank';a.rel='noopener noreferrer';body.append(a);at=match.index+match[0].length;}body.append(document.createTextNode(value.slice(at)));row.append(who,body);$('messages').append(row);}
const projectPanel=document.createElement('details'),projectTitle=document.createElement('summary'),projectViews=document.createElement('div'),projectBody=document.createElement('div');projectTitle.textContent='Project';projectPanel.append(projectTitle,projectViews,projectBody);$('messages').before(projectPanel);
for(const view of ['brain','rules','context','mission']){const button=document.createElement('button');button.textContent=view;button.onclick=async()=>{try{const result=await call('project',{sessionId:selected,view});projectBody.replaceChildren();const rows=Array.isArray(result)?result:result?.included||[result];for(const item of rows){if(!item)continue;const line=document.createElement('p');line.textContent=item.text||[item.phase,item.objective,item.roundsStarted!=null?'Round '+item.roundsStarted:''].filter(Boolean).join(' · ');projectBody.append(line);}}catch(e){showError(e);}};projectViews.append(button);}
async function poll(){if(!ready||!selected||polling||document.hidden)return;polling=true;const id=selected;try{const s=await call('session',{sessionId:id});if(id!==selected)return;const key=JSON.stringify([id,s.records,s.assistantStream]);if(key===lastRenderKey){await showInteractions();return;}lastRenderKey=key;const pane=$('messages'),atBottom=pane.scrollHeight-pane.scrollTop-pane.clientHeight<80;pane.replaceChildren();for(const r of s.records||[]){const e=r.event;if(e?.type==='user/message')article('You',text(e.data));if(e?.type==='assistant/message')article('NODO',text(e.data));}article('NODO · streaming',text({stream:s.assistantStream?.activeAttempt?.stream}));if(atBottom)pane.scrollTop=pane.scrollHeight;await showInteractions();}finally{polling=false;}}
function connect(){
 if(!pairConfirmed){status('Открой в Safari');return;}
 clearTimeout(timer);ready=false;if(!room){status('Not paired');showError(Error('В NODO на Mac открой Remote → Connect iPhone и отсканируй QR.'));return;}
 status('Reconnecting…');socket=new WebSocket('wss://'+location.host+'/relay');
 socket.onopen=()=>socket.send(JSON.stringify({type:'attach',roomId:room}));
 socket.onmessage=async event=>{try{const msg=JSON.parse(event.data);if(msg.type==='connected'){
  connectionId=msg.connectionId;seq=0;
  if(fragment.get('secret')){const key=await importKey(fragment.get('secret'));send({type:'pair',pairingId:fragment.get('pair'),box:await seal(key,{name:'iPhone Safari'},'nodo-pair-v1:'+fragment.get('pair'))});}
  else if(device)send({type:'hello',deviceId:device.id});else throw Error('Отсканируй свежий QR на Mac.');
 }else if(msg.type==='from_host'){
  const frame=unwrap(msg.frame);
  if(frame.type==='paired'){const key=await importKey(fragment.get('secret')),result=await open(key,frame.box,'nodo-pair-result-v1:'+fragment.get('pair'));device={id:result.deviceId,key:await importKey(result.key)};await vault('write',device);fragment.delete('secret');fragment.delete('pair');localStorage.setItem('nodo.room',room);send({type:'hello',deviceId:device.id});}
  if(frame.type==='challenge'){challenge=frame.challenge;ready=true;status('Загрузка сессий…');$('error').textContent='';await refresh();status('Connected');}
  if(frame.type==='response'){const response=await open(device.key,frame.box,'nodo-response-v1:'+connectionId+':'+challenge),p=pending.get(response.seq);if(p){clearTimeout(p.timeout);pending.delete(response.seq);response.error?p.reject(Error(response.error)):p.resolve(response.result);}}
  if(frame.type==='rejected')throw Error('Доступ отклонён или pairing истёк. Создай новый QR на Mac.');
 } }catch(e){showError(e);}};
 socket.onclose=()=>{ready=false;status('NODO offline / reconnecting…');for(const p of pending.values()){clearTimeout(p.timeout);p.reject(Error('Связь прервалась. Сообщение не отправляется повторно автоматически.'));}pending.clear();timer=setTimeout(connect,2500);};socket.onerror=()=>status('Connection unavailable');
}
$('workspaces').onchange=()=>{sessionOptions();poll().catch(showError);};$('sessions').onchange=()=>{projectBody.replaceChildren();selected=$('sessions').value;localStorage.setItem('nodo.session',selected);poll().catch(showError);};
$('refresh').onclick=()=>refresh().catch(showError);$('new').onclick=async()=>{try{const s=await call('newSession',{workspaceId:$('workspaces').value,requestId:crypto.randomUUID()});selected=s.sessionId;localStorage.setItem('nodo.session',selected);await refresh();}catch(e){showError(e);}};
$('composer').onsubmit=async event=>{event.preventDefault();const text=$('draft').value;if(!selected||!text.trim())return;$('send').disabled=true;try{await call('send',{sessionId:selected,requestId:crypto.randomUUID(),text});$('draft').value='';await poll();}catch(e){showError(e);}finally{$('send').disabled=false;}};
$('stop').onclick=()=>call('stop',{sessionId:selected}).then(poll).catch(showError);
document.addEventListener('visibilitychange',()=>{if(!document.hidden){if(socket?.readyState!==1)connect();else poll().catch(showError);}});
setInterval(()=>poll().catch(showError),1200);
const request=indexedDB.open('nodo-remote',1);request.onupgradeneeded=()=>request.result.createObjectStore('device');request.onsuccess=async()=>{db=request.result;device=await vault('read');if($('confirm-pair'))$('confirm-pair').disabled=false;connect();};request.onerror=()=>showError(Error('Safari storage unavailable'));
if(needsPairConfirmation){
 const landing=document.createElement('section');landing.id='pair-landing';
 const message=document.createElement('p');message.textContent='Если QR открылся в сканере iPhone, сначала нажми значок Safari внизу. Уже в Safari нажми кнопку ниже. Не подключайся внутри сканера.';
 const button=document.createElement('button');button.id='confirm-pair';button.textContent='Я в Safari — подключить iPhone';button.disabled=!db;
 button.onclick=()=>{if(!db){showError(Error('Хранилище ещё загружается. Попробуй через секунду.'));return;}pairConfirmed=true;history.replaceState(null,'',location.pathname);landing.remove();connect();};
 landing.append(message,button);$('error').before(landing);status('Открой в Safari');
}
if(!needsPairConfirmation&&'serviceWorker'in navigator)navigator.serviceWorker.register('/sw.js').catch(()=>{});
