const test=require('node:test'),assert=require('node:assert/strict'),v=require('../lib/remote-view.cjs');
test('phone DTO retains native titles and text, strips tool/context/filesystem data',()=>{
 assert.deepEqual(v.sessions({items:[{sessionId:'s',cwd:'/private',projections:{values:{title:'Native title',contextBreakdown:'private'}}}]}),{items:[{sessionId:'s',title:'Native title',running:undefined,updatedAt:undefined}]});
 const out=v.session({records:[{event:{type:'tool/result',data:{secret:'private'}}},{event:{type:'assistant/message',data:{stream:[['text','Answer'],['tool','private']]}}},{event:{type:'user/message',data:{content:[{type:'text',text:'Hello'},{type:'image',path:'/private'}]}}}],assistantStream:{activeAttempt:{stream:[['text','Live'],['reasoning','private']]}}});
 assert.equal(out.records.length,2);assert.equal(out.records[0].event.data.content[0].text,'Answer');assert(!JSON.stringify(out).includes('private'));assert.deepEqual(out.assistantStream.activeAttempt.stream,[['text','Live']]);
});
