'use strict';
const crypto=require('node:crypto');
const secret=()=>crypto.randomBytes(32).toString('base64url');
function decode(key){const b=Buffer.from(key,'base64url');if(b.length!==32)throw Error('Invalid device key');return b;}
function seal(key,value,aad){
 const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',decode(key),iv);
 cipher.setAAD(Buffer.from(aad));const body=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);
 return {iv:iv.toString('base64url'),body:body.toString('base64url'),tag:cipher.getAuthTag().toString('base64url')};
}
function open(key,box,aad){
 if(!box||typeof box.body!=='string'||box.body.length>2*1024*1024)throw Error('Invalid encrypted frame');
 const iv=Buffer.from(box.iv||'','base64url'),tag=Buffer.from(box.tag||'','base64url');if(iv.length!==12||tag.length!==16)throw Error('Invalid encrypted frame');
 const cipher=crypto.createDecipheriv('aes-256-gcm',decode(key),iv);cipher.setAAD(Buffer.from(aad));cipher.setAuthTag(tag);
 return JSON.parse(Buffer.concat([cipher.update(Buffer.from(box.body,'base64url')),cipher.final()]).toString('utf8'));
}
// Store is a Keychain-backed encrypted vault supplied by the Electron main process.
// Pairing proof is never stored. A lost pairing response requires a fresh QR.
class Pairings{
 constructor({store,now=Date.now}){this.store=store;this.now=now;this.pending=null;this.devices=store.read()||[];this.channels=new Map();}
 begin(){this.pending={id:crypto.randomUUID(),key:secret(),expiresAt:this.now()+300000};return {...this.pending};}
 pair(pairingId,box){
  const p=this.pending;if(!p||p.id!==pairingId||p.expiresAt<=this.now())throw Error('Pairing expired');
  const request=open(p.key,box,'nodo-pair-v1:'+p.id);
  if(typeof request.name!=='string'||!request.name.trim()||request.name.length>80)throw Error('Invalid device name');
  const device={id:crypto.randomUUID(),name:request.name,key:secret(),createdAt:this.now()};
  const next=[...this.devices,device];if(next.length>16)throw Error('Paired device limit reached');
  this.store.write(next);this.devices=next;this.pending=null;
  return seal(p.key,{deviceId:device.id,key:device.key},'nodo-pair-result-v1:'+p.id);
 }
 list(){return this.devices.map(({key,...d})=>d);}
 revoke(id){const next=this.devices.filter(d=>d.id!==id);this.store.write(next);this.devices=next;for(const [key,c]of this.channels)if(c.deviceId===id)this.channels.delete(key);}
 reset(){this.store.write([]);this.devices=[];this.pending=null;this.channels.clear();}
 challenge(deviceId,channelId){
  if(!this.devices.some(d=>d.id===deviceId))throw Error('Device revoked or unknown');
  if(typeof channelId!=='string'||channelId.length>120||this.channels.size>=32)throw Error('Invalid channel');
  const challenge=secret();this.channels.set(channelId,{deviceId,challenge,seq:0,expiresAt:this.now()+3600000});return challenge;
 }
 accept(channelId,box){
  const c=this.channels.get(channelId),d=this.devices.find(d=>d.id===c?.deviceId);
  if(!c||!d||c.expiresAt<=this.now())throw Error('Channel expired');
  const request=open(d.key,box,'nodo-request-v1:'+channelId+':'+c.challenge);
  if(!Number.isSafeInteger(request.seq)||request.seq!==c.seq+1)throw Error('Replay or out-of-order request');
  c.seq=request.seq;return {request,respond:value=>seal(d.key,{seq:request.seq,...value},'nodo-response-v1:'+channelId+':'+c.challenge)};
 }
 disconnect(channelId){this.channels.delete(channelId);}
}
module.exports={Pairings,seal,open};
