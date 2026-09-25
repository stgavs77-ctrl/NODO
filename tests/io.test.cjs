const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {save,read}=require('../lib/io.cjs');
test('save is atomic with unique temp files and leaves no temp behind',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nodo-io-')),file=path.join(dir,'state.json');
 for(let i=0;i<5;i++)save(file,{i});
 assert.deepEqual(read(file,null),{i:4});assert.deepEqual(fs.readdirSync(dir),['state.json']);
 assert.equal(fs.statSync(file).mode&0o777,0o600);fs.rmSync(dir,{recursive:true,force:true});
});
test('a corrupt JSON file is moved aside when a fallback exists and still throws without one',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nodo-io-')),file=path.join(dir,'tasks.json');
 fs.writeFileSync(file,'[{"status":"Run');assert.throws(()=>read(file));
 const warn=console.warn;console.warn=()=>{};try{assert.deepEqual(read(file,[]),[]);}finally{console.warn=warn;}
 const names=fs.readdirSync(dir);assert.equal(names.length,1);assert.match(names[0],/^tasks\.json\.corrupt-/);
 assert.equal(fs.readFileSync(path.join(dir,names[0]),'utf8'),'[{"status":"Run');
 assert.equal(read(file,'missing'),'missing');fs.rmSync(dir,{recursive:true,force:true});
});
