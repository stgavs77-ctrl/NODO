// Contract: https://api-docs.deepseek.com/api/get-user-balance/
// Secrets are acquired on the backend and never retained in observable state.
class DeepSeekBalance {
 constructor({getKey,fetchImpl=globalThis.fetch,onChange=()=>{},now=()=>new Date().toISOString()}){this.getKey=getKey;this.fetch=fetchImpl;this.onChange=onChange;this.now=now;this.value={status:'unknown',balances:null,isAvailable:null,updatedAt:null,error:null};}
 snapshot(){return structuredClone(this.value);}
 start(){this.stop();void this.refresh();this.timer=setInterval(()=>void this.refresh(),60000);this.timer.unref?.();}
 stop(){clearInterval(this.timer);}
 afterTurn(){return this.refresh();}
 refresh(){if(this.pending)return this.pending;this.pending=this.load().finally(()=>{this.pending=null;});return this.pending;}
 async load(){try{const key=await this.getKey();if(!key)throw Error('credentials');const response=await this.fetch('https://api.deepseek.com/user/balance',{method:'GET',headers:{Authorization:'Bearer '+key,Accept:'application/json'},signal:AbortSignal.timeout(12000),redirect:'error'});if(!response.ok)throw Error('HTTP '+response.status);const body=await response.json();if(typeof body.is_available!=='boolean'||!Array.isArray(body.balance_infos)||!body.balance_infos.length)throw Error('invalid-response');const balances=body.balance_infos.map(x=>{if(!/^[A-Z]{3}$/.test(x.currency)||!['total_balance','granted_balance','topped_up_balance'].every(k=>typeof x[k]==='string'&&/^-?\d+(\.\d+)?$/.test(x[k])))throw Error('invalid-response');return{currency:x.currency,total:x.total_balance,granted:x.granted_balance,toppedUp:x.topped_up_balance};});this.value={status:'current',balances,isAvailable:body.is_available,updatedAt:this.now(),error:null};}catch(e){const safe=/^HTTP \d{3}$/.test(e.message)?e.message:e.message==='credentials'?'Credentials unavailable':'Balance temporarily unavailable';this.value={...this.value,status:this.value.updatedAt?'stale':'unavailable',error:safe};}this.onChange();return this.snapshot();}
}
module.exports={DeepSeekBalance};
