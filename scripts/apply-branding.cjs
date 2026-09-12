// Deterministic second build stage. Base hashes pin the already UI-patched
// dependency files. All surfaces consume the same generated vector sources.
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const root=path.resolve(process.argv[2]||path.join(__dirname,'..'));
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
const manifest=JSON.parse(fs.readFileSync(path.join(root,'patches/branding.json')));
const symbol=fs.readFileSync(path.join(root,'assets/nodo-symbol.svg'),'utf8'),lockup=fs.readFileSync(path.join(root,'assets/nodo-lockup.svg'),'utf8');
const uri=s=>'data:image/svg+xml;base64,'+Buffer.from(s).toString('base64');
const appliedPath=path.join(root,'patches/branding.applied.json'),prior=fs.existsSync(appliedPath)?JSON.parse(fs.readFileSync(appliedPath)):null;
const assetHash=hash(symbol+lockup),changes=[];
for(const entry of manifest.files){const file=path.join(root,'runtime',entry.file),source=fs.readFileSync(file,'utf8');
 if(prior?.assetHash===assetHash&&prior.files[entry.file]===hash(source))continue;
 if(hash(source)!==entry.sha256)throw Error('Branding upstream changed: '+entry.file);
 let result=source;
 if(entry.file.endsWith('favicon.svg'))result=symbol;
 else {let matches=0;result=result.replace(/data:image\/svg\+xml;base64,([A-Za-z0-9+/=]+)/g,(whole,b64)=>{const svg=Buffer.from(b64,'base64').toString('utf8');if(!svg.includes('#7A9CBF')&&!svg.includes('NODO HARNESS'))return whole;matches++;return uri(svg.includes('HARNESS')?lockup:symbol);});if(!matches)throw Error('Branding anchor missing: '+entry.file);result=result.replaceAll(uri(lockup)+'", width:192',uri(lockup)+'", width:148');}
 changes.push({entry,file,result});
}
for(const {file,result}of changes)fs.writeFileSync(file,result);
// Keep --check valid inside the shipped app after deterministic brand changes.
const uiFile=path.join(root,'patches/ui.json'),ui=JSON.parse(fs.readFileSync(uiFile));for(const p of ui.patches){const source=fs.readFileSync(path.join(root,'runtime',p.file),'utf8'),offset=source.indexOf(p.insert);if(offset<0)throw Error('UI patch missing after branding: '+p.file);p.offset=offset;p.patchedHash=hash(source);p.originalHash=hash(source.slice(0,offset)+p.remove+source.slice(offset+p.insert.length));}fs.writeFileSync(uiFile,JSON.stringify(ui,null,2)+'\n');
fs.writeFileSync(appliedPath,JSON.stringify({assetHash,files:Object.fromEntries(manifest.files.map(e=>[e.file,hash(fs.readFileSync(path.join(root,'runtime',e.file)))]))},null,2));console.log('Unified branding: '+manifest.files.length+' pinned native surfaces');
