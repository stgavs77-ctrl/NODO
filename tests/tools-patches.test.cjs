'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {createToolPolicy,NATIVE_TOOLS,EXTERNAL_TOOLS}=require('../lib/tool-policy.cjs');
const {prepare}=require('../scripts/prepare-patches.cjs');
const manifest=require('../patches/ui.json');
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
const {createProviderUsageHook}=require('../lib/provider-usage-hook.cjs');
test('inherited sandbox runner rejects markers, changed roots, read-only and absent confinement',()=>{
 const {validate,verifyInheritedSandbox}=require('../scripts/outer-sandbox-runner.cjs');
 const env={NODO_ISOLATED:'1',NODO_OUTER_SANDBOX:'1',RC_WORKSPACE:'/synthetic/workspace'};
 const argv=['--ro-bind','/','/','--dev','/dev','--unshare-pid','--proc','/proc','--die-with-parent','--tmpfs','/tmp','--bind','/synthetic/workspace','/synthetic/workspace','--','/usr/bin/true'];
 const identity=x=>x;
 assert.deepEqual(validate(argv,env,'darwin',identity),['/usr/bin/true']);
 assert.throws(()=>validate(argv,{...env,NODO_OUTER_SANDBOX:'0'},'darwin',identity));
 assert.throws(()=>validate(argv,{...env,RC_WORKSPACE:'/other'},'darwin',identity));
 assert.throws(()=>validate([...argv.slice(0,9),'--','true'],env,'darwin',identity));
 assert.throws(()=>verifyInheritedSandbox(()=>({status:0,stderr:''})));
 verifyInheritedSandbox(()=>({status:71,stderr:'sandbox-exec: sandbox_apply: Operation not permitted'}));
});
test('MCP mock initializes and discovers read-only probe without launching REAPER',async()=>{
 const sdk='../runtime/node_modules/@modelcontextprotocol/sdk/dist/cjs/';
 const {Client}=require(sdk+'client/index.js');
 const {Server}=require(sdk+'server/index.js');
 const {InMemoryTransport}=require(sdk+'inMemory.js');
 const {ListToolsRequestSchema,CallToolRequestSchema}=require(sdk+'types.js');
 const server=new Server({name:'synthetic-reaper',version:'test'},{capabilities:{tools:{}}});
 server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[{name:'probe',description:'Synthetic read-only probe',inputSchema:{type:'object',properties:{}}}]}));
 server.setRequestHandler(CallToolRequestSchema,async()=>({content:[{type:'text',text:'MOCK_ONLY'}]}));
 const client=new Client({name:'nodo-mock-test',version:'test'});
 const [a,b]=InMemoryTransport.createLinkedPair();
 try{
  await Promise.all([server.connect(b),client.connect(a)]);
  assert.equal(client.getServerVersion().name,'synthetic-reaper');
  assert.deepEqual((await client.listTools()).tools.map(t=>t.name),['probe']);
  assert.equal((await client.callTool({name:'probe',arguments:{}})).content[0].text,'MOCK_ONLY');
  assert.equal(createToolPolicy({NODO_ISOLATED:'1',NODO_ENABLE_REAPER:'1'}).permits('mcp__reaper__probe'),false);
 }finally{await client.close();await server.close();}
});
test('provider hook sends counters only after turn end and retries delivery without double counting',async()=>{
 const payloads=[];let fail=true;
 const hook=createProviderUsageHook(async p=>{payloads.push(p);if(fail)throw Error('offline');});
 const session={id:'synthetic-session'};
 await hook(session,{type:'assistant/message',seq:1,data:{message:{content:'PRIVATE'},usage:{inputTokens:5,outputTokens:8,cacheReadTokens:2,secret:'SECRET'}}});
 assert.equal(payloads.length,0);
 await hook(session,{type:'turn/end'});
 fail=false;await hook(session,{type:'turn/end'});
 assert.deepEqual(payloads[0],payloads[1]);
 assert(!JSON.stringify(payloads).includes('PRIVATE'));assert(!JSON.stringify(payloads).includes('SECRET'));
 await hook(session,{type:'turn/end'});
 assert.deepEqual(payloads[2].events,[]);
});
test('exact native policy permits planning tools but never wildcard native names',()=>{
 const p=createToolPolicy({NODO_ISOLATED:'1',NODO_ENABLE_REAPER:'1'});
 for(const name of NATIVE_TOOLS)assert.equal(p.guard({name}),undefined,name);
 for(const name of [...EXTERNAL_TOOLS,'job_delete','goal','todo','mcp__reaper__read','mcp__other__read'])assert.equal(typeof p.guard({name}),'string',name);
});
test('REAPER requires explicit non-isolated opt-in and only its namespace',()=>{
 assert.equal(createToolPolicy({}).permits('mcp__reaper__ping'),false);
 const p=createToolPolicy({NODO_ENABLE_REAPER:'1'});
 assert.equal(p.permits('mcp__reaper__ping'),true);
 assert.equal(p.permits('mcp__other__ping'),false);
 assert.equal(p.permits('mcp__reaper__'),false);
});
test('pinned patches restore clean source, apply reproducibly, repeat safely, reject drift atomically',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'nodo-patch-test-'));
 try{
  for(const p of manifest.patches){
   const patched=fs.readFileSync(path.resolve(__dirname,'../runtime',p.file),'utf8');
   assert.equal(sha(patched),p.patchedHash);
   const original=patched.slice(0,p.offset)+p.remove+patched.slice(p.offset+p.insert.length);
   assert.equal(sha(original),p.originalHash);
   fs.mkdirSync(path.dirname(path.join(root,p.file)),{recursive:true});
   fs.writeFileSync(path.join(root,p.file),original);
   fs.writeFileSync(path.join(root,'node_modules',p.package,'package.json'),JSON.stringify({version:p.version}));
  }
  assert(prepare(root,{check:true}).every(x=>x.status==='needs-patch'));
  assert(prepare(root).every(x=>x.status==='patched'));
  assert(prepare(root).every(x=>x.status==='already-patched'));
  const first=manifest.patches[0],second=manifest.patches[1];
  const a=fs.readFileSync(path.join(root,first.file),'utf8');
  const clean=a.slice(0,first.offset)+first.remove+a.slice(first.offset+first.insert.length);
  fs.writeFileSync(path.join(root,first.file),clean);
  fs.appendFileSync(path.join(root,second.file),'\n// changed');
  assert.throws(()=>prepare(root),/unknown source hash/);
  assert.equal(fs.readFileSync(path.join(root,first.file),'utf8'),clean);
  fs.writeFileSync(path.join(root,'node_modules',first.package,'package.json'),'{"version":"new"}');
  assert.throws(()=>prepare(root),/incompatible version/);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('composer diagnostics default off; throttle and focus recovery preserved',()=>{
 const chat=fs.readFileSync(path.resolve(__dirname,'../runtime',manifest.patches[0].file),'utf8');
 const composer=fs.readFileSync(path.resolve(__dirname,'../runtime',manifest.patches[1].file),'utf8');
 assert.match(chat,/NODO_STREAM_THROTTLE_MS = 80/);
 assert.match(composer,/if \(window\.__nodoComposerDiagnostics !== true\) return/);
 assert.match(composer,/root\.focus\(\{ preventScroll: true \}\)/);
});
