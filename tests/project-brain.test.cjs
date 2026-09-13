const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const {ProjectBrain}=require('../lib/project-brain.cjs');const {route}=require('../lib/auto-router.cjs');
test('Brain persists, retrieves across sessions, isolates workspaces and honors exclusions',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nodo-brain-test-'));const b=new ProjectBrain(dir);
 const e=b.mutate('/project/a','entries','save',{text:'Apollo uses SQLite for storage',type:'technical',pinned:true});
 b.mutate('/project/a','rules','save',{text:'Never modify original vocals',scope:'REAPER',enabled:true,priority:80});
 assert.equal(b.select('/project/a','session1','Apollo storage').included.length,1);
 const fresh=new ProjectBrain(dir);assert.equal(fresh.select('/project/a','session2','Apollo').included[0].id,e.id);
 assert.equal(fresh.select('/project/b','session3','Apollo').included.length,0);
 assert.equal(fresh.select('/project/a','session2','Apollo',{exclude:[e.id]}).included.length,0);
 assert.equal(fresh.select('/project/a','session2','REAPER vocals').included.some(x=>x.kind==='rule'),true);
});
test('Brain undo only changes own action state; history untouched; correction requires approval',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nodo-brain-undo-'));fs.writeFileSync(path.join(dir,'session.json'),'history');const b=new ProjectBrain(dir);
 const e=b.mutate('/project','entries','save',{text:'Original',type:'note'});b.mutate('/project','entries','save',{...e,text:'Changed'});b.undo('/project',b.list('/project').timeline[0].id);
 assert.equal(b.list('/project').entries[0].text,'Original');assert.equal(fs.readFileSync(path.join(dir,'session.json'),'utf8'),'history');
 assert.equal(b.correction('Так больше не делай, используй Browser').requiresConfirmation,true);assert.equal(b.list('/project').rules.length,0);assert.equal(b.correction('Привет'),null);
});
test('AUTO routes coding only to available configured Codex; never grants capabilities',()=>{
 assert.equal(route({text:'Implement repo bug fix',codexReady:true,choice:{model:'configured',effort:'medium'}}).agent,'Codex');
 assert.equal(route({text:'Составь список покупок',codexReady:true,choice:{model:'configured',effort:'medium'}}).agent,'DeepSeek');
 const unavailable=route({text:'Implement repo bug fix',codexReady:false});assert.equal(unavailable.agent,'DeepSeek');assert.equal(unavailable.permissionChange,false);
});
