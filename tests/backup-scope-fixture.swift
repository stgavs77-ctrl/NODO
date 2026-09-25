import Foundation

enum ScopeTestError:Error {case failed(String)}
func checkScope(_ value:Bool,_ message:String)throws{if !value{throw ScopeTestError.failed(message)}}
@main struct Main {
 static func main()throws{
  let fm=FileManager.default,root=URL(fileURLWithPath:CommandLine.arguments[1]),home=root.appendingPathComponent("home")
  let profile="Library/Application Support/NODO DEV",data=home.appendingPathComponent(profile)
  let bridge=".dsh/plugins/telegram-bridge/"
  func put(_ relative:String,_ bytes:Data)throws{let file=home.appendingPathComponent(relative);try fm.createDirectory(at:file.deletingLastPathComponent(),withIntermediateDirectories:true);try bytes.write(to:file)}
  let marker=Data("SYNTHETIC_SELECTED_PROFILE_ONLY".utf8)
  try put(profile+"/dsh/settings.yaml",marker)
  try put(profile+"/future-persistent.json",marker)
  try put(profile+"/dsh/sessions/synthetic/session.jsonl",Data(repeating:65,count:4*1024*1024))
  for file in nodoBridgeBackupFiles{try put(bridge+file,Data(("SYNTHETIC_CRITICAL_"+file).utf8))}
  for file in ["board.json","alerts.json","alerts-history.jsonl"]{try put(".dsh/plugins/sessions-observer/"+file,marker)}
  let excluded=[bridge+"lead-session/work.session",bridge+"lead-state.json",bridge+"lead-watch.log",bridge+"watch.json",bridge+"watch-alerts.jsonl",bridge+"watch.out",bridge+"watch.err",bridge+"owner.json","Documents/ChatGPT/NODO Workspace/.private/deployment-v13/state.sqlite","Documents/ChatGPT/NODO Workspace/.private/journal-bridge-v1/raw-journal/mock.enc","Library/Application Support/example-localOrderInbox/receiver-health.json","Library/Application Support/NODO/dsh/other-profile.txt"]
  let allExcluded=excluded+[profile+"/updates/install-test/installer.log"]
  for file in allExcluded{try put(file,Data("SYNTHETIC_EXCLUDED".utf8))}
  let scope=try nodoBackupScope(data:data,userHome:home)
  // Compare normalized paths: newer Foundation returns directory URLs with a trailing
  // slash and may resolve /var to /private/var, so URL equality is not reliable.
  func norm(_ u:URL)->String{u.standardizedFileURL.resolvingSymlinksInPath().path}
  let scopePaths=Set(scope.map(norm))
  func selected(_ u:URL)->Bool{scopePaths.contains(norm(u))}
  try checkScope(selected(data.appendingPathComponent("dsh")),"selected profile data absent")
  try checkScope(selected(data.appendingPathComponent("future-persistent.json")),"unknown persistent file absent")
  try checkScope(scope.count==2+nodoBridgeBackupFiles.count+3,"scope cardinality")
  for file in nodoBridgeBackupFiles{try checkScope(selected(home.appendingPathComponent(bridge+file)),"critical state absent")}
  for file in allExcluded{let p=norm(home.appendingPathComponent(file));try checkScope(!scopePaths.contains{p==$0||p.hasPrefix($0+"/")},"excluded file selected")}

  // Keep independent example-local and watch diagnostics changing during encryption.
  let queue=DispatchQueue(label:"synthetic-excluded-writers"),timer=DispatchSource.makeTimerSource(queue:queue)
  var writes=0
  timer.schedule(deadline:.now(),repeating:.milliseconds(1))
  timer.setEventHandler{for file in allExcluded{try? put(file,Data(("SYNTHETIC_UPDATE_"+String(writes)).utf8))};writes+=1}
  timer.resume()
  let receipt:[String:Any]
  do{receipt=try backupUserStateForTesting(roots:scope,destination:root.appendingPathComponent("encrypted"),key:Data(repeating:7,count:32))}
  catch{timer.cancel();queue.sync{};throw error}
  timer.cancel();queue.sync{}
  try checkScope(writes>0,"background synthetic writer did not run")
  let archive=URL(fileURLWithPath:receipt["archivePath"] as! String)
  try checkScope((try Data(contentsOf:archive)).range(of:marker)==nil,"plaintext leaked into encrypted archive")
  _=try verifyUserBackupForTesting(archive:archive,key:Data(repeating:7,count:32))
  let restored=root.appendingPathComponent("restored")
  _=try restoreUserBackupForTesting(archive:archive,destination:restored,key:Data(repeating:7,count:32))
  try checkScope(receipt["commonRoot"] as? String==home.path,"unexpected archive root")
  try checkScope(try Data(contentsOf:restored.appendingPathComponent(profile+"/dsh/settings.yaml"))==marker,"profile restore mismatch")
  try checkScope(try Data(contentsOf:restored.appendingPathComponent(profile+"/future-persistent.json"))==marker,"unknown persistent restore mismatch")
  for file in nodoBridgeBackupFiles{try checkScope(try Data(contentsOf:restored.appendingPathComponent(bridge+file))==Data(("SYNTHETIC_CRITICAL_"+file).utf8),"critical bridge restore mismatch")}
  for file in allExcluded{try checkScope(!fm.fileExists(atPath:restored.appendingPathComponent(file).path),"excluded live file restored")}
  // Missing mandatory state and symlink substitutions must fail closed.
  let required=home.appendingPathComponent(bridge+"state.json")
  try fm.removeItem(at:required)
  var refused=false;do{_=try nodoBackupScope(data:data,userHome:home)}catch{refused=true}
  try checkScope(refused,"missing critical state accepted")
  try fm.createSymbolicLink(at:required,withDestinationURL:home.appendingPathComponent(bridge+"lead-state.json"))
  refused=false;do{_=try nodoBackupScope(data:data,userHome:home)}catch{refused=true}
  try checkScope(refused,"critical symlink accepted")
  print("PASS exact scope + encrypted restore + concurrent excluded writers + fail-closed critical state; no Keychain")
 }
}
