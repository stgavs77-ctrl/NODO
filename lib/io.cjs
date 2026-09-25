const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const crypto=require('node:crypto');
// Atomic, durable write: unique temp file (concurrent writers never share it), fsync, rename.
function save(file,value){fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});const tmp=file+'.'+process.pid+'.'+crypto.randomBytes(4).toString('hex')+'.tmp';
 try{const fd=fs.openSync(tmp,'w',0o600);try{fs.writeSync(fd,JSON.stringify(value,null,2));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(tmp,file);}
 catch(e){try{fs.unlinkSync(tmp);}catch{}throw e;}}
// A file that exists but does not parse is moved aside as <file>.corrupt-<time> when the caller
// supplied a fallback, so one damaged file cannot stop startup. Without a fallback it still throws.
function read(file,fallback){let raw;try{raw=fs.readFileSync(file,'utf8');}catch(e){if(e.code==='ENOENT')return fallback;throw e;}
 try{return JSON.parse(raw);}catch(e){if(fallback===undefined)throw e;const aside=file+'.corrupt-'+new Date().toISOString().replace(/[:.]/g,'-');try{fs.renameSync(file,aside);}catch{}console.warn('NODO: unreadable JSON moved aside: '+aside);return fallback;}}
function rpc(socketPath,method,params={},timeout=30000){return new Promise((resolve,reject)=>{const req=http.request({socketPath,path:'/',method:'POST',headers:{'Content-Type':'application/json'}},res=>{res.setEncoding('utf8');let body='';res.on('data',d=>body+=d);res.on('end',()=>{try{const v=JSON.parse(body);v.error?reject(Error(v.error)):resolve(v.result);}catch(e){reject(e);}});});req.setTimeout(timeout,()=>req.destroy(Error(method+' timed out')));req.on('error',reject);req.end(JSON.stringify({method,params}));});}
function serve(socketPath,handler){const server=http.createServer(async(req,res)=>{try{if(req.method!=='POST')throw Error('POST required');req.setEncoding('utf8');let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>24*1024*1024)throw Error('Request too large');}const {method,params}=JSON.parse(body);const result=await handler(method,params||{});res.setHeader('Content-Type','application/json');res.end(JSON.stringify({result:result??null}));}catch(e){res.statusCode=400;res.end(JSON.stringify({error:e.message}));}});server.listen(socketPath,()=>fs.chmodSync(socketPath,0o600));return server;}
module.exports={save,read,rpc,serve};
