import Foundation
import CryptoKit

@main struct BackupAcceptance {
    static func require(_ condition:Bool,_ message:String) throws {if !condition{throw NSError(domain:"BackupAcceptance",code:1,userInfo:[NSLocalizedDescriptionKey:message])}}
    static func main() throws {
        let keychainTest=CommandLine.arguments.contains("--keychain")
        let fm=FileManager.default,root=fm.temporaryDirectory.appendingPathComponent("nodo-backup-test-\(UUID().uuidString)")
        let profile=root.appendingPathComponent("sources/NODO"),telegram=root.appendingPathComponent("sources/telegram-state"),backup=root.appendingPathComponent("encrypted")
        try fm.createDirectory(at:profile.appendingPathComponent("sessions"),withIntermediateDirectories:true)
        try fm.createDirectory(at:telegram,withIntermediateDirectories:true)
        let secret=Data("synthetic-token-only-not-a-real-secret".utf8),history=Data((0..<(3*1024*1024+73)).map{UInt8($0%251)})
        try secret.write(to:profile.appendingPathComponent(".auth.json"));try history.write(to:profile.appendingPathComponent("sessions/history.bin"))
        try Data("synthetic external telegram state".utf8).write(to:telegram.appendingPathComponent("ledger.json"))
        try fm.createSymbolicLink(atPath:profile.appendingPathComponent("history-link").path,withDestinationPath:"sessions/history.bin")
        let key=Data(repeating:0x7A,count:32)
        func verify(_ archive:URL) throws -> [String:Any] {keychainTest ? try verifyUserBackup(archive:archive) : try verifyUserBackupForTesting(archive:archive,key:key)}
        func restore(_ archive:URL,_ destination:URL) throws -> [String:Any] {keychainTest ? try restoreUserBackup(archive:archive,destination:destination) : try restoreUserBackupForTesting(archive:archive,destination:destination,key:key)}
        let receipt=keychainTest ? try backupUserState(roots:[profile,telegram],destination:backup) : try backupUserStateForTesting(roots:[profile,telegram],destination:backup,key:key)
        let archive=backup.appendingPathComponent("user-state.nodobackup")
        _=try verify(archive)
        try require(receipt["verified"] as? Bool==true,"Backup was not verified")
        try require((receipt["chunkCount"] as? UInt64 ?? 0)>1,"Expected streaming frames")
        try require(try Data(contentsOf:archive).range(of:secret)==nil,"Plaintext leaked into encrypted archive")
        let items=try fm.contentsOfDirectory(atPath:backup.path).sorted();try require(items==["receipt.json","user-state.nodobackup"],"Unexpected plaintext or partial output")
        let restored=root.appendingPathComponent("isolated-restore")
        _=try restore(archive,restored)
        try require(try Data(contentsOf:restored.appendingPathComponent("NODO/.auth.json"))==secret,"Auth fixture mismatch")
        try require(try Data(contentsOf:restored.appendingPathComponent("NODO/sessions/history.bin"))==history,"History mismatch")
        try require(try Data(contentsOf:restored.appendingPathComponent("telegram-state/ledger.json"))==Data("synthetic external telegram state".utf8),"External root missing")
        try require(try fm.destinationOfSymbolicLink(atPath:restored.appendingPathComponent("NODO/history-link").path)=="sessions/history.bin","Symlink mismatch")
        var refused=false;do{_=try restore(archive,restored)}catch{refused=true};try require(refused,"Existing destination was not refused")
        var damaged=try Data(contentsOf:archive);damaged[damaged.count/2]^=0x01;let bad=root.appendingPathComponent("tampered.nodobackup");try damaged.write(to:bad)
        refused=false;do{_=try verify(bad)}catch{refused=true};try require(refused,"Tampered backup accepted")
        let badRestore=root.appendingPathComponent("must-not-exist");do{_=try restore(bad,badRestore)}catch{}
        try require(!fm.fileExists(atPath:badRestore.path),"Tampered archive extracted before authentication")
        let truncated=root.appendingPathComponent("truncated.nodobackup");try Data((try Data(contentsOf:archive)).dropLast(64)).write(to:truncated);refused=false;do{_=try verify(truncated)}catch{refused=true};try require(refused,"Truncation accepted")
        if keychainTest {
            let report:[String:Any]=["pass":true,"backupID":receipt["backupID"]!,"receiptPath":backup.appendingPathComponent("receipt.json").path,"archivePath":archive.path,"keychainService":"NODO Backup/Recovery","keyRetained":true]
            print(String(data:try JSONSerialization.data(withJSONObject:report,options:.sortedKeys),encoding:.utf8)!)
        }else{print("PASS: streaming encrypted multi-root roundtrip, exact bytes and symlink, no plaintext archive, existing-target refusal, tamper/truncation rejection before extraction. Keychain not accessed.")}
    }
}
