const {createGate,symbol}=require('../services/lifecycle-gate.cjs');
function lifecycleControl(ctx,isolated){
 const registry=globalThis[symbol]||(globalThis[symbol]=new Map());
 const gate=createGate('nodo-tools',{registry});let paused=false;
 const commands=ctx.sessionController.commands;
 if(!commands||typeof commands.prompt!=='function')throw Error('Pinned session controller admission gate unavailable');
 const original=commands.prompt;
 commands.prompt=function(...args){if(paused)throw Error('NODO is paused for a safe update');return original.apply(this,args);};
 const configured=process.env.NODO_OPTIONAL_SERVICES===undefined?['telegram-bridge','sessions-observer']:JSON.parse(process.env.NODO_OPTIONAL_SERVICES);
 if(!Array.isArray(configured)||configured.some(n=>!['telegram-bridge','sessions-observer'].includes(n)))throw Error('Invalid optional service inventory');
 const required=['nodo-tools',...(isolated?[]:configured)];
 const status=()=>({protocol:1,paused,activeTurns:ctx.agents.list().filter(a=>['running','queued','starting'].includes(a.status)).length,services:required.map(name=>registry.get(name)?.status()||{name,missing:true})});
 const activeAgents=()=>ctx.agents.list().filter(a=>['running','queued','starting'].includes(a.status)&&typeof a.session?.id==='string');
 const prepareQuit=()=>{paused=true;return {prepared:true,activeTurns:activeAgents().length};};
 const cancelActive=async()=>{prepareQuit();const agents=activeAgents();for(const agent of agents)await ctx.sessionController.cancel({sessionId:agent.session.id});return {prepared:true,cancelled:agents.map(agent=>agent.session.id)};};
 return {gate,status,get paused(){return paused;},
  prepareQuit,cancelActive,
  async pause(){paused=true;const missing=required.filter(n=>!registry.has(n));if(missing.length)throw Error('Lifecycle services missing: '+missing.join(', '));await Promise.all(required.map(n=>registry.get(n).pause()));const s=status();if(s.activeTurns!==0||s.services.some(x=>!x.drained))throw Error('Background work has not drained; code update forbidden');return s;},
  resume(){for(const n of required)registry.get(n)?.resume();paused=false;return status();},
  dispose(){commands.prompt=original;registry.delete('nodo-tools');}
 };
}
module.exports={lifecycleControl};
