import Foundation
#if NODO_UPDATER_TESTING
func nodoTestCommand(_ executable:String,_ args:[String]) throws -> (Int32,String)? {
 guard executable=="/bin/launchctl" else{return nil}
 let root=URL(fileURLWithPath:ProcessInfo.processInfo.environment["NODO_TEST_HOME"]!),domain="gui/\(getuid())"
 let labels=["com.example-local.dsh-watchdog","com.example-local.vk-factoscope"]
 let label=labels.first{args.contains(domain+"/"+$0)||args.contains(root.appendingPathComponent("Library/LaunchAgents/"+$0+".plist").path)} ?? "com.example-local.dsh-watchdog"
 let service=domain+"/"+label,plist=root.appendingPathComponent("Library/LaunchAgents/"+label+".plist")
 guard [["print",service],["print-disabled",domain],["bootout",service],["bootstrap",domain,plist.path]].contains(args) else{throw NSError(domain:"Fixture",code:1,userInfo:[NSLocalizedDescriptionKey:"Unexpected launchctl command"])}
 let state=root.appendingPathComponent(label=="com.example-local.dsh-watchdog" ? "mock-watchdog.json":"mock-factoscope.json"),log=root.appendingPathComponent("mock-watchdog-calls.jsonl")
 let bytes=try Data(contentsOf:state),value=try JSONSerialization.jsonObject(with:bytes) as! [String:Bool]
 let loaded=value["loaded"]==true
 let row=try JSONSerialization.data(withJSONObject:args)+Data("\n".utf8)
 if !FileManager.default.fileExists(atPath:log.path){FileManager.default.createFile(atPath:log.path,contents:nil)}
 let handle=try FileHandle(forWritingTo:log);try handle.seekToEnd();try handle.write(contentsOf:row);try handle.close()
 if args[0]=="print"{return loaded ? (0,"state = waiting\n"):(113,"not found")}
 if args[0]=="print-disabled"{return (0,"com.example-local.dsh-watchdog => false\ncom.example-local.vk-factoscope => false\n")}
 try JSONSerialization.data(withJSONObject:["loaded":args[0]=="bootstrap"]).write(to:state,options:.atomic)
 return (0,"")
}
#endif
