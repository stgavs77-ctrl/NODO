import AppKit
import Foundation
import CryptoKit

let fm = FileManager.default
#if NODO_UPDATER_TESTING
let updaterTesting = true
#else
let updaterTesting = false
#endif
#if NODO_UPDATER_TESTING
let home = URL(fileURLWithPath:ProcessInfo.processInfo.environment["NODO_TEST_HOME"]!)
#else
let home = fm.homeDirectoryForCurrentUser
#endif
func fail(_ text: String) throws -> Never { throw NSError(domain:"NODO Rescue", code:1, userInfo:[NSLocalizedDescriptionKey:text]) }
func json(_ url: URL) throws -> [String:Any] { try JSONSerialization.jsonObject(with:Data(contentsOf:url)) as? [String:Any] ?? [:] }
func write(_ value:[String:Any], _ url:URL) throws { try fm.createDirectory(at:url.deletingLastPathComponent(),withIntermediateDirectories:true); try JSONSerialization.data(withJSONObject:value,options:[.prettyPrinted,.sortedKeys]).write(to:url,options:.atomic) }
func run(_ executable:String,_ args:[String]) throws -> (Int32,String) {
 #if NODO_UPDATER_TESTING
 if let result=try nodoTestCommand(executable,args){return result}
 #endif
 let p=Process(); p.executableURL=URL(fileURLWithPath:executable);p.arguments=args;let pipe=Pipe();p.standardOutput=pipe;p.standardError=pipe;try p.run();let data=pipe.fileHandleForReading.readDataToEndOfFile();p.waitUntilExit();return (p.terminationStatus,String(data:data,encoding:.utf8) ?? "")
}
func installationBackup(_ roots:[URL],_ destination:URL,_ account:String) throws -> [String:Any] {
 #if NODO_UPDATER_TESTING
 return try backupUserStateForTesting(roots:roots,destination:destination,key:Data(repeating:0x5A,count:32))
 #else
 return try backupUserState(roots:roots,destination:destination,recoveryKeyAccount:account)
 #endif
}
func digest(_ url:URL) throws -> String { SHA256.hash(data:try Data(contentsOf:url,options:.mappedIfSafe)).map{String(format:"%02x",$0)}.joined() }
func verify(_ root:URL,_ manifest:[String:String]) throws { for (path,hash) in manifest { if path.hasPrefix("/") || path.split(separator:"/").contains("..") { try fail("Unsafe manifest path") };let file=root.appendingPathComponent(path);if try file.resourceValues(forKeys:[.isSymbolicLinkKey]).isSymbolicLink == true { try fail("Manifest file is a symlink: \(path)") };if try digest(file) != hash { try fail("Integrity mismatch: \(path)") } } }
func verifySnapshot(_ root:URL,_ snapshot:[String:Any]) throws {let root=root.resolvingSymlinksInPath();guard let files=snapshot["files"] as? [String:String],!files.isEmpty else{try fail("Empty integrity manifest")};try verify(root,files);if let links=snapshot["symlinks"] as? [String:String]{for (path,target) in links{guard !path.hasPrefix("/"),!path.split(separator:"/").contains(".."),try fm.destinationOfSymbolicLink(atPath:root.appendingPathComponent(path).path)==target else{try fail("Changed symbolic link")}};let ignored=snapshot["ignored"] as? [String] ?? [];var actual=Set<String>();guard let e=fm.enumerator(at:root,includingPropertiesForKeys:[.isRegularFileKey,.isSymbolicLinkKey])else{try fail("Cannot enumerate integrity root")};for case let file as URL in e{let rel=String(file.deletingLastPathComponent().resolvingSymlinksInPath().appendingPathComponent(file.lastPathComponent).path.dropFirst(root.path.count+1));if ignored.contains(where:{rel == $0 || rel.hasPrefix($0+"/")}){if try file.resourceValues(forKeys:[.isDirectoryKey]).isDirectory == true{e.skipDescendants()};continue};let v=try file.resourceValues(forKeys:[.isRegularFileKey,.isSymbolicLinkKey]);if v.isRegularFile == true || v.isSymbolicLink == true{actual.insert(rel)}};guard actual == Set(files.keys).union(links.keys) else{try fail("Code file inventory changed: unexpected=" + actual.subtracting(Set(files.keys).union(links.keys)).sorted().joined(separator:",") + " missing=" + Set(files.keys).union(links.keys).subtracting(actual).sorted().joined(separator:","))}}}
func manifest(_ app:URL) throws {
 let m=try json(app.appendingPathComponent("Contents/Resources/nodo-manifest.json"))
 guard m["signatureRequired"] as? Bool == true else{try fail("Manifest requires signature policy schema 2")}
 let signed=try run("/usr/bin/codesign",["--verify","--deep","--strict",app.path]);guard signed.0 == 0 else{try fail("Application code signature verification failed")}
 try verifySnapshot(app,m)
}
func makeManifest(_ app:URL) throws {
 // This is called only on newly-created backup/repair copies, never on the installed or source app.
 let link=app.appendingPathComponent("Contents/Resources/project/runtime/node_modules/deepseek-harness-rc-extension")
 if let target=try? fm.destinationOfSymbolicLink(atPath:link.path),target.hasPrefix("/"){try fm.removeItem(at:link);try fm.createSymbolicLink(atPath:link.path,withDestinationPath:"../../extension")}
 guard let info=NSDictionary(contentsOf:app.appendingPathComponent("Contents/Info.plist")),let executable=info["CFBundleExecutable"] as? String,!executable.isEmpty,!executable.contains("/"),executable != ".." else{try fail("Invalid main executable")}
 var files:[String:String]=[:],links:[String:String]=[:];let ignored=["Contents/Resources/nodo-manifest.json","Contents/_CodeSignature","Contents/MacOS/\(executable)"];guard let e=fm.enumerator(at:app,includingPropertiesForKeys:[.isRegularFileKey,.isSymbolicLinkKey])else{try fail("Cannot enumerate backup")};for case let u as URL in e{let rel=String(u.path.dropFirst(app.path.count+1));if ignored.contains(where:{rel == $0 || rel.hasPrefix($0+"/")}){if try u.resourceValues(forKeys:[.isDirectoryKey]).isDirectory == true{e.skipDescendants()};continue};let v=try u.resourceValues(forKeys:[.isRegularFileKey,.isSymbolicLinkKey]);if v.isSymbolicLink == true{links[rel]=try fm.destinationOfSymbolicLink(atPath:u.path)}else if v.isRegularFile == true{files[rel]=try digest(u)}};try write(["schema":2,"signatureRequired":true,"files":files,"symlinks":links,"ignored":ignored],app.appendingPathComponent("Contents/Resources/nodo-manifest.json"))}
func prepareLegacyBackup(_ app:URL,_ target:URL,_ template:URL) throws {
 let resources=app.appendingPathComponent("Contents/Resources"),archive=resources.appendingPathComponent("app.asar")
 let bytes=try Data(contentsOf:archive,options:.mappedIfSafe)
 guard bytes.count>=16 else{try fail("Legacy ASAR header missing")}
 func uint(_ offset:Int)->Int{(0..<4).reduce(0){$0 | (Int(bytes[offset+$1]) << (8*$1))}}
 let headerLength=uint(12);guard headerLength>0,headerLength<=bytes.count-16 else{try fail("Invalid legacy ASAR header")}
 guard let header=try JSONSerialization.jsonObject(with:bytes.subdata(in:16..<(16+headerLength))) as? [String:Any],let files=header["files"] as? [String:Any],files["main.cjs"] != nil,let package=files["package.json"] as? [String:Any],let rawOffset=package["offset"] as? String,let offset=Int(rawOffset),let size=package["size"] as? Int else{try fail("Unsupported legacy ASAR structure")}
 let start=8+uint(4)+offset;guard start>=16,size>0,start<=bytes.count-size,let metadata=try JSONSerialization.jsonObject(with:bytes.subdata(in:start..<(start+size))) as? [String:Any],metadata["main"] as? String == "main.cjs" else{try fail("Unsupported legacy entry point")}
 let wrapper=resources.appendingPathComponent("app");guard !fm.fileExists(atPath:wrapper.path),!fm.fileExists(atPath:resources.appendingPathComponent("legacy.asar").path)else{try fail("Legacy bootstrap already exists")}
 // Resolve the known profile module to backed-up code, without changing the user's profile/symlink.
 let overlay:[[String:Any]]=[["id":"rc-workstation","disabled":true],["insert":[["id":"nodo-legacy","name":target.appendingPathComponent("Contents/Resources/project/extension/index.mjs").path]]]]
 try JSONSerialization.data(withJSONObject:overlay,options:.prettyPrinted).write(to:resources.appendingPathComponent("legacy-overlay.json"),options:.atomic)
 try write(["name":"nodo-legacy-bootstrap","version":"1.0.0","main":"index.cjs"],wrapper.appendingPathComponent("package.json"))
 try fm.copyItem(at:template,to:wrapper.appendingPathComponent("index.cjs"))
 try fm.moveItem(at:archive,to:resources.appendingPathComponent("legacy.asar"))
}
// Only our still-running cleanup children are exempt; never match by process name.
var ownedCleanupProcesses:[Process]=[]
// The installer's own process carries the target and data paths in its
// arguments, so it would otherwise look like a running NODO and force the
// drain path on a closed profile. Updater-owned processes are never markers.
func isOwnedUpdaterPID(_ pid:Int32)->Bool {
 if pid == getpid() {return true}
 if ownedCleanupProcesses.contains(where:{$0.isRunning && $0.processIdentifier == pid}) {return true}
 let own=CommandLine.arguments.first ?? ""
 if !own.isEmpty,let comm=try? run("/bin/ps",["-p",String(pid),"-o","comm="]).1.trimmingCharacters(in:.whitespacesAndNewlines),comm==own {return true}
 return false
}
// The marker test is deliberately evaluated BEFORE isOwnedUpdaterPID: that
// check spawns one ps process per candidate, and running it for every system
// process made a single sweep take ~60 seconds (measured) instead of
// milliseconds. The filtered result is identical, only the cost changes.
func processes(_ markers:[String]) throws -> [String] { let (status,out)=try run("/bin/ps",["-axo","pid=,command="]);guard status == 0 else { try fail("Cannot verify processes") };return out.split(separator:"\n").map(String.init).filter{ line in guard markers.contains(where:{!$0.isEmpty && (line.contains($0+"/") || line.hasSuffix($0) || line.contains($0+" --"))}) else {return false};let pid=Int32(line.trimmingCharacters(in:.whitespaces).split(separator:" ").first ?? "") ?? 0;return !isOwnedUpdaterPID(pid) } }
// End-to-end updater tests install into their own app directory and profile.
// The flags are parsed only for the CLI and default to the real paths, so a
// user-run Rescue command is never redirected to another target.
func testPath(_ flag:String,_ fallback:URL)->URL {
 let args=CommandLine.arguments
 guard let index=args.firstIndex(of:flag),args.count>index+1 else{return fallback}
 // Only synthetic locations are accepted: the update tests own them.
 let value=args[index+1]
 guard value.hasPrefix("/tmp/")||value.hasPrefix("/private/tmp/")||value.contains("/build/e2e-") else{return fallback}
 return URL(fileURLWithPath:value)
}
let defaultData = testPath("--data",home.appendingPathComponent("Library/Application Support/NODO"))
let defaultApp = testPath("--app",home.appendingPathComponent("Applications/NODO.app"))
let rescueRoot = home.appendingPathComponent("Library/Application Support/NODO Rescue")
// A testOnly (synthetic) install must keep BOTH its application and its profile
// under a temporary root. That makes the installed NODO, its profile, the
// launchd jobs and the installed Rescue helper unreachable by construction: the
// guarantee is enforced here instead of being left to the caller.
let temporaryRoots=[fm.temporaryDirectory.path,"/private/tmp/","/tmp/"]
func isTemporaryPath(_ p:String)->Bool{!p.isEmpty && temporaryRoots.contains{p.hasPrefix($0)}}
func assertIdle(_ markers:[String],_ data:URL) throws {
 if !(try processes(markers)).isEmpty {try fail("NODO or dependent data writer is running. Nothing changed.")}
 let tasks=data.appendingPathComponent("tasks.json");if fm.fileExists(atPath:tasks.path){let value=try JSONSerialization.jsonObject(with:Data(contentsOf:tasks));let rows=(value as? [[String:Any]]) ?? ((value as? [String:Any])?["items"] as? [[String:Any]]) ?? [];let active=Set(["running","queued","starting","pending","waiting","waitingapproval","waiting approval"]);if rows.contains(where:{active.contains(($0["status"] as? String ?? "").lowercased())}){try fail("Saved Tasks contains unfinished work. Review and stop/finish it in NODO before updating.")}}
 if fm.fileExists(atPath:data.path){let scan=try run("/usr/sbin/lsof",["-nP","-t","+D",data.path]);let pids=scan.1.split(separator:"\n").compactMap{Int32($0)}.filter{!isOwnedUpdaterPID($0)};if !pids.isEmpty{try fail("An open file in NODO user data is still held by a process. Close dependent applications before updating.")};if scan.0 != 0 && scan.0 != 1{try fail("Cannot verify open data files")}}
}
func status(_ app:URL,_ data:URL) -> [String:Any] {
 var result:[String:Any] = ["schema":1,"time":ISO8601DateFormatter().string(from:Date()),"appExists":fm.fileExists(atPath:app.path),"dataExists":fm.fileExists(atPath:data.path)]
 do { try manifest(app);result["integrity"]="ok" } catch { result["integrity"]="failed";result["integrityError"]=error.localizedDescription.replacingOccurrences(of:home.path,with:"~") }
 if let info=try? json(app.appendingPathComponent("Contents/Resources/project/build-info.json")) { result["build"] = info.filter{["version","builtAt","commit","safeMode"].contains($0.key)} }
 if let state=try? json(data.appendingPathComponent("startup-status.json")) { var safe=state.filter{["state","pid","version","updatedAt","phase","errorCode"].contains($0.key)};if let error=state["error"] as? String,error.range(of:"^[A-Za-z][A-Za-z0-9_]{0,63}$",options:.regularExpression) != nil {safe["error"]=error};result["startup"]=safe }
 let owned=(try? processes([app.path,data.path])) ?? [];result["ownedProcessCount"]=owned.count;result["ownedPids"]=owned.compactMap{Int($0.trimmingCharacters(in:.whitespaces).split(separator:" ").first ?? "")}
 if let lkg=try? json(rescueRoot.appendingPathComponent("last-known-good.json")){result["lastKnownGood"]=lkg.filter{["version","verifiedAt","verification"].contains($0.key)}}
 if let update=try? json(rescueRoot.appendingPathComponent("last-update.json")){result["lastUpdatePhase"]=update["phase"] ?? "unknown"}
 var errors:[String:Int]=[:];for name in ["dsh.log","main.log","renderer.log","logs/main.log"] {let u=data.appendingPathComponent(name);if let h=try? FileHandle(forReadingFrom:u){defer{try? h.close()};let end=(try? h.seekToEnd()) ?? 0;try? h.seek(toOffset:end>65536 ? end-65536:0);let text=String(data:(try? h.readToEnd()) ?? Data(),encoding:.utf8)?.lowercased() ?? "";for category in ["eaddrinuse","econnrefused","enoent","cannot find module","syntaxerror","permission denied","renderer crashed","out of memory","invalid json","transport closed","context_length_exceeded"] {let n=text.components(separatedBy:category).count-1;if n>0{errors[category,default:0]+=n}}}};result["recentErrorCategories"]=errors
 let lock=data.appendingPathComponent("Electron/SingletonLock");if let v=try? fm.destinationOfSymbolicLink(atPath:lock.path),let raw=v.split(separator:"-").last,let pid=Int32(raw){result["electronLock"]=["pid":pid,"pidAlive":kill(pid,0)==0]}
 result["ports"] = [4180,4182,4183].map { port -> [String:Any] in let r=try? run("/usr/sbin/lsof",["-nP","-iTCP:\(port)","-sTCP:LISTEN","-t"]);return ["port":port,"pids":r?.1.split(separator:"\n").compactMap{Int($0)} ?? []] }
 var configs:[String:String]=[:];for path in ["workstation.json","tasks.json","dsh/storages/workspace.json"] { let url=data.appendingPathComponent(path);if fm.fileExists(atPath:url.path) { do {_=try JSONSerialization.jsonObject(with:Data(contentsOf:url));configs[path]="valid JSON"}catch{configs[path]="invalid JSON"} } };result["configValidation"]=configs
 // Only metadata is exported. Raw logs can contain complete customer prompts and credentials.
 var logs:[[String:Any]]=[];let locations=[data.appendingPathComponent("logs"),home.appendingPathComponent("Library/Logs/DiagnosticReports")];for dir in locations { for u in (try? fm.contentsOfDirectory(at:dir,includingPropertiesForKeys:[.fileSizeKey,.contentModificationDateKey])) ?? [] { if dir.lastPathComponent == "DiagnosticReports" && !u.lastPathComponent.lowercased().contains("nodo") { continue };let v=try? u.resourceValues(forKeys:[.fileSizeKey,.contentModificationDateKey]);logs.append(["kind":dir.lastPathComponent,"bytes":v?.fileSize ?? 0,"modified":v?.contentModificationDate.map{ISO8601DateFormatter().string(from:$0)} ?? "unknown"]) } };result["logMetadata"]=logs
 for name in ["dsh.log","main.log"] {let u=data.appendingPathComponent(name);if let a=try? fm.attributesOfItem(atPath:u.path){logs.append(["kind":name,"bytes":a[.size] ?? 0,"modified":(a[.modificationDate] as? Date).map{ISO8601DateFormatter().string(from:$0)} ?? "unknown"])}};result["logMetadata"]=logs
 return result
}
func bundle(_ app:URL,_ data:URL) throws -> URL { let dest=home.appendingPathComponent("Downloads/NODO-Diagnostics-\(Int(Date().timeIntervalSince1970))");try write(status(app,data),dest.appendingPathComponent("diagnostics.json"));return dest }
func ready(_ app:URL,_ data:URL,safe:Bool=false) throws {
 try manifest(app)
 let legacy=fm.fileExists(atPath:app.appendingPathComponent("Contents/Resources/rc-location.json").path) && !fm.fileExists(atPath:app.appendingPathComponent("Contents/Resources/project/build-info.json").path)
 if legacy && safe {try fail("This legacy version has no Safe Mode. Install the prepared update or use Diagnose & Repair.")}
 if !(try processes([app.path,data.path])).isEmpty { try fail("NODO or its data writer is already running. Close NODO first.") }
 let started=Date();guard let info=NSDictionary(contentsOf:app.appendingPathComponent("Contents/Info.plist")),let executable=info["CFBundleExecutable"] as? String,!executable.contains("/") else{try fail("Invalid application executable")};let p=Process();p.executableURL=app.appendingPathComponent("Contents/MacOS/\(executable)");var env=ProcessInfo.processInfo.environment;env.removeValue(forKey:"NODO_DEV");env.removeValue(forKey:"NODO_DATA");env.removeValue(forKey:"NODO_SAFE_MODE");if safe{env["NODO_SAFE_MODE"]="1"};if data.standardizedFileURL.path != home.appendingPathComponent("Library/Application Support/NODO").standardizedFileURL.path{env["NODO_DATA"]=data.path};p.environment=env;p.standardOutput=FileHandle.nullDevice;p.standardError=FileHandle.nullDevice;try p.run()
 for _ in 0..<45 { Thread.sleep(forTimeInterval:1);if !p.isRunning {try fail("NODO exited during startup (code \(p.terminationStatus)). Open Diagnose & Repair.")};let f=data.appendingPathComponent("startup-status.json");if let attrs=try? fm.attributesOfItem(atPath:f.path), let date=attrs[.modificationDate] as? Date,date>=started,let s=try? json(f),s["state"] as? String == "ready",let pid=s["pid"] as? Int,pid == Int(p.processIdentifier),kill(Int32(pid),0)==0 { return };if legacy {let listeners=try run("/usr/sbin/lsof",["-nP","-iTCP:4180","-sTCP:LISTEN","-t"]).1.split(separator:"\n");for pid in listeners {let command=try run("/bin/ps",["-p",String(pid),"-o","command="]).1;if command.contains(app.appendingPathComponent("Contents/Resources/project/runtime").path),try run("/usr/bin/curl",["--silent","--output","/dev/null","--write-out","%{http_code}","--max-time","2","http://127.0.0.1:4180/"]).1 == "200" {try write(["app":app.path,"verifiedAt":ISO8601DateFormatter().string(from:Date()),"version":"legacy rollback","verification":"owned DSH listener + HTTP 200"],rescueRoot.appendingPathComponent("last-known-good.json"));return}}} }
 try fail("NODO did not report a fresh ready state in 45 seconds. Diagnose & Repair is available; no process was killed.")
}
func recoverFailedStartup(_ target:URL,_ data:URL,_ base:URL) throws {
 if !(try processes([target.path,data.path])).isEmpty {
  do {_ = try lifecycleCommand(target,"pause");_ = try lifecycleCommand(target,"quit")}
  catch {try fail("New runtime cannot confirm safe shutdown. No force kill or data rollback used; Rescue retained the verified backup.")}
  for attempt in 0..<31 {if (try processes([target.path,data.path])).isEmpty{break};if attempt==30{try fail("New runtime did not exit safely; verified recovery remains available")};Thread.sleep(forTimeInterval:1)}
 }
 try assertIdle([target.path,data.path],data)
 try rollback(base)
 try ready(target,data)
}
func install(_ folder:URL) throws {
 let cfg=try json(folder.appendingPathComponent("update.json"));let test=cfg["testOnly"] as? Bool == true
 // A production package cannot nominate its own target, source or baseline.
 // Those paths are local trust decisions. Synthetic fixtures retain explicit
 // paths solely behind NODO_UPDATER_TESTING.
 let target=test ? (cfg["targetApp"] as? String ?? "") : defaultApp.path
 let dataPath=test ? (cfg["dataPath"] as? String ?? "") : defaultData.path
 let baseline=test ? (cfg["baseline"] as? [[String:Any]] ?? []) : []
 guard !target.isEmpty,!dataPath.isEmpty else { try fail("Invalid update metadata") }
 let kind=(cfg["kind"] as? String ?? (updaterTesting ? "migration" : ""))
 guard kind=="patch" || kind=="migration" else {try fail("Update kind must be patch or migration")}
 if !test && !updaterTesting && cfg["schema"] as? Int != 3 {try fail("Unsigned or obsolete update metadata")}
 let targetURL=URL(fileURLWithPath:target);let data=URL(fileURLWithPath:dataPath)
 if test && !(isTemporaryPath(target) && isTemporaryPath(dataPath)) { try fail("Synthetic install requires a temporary application and profile") }
 if !test && (targetURL.standardizedFileURL.path != defaultApp.standardizedFileURL.path || data.standardizedFileURL.path != defaultData.standardizedFileURL.path) { try fail("Unexpected install target or user profile") }
 let markers=[target,dataPath] // never accept process markers from a remote package
 for item in baseline { guard let root=item["root"] as? String else { try fail("Invalid baseline") };try verifySnapshot(URL(fileURLWithPath:root),item) }
 let app=folder.appendingPathComponent("NODO.app");try manifest(app)
 let base=test ? targetURL.deletingLastPathComponent().appendingPathComponent("RescueState") : rescueRoot
 let transaction=base.appendingPathComponent("transactions/\(UUID().uuidString)")
 let watchdog=WatchdogTransaction(transaction.appendingPathComponent("watchdog.json"))
 let scheduled=WatchdogTransaction(transaction.appendingPathComponent("factoscope/watchdog.json"),label:"com.example-local.vk-factoscope")
 var scheduledCaptured=false
 var watchdogCaptured=false,pausedAttempted=false,completed=false,before:[String:Any]=[:]
 defer {
  if !test && pausedAttempted && !completed {_ = try? lifecycleCommand(app,"resume")}
  if watchdogCaptured {do{try watchdog.restore()}catch{fputs("NODO Rescue: watchdog cleanup failed. Reopen Rescue and run cleanup; configuration was not overwritten.\n",stderr)}}
  if scheduledCaptured {do{try scheduled.restore()}catch{fputs("NODO Rescue: scheduled runner cleanup failed; original configuration retained for recovery.\n",stderr)}}
 }
 if !test {
  try scheduled.assertInactive()
  let scheduledLoaded=try scheduled.loaded()
  if !fm.fileExists(atPath:scheduled.plist.path) && scheduledLoaded{try fail("Loaded NODO scheduled job has no recoverable plist")}
 }
  // User may finish work and close legacy NODO first. Never signal a running
  // legacy runtime lacking drain; closed history must be structurally complete.
  let alreadyClosed=(try processes(markers)).isEmpty
  if alreadyClosed {try assertIdle(markers,data);_ = try lifecycleCommand(app,"cold")}
  else {_ = try lifecycleCommand(app,"inspect")}
 if !test {
  if kind=="migration" {guard let account=cfg["backupKeyAccount"] as? String,UUID(uuidString:account) != nil else{try fail("Missing dedicated recovery Keychain account")}
   #if !NODO_UPDATER_TESTING
   try validateRecoveryKey(account)
   #endif
  }
  try watchdog.capture();watchdogCaptured=true
  let guardian=Process();guardian.executableURL=URL(fileURLWithPath:CommandLine.arguments[0]);guardian.arguments=["watchdog-cleanup",watchdog.journal.path,String(getpid())];guardian.standardOutput=FileHandle.nullDevice;guardian.standardError=FileHandle.nullDevice;try guardian.run()
  ownedCleanupProcesses.append(guardian)
  try watchdog.suspend()
  if fm.fileExists(atPath:scheduled.plist.path) {
   try scheduled.capture();scheduledCaptured=true
   let guardian=Process();guardian.executableURL=URL(fileURLWithPath:CommandLine.arguments[0]);guardian.arguments=["watchdog-cleanup",scheduled.journal.path,String(getpid())];guardian.standardOutput=FileHandle.nullDevice;guardian.standardError=FileHandle.nullDevice;try guardian.run()
   ownedCleanupProcesses.append(guardian)
   try scheduled.assertInactive();try scheduled.suspend()
  }
 }
 if alreadyClosed {try assertIdle(markers,data);_ = try lifecycleCommand(app,"cold")}
 else {pausedAttempted=true;_ = try lifecycleCommand(app,"pause")}
  before = try lifecycleCommand(app,"snapshot")
  if !alreadyClosed {_ = try lifecycleCommand(app,"quit")}
  for n in 0..<61 {if (try processes(markers)).isEmpty{break};if n==60{try fail("Known NODO processes did not exit gracefully; no force kill used")};Thread.sleep(forTimeInterval:1)}
 try assertIdle(markers,data)
 if !test && kind=="migration" {_ = try lifecycleCommand(app,"backup-policy");let roots=try userStateRoots(data);try assertPersistentStateIdle(roots);let receipt=try installationBackup(roots,transaction.appendingPathComponent("user-backup"),cfg["backupKeyAccount"] as! String);try write(receipt,transaction.appendingPathComponent("backup-receipt.json"));try write(before,transaction.appendingPathComponent("controls.json"));try assertPersistentStateIdle(roots);_ = try lifecycleCommand(app,"backup-policy")}
 let backup=base.appendingPathComponent("backups/\(UUID().uuidString)/NODO.app");let prior=fm.fileExists(atPath:target) ? targetURL : (test ? URL(fileURLWithPath:cfg["sourceApp"] as? String ?? "") : targetURL)
 guard fm.fileExists(atPath:prior.path),prior.path.hasSuffix("/NODO.app") else { try fail("Previous NODO.app is unavailable; rollback cannot be guaranteed") }
 try fm.createDirectory(at:backup.deletingLastPathComponent(),withIntermediateDirectories:true);try fm.copyItem(at:prior,to:backup)
 // The original development app may refer to its external project. Preserve that dependency as code only.
 if test,let source=cfg["sourceCode"] as? String,prior.path == cfg["sourceApp"] as? String {
  let code=backup.appendingPathComponent("Contents/Resources/project");try fm.createDirectory(at:code,withIntermediateDirectories:true)
  for name in ["main.cjs","preload.cjs","package.json","lib","ui","extension","assets","scripts","runtime","vendor","dsh-plugin.mjs","profile.patch.yml","codex-config.toml"] {let from=URL(fileURLWithPath:source).appendingPathComponent(name);if fm.fileExists(atPath:from.path){try fm.copyItem(at:from,to:code.appendingPathComponent(name))}}
  let bundledNode=code.appendingPathComponent("runtime/node"),releaseNode=app.appendingPathComponent("Contents/Resources/project/runtime/node");if !fm.fileExists(atPath:bundledNode.path),fm.fileExists(atPath:releaseNode.path){try fm.copyItem(at:releaseNode,to:bundledNode);let dependencies=app.appendingPathComponent("Contents/Resources/project/runtime/node-libs");if fm.fileExists(atPath:dependencies.path){try fm.copyItem(at:dependencies,to:code.appendingPathComponent("runtime/node-libs"))}}
  try write(["root":targetURL.appendingPathComponent("Contents/Resources/project").path],backup.appendingPathComponent("Contents/Resources/rc-location.json"))
  // Stable launch jobs must also work after code-only rollback to the legacy bundle.
  for name in ["start-current-nodo.command","vk-factoscope-runner.sh","telegram-read.py"] {
   let from=app.appendingPathComponent("Contents/Resources/project/scripts/\(name)"),to=code.appendingPathComponent("scripts/\(name)")
   if fm.fileExists(atPath:from.path) {if fm.fileExists(atPath:to.path){try fm.removeItem(at:to)};try fm.copyItem(at:from,to:to)}
  }
  try prepareLegacyBackup(backup,targetURL,folder.appendingPathComponent("NODO Rescue.app/Contents/Resources/legacy-bootstrap.cjs"))
  let signed=try run("/usr/bin/codesign",["--force","--deep","--sign","-",backup.path]);if signed.0 != 0 {try fail("Cannot sign self-contained legacy backup")};try makeManifest(backup);if try run("/usr/bin/codesign",["--force","--sign","-",backup.path]).0 != 0 {try fail("Cannot sign backup integrity manifest")}
 }
 try fm.createDirectory(at:targetURL.deletingLastPathComponent(),withIntermediateDirectories:true)
 let staged=targetURL.deletingLastPathComponent().appendingPathComponent(".NODO-stage-\(UUID().uuidString).app");try fm.copyItem(at:app,to:staged);try manifest(staged)
 let displaced=backup.deletingLastPathComponent().appendingPathComponent("replaced-target.app")
 try write(["target":target,"backup":backup.path,"dataPath":dataPath,"phase":"prepared","kind":kind,"testOnly":test],base.appendingPathComponent("last-update.json"))
 if fm.fileExists(atPath:target) { try fm.moveItem(at:targetURL,to:displaced) };do {try fm.moveItem(at:staged,to:targetURL)} catch {if fm.fileExists(atPath:displaced.path){try? fm.moveItem(at:displaced,to:targetURL)};throw error}
 try write(["target":target,"backup":backup.path,"dataPath":dataPath,"phase":"installed","kind":kind,"testOnly":test],base.appendingPathComponent("last-update.json"))
 if !test { let rescue=folder.appendingPathComponent("NODO Rescue.app");if fm.fileExists(atPath:rescue.path){let dest=home.appendingPathComponent("Applications/NODO Rescue.app");if fm.fileExists(atPath:dest.path){try fm.moveItem(at:dest,to:backup.deletingLastPathComponent().appendingPathComponent("NODO Rescue.app"))};try fm.copyItem(at:rescue,to:dest)}};do {try ready(targetURL,data);var report:[String:Any]?,healthError="No health response";for _ in 0..<30{do{report=try lifecycleCommand(targetURL,"health");break}catch{healthError=error.localizedDescription};Thread.sleep(forTimeInterval:1)};guard let after=report?["snapshot"] as? [String:Any] else{try fail("Post-start services not healthy: \(healthError). Update NOT accepted; use Repair/Rollback.")};try assertPreserved(before,after);if scheduledCaptured {try scheduled.migrateLaunchTarget();try scheduled.commitLaunchTarget()};if watchdogCaptured {try watchdog.migrateLaunchTarget();try watchdog.commitLaunchTarget();try watchdog.restore()};if scheduledCaptured {try scheduled.restore()};try write(["phase":"verified","counts":after["counts"] ?? [:]],transaction.appendingPathComponent("result.json")); } catch {let reason=error.localizedDescription;try recoverFailedStartup(targetURL,data,base);try fail("Update NOT accepted: \(reason). Previous code restored and started; user data retained.")}
 completed=true
}
func rollback(_ base:URL) throws { let cfg=try json(base.appendingPathComponent("last-update.json"));guard let target=cfg["target"] as? String,let backup=cfg["backup"] as? String,let data=cfg["dataPath"] as? String else {try fail("No previous update")};let test=cfg["testOnly"] as? Bool == true;if !test && (target != defaultApp.path || data != defaultData.path){try fail("Unexpected rollback target")};if test && !(isTemporaryPath(target) && isTemporaryPath(data)){try fail("Invalid test rollback target")};if !(try processes([target,data])).isEmpty {try fail("Close NODO and dependent writers before rollback")};guard backup.hasPrefix(base.appendingPathComponent("backups").path+"/"),backup.hasSuffix("/NODO.app"),!backup.split(separator:"/").contains("..") else{try fail("Invalid rollback path")};let b=URL(fileURLWithPath:backup);guard fm.fileExists(atPath:b.path) else{try fail("Backup missing")};if !test {try manifest(b)};let t=URL(fileURLWithPath:target),stage=t.deletingLastPathComponent().appendingPathComponent(".NODO-rollback-\(UUID().uuidString).app");try fm.copyItem(at:b,to:stage);let displaced=b.deletingLastPathComponent().appendingPathComponent("failed-\(UUID().uuidString).app");if fm.fileExists(atPath:t.path){try fm.moveItem(at:t,to:displaced)};do{try fm.moveItem(at:stage,to:t)}catch{if fm.fileExists(atPath:displaced.path){try? fm.moveItem(at:displaced,to:t)};throw error};var done=cfg;done["phase"]="rolled-back";try write(done,base.appendingPathComponent("last-update.json")) }
func repairCopy(_ app:URL,_ data:URL) throws -> URL {let source=app.appendingPathComponent("Contents/Resources/project");guard fm.fileExists(atPath:source.path) else{try fail("Packaged project missing; use rollback")};guard fm.fileExists(atPath:source.appendingPathComponent("build-mode.json").path) else{try fail("Legacy version does not support isolated repair launch. Use the prepared new release as the repair source.")};let dest=home.appendingPathComponent("Documents/Codex/NODO-Repair-\(UUID().uuidString)");try fm.createDirectory(at:dest,withIntermediateDirectories:true);let copied=dest.appendingPathComponent("NODO Repair.app");try fm.copyItem(at:app,to:copied);try write(["mode":"dev"],copied.appendingPathComponent("Contents/Resources/project/build-mode.json"));try makeManifest(copied);if try run("/usr/bin/codesign",["--force","--sign","-",copied.path]).0 != 0{try fail("Repair copy created, but signing failed; do not launch until signature is fixed")};try write(status(app,data),dest.appendingPathComponent("diagnostics.json"));try "Repair only NODO Repair.app/Contents/Resources/project in this isolated copy. The complete Electron shell and runtimes are included. build-mode.json is dev; never switch it to production. Do not access live NODO, userData, Telegram, credentials or messages. Inspect diagnostics and fix code in this copy. Test by launching this copied app once (uses NODO DEV, so ensure no other NODO DEV runs). Re-sign the copied bundle after edits. Missing developer build scripts/vendor do not block testing this complete copied app. Do not install or modify the working app. Prepare a reviewed code diff and test report.\n".write(to:dest.appendingPathComponent("REPAIR_REQUEST.txt"),atomically:true,encoding:.utf8);return dest}
func repairStaleLock(_ app:URL,_ data:URL) throws -> String {
 if !(try processes([app.path,data.path])).isEmpty {return "NODO работает; ремонт не выполнялся."}
 let lock=data.appendingPathComponent("Electron/SingletonLock");guard let value=try? fm.destinationOfSymbolicLink(atPath:lock.path),let dash=value.lastIndex(of:"-"),let pid=Int32(value[value.index(after:dash)...]) else{return "Известный stale lock не найден."}
 let host=String(value[..<dash]);guard host == ProcessInfo.processInfo.hostName,kill(pid,0) == -1,errno == ESRCH else{return "Lock не подтверждён как устаревший; оставлен на месте."}
 let quarantine=rescueRoot.appendingPathComponent("quarantine/\(UUID().uuidString)");try fm.createDirectory(at:quarantine,withIntermediateDirectories:true);try fm.moveItem(at:lock,to:quarantine.appendingPathComponent("SingletonLock"));return "Устаревший lock сохранён в карантин."
}
func repairCode(_ app:URL,_ data:URL,_ base:URL) throws -> String {
 let current=status(app,data)
 guard current["integrity"] as? String == "failed" else{return "Целостность кода подтверждена; откат не нужен."}
 guard let update=try? json(base.appendingPathComponent("last-update.json")),let target=update["target"] as? String,let dataPath=update["dataPath"] as? String,let backup=update["backup"] as? String else{return "Код повреждён или отсутствует; подтверждённого backup нет. Сохраните диагностический пакет."}
 guard URL(fileURLWithPath:target).standardizedFileURL == app.standardizedFileURL,URL(fileURLWithPath:dataPath).standardizedFileURL == data.standardizedFileURL,["prepared","installed"].contains(update["phase"] as? String ?? "") else{return "Backup относится к другому состоянию; автоматический откат не выполнялся."}
 guard backup.hasPrefix(base.appendingPathComponent("backups").path+"/"),backup.hasSuffix("/NODO.app"),!backup.split(separator:"/").contains("..") else{return "Некорректный путь backup; ремонт не выполнялся."}
 do{try manifest(URL(fileURLWithPath:backup))}catch{return "Backup не прошёл проверку целостности; ремонт не выполнялся."}
 try assertIdle([app.path,data.path],data)
 try rollback(base)
 return "Повреждённый/неполный код восстановлен из проверенной предыдущей версии. История и настройки не изменялись."
}

final class Delegate:NSObject,NSApplicationDelegate {
 var window:NSWindow!;var label:NSTextField!
 func whiteLabel(_ text:String,_ size:CGFloat = 13,_ weight:NSFont.Weight = .regular)->NSTextField {let field=NSTextField(labelWithString:text);field.textColor = .white;field.font=NSFont.systemFont(ofSize:size,weight:weight);return field}
 func applicationDidFinishLaunching(_ notification:Notification){
  window=NSWindow(contentRect:NSRect(x:0,y:0,width:460,height:480),styleMask:[.titled,.closable,.miniaturizable],backing:.buffered,defer:false);window.title="NODO Rescue";window.backgroundColor = .black;window.center()
  let stack=NSStackView();stack.orientation = .vertical;stack.alignment = .leading;stack.spacing=12;stack.edgeInsets=NSEdgeInsets(top:24,left:28,bottom:24,right:28);stack.frame=window.contentView!.bounds;stack.autoresizingMask=[.width,.height];window.contentView!.wantsLayer=true;window.contentView!.layer?.backgroundColor=NSColor.black.cgColor;window.contentView!.addSubview(stack)
  let brand=NSStackView();brand.orientation = .horizontal;brand.alignment = .centerY;brand.spacing=9
  let icon=NSImageView();icon.image=NSApp.applicationIconImage;icon.imageScaling = .scaleProportionallyUpOrDown;icon.translatesAutoresizingMaskIntoConstraints=false;icon.widthAnchor.constraint(equalToConstant:38).isActive=true;icon.heightAnchor.constraint(equalToConstant:38).isActive=true;brand.addArrangedSubview(icon)
  brand.addArrangedSubview(whiteLabel("NODO",16,.medium));let harness=whiteLabel("HARNESS",12,.medium);harness.wantsLayer=true;harness.layer?.borderColor=NSColor.white.cgColor;harness.layer?.borderWidth=1;harness.layer?.cornerRadius=5;harness.alignment = .center;harness.translatesAutoresizingMaskIntoConstraints=false;harness.widthAnchor.constraint(equalToConstant:74).isActive=true;harness.heightAnchor.constraint(equalToConstant:24).isActive=true;brand.addArrangedSubview(harness);stack.addArrangedSubview(brand)
  label=NSTextField(wrappingLabelWithString:"Независимое восстановление NODO. История остаётся на месте.");label.textColor = .white;stack.addArrangedSubview(label)
  for (title,tag) in [("Запустить NODO",0),("Безопасный режим",1),("Диагностика и восстановление",2),("Откатить последнее обновление",3),("Открыть журналы",4),("Создать диагностический пакет",5),("Подготовить копию для внешнего Codex",6)] {let b=NSButton(title:title,target:self,action:#selector(action(_:)));b.tag=tag;b.isBordered=false;b.wantsLayer=true;b.layer?.backgroundColor=NSColor.black.cgColor;b.layer?.borderColor=NSColor.white.cgColor;b.layer?.borderWidth=1;b.layer?.cornerRadius=6;b.contentTintColor = .white;b.attributedTitle=NSAttributedString(string:title,attributes:[.foregroundColor:NSColor.white,.font:NSFont.systemFont(ofSize:13)]);b.translatesAutoresizingMaskIntoConstraints=false;b.widthAnchor.constraint(equalToConstant:404).isActive=true;b.heightAnchor.constraint(equalToConstant:32).isActive=true;stack.addArrangedSubview(b)}
  window.makeKeyAndOrderFront(nil);NSApp.activate(ignoringOtherApps:true)
 }
 @objc func action(_ button:NSButton){let tag=button.tag;label.stringValue="Проверка…";DispatchQueue.global().async {var message="";do {switch tag {case 0:try ready(defaultApp,defaultData);message="NODO запущен и сообщил ready.";case 1:try ready(defaultApp,home.appendingPathComponent("Library/Application Support/NODO Safe Mode"),safe:true);message="Безопасный режим запущен.";case 2:let file=try bundle(defaultApp,defaultData);let repaired=try repairStaleLock(defaultApp,defaultData);let code=try repairCode(defaultApp,defaultData,rescueRoot);message="\(repaired) \(code) Диагностика: \(file.lastPathComponent).";case 3:try rollback(rescueRoot);message="Предыдущий код восстановлен. Пользовательские данные сохранены.";case 4:NSWorkspace.shared.open(defaultData);message="Открыт каталог данных с журналами dsh.log и logs.";case 5:let p=try bundle(defaultApp,defaultData);NSWorkspace.shared.open(p);message="Создан \(p.lastPathComponent). Сырые логи и переписка исключены.";default:let p=try repairCopy(defaultApp,defaultData);NSWorkspace.shared.open(p);message="Копия готова. Откройте её в отдельном Codex и передайте REPAIR_REQUEST.txt."}} catch {message=error.localizedDescription};DispatchQueue.main.async {self.label.stringValue=message} }}
 func applicationShouldTerminateAfterLastWindowClosed(_ sender:NSApplication)->Bool{true}
}
do {
 let args=CommandLine.arguments
 if args.count>1 {
  switch args[1] {
  case "verify":
   guard args.count==3 else{try fail("Application path required")};try manifest(URL(fileURLWithPath:args[2]));print("Application integrity verified")
  case "watchdog-cleanup":
   guard args.count==4,args[2].hasPrefix(rescueRoot.appendingPathComponent("transactions").path+"/"),args[2].hasSuffix("/watchdog.json"),!args[2].split(separator:"/").contains(".."),let parent=Int32(args[3]) else{try fail("Invalid cleanup transaction")}
   let journal=URL(fileURLWithPath:args[2]);let record=try json(journal);let watchdog=WatchdogTransaction(journal,label:record["label"] as? String ?? "invalid");while kill(parent,0)==0{if (try? json(watchdog.journal)["phase"] as? String)=="restored"{exit(0)};Thread.sleep(forTimeInterval:1)};try watchdog.restore()
  case "verify-user-backup":
   guard args.count==3 else{try fail("Backup archive required")};_ = try verifyUserBackup(archive:URL(fileURLWithPath:args[2]));print("Encrypted user backup authenticated")
  case "restore-user-backup":
   guard args.count==4 else{try fail("Backup archive and NEW destination required")};_ = try restoreUserBackup(archive:URL(fileURLWithPath:args[2]),destination:URL(fileURLWithPath:args[3]));print("Backup restored into a new directory; live profile not overwritten")
  case "legacy-backup-test":
   guard args.count==5,args[2].hasPrefix(fm.temporaryDirectory.path),args[3].hasPrefix(fm.temporaryDirectory.path) else{try fail("Legacy test requires temporary app/target")}
   try prepareLegacyBackup(URL(fileURLWithPath:args[2]),URL(fileURLWithPath:args[3]),URL(fileURLWithPath:args[4]));print("Legacy bootstrap prepared in synthetic app")
  case "diagnose":
   let app=args.count>2 ? URL(fileURLWithPath:args[2]) : defaultApp;let data=args.count>3 ? URL(fileURLWithPath:args[3]) : defaultData
   print(String(data:try JSONSerialization.data(withJSONObject:status(app,data),options:.sortedKeys),encoding:.utf8)!)
  case "repair":print(try repairCode(args.count>2 ? URL(fileURLWithPath:args[2]) : defaultApp,args.count>3 ? URL(fileURLWithPath:args[3]) : defaultData,args.count>4 ? URL(fileURLWithPath:args[4]) : rescueRoot))
  case "start":try ready(args.count>2 ? URL(fileURLWithPath:args[2]) : defaultApp,args.count>3 ? URL(fileURLWithPath:args[3]) : defaultData)
  case "install":guard args.count>2 else{try fail("Update folder required")};try install(URL(fileURLWithPath:args[2]));print("Installed; user data unchanged")
  case "rollback":try rollback(args.count>2 ? URL(fileURLWithPath:args[2]) : rescueRoot);print("Code rollback complete; user data unchanged")
  default:try fail("Unknown command")
  }
 }else{let app=NSApplication.shared;let delegate=Delegate();app.delegate=delegate;app.setActivationPolicy(.regular);app.run()}
}catch{fputs("NODO Rescue: \(error.localizedDescription)\n",stderr);exit(1)}
