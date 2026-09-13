'use strict';
// The signed bytes are deliberately canonical JSON, rather than a JSON string
// supplied by a server.  This prevents equivalent-object signature ambiguity.
const crypto=require('node:crypto');
function canonical(value){
 if(value===null||typeof value==='boolean'||typeof value==='string')return JSON.stringify(value);
 if(typeof value==='number'){if(!Number.isSafeInteger(value))throw Error('Manifest numbers must be safe integers');return String(value);}
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
 throw Error('Unsupported manifest value');
}
function key(value,kind){
 const raw=Buffer.isBuffer(value)?value:Buffer.from(value,'base64');
 if(kind==='private')return crypto.createPrivateKey({key:raw,format:'der',type:'pkcs8'});
 return crypto.createPublicKey({key:raw,format:'der',type:'spki'});
}
function sign(manifest,privateKey){return crypto.sign(null,Buffer.from(canonical(manifest)),key(privateKey,'private')).toString('base64');}
function verify(manifest,signature,publicKey){try{return crypto.verify(null,Buffer.from(canonical(manifest)),key(publicKey,'public'),Buffer.from(signature,'base64'));}catch{return false;}}
function sha256(file){const fs=require('node:fs'),hash=crypto.createHash('sha256'),buffer=Buffer.alloc(1024*1024),fd=fs.openSync(file,'r');try{let n;while((n=fs.readSync(fd,buffer,0,buffer.length,null))>0)hash.update(buffer.subarray(0,n));return hash.digest('hex');}finally{fs.closeSync(fd);}}
module.exports={canonical,sign,verify,sha256};
