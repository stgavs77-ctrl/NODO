// Runs only in the restored legacy bundle. The archived application is unchanged.
const path=require('node:path');
const fs=require('node:fs');
const cp=require('node:child_process');
const resources=path.resolve(__dirname,'..');
const project=JSON.parse(fs.readFileSync(path.join(resources,'rc-location.json'),'utf8')).root;
const dshBin=path.join(project,'runtime/node_modules/@deepseek-ai/dsh/lib/bin.js');
const originalSpawn=cp.spawn;
cp.spawn=function(binary,args,options){
 if(Array.isArray(args)&&typeof args[0]==='string'&&path.resolve(args[0])===dshBin){
  args=[...args];
  // Legacy uses the web command alias; explicit profile accepts the final overlay.
  if(args[1]==='web')args.splice(1,1,'--profile','web');
  // Launcher flags must precede the web application's --host/--port flags.
  if(args[1]!=='--profile'||args[2]!=='web')throw Error('Unsupported legacy DSH launch');
  args.splice(3,0,'--patch',path.join(resources,'legacy-overlay.json'));
  const bundledNode=path.join(project,'runtime/node');
  if(fs.existsSync(bundledNode))binary=bundledNode;
 }
 return Reflect.apply(originalSpawn,this,[binary,args,options]);
};
require(path.join(resources,'legacy.asar','main.cjs'));
