'use strict';
// DSH sandbox-local's supported custom runner protocol. The launching Electron
// process has already installed Seatbelt; macOS forbids a second sandbox_init.
// Shell writes remain confined to DEV data by that inherited OS sandbox.
const fs=require('node:fs'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const PREFIX='NODO_OUTER_SANDBOX_FAILURE:';
function validate(args,env,platform=process.platform,realpath=fs.realpathSync){
 if(platform!=='darwin'||env.NODO_ISOLATED!=='1'||env.NODO_OUTER_SANDBOX!=='1')throw Error('trusted isolated Seatbelt launch required');
 const root=realpath(env.RC_WORKSPACE||'');
 if(!path.isAbsolute(root))throw Error('absolute workspace required');
 const expected=['--ro-bind','/','/','--dev','/dev','--unshare-pid','--proc','/proc','--die-with-parent','--tmpfs','/tmp','--bind',root,root,'--'];
 // Reject read-only, changed profiles, extra grants and arbitrary runner flags.
 if(!expected.every((part,i)=>part===args[i])||args.length<=expected.length)throw Error('unsupported profile or workspace; only workspace-write is supported');
 return args.slice(expected.length);
}
function verifyInheritedSandbox(probe=spawnSync){
 const result=probe('/usr/bin/sandbox-exec',['-p','(version 1)(allow default)','/usr/bin/true'],{encoding:'utf8',timeout:5000});
 if(result.status!==71 && result.status!==1)throw Error('inherited Seatbelt confinement not verified');
 if(!/sandbox(?:_apply|_init): Operation not permitted/.test(result.stderr||''))throw Error('inherited Seatbelt confinement not verified');
}
module.exports={validate,verifyInheritedSandbox};
if(require.main===module){try{
 const argv=validate(process.argv.slice(2),process.env);verifyInheritedSandbox();
 const child=spawnSync(argv[0],argv.slice(1),{stdio:'inherit',env:process.env});
 if(child.error)throw Error('child launch failed');
 if(child.signal){process.kill(process.pid,child.signal);}else process.exitCode=child.status??1;
}catch(error){console.error(PREFIX+' '+error.message);process.exitCode=125;}}
