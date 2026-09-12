import Foundation

// Transactional NODO recovery, not a disaster-recovery snapshot of nodo-optional.
// Keep exact bridge-owned state; never recursively select the shared plugin dir.
let nodoBridgeBackupFiles = [
 "state.json", "state.json.bak", "chat-sessions.json", "send-ledger.jsonl",
 "allowed-chats.json", "bridge-config.json", "include-bots.json", "title-emoji.json",
 "voice-cache.json", "watch-config.json", "restart-budget.json", "last-restart.json",
 "alerts.json", "alerts.jsonl"
]
func nodoBackupScope(data:URL,userHome:URL) throws -> [URL] {
 let manager=FileManager.default
 let bridge=userHome.appendingPathComponent(".dsh/plugins/telegram-bridge")
 let observer=userHome.appendingPathComponent(".dsh/plugins/sessions-observer")
 // The running installer and its log live in updates/. This is a disposable
 // download/staging cache, not user state. Include every other top-level entry,
 // including unknown future persistent files, instead of maintaining an allowlist.
 var roots=try manager.contentsOfDirectory(at:data,includingPropertiesForKeys:nil)
  .filter{$0.lastPathComponent != "updates"}.sorted{$0.path<$1.path}
 for file in nodoBridgeBackupFiles {
  let url=bridge.appendingPathComponent(file)
  if manager.fileExists(atPath:url.path) {
   let values=try url.resourceValues(forKeys:[.isRegularFileKey,.isSymbolicLinkKey])
   guard values.isRegularFile==true,values.isSymbolicLink != true else{throw NSError(domain:"NODOBackupScope",code:1,userInfo:[NSLocalizedDescriptionKey:"Unexpected bridge state path: \(file)"])}
   roots.append(url)
  } else if ["state.json","chat-sessions.json","allowed-chats.json","bridge-config.json"].contains(file) {
   throw NSError(domain:"NODOBackupScope",code:2,userInfo:[NSLocalizedDescriptionKey:"Required bridge state missing: \(file)"])
  }
 }
 for file in ["board.json","alerts.json","alerts-history.jsonl"] {
  let url=observer.appendingPathComponent(file)
  if manager.fileExists(atPath:url.path) {
   let values=try url.resourceValues(forKeys:[.isRegularFileKey,.isSymbolicLinkKey])
   guard values.isRegularFile==true,values.isSymbolicLink != true else{throw NSError(domain:"NODOBackupScope",code:3)}
   roots.append(url)
  }
 }
 return roots
}
