'use strict';

const path=require('node:path');

const INLINE_MAX_BYTES=400*1024;

class RemoteMediaError extends Error{
 constructor(code,message){super(message);this.name='RemoteMediaError';this.code=code;}
}

function inside(root,target){return target===root||target.startsWith(root+path.sep);}
function card(descriptor){
 return {name:descriptor.name||path.basename(descriptor.path||''),mime:descriptor.mime||'application/octet-stream',size:descriptor.size??null,path:descriptor.path,kind:descriptor.kind||'unknown',format:descriptor.format||'unknown',status:descriptor.status,active:false,...(descriptor.reason?{reason:descriptor.reason}:{})};
}

class RemoteMedia{
 constructor({workspace,mediaPreview,maxInlineBytes=INLINE_MAX_BYTES}={}){
  if(typeof workspace!=='string'||!path.isAbsolute(workspace))throw new RemoteMediaError('WORKSPACE_REQUIRED','A selected absolute native workspace is required');
  if(!mediaPreview||typeof mediaPreview.inspect!=='function'||typeof mediaPreview.issue!=='function'||typeof mediaPreview.openToken!=='function'||typeof mediaPreview.revoke!=='function')throw new RemoteMediaError('PREVIEW_REQUIRED','A verified MediaPreview instance is required');
  if(!Number.isSafeInteger(maxInlineBytes)||maxInlineBytes<1)throw new RemoteMediaError('LIMIT_INVALID','Inline media limit must be positive');
  this.workspace=path.resolve(workspace);this.mediaPreview=mediaPreview;this.maxInlineBytes=maxInlineBytes;
 }
 async readRemoteMedia({workspace,filePath,path:legacyPath}={}){
  if(typeof workspace!=='string'||path.resolve(workspace)!==this.workspace)throw new RemoteMediaError('WORKSPACE_MISMATCH','Remote media workspace is not the selected native workspace');
  const requested=filePath??legacyPath;
  if(typeof requested!=='string'||!path.isAbsolute(requested))throw new RemoteMediaError('PATH_INVALID','Remote media path must be absolute');
  const target=path.resolve(requested);
  if(!inside(this.workspace,target))throw new RemoteMediaError('OUTSIDE_SELECTED_WORKSPACE','Remote media path is outside the selected native workspace');
  const descriptor=await this.mediaPreview.inspect(target);
  const result={status:descriptor.status,card:card(descriptor),...(descriptor.retryable?{retryable:true}:{})};
  if(descriptor.status!=='ready'||!['image','audio'].includes(descriptor.kind)||descriptor.size>this.maxInlineBytes)return result;
  const issued=await this.mediaPreview.issue(target);
  if(issued.status!=='ready'||!issued.token)return {status:issued.status,card:card(issued),...(issued.retryable?{retryable:true}:{})};
  try{
   const response=await this.mediaPreview.openToken(issued.token);
   const chunks=[];let total=0;
   for await(const chunk of response.stream){total+=chunk.length;if(total>this.maxInlineBytes)throw new RemoteMediaError('INLINE_LIMIT','Verified media exceeded inline limit');chunks.push(chunk);}
   return {...result,content:{encoding:'base64',mime:descriptor.mime,base64:Buffer.concat(chunks,total).toString('base64')}};
  }finally{this.mediaPreview.revoke(issued.token);}
 }
}

function createRemoteMedia(options){return new RemoteMedia(options);}

module.exports={RemoteMedia,RemoteMediaError,createRemoteMedia,INLINE_MAX_BYTES};
