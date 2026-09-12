import Foundation
import CryptoKit

let fm=FileManager.default
let home=URL(fileURLWithPath:CommandLine.arguments[1])
var mockLoaded=true
var mockDisabled="disabled = { com.nodo-optional.dsh-watchdog => true }"
var calls:[[String]]=[]
enum FixtureError:Error {case failed(String)}
func fail(_ message:String) throws -> Never {throw FixtureError.failed(message)}
func check(_ condition:Bool,_ message:String)throws{if !condition{try fail(message)}}
func digest(_ url:URL)throws->String{SHA256.hash(data:try Data(contentsOf:url)).map{String(format:"%02x",$0)}.joined()}
func write(_ value:[String:Any],_ url:URL)throws{try JSONSerialization.data(withJSONObject:value,options:.sortedKeys).write(to:url,options:.atomic)}
func json(_ url:URL)throws->[String:Any]{try JSONSerialization.jsonObject(with:Data(contentsOf:url)) as! [String:Any]}
// Fake backend: NEVER executes any subprocess, launchctl, or shell command.
func run(_ executable:String,_ args:[String])throws->(Int32,String){
 try check(executable=="/bin/launchctl","unexpected executable")
 let domain="gui/\(getuid())",service=domain+"/com.nodo-optional.dsh-watchdog"
 let allowed:[[String]]=[["print",service],["print-disabled",domain],["bootout",service],["bootstrap",domain,home.appendingPathComponent("Library/LaunchAgents/com.nodo-optional.dsh-watchdog.plist").path]]
 try check(allowed.contains(args),"unexpected job or mutation command")
 calls.append(args)
 switch args[0]{
 case "print":return mockLoaded ? (0,"state = waiting\n"):(113,"not found")
 case "print-disabled":return (0,mockDisabled)
 case "bootout":mockLoaded=false;return (0,"")
 case "bootstrap":mockLoaded=true;return (0,"")
 default:try fail("unreachable")
 }
}
@main struct Main{
 static func main()throws{
  let plist=home.appendingPathComponent("Library/LaunchAgents/com.nodo-optional.dsh-watchdog.plist")
  try fm.createDirectory(at:plist.deletingLastPathComponent(),withIntermediateDirectories:true)
  let original=try PropertyListSerialization.data(fromPropertyList:["Label":"com.nodo-optional.dsh-watchdog","StartInterval":20],format:.xml,options:0)
  try original.write(to:plist)
  let disabledBefore=mockDisabled
  let first=WatchdogTransaction(home.appendingPathComponent("loaded.json"))
  try first.capture();try check(first.record["loaded"] as? Bool==true,"loaded capture")
  try first.suspend();try check(!mockLoaded,"suspend")
  let recovered=WatchdogTransaction(first.journal);try recovered.restore()
  try check(mockLoaded,"persisted cleanup restore")
  try check(calls.filter{$0[0]=="bootout"}.count==1&&calls.filter{$0[0]=="bootstrap"}.count==1,"exact transition count")
  try check(mockDisabled==disabledBefore,"disabled state changed")
  try check(try Data(contentsOf:plist)==original,"plist rewritten")

  calls=[];mockLoaded=false
  let unloaded=WatchdogTransaction(home.appendingPathComponent("unloaded.json"))
  try unloaded.capture();try unloaded.suspend();try unloaded.restore()
  try check(!mockLoaded,"unloaded job started")
  try check(!calls.contains{$0[0]=="bootstrap"||$0[0]=="bootout"},"unloaded mutation")

  calls=[];mockLoaded=true
  let cleanup=WatchdogTransaction(home.appendingPathComponent("cleanup.json"))
  try cleanup.capture()
  do{try cleanup.suspend();try fail("synthetic install failure")}catch{try cleanup.restore()}
  try check(mockLoaded,"cleanup after throw did not restore")

  calls=[];mockLoaded=true
  let migrated=WatchdogTransaction(home.appendingPathComponent("migrated.json"))
  try migrated.capture();try migrated.suspend();try migrated.migrateLaunchTarget()
  try check(try Data(contentsOf:plist) != original,"target not migrated")
  try WatchdogTransaction(migrated.journal).restore()
  try check(try Data(contentsOf:plist)==original,"interrupted target migration not reverted")
  let committed=WatchdogTransaction(home.appendingPathComponent("committed.json"))
  try committed.capture();try committed.suspend();try committed.migrateLaunchTarget();try committed.commitLaunchTarget()
  try WatchdogTransaction(committed.journal).restore()
  let updated=NSDictionary(contentsOf:plist)!["EnvironmentVariables"] as! [String:String]
  try check(updated["DSH_BRIDGE_RESTART"]==home.appendingPathComponent("Applications/NODO.app/Contents/Resources/project/scripts/start-current-nodo.command").path,"unstable target")
  try check(mockLoaded,"committed watchdog not restored")
  try original.write(to:plist)
  calls=[]
  let drift=WatchdogTransaction(home.appendingPathComponent("drift.json"))
  try drift.capture();try drift.suspend()
  var changed=original;changed.append(Data("\n".utf8));try changed.write(to:plist)
  var refused=false
  do{try drift.restore()}catch{refused=true}
  try check(refused,"concurrent plist drift accepted")
  try check(try Data(contentsOf:plist)==changed,"concurrent plist overwritten")
  try check(!mockLoaded && !calls.contains{$0[0]=="bootstrap"},"drift bootstrapped")
  try check(mockDisabled==disabledBefore,"disabled state changed after failure")
  print("PASS loaded/unloaded capture, exact suspend/restore, persisted cleanup, throw cleanup, drift refusal, disabled state unchanged; mock backend only")
 }
}
