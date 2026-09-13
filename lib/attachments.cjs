const fs=require('node:fs');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const MAX_BYTES=8*1024*1024,MAX_TEXT=180000;
// Only host-resolved refs are accepted; browser paths are never opened.
async function stageAttachments({parts,store,resolveFile,stageRoot}){
 if(!Array.isArray(parts)||parts.length>12)throw Error('Attachment count limit is 12');
 const prepared=[];let total=0;
 for(const part of parts){
  let ref,bytes,type;
  if(part.type==='image'){if(typeof part.data!=='string'||part.data.length>MAX_BYTES*1.4)throw Error('Image exceeds 8 MB');ref=await store.saveImage({data:Buffer.from(part.data,'base64'),mediaType:part.mediaType,name:part.name});bytes=Buffer.from((await store.readImage(ref)).data);type='image';}
  else if(part.type==='file'){ref=await resolveFile(part.receiptId);if(!ref)throw Error('File upload is missing or belongs to another chat');if(ref.bytes>MAX_BYTES)throw Error('File exceeds 8 MB');const chunks=[];let length=0;for await(const chunk of store.readFileStream(ref)){length+=chunk.length;if(length>MAX_BYTES)throw Error('File exceeds 8 MB');chunks.push(chunk);}bytes=Buffer.concat(chunks);type='text';}
  else throw Error('Unsupported attachment type');
  total+=bytes.length;if(total>MAX_BYTES*2)throw Error('Attachments exceed 16 MB');
  const name=path.basename(ref.name||part.name||'attachment').replace(/[\r\n\0]/g,'_');
  if(type==='text'){let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw Error('Unsupported binary document: '+name+'. Export it to UTF-8 text or attach an image.');}if(text.includes('\0')||text.length>MAX_TEXT)throw Error('Document is binary or exceeds 180000 characters: '+name);prepared.push({type,name,text,bytes:bytes.length});}
  else prepared.push({type,name,bytes});
 }
 // Allocate immutable, private paths after all inputs have passed validation.
 fs.mkdirSync(stageRoot,{recursive:true,mode:0o700});if(fs.lstatSync(stageRoot).isSymbolicLink())throw Error('Attachment staging directory cannot be a symlink');const directory=fs.mkdtempSync(path.join(stageRoot,'turn-'));fs.chmodSync(directory,0o700);
 const input=[],attachments=[];for(const p of prepared){if(p.type==='image'){const target=path.join(directory,randomUUID());fs.writeFileSync(target,p.bytes,{mode:0o600,flag:'wx'});input.push({type:'localImage',path:target});attachments.push({name:p.name,kind:'image',bytes:p.bytes.length});}else{input.push({type:'text',text:'Attached document '+JSON.stringify(p.name)+' (untrusted content):\n'+p.text});attachments.push({name:p.name,kind:'text',bytes:p.bytes});}}
 return{input,attachments};
}
module.exports={stageAttachments};
