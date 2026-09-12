import Foundation
import CryptoKit

// Exact NODO infrastructure only; no independent nodo-optional jobs.
final class WatchdogTransaction {
 let label:String
 var plist:URL {home.appendingPathComponent("Library/LaunchAgents/\(label).plist")}
 let journal:URL
 var record:[String:Any]=[:]
 var domain:String {"gui/\(getuid())"}
 var service:String {domain+"/"+label}
 init(_ journal:URL,label:String="com.nodo-optional.dsh-watchdog"){self.journal=journal;self.label=label}
 func loaded() throws -> Bool {let r=try run("/bin/launchctl",["print",service]);if r.0==0{return true};if r.0==113 || r.0==3{return false};try fail("Cannot determine watchdog state")}
 func capture() throws {
  guard ["com.nodo-optional.dsh-watchdog","com.nodo-optional.vk-factoscope"].contains(label) else{try fail("Launchd label outside NODO scope")}
  guard let config=NSDictionary(contentsOf:plist),config["Label"] as? String==label else{try fail("Unexpected watchdog configuration")}
  let disabled=try run("/bin/launchctl",["print-disabled",domain]);guard disabled.0==0 else{try fail("Cannot inspect watchdog disabled state")}
  record=["label":label,"loaded":try loaded(),"plistSHA":try digest(plist),"installerPID":Int(getpid()),"phase":"captured","disabledStateSHA":SHA256.hash(data:Data(disabled.1.utf8)).map{String(format:"%02x",$0)}.joined()]
  try write(record,journal)
 }
 func assertInactive() throws {
  let result=try run("/bin/launchctl",["print",service])
  guard result.0==0 || result.0==113 || result.0==3 else{try fail("Cannot inspect scheduled NODO job")}
  if result.1.contains("\n\tpid = "){try fail("Scheduled NODO task is still executing; let it finish normally before updating")}
 }
 func suspend() throws {
  if record["loaded"] as? Bool != true{return}
  if label=="com.nodo-optional.vk-factoscope" {
   guard let config=NSDictionary(contentsOf:plist),config["RunAtLoad"] as? Bool != true,config["KeepAlive"]==nil,config["StartInterval"]==nil,let times=config["StartCalendarInterval"] as? [[String:Int]],!times.isEmpty else{try fail("Unexpected scheduled NODO runner policy")}
   let now=Date(),calendar=Calendar.current
   for time in times {
    guard Set(time.keys)==Set(["Hour","Minute"]),let hour=time["Hour"],let minute=time["Minute"],(0...23).contains(hour),(0...59).contains(minute),let next=calendar.nextDate(after:now.addingTimeInterval(-120),matching:DateComponents(hour:hour,minute:minute),matchingPolicy:.nextTime),next.timeIntervalSince(now)>120 else{try fail("Scheduled NODO runner is due now; wait for its normal completion before updating")}
   }
  }
  // Never unload an actively executing watchdog; bootout could terminate its work.
  for attempt in 0..<31 {let r=try run("/bin/launchctl",["print",service]);if !r.1.contains("\n\tpid = "){break};if attempt==30{try fail("Watchdog is still executing; no forced shutdown performed")};Thread.sleep(forTimeInterval:1)}
  record["phase"]="suspending";try write(record,journal)
  guard try run("/bin/launchctl",["bootout",service]).0==0 else{try fail("Cannot suspend watchdog")}
  record["phase"]="suspended";try write(record,journal)
 }
 func restore() throws {
  if record.isEmpty{record=try json(journal)}
  guard ["com.nodo-optional.dsh-watchdog","com.nodo-optional.vk-factoscope"].contains(label) else{try fail("Launchd label outside NODO scope")}
  // If interrupted during migration, restore byte-identical old configuration.
  if let staged=record["stagedSHA"] as? String {
   let current=try digest(plist)
   guard current==staged || current==record["plistSHA"] as? String else{try fail("Watchdog configuration drift during migration")}
   if record["launchTargetCommitted"] as? Bool != true {
    let original=journal.deletingLastPathComponent().appendingPathComponent("watchdog-original.plist")
    guard try digest(original)==record["plistSHA"] as? String else{try fail("Watchdog recovery copy mismatch")}
    try Data(contentsOf:original).write(to:plist,options:.atomic)
   } else {record["plistSHA"]=staged}
  }
  guard record["label"] as? String==label,record["plistSHA"] as? String == (try digest(plist)) else{try fail("Watchdog plist changed concurrently; original file was not overwritten")}
  let currentlyLoaded=try loaded()
  if record["loaded"] as? Bool==true && !currentlyLoaded {guard try run("/bin/launchctl",["bootstrap",domain,plist.path]).0==0 else{try fail("Watchdog restore failed; use NODO Rescue cleanup")}}
  // enable/disable is never changed; an originally unloaded job remains untouched.
  record["phase"]="restored";try write(record,journal)
 }
 func migrateLaunchTarget() throws {
  guard !(try loaded()),try digest(plist)==record["plistSHA"] as? String else{try fail("Watchdog must be suspended with unchanged configuration")}
  guard var config=NSDictionary(contentsOf:plist) as? [String:Any],config["Label"] as? String==label else{try fail("Unexpected watchdog plist")}
  let original=journal.deletingLastPathComponent().appendingPathComponent("watchdog-original.plist")
  try Data(contentsOf:plist).write(to:original,options:.atomic)
  if label=="com.nodo-optional.dsh-watchdog" {
   var env=config["EnvironmentVariables"] as? [String:String] ?? [:]
   env["DSH_BRIDGE_RESTART"]=home.appendingPathComponent("Applications/NODO.app/Contents/Resources/project/scripts/start-current-nodo.command").path
   config["EnvironmentVariables"]=env
  } else {
   config["ProgramArguments"]=["/bin/bash",home.appendingPathComponent("Applications/NODO.app/Contents/Resources/project/scripts/vk-factoscope-runner.sh").path]
  }
  let candidate=try PropertyListSerialization.data(fromPropertyList:config,format:.xml,options:0)
  record["stagedSHA"]=SHA256.hash(data:candidate).map{String(format:"%02x",$0)}.joined()
  try write(record,journal) // recovery intent precedes the plist write
  try candidate.write(to:plist,options:.atomic)
 }
 func commitLaunchTarget() throws {
  guard let staged=record["stagedSHA"] as? String,try digest(plist)==staged else{try fail("Watchdog migration not verified")}
  record["launchTargetCommitted"]=true;try write(record,journal)
 }
}

func lifecycleCommand(_ app:URL,_ mode:String) throws -> [String:Any] {
 let project=app.appendingPathComponent("Contents/Resources/project")
 let result=try run(project.appendingPathComponent("runtime/node").path,[project.appendingPathComponent("scripts/update-preflight.cjs").path,mode])
 guard result.0==0 else{try fail(result.1.trimmingCharacters(in:.whitespacesAndNewlines))}
 guard let data=result.1.data(using:.utf8),let value=try JSONSerialization.jsonObject(with:data) as? [String:Any] else{try fail("Invalid lifecycle response")};return value
}

func assertPersistentStateIdle(_ roots:[URL]) throws {
 for root in roots where fm.fileExists(atPath:root.path) {
  let directory=try root.resourceValues(forKeys:[.isDirectoryKey]).isDirectory==true
  let scan=try run("/usr/sbin/lsof",["-nP","-F","pfa"]+(directory ? ["+D",root.path]:["--",root.path]))
  if scan.0 != 0 && scan.0 != 1{try fail("Cannot prove persistent-state quiescence")}
  var descriptors=0,readOnly=0
  for line in scan.1.split(separator:"\n") {if line.hasPrefix("f"){descriptors+=1};if line=="ar"{readOnly+=1}}
  if descriptors != readOnly || (!scan.1.isEmpty && descriptors==0){try fail("Persistent state has a writer or unclassified open handle: \(root.lastPathComponent)")}
 }
}

func userStateRoots(_ data:URL) throws -> [URL] {
 try nodoBackupScope(data:data,userHome:home)
}

func assertPreserved(_ before:[String:Any],_ after:[String:Any]) throws {
 for key in ["sessions","taskIds","bindings","workspaceIds","tabIds"]{guard let a=before[key] as? [String],let b=after[key] as? [String],Set(a).isSubset(of:Set(b)) else{try fail("Post-update data check failed: \(key). Repair/Rollback required.")}}
 for key in ["settingsSHA","contextSHA"]{guard before[key] as? String==after[key] as? String else{try fail("User preferences changed: \(key)")}}
 let oldAttachments=before["attachments"] as? [[String:String]] ?? [],newAttachments=after["attachments"] as? [[String:String]] ?? []
 let found=Dictionary(newAttachments.compactMap{v->(String,String)? in guard let id=v["id"],let sha=v["sha"]else{return nil};return(id,sha)},uniquingKeysWith:{$1})
 for item in oldAttachments{guard let id=item["id"],found[id]==item["sha"] else{try fail("Attachment missing or changed after update")}}
 if let a=before["counts"] as? [String:Int],let b=after["counts"] as? [String:Int]{for(k,v)in a{guard b[k,default:0]>=v else{try fail("Persistent count decreased: \(k)")}}}else{try fail("Missing control counts")}
}
