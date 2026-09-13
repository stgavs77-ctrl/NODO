'use strict';
// The header indicator must stay visible and honest for every provider shape:
// money shows a real balance, credit providers say credits, metered providers
// report usage/limits, and an unreachable provider never renders as a number.
const test=require('node:test'),assert=require('node:assert');
const {indicatorFor,PROVIDERS}=require('../lib/balance.cjs');

test('balance provider shows the real amount and a top-up page',()=>{
 const i=indicatorFor({provider:'deepseek',status:'current',balances:[{currency:'USD',total:'10.19',granted:'0.00',toppedUp:'10.19'}]});
 assert.equal(i.kind,'balance');
 assert.equal(i.compact,'$10.19');
 assert.match(i.title,/Баланс аккаунта: \$10\.19 USD/);
 assert.match(i.url,/^https:\/\/platform\.deepseek\.com\//);
});
test('unreachable balance provider says so instead of showing $0',()=>{
 for(const status of ['unavailable','stale'])for(const error of [null,'HTTP 500','Balance temporarily unavailable']){
  const i=indicatorFor({provider:'deepseek',status,error});
  assert.equal(i.kind,'unavailable');
  assert.equal(i.compact,'нет данных');
  assert.doesNotMatch(i.compact,/\$0/);
  assert.match(i.url,/^https:\/\//);
 }
});
test('credit and metered providers are provider-aware',()=>{
 const credits=indicatorFor({provider:'openai'});
 assert.equal(credits.kind,'credits');assert.match(credits.title,/Кредиты/i);
 const metered=indicatorFor({provider:'xai',limits:{used:12,total:100}});
 assert.equal(metered.kind,'usage');assert.equal(metered.compact,'12/100');
 const local=indicatorFor({provider:'local'});
 assert.equal(local.kind,'local');assert.equal(local.url,null);
});
test('an unknown provider never invents a balance',()=>{
 const i=indicatorFor({provider:'acme'});
 assert.equal(i.kind,'usage');
 assert.equal(i.url,null);
 assert.equal(i.compact,'usage');
});
test('every configured link is an https provider page',()=>{
 for(const[key,entry]of Object.entries(PROVIDERS))for(const url of [entry.billing,entry.usage]){
  if(url===null){assert.equal(key,'local');continue;}
  assert.match(url,/^https:\/\//,key+' must use https');
 }
});
