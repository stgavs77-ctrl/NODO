// Compile the exact production inventory function and exercise it with real
// owned/unowned child PIDs; never signal any pre-existing process.
const fs=require('fs'),path=require('path'),os=require('os'),cp=require('child_process');
const source=fs.readFileSync(path.join(__dirname,'../rescue/Rescue.swift'),'utf8');
const fn=source.split('\n').filter(l=>l.startsWith('func processes(')||l.startsWith('func isOwnedUpdaterPID(')).join('\n');
const idle=source.slice(source.indexOf('func assertIdle('),source.indexOf('func status('));
if(!fn)throw Error('Production process inventory missing');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nodo-process-scope-'));
const swift=`import Foundation
var ownedCleanupProcesses:[Process]=[]
let fm=FileManager.default
func fail(_ text:String) throws -> Never {throw NSError(domain:text,code:1)}
func run(_ executable:String,_ args:[String]) throws -> (Int32,String) {let p=Process();p.executableURL=URL(fileURLWithPath:executable);p.arguments=args;let pipe=Pipe();p.standardOutput=pipe;try p.run();let data=pipe.fileHandleForReading.readDataToEndOfFile();p.waitUntilExit();return(p.terminationStatus,String(data:data,encoding:.utf8)!)}
${fn}
${idle}
let profile=URL(fileURLWithPath:"${dir}/profile")
try fm.createDirectory(at:profile,withIntermediateDirectories:true)
let state=profile.appendingPathComponent("state.txt")
try Data().write(to:state)
let owned=Process(),other=Process()
for p in [owned,other] {p.executableURL=URL(fileURLWithPath:"/usr/bin/tail");p.arguments=["-f",state.path];try p.run()}
defer {for p in [owned,other] {if p.isRunning {p.terminate();p.waitUntilExit()}}}
ownedCleanupProcesses.append(owned)
let rows=try processes([profile.path])
func present(_ pid:Int32)->Bool {rows.contains{$0.trimmingCharacters(in:.whitespaces).hasPrefix(String(pid)+" ")}}
guard !present(owned.processIdentifier),present(other.processIdentifier) else {fatalError("Incorrect inventory exemption")}
other.terminate();other.waitUntilExit()
try assertIdle([profile.path],profile)
print("PASS owned guardian excluded from process AND open-file inventories inside profile; unrelated PID remains blocked")
`;
try{fs.writeFileSync(path.join(dir,'main.swift'),swift);cp.execFileSync('/usr/bin/xcrun',['swiftc',path.join(dir,'main.swift'),'-o',path.join(dir,'test')]);console.log(cp.execFileSync(path.join(dir,'test'),{encoding:'utf8'}));}finally{fs.rmSync(dir,{recursive:true,force:true});}
