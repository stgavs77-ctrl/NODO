const {spawn}=require('node:child_process');
const {EventEmitter}=require('node:events');
const path=require('node:path');
const {sandboxArgs}=require('./environment.cjs');
function codexEnvironment(data,source=process.env){
 // Start from a small process environment, not the launching agent's secrets,
 // config overrides, plugin paths, IPC sockets or authorization locations.
 const env={};for(const k of ['PATH','HOME','USER','LOGNAME','SHELL','LANG','LC_ALL','LC_CTYPE','TZ','TERM','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy','all_proxy','no_proxy','SSL_CERT_FILE','SSL_CERT_DIR'])if(source[k]!==undefined)env[k]=source[k];
 env.CODEX_HOME=path.join(data,'codex');env.TMPDIR=path.join(data,'tmp');return env;
}
class Codex extends EventEmitter{
 constructor(root,data){super();this.root=root;this.data=data;this.pending=new Map();this.seq=0;this.ready=false;this.lastError=null;this.models=[];this.account=null;this.stopped=false;this.restarts=0;this.restartTimer=null;}
 async start(){
  const env=codexEnvironment(this.data);
  const launch=sandboxArgs({data:this.data,isolated:process.env.NODO_ISOLATED==='1'},path.join(this.root,'runtime/codex'),['app-server','--listen','stdio://']);
  this.stopped=false;clearTimeout(this.restartTimer);this.restartTimer=null;
  const child=this.child=spawn(launch.bin,launch.args,{cwd:path.join(this.data,'workspace'),env,stdio:['pipe','pipe','pipe']});
  // Decode as a stream so multibyte UTF-8 (Cyrillic) split across chunks stays intact.
  child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
  let buffer='';child.stdout.on('data',d=>{buffer+=d;let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);try{this.message(JSON.parse(line));}catch(e){this.lastError=e.message;}}});
  child.stderr.on('data',s=>{if(/"level":"ERROR"|^error:/im.test(s))this.lastError=s.slice(-1000);});
  // Events from a replaced child must not fail the current one.
  child.on('error',e=>{if(this.child===child)this.fail(e.message);});child.on('exit',code=>{if(this.child===child)this.fail('Codex runtime exited: '+code);});
  try{this.info=await this.request('initialize',{clientInfo:{name:'deepseek_harness_rc',title:'NODO',version:'0.1.0'},capabilities:{experimentalApi:true}},30000);}
  catch(e){if(this.child===child){child.kill('SIGTERM');this.fail(e.message);}throw e;}
  this.send({method:'initialized'});this.ready=true;this.restarts=0;await this.refresh();return this;
 }
 send(value){if(!this.child||this.child.stdin.destroyed)throw Error('Codex runtime unavailable');this.child.stdin.write(JSON.stringify(value)+'\n');}
 request(method,params={},timeout=30000){return new Promise((resolve,reject)=>{const id=++this.seq;const timer=setTimeout(()=>{this.pending.delete(id);reject(Error(method+' timed out'));},timeout);this.pending.set(id,{resolve,reject,timer});try{this.send({id,method,params});}catch(e){clearTimeout(timer);this.pending.delete(id);reject(e);}});}
 message(m){if(m.id!==undefined&&!m.method){const p=this.pending.get(m.id);if(p){clearTimeout(p.timer);this.pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}return;}if(m.method)this.emit('event',m);}
 fail(message){this.ready=false;this.lastError=message;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(Error(message));}this.pending.clear();this.emit('offline',message);this.scheduleRestart();}
 // Restart after an unexpected exit with backoff (2s, 4s … 60s), at most 8 tries until a start succeeds.
 scheduleRestart(){if(this.stopped||this.restartTimer||this.restarts>=8)return;const delay=Math.min(60000,2000*2**this.restarts++);this.restartTimer=setTimeout(()=>{this.restartTimer=null;if(this.stopped)return;this.start().then(()=>this.emit('restarted')).catch(e=>{this.lastError=e.message;});},delay);this.restartTimer.unref?.();}
 async refresh(){const a=await this.request('account/read',{refreshToken:false});this.account=a.account;const models=[];if(this.account?.type==='chatgpt'){let cursor;do{const r=await this.request('model/list',{includeHidden:false,limit:100,...cursor?{cursor}:{}});models.push(...r.data.filter(x=>!x.hidden));cursor=r.nextCursor;}while(cursor);}this.models=[...new Map(models.map(m=>[m.model,m])).values()];this.lastError=null;return this.status();}
 status(){return{ready:this.ready,account:this.account?{type:this.account.type,planType:this.account.planType,email:this.account.email}:null,models:this.models,lastError:this.lastError,pid:this.child?.pid,version:'0.151.0'};}
 async login(){return this.request('account/login/start',{type:'chatgpt'});}
 validate(model,effort){if(this.account?.type!=='chatgpt')throw Error('Connect Codex using ChatGPT login first');const found=this.models.find(m=>m.model===model);if(!found)throw Error('Selected Codex model is unavailable; refresh models and choose explicitly');if(!found.supportedReasoningEfforts.some(e=>e.reasoningEffort===effort))throw Error('Selected reasoning is unavailable for '+model);}
 stop(){this.stopped=true;clearTimeout(this.restartTimer);this.restartTimer=null;this.child?.kill('SIGTERM');}
}
module.exports={Codex,codexEnvironment};
