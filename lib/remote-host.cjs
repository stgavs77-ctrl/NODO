'use strict';
const {Pairings}=require('./remote-pairing.cjs');
const WS=require('../runtime/node_modules/ws');
const encode=v=>Buffer.from(JSON.stringify(v)).toString('base64url');
const decode=v=>JSON.parse(Buffer.from(v,'base64url').toString('utf8'));
// No listening socket on the Mac. Relay config is local administrator data,
// never a URL supplied by a phone or web page. Disabled until configured.
class RemoteHost{
 constructor({config,store,call,power,onStatus=()=>{},WebSocket=WS}){
  Object.assign(this,{config,call,power,onStatus,WebSocket});this.pairings=new Pairings({store});this.enabled=false;this.failures=new Map();this.chains=new Map();this.connections=new Set();this.generation=0;
 }
 status(){return {configured:!!this.config?.url,enabled:this.enabled,status:!this.enabled?'Off':this.connections.size?'Connected':this.connected?'Available':'Reconnecting',devices:this.pairings.list(),connectedDevices:this.connections.size,keepAvailable:this.powerId!==undefined};}
 notify(){this.onStatus(this.status());}
 enable(){
  const c=this.config,u=new URL(c?.url||'https://unconfigured.invalid');
  if(!c?.url||u.protocol!=='wss:'||u.username||u.password||u.hash||u.search||!/^[-_a-zA-Z0-9]{20,128}$/.test(c.roomId||'')||!/^[-_a-zA-Z0-9]{32,128}$/.test(c.hostCredential||''))throw Error('Secure NODO relay is not configured');
  if(this.enabled)return;this.enabled=true;this.powerId=this.power.start('prevent-app-suspension');this.connect();this.notify();
 }
 connect(){
  if(!this.enabled)return;const generation=++this.generation;
  const socket=this.socket=new this.WebSocket(this.config.url,{headers:{Authorization:'Bearer '+this.config.hostCredential,Origin:new URL(this.config.webURL).origin},maxPayload:2*1024*1024,handshakeTimeout:15000});
  socket.on('open',()=>socket.send(JSON.stringify({type:'register',roomId:this.config.roomId})));
  socket.on('message',raw=>{
   if(!this.enabled||generation!==this.generation)return;
   try{const msg=JSON.parse(raw.toString());
    if(msg.type==='ready'){this.connected=true;this.notify();return;}
    if(msg.type==='phone_disconnected'){this.pairings.disconnect(msg.connectionId);this.connections.delete(msg.connectionId);this.chains.delete(msg.connectionId);this.failures.delete(msg.connectionId);this.notify();return;}
    if(msg.type!=='from_phone'||typeof msg.connectionId!=='string')return;
    const old=this.chains.get(msg.connectionId)||Promise.resolve();
    const next=old.then(()=>this.receive(msg.connectionId,decode(msg.frame))).catch(()=>{}).finally(()=>{if(this.chains.get(msg.connectionId)===next)this.chains.delete(msg.connectionId);});this.chains.set(msg.connectionId,next);
   }catch{/* Invalid transport frames do not reveal internal exception details. */}
  });
  socket.on('error',()=>{});
  socket.on('close',()=>{if(generation!==this.generation)return;this.connected=false;this.connections.clear();this.pairings.channels.clear();this.notify();if(this.enabled)this.timer=setTimeout(()=>this.connect(),2000);});
 }
 send(connectionId,frame){if(this.socket?.readyState===1)this.socket.send(JSON.stringify({type:'to_phone',connectionId,frame:encode(frame)}));}
 async receive(connectionId,frame){
  if(!this.enabled||(this.failures.get(connectionId)||0)>=5)return;
  try{
   if(frame.type==='pair'){this.send(connectionId,{type:'paired',box:this.pairings.pair(frame.pairingId,frame.box)});this.notify();return;}
   if(frame.type==='hello'){const challenge=this.pairings.challenge(frame.deviceId,connectionId);this.send(connectionId,{type:'challenge',challenge});return;}
   if(frame.type!=='request')throw Error('Unexpected frame');
   const {request,respond}=this.pairings.accept(connectionId,frame.box);
   this.connections.add(connectionId);this.notify();
   try{const result=await this.call(request.method,request.params||{});if(Buffer.byteLength(JSON.stringify(result))>750000)throw Error('Response exceeds mobile limit');this.send(connectionId,{type:'response',box:respond({result})});}
   catch{this.send(connectionId,{type:'response',box:respond({error:'Operation failed. Check NODO on the Mac; no automatic resend.'})});}
  }catch{this.failures.set(connectionId,(this.failures.get(connectionId)||0)+1);this.send(connectionId,{type:'rejected'});}
 }
 beginPairing(){if(!this.enabled||!this.connected)throw Error('Relay is not connected');const p=this.pairings.begin();const u=new URL(this.config.webURL);if(u.protocol!=='https:')throw Error('HTTPS mobile UI required');u.hash=new URLSearchParams({room:this.config.roomId,pair:p.id,secret:p.key}).toString();return {url:u.toString(),expiresAt:p.expiresAt};}
 revoke(id){this.pairings.revoke(id);this.connections.clear();this.notify();}
 reset(){this.pairings.reset();this.connections.clear();this.notify();}
 async disable(){this.enabled=false;++this.generation;clearTimeout(this.timer);this.socket?.close();this.connected=false;this.pairings.pending=null;this.pairings.channels.clear();this.connections.clear();if(this.powerId!==undefined){this.power.stop(this.powerId);this.powerId=undefined;}await Promise.allSettled([...this.chains.values()]);this.notify();}
}
module.exports={RemoteHost};
