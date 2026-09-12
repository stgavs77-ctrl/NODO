import catalog from './catalog.json';
export default {async fetch(request,env,ctx){
 const url=new URL(request.url);if(request.method!=='GET'&&request.method!=='HEAD')return new Response(null,{status:405});
 if(url.pathname==='/health')return Response.json({service:'nodo-updates',bytes:catalog.bytes,parts:catalog.parts.length});
 if(catalog.parts.includes(url.pathname)){const r=await env.ASSETS.fetch(new Request(request,{headers:{'Accept-Encoding':'identity'}}));return new Response(r.body,{status:r.status,headers:{'Content-Type':'application/octet-stream','Cache-Control':'public, max-age=31536000, immutable','X-Content-Type-Options':'nosniff'}});}
 if(url.pathname==='/manifest.json'||url.pathname==='/release-notes.md'){
  const asset=await env.ASSETS.fetch(request);const res=new Response(asset.body,asset);res.headers.set('Cache-Control','no-store');res.headers.set('X-Content-Type-Options','nosniff');return res;
 }
 if(url.pathname!==catalog.path)return new Response('NODO signed updates',{status:404});
 const headers={'Content-Type':'application/zip','Content-Length':String(catalog.bytes),'Cache-Control':'public, max-age=31536000, immutable','X-Content-Type-Options':'nosniff'};
 if(request.method==='HEAD')return new Response(null,{headers});
 // Native stream piping avoids copying a large package through JavaScript.
 const stream=new TransformStream();
 const pump=(async()=>{try{
  for(const part of catalog.parts){
   const response=await env.ASSETS.fetch(new Request(url.origin+part,{headers:{'Accept-Encoding':'identity'}}));
   if(!response.ok||!response.body)throw Error('Release part unavailable');
   await response.body.pipeTo(stream.writable,{preventClose:true});
  }
  await stream.writable.getWriter().close();
 }catch(error){await stream.writable.abort(error).catch(()=>{});}})();
 ctx.waitUntil(pump);
 return new Response(stream.readable,{headers});
}};
