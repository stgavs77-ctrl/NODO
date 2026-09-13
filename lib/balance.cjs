// Contract: https://api-docs.deepseek.com/api/get-user-balance/
// Secrets are acquired on the backend and never retained in observable state.
class DeepSeekBalance {
 constructor({getKey,fetchImpl=globalThis.fetch,onChange=()=>{},now=()=>new Date().toISOString(),provider='deepseek',model=null}={}){this.getKey=getKey;this.fetch=fetchImpl;this.onChange=onChange;this.now=now;this.provider=provider;this.model=model;this.value={status:'unknown',balances:null,isAvailable:null,updatedAt:null,error:null};}
 // The snapshot always carries a resolved indicator, so the header slot can
 // render a provider-aware value even before the first successful fetch.
 snapshot(){const value=structuredClone(this.value);const entry=PROVIDERS[String(this.provider).toLowerCase()]||null;const model=typeof this.model==='function'?this.model():this.model;const indicator=indicatorFor({provider:this.provider,model,status:value.status,balances:value.balances,limits:this.limits||null,error:value.error});return{...value,provider:String(this.provider).toLowerCase(),providerLabel:entry?entry.label:String(this.provider),model:model||null,indicator,limits:this.limits||null};}
 start(){this.stop();void this.refresh();this.timer=setInterval(()=>void this.refresh(),60000);this.timer.unref?.();}
 stop(){clearInterval(this.timer);}
 afterTurn(){return this.refresh();}
 refresh(){if(this.pending)return this.pending;this.pending=this.load().finally(()=>{this.pending=null;});return this.pending;}
 async load(){try{const key=await this.getKey();if(!key)throw Error('credentials');const response=await this.fetch('https://api.deepseek.com/user/balance',{method:'GET',headers:{Authorization:'Bearer '+key,Accept:'application/json'},signal:AbortSignal.timeout(12000),redirect:'error'});if(!response.ok)throw Error('HTTP '+response.status);const body=await response.json();if(typeof body.is_available!=='boolean'||!Array.isArray(body.balance_infos)||!body.balance_infos.length)throw Error('invalid-response');const balances=body.balance_infos.map(x=>{if(!/^[A-Z]{3}$/.test(x.currency)||!['total_balance','granted_balance','topped_up_balance'].every(k=>typeof x[k]==='string'&&/^-?\d+(\.\d+)?$/.test(x[k])))throw Error('invalid-response');return{currency:x.currency,total:x.total_balance,granted:x.granted_balance,toppedUp:x.topped_up_balance};});this.value={status:'current',balances,isAvailable:body.is_available,updatedAt:this.now(),error:null};}catch(e){const safe=/^HTTP \d{3}$/.test(e.message)?e.message:e.message==='credentials'?'Credentials unavailable':'Balance temporarily unavailable';this.value={...this.value,status:this.value.updatedAt?'stale':'unavailable',error:safe};}this.onChange();return this.snapshot();}
}


// ---------------------------------------------------------------------------
// Provider registry for the header indicator.
//
// kind 'balance'  -> money: a real account balance is fetched and shown.
// kind 'credits'  -> credits: prepaid credit remaining, not cash.
// kind 'usage'    -> limits: no balance API; usage and limits are shown.
// kind 'local'    -> local endpoint: nothing to bill, the indicator says so.
//
// URLs are only ever opened through the app shell and only when https.
const PROVIDERS={
 deepseek:{label:'DeepSeek',short:'DS',kind:'balance',billing:'https://platform.deepseek.com/top_up',usage:'https://platform.deepseek.com/usage'},
 openai:{label:'OpenAI',short:'OAI',kind:'credits',billing:'https://platform.openai.com/settings/organization/billing/overview',usage:'https://platform.openai.com/usage'},
 anthropic:{label:'Anthropic',short:'AN',kind:'credits',billing:'https://console.anthropic.com/settings/billing',usage:'https://console.anthropic.com/settings/usage'},
 google:{label:'Google AI',short:'G',kind:'credits',billing:'https://aistudio.google.com/app/apikey',usage:'https://console.cloud.google.com/apis/dashboard'},
 xai:{label:'xAI',short:'xAI',kind:'usage',billing:'https://console.x.ai/team/default/billing',usage:'https://console.x.ai/team/default/usage'},
 openrouter:{label:'OpenRouter',short:'OR',kind:'credits',billing:'https://openrouter.ai/credits',usage:'https://openrouter.ai/activity'},
 local:{label:'Local model',short:'local',kind:'local',billing:null,usage:null}
};
const money=(v)=>({USD:'$',CNY:'¥',EUR:'€',GBP:'£',JPY:'¥'}[v.currency]||v.currency+' ')+v.total;
function indicatorFor({provider='deepseek',model=null,status='unknown',balances=null,limits=null,error=null}={}){
 const entry=PROVIDERS[String(provider).toLowerCase()]||{label:String(provider),short:String(provider).slice(0,3).toUpperCase(),kind:'usage',billing:null,usage:null};
 const base={provider:entry.label,model:model||null,kind:entry.kind,url:null,action:null,compact:'—',title:'Показатель ещё не получен'};
 if(entry.kind==='local')return{...base,kind:'local',compact:'локально',title:'Локальная модель: биллинга у провайдера нет'};
 if(entry.kind==='balance'){
  if(Array.isArray(balances)&&balances.length){
   const compact=balances.map(money).join(' / ');
   return{...base,url:entry.billing,action:'пополнить',compact,title:'Баланс аккаунта: '+balances.map(v=>money(v)+' '+v.currency).join(' / ')};
  }
  return{...base,kind:'unavailable',url:entry.usage,action:'usage',compact:'нет данных',title:error?('Баланс недоступен: '+error):'Баланс недоступен: провайдер не ответил'};
 }
 if(limits&&(limits.used!==undefined||limits.total!==undefined)){
  const compact=(limits.used??'?')+'/'+(limits.total??'?');
  return{...base,url:entry.usage,action:'лимиты',compact,title:'Использование/лимиты: '+compact+(limits.resetsAt?(' · reset '+limits.resetsAt):'')};
 }
 if(entry.kind==='credits')return{...base,kind:'credits',url:entry.billing,action:'кредиты',compact:'кредиты',title:'Кредиты: точный остаток этот API провайдера не отдаёт'};
 return{...base,kind:'usage',url:entry.usage,action:'usage',compact:'usage',title:'Провайдер по лимитам: usage и лимиты, денежного баланса в API нет'};
}
module.exports={DeepSeekBalance,PROVIDERS,indicatorFor};
