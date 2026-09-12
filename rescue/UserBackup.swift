import Foundation
import CryptoKit
import Security
import Darwin

// No plaintext archive is ever written. The caller must first quiesce every writer.
private let nodoBackupService = "NODO Backup/Recovery"
private let nodoBackupMagic = Data("NODOBACKUP2\n".utf8)
private let nodoBackupChunkSize = 1024 * 1024
private let nodoBackupFM = FileManager.default

private func nodoBackupError(_ message:String) -> NSError {
    NSError(domain:"NODO Backup/Recovery",code:1,userInfo:[NSLocalizedDescriptionKey:message])
}
private func nodoBackupHex(_ bytes:some Sequence<UInt8>) -> String { bytes.map{String(format:"%02x",$0)}.joined() }
private func nodoBackupUInt64(_ value:UInt64) -> Data { var n=value.bigEndian;return withUnsafeBytes(of:&n){Data($0)} }
private func nodoBackupReadUInt64(_ bytes:Data,_ offset:Int) throws -> UInt64 {
    guard offset>=0,bytes.count>=offset+8 else{throw nodoBackupError("Invalid encrypted frame")}
    return bytes.subdata(in:offset..<(offset+8)).reduce(UInt64(0)){($0 << 8) | UInt64($1)}
}
private func nodoBackupReadExact(_ handle:FileHandle,_ count:Int) throws -> Data {
    var output=Data();output.reserveCapacity(count)
    while output.count<count {
        guard let part=try handle.read(upToCount:count-output.count),!part.isEmpty else{throw nodoBackupError("Encrypted backup is truncated")}
        output.append(part)
    }
    return output
}
private func nodoBackupKey(_ identifier:String) throws -> SymmetricKey {
    guard UUID(uuidString:identifier) != nil else{throw nodoBackupError("Invalid backup identifier")}
    let query:[String:Any]=[kSecClass as String:kSecClassGenericPassword,kSecAttrService as String:nodoBackupService,kSecAttrAccount as String:identifier,kSecReturnData as String:true,kSecMatchLimit as String:kSecMatchLimitOne]
    var result:CFTypeRef?
    let status=SecItemCopyMatching(query as CFDictionary,&result)
    guard status==errSecSuccess,let bytes=result as? Data,bytes.count==32 else{throw nodoBackupError("The recovery key for this backup is unavailable in NODO Backup/Recovery (Keychain status \(status)).")}
    return SymmetricKey(data:bytes)
}
private func nodoBackupCreateKey(_ identifier:String) throws -> SymmetricKey {
    var bytes=[UInt8](repeating:0,count:32)
    guard SecRandomCopyBytes(kSecRandomDefault,bytes.count,&bytes)==errSecSuccess else{throw nodoBackupError("Cannot generate backup key")}
    let value=Data(bytes)
    let item:[String:Any]=[kSecClass as String:kSecClassGenericPassword,kSecAttrService as String:nodoBackupService,kSecAttrAccount as String:identifier,kSecAttrLabel as String:"NODO Backup/Recovery \(identifier)",kSecAttrDescription as String:"Recovery key for one encrypted NODO user-state backup",kSecAttrSynchronizable as String:false,kSecValueData as String:value]
    // Add only. Never update/delete existing Keychain items, even on failure.
    let status=SecItemAdd(item as CFDictionary,nil)
    guard status==errSecSuccess else{throw nodoBackupError("Cannot create the new recovery key (Keychain status \(status)); no backup started.")}
    return SymmetricKey(data:value)
}
func validateRecoveryKey(_ account:String) throws { _ = try nodoBackupKey(account) }
private func nodoBackupRoots(_ input:[URL],_ destination:URL) throws -> ([URL],URL,[String]) {
    guard !input.isEmpty,destination.isFileURL else{throw nodoBackupError("Explicit source roots and a local destination are required")}
    let canonical=input.map{$0.standardizedFileURL.resolvingSymlinksInPath()}.sorted{$0.path<$1.path}
    var roots=[URL]()
    for root in canonical {
        guard root.isFileURL,root.path != "/",nodoBackupFM.fileExists(atPath:root.path) else{throw nodoBackupError("A requested backup root is missing or invalid")}
        if roots.contains(where:{root.path==$0.path || root.path.hasPrefix($0.path+"/")}){continue}
        roots.append(root)
    }
    let target=destination.standardizedFileURL.resolvingSymlinksInPath().path
    guard !roots.contains(where:{target==$0.path || target.hasPrefix($0.path+"/")}) else{throw nodoBackupError("Backup destination must be outside the source roots")}
    var common=roots[0].deletingLastPathComponent().pathComponents
    for root in roots.dropFirst(){let other=root.deletingLastPathComponent().pathComponents;common=Array(common.prefix(zip(common,other).prefix(while:{$0.0==$0.1}).count))}
    let base=URL(fileURLWithPath:NSString.path(withComponents:common),isDirectory:true)
    let relative=roots.map{String($0.path.dropFirst(base.path=="/" ? 1:base.path.count+1))}
    guard relative.allSatisfy({!$0.isEmpty && !$0.hasPrefix("/") && !$0.split(separator:"/").contains("..")}) else{throw nodoBackupError("Unsafe archive root")}
    return (roots,base,relative)
}
private func nodoBackupInventory(_ roots:[URL]) throws -> [String:Any] {
    var files=0,folders=0,links=0,bytes:Int64=0,hash=SHA256()
    let keys:Set<URLResourceKey>=[.isRegularFileKey,.isDirectoryKey,.isSymbolicLinkKey,.fileSizeKey,.contentModificationDateKey]
    func inspect(_ url:URL) throws {
        let values=try url.resourceValues(forKeys:keys)
        let type:String
        if values.isSymbolicLink==true{links+=1;type="link"}
        else if values.isDirectory==true{folders+=1;type="directory"}
        else if values.isRegularFile==true{files+=1;bytes+=Int64(values.fileSize ?? 0);type="file"}
        else{type="special"}
        let record="\(url.path)\u{0}\(type)\u{0}\(values.fileSize ?? 0)\u{0}\(values.contentModificationDate?.timeIntervalSince1970 ?? 0)\n"
        hash.update(data:Data(record.utf8))
        if type=="link"{hash.update(data:Data(try nodoBackupFM.destinationOfSymbolicLink(atPath:url.path).utf8))}
    }
    for root in roots {
        try inspect(root)
        if try root.resourceValues(forKeys:[.isDirectoryKey]).isDirectory==true {
            var enumerationError:Error?
            guard let walker=nodoBackupFM.enumerator(at:root,includingPropertiesForKeys:Array(keys),options:[],errorHandler:{_,error in enumerationError=error;return false}) else{throw nodoBackupError("Cannot enumerate requested backup root")}
            for case let url as URL in walker{try inspect(url)}
            if let error=enumerationError{throw error}
        }
    }
    return ["fileCount":files,"directoryCount":folders,"symlinkCount":links,"fileBytes":bytes,"inventorySHA256":nodoBackupHex(hash.finalize())]
}
private func nodoBackupProcess(_ args:[String]) -> Process {
    let process=Process();process.executableURL=URL(fileURLWithPath:"/usr/bin/tar");process.arguments=args
    process.standardError=FileHandle.nullDevice
    return process
}
private func nodoBackupWriteFrame(_ payload:Data,_ key:SymmetricKey,_ aad:Data,_ output:FileHandle,_ encryptedHash:inout SHA256,_ encryptedBytes:inout UInt64) throws {
    guard let sealed=try AES.GCM.seal(payload,using:key,authenticating:aad).combined else{throw nodoBackupError("Cannot seal backup frame")}
    guard sealed.count<=nodoBackupChunkSize+128 else{throw nodoBackupError("Backup frame exceeds limit")}
    var length=UInt32(sealed.count).bigEndian
    let prefix=withUnsafeBytes(of:&length){Data($0)}
    try output.write(contentsOf:prefix);try output.write(contentsOf:sealed)
    encryptedHash.update(data:prefix);encryptedHash.update(data:sealed);encryptedBytes+=UInt64(prefix.count+sealed.count)
}
private func nodoBackupHeader(_ input:FileHandle) throws -> (String,Data) {
    let header=try nodoBackupReadExact(input,nodoBackupMagic.count+36)
    guard header.prefix(nodoBackupMagic.count)==nodoBackupMagic,let identifier=String(data:header.suffix(36),encoding:.utf8),UUID(uuidString:identifier) != nil else{throw nodoBackupError("Unsupported backup format")}
    return (identifier,header)
}
private func nodoBackupVerify(_ archive:URL,_ suppliedKey:SymmetricKey?,consume:((Data)throws->Void)?=nil) throws -> [String:Any] {
    let input=try FileHandle(forReadingFrom:archive);defer{try? input.close()}
    let (identifier,header)=try nodoBackupHeader(input)
    let key=try suppliedKey ?? nodoBackupKey(identifier)
    var encryptedHash=SHA256(),plainHash=SHA256(),encryptedBytes=UInt64(header.count),plainBytes:UInt64=0,sequence:UInt64=0
    encryptedHash.update(data:header)
    while true {
        let prefix=try nodoBackupReadExact(input,4)
        let length=prefix.reduce(UInt32(0)){($0<<8)|UInt32($1)}
        guard length>=37,length<=UInt32(nodoBackupChunkSize+128) else{throw nodoBackupError("Invalid encrypted backup frame size")}
        let encoded=try nodoBackupReadExact(input,Int(length));encryptedHash.update(data:prefix);encryptedHash.update(data:encoded);encryptedBytes+=UInt64(4)+UInt64(length)
        let payload:Data
        do{payload=try AES.GCM.open(AES.GCM.SealedBox(combined:encoded),using:key,authenticating:header)}catch{throw nodoBackupError("Backup authentication failed; archive/key does not match")}
        guard payload.count>=9,try nodoBackupReadUInt64(payload,1)==sequence else{throw nodoBackupError("Backup frame sequence is invalid")}
        if payload[0]==0 {
            let chunk=payload.subdata(in:9..<payload.count);guard !chunk.isEmpty else{throw nodoBackupError("Empty backup data frame")}
            plainHash.update(data:chunk);plainBytes+=UInt64(chunk.count);sequence+=1;try consume?(chunk)
        }else if payload[0]==1 {
            guard payload.count==49,try nodoBackupReadUInt64(payload,9)==plainBytes else{throw nodoBackupError("Backup footer length mismatch")}
            let digest=Data(plainHash.finalize());guard payload.subdata(in:17..<49)==digest else{throw nodoBackupError("Backup plaintext SHA256 mismatch")}
            guard (try input.read(upToCount:1))?.isEmpty != false else{throw nodoBackupError("Unexpected bytes after authenticated backup footer")}
            return ["backupID":identifier,"archiveSHA256":nodoBackupHex(encryptedHash.finalize()),"streamSHA256":nodoBackupHex(digest),"plaintextBytes":plainBytes,"encryptedBytes":encryptedBytes,"chunkCount":sequence,"verified":true]
        }else{throw nodoBackupError("Unsupported backup frame type")}
    }
}
private func nodoBackupPerform(_ roots:[URL],_ destination:URL,_ identifier:String,_ key:SymmetricKey) throws -> [String:Any] {
    let (sources,base,relative)=try nodoBackupRoots(roots,destination)
    guard !nodoBackupFM.fileExists(atPath:destination.path) else{throw nodoBackupError("Backup destination already exists; refusing overwrite")}
    let before=try nodoBackupInventory(sources)
    try nodoBackupFM.createDirectory(at:destination,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])
    let partial=destination.appendingPathComponent("user-state.partial.nodobackup"),archive=destination.appendingPathComponent("user-state.nodobackup")
    guard nodoBackupFM.createFile(atPath:partial.path,contents:nil,attributes:[.posixPermissions:0o600]) else{throw nodoBackupError("Cannot create encrypted backup")}
    let output=try FileHandle(forWritingTo:partial);defer{try? output.close()}
    let process=nodoBackupProcess(["-cpf","-","-C",base.path,"--"]+relative),pipe=Pipe();process.standardOutput=pipe
    try process.run();defer{if process.isRunning{process.terminate();process.waitUntilExit()}}
    defer{try? pipe.fileHandleForReading.close()}
    let header=nodoBackupMagic+Data(identifier.utf8)
    try output.write(contentsOf:header)
    var encryptedHash=SHA256(),plainHash=SHA256(),encryptedBytes=UInt64(header.count),plainBytes:UInt64=0,sequence:UInt64=0
    encryptedHash.update(data:header)
    while let chunk=try pipe.fileHandleForReading.read(upToCount:nodoBackupChunkSize),!chunk.isEmpty {
        plainHash.update(data:chunk);plainBytes+=UInt64(chunk.count)
        try nodoBackupWriteFrame(Data([0])+nodoBackupUInt64(sequence)+chunk,key,header,output,&encryptedHash,&encryptedBytes);sequence+=1
    }
    process.waitUntilExit();guard process.terminationStatus==0 else{throw nodoBackupError("tar failed (\(process.terminationStatus)); encrypted partial archive retained")}
    let after=try nodoBackupInventory(sources)
    guard before["inventorySHA256"] as? String==after["inventorySHA256"] as? String else{throw nodoBackupError("Source metadata changed during backup; partial archive is not accepted")}
    let digest=Data(plainHash.finalize())
    try nodoBackupWriteFrame(Data([1])+nodoBackupUInt64(sequence)+nodoBackupUInt64(plainBytes)+digest,key,header,output,&encryptedHash,&encryptedBytes)
    try output.synchronize();try output.close()
    var receipt=try nodoBackupVerify(partial,key)
    guard receipt["archiveSHA256"] as? String==nodoBackupHex(encryptedHash.finalize()) else{throw nodoBackupError("Encrypted file readback mismatch")}
    try nodoBackupFM.moveItem(at:partial,to:archive)
    receipt["schema"]=2;receipt["keychainService"]=nodoBackupService;receipt["archivePath"]=archive.path;receipt["commonRoot"]=base.path;receipt["roots"]=relative;receipt["inventory"]=before;receipt["createdAt"]=ISO8601DateFormatter().string(from:Date())
    try JSONSerialization.data(withJSONObject:receipt,options:[.prettyPrinted,.sortedKeys]).write(to:destination.appendingPathComponent("receipt.json"),options:.atomic)
    return receipt
}

/// Writes a new key under NODO Backup/Recovery, then a streaming encrypted backup.
/// destination is a NEW directory outside all roots. Never exports existing Keychain auth.
func backupUserState(roots:[URL],destination:URL,recoveryKeyAccount:String?=nil) throws -> [String:Any] {
    _=try nodoBackupRoots(roots,destination)
    guard !nodoBackupFM.fileExists(atPath:destination.path) else{throw nodoBackupError("Backup destination already exists")}
    let identifier=recoveryKeyAccount ?? UUID().uuidString
    let key = recoveryKeyAccount == nil ? try nodoBackupCreateKey(identifier) : try nodoBackupKey(identifier)
    return try nodoBackupPerform(roots,destination,identifier,key)
}
/// Reads only the key with this archive's UUID in the dedicated recovery service.
func verifyUserBackup(archive:URL) throws -> [String:Any] { try nodoBackupVerify(archive,nil) }
private func nodoBackupRestore(_ archive:URL,_ destination:URL,_ key:SymmetricKey?) throws -> [String:Any] {
    let verified=try nodoBackupVerify(archive,key)
    guard destination.isFileURL,!nodoBackupFM.fileExists(atPath:destination.path) else{throw nodoBackupError("Restore requires a NEW isolated directory; existing paths are never overwritten")}
    try nodoBackupFM.createDirectory(at:destination,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])
    // No -P / absolute paths / symlink-following options; libarchive's traversal checks remain enabled.
    let process=nodoBackupProcess(["-xpf","-","--no-same-owner","-C",destination.path]),pipe=Pipe();process.standardInput=pipe;process.standardOutput=FileHandle.nullDevice
    try process.run();defer{if process.isRunning{process.terminate();process.waitUntilExit()}}
    defer{try? pipe.fileHandleForWriting.close()}
    _=fcntl(pipe.fileHandleForWriting.fileDescriptor,F_SETNOSIGPIPE,1)
    let readback=try nodoBackupVerify(archive,key){try pipe.fileHandleForWriting.write(contentsOf:$0)}
    try pipe.fileHandleForWriting.close();process.waitUntilExit()
    guard process.terminationStatus==0 else{throw nodoBackupError("Extraction failed; partial output remains only in the new isolated directory")}
    guard readback["archiveSHA256"] as? String==verified["archiveSHA256"] as? String else{throw nodoBackupError("Archive changed between verification and extraction")}
    var result=verified;result["restoredTo"]=destination.path;result["restored"]=true;return result
}
func restoreUserBackup(archive:URL,destination:URL) throws -> [String:Any] { try nodoBackupRestore(archive,destination,nil) }

#if NODO_BACKUP_TESTING
// Not compiled into Rescue. Synthetic tests never read or write Keychain.
func backupUserStateForTesting(roots:[URL],destination:URL,key:Data) throws -> [String:Any] {
    guard key.count==32 else{throw nodoBackupError("Test key must be 256 bits")}
    return try nodoBackupPerform(roots,destination,UUID().uuidString,SymmetricKey(data:key))
}
func verifyUserBackupForTesting(archive:URL,key:Data) throws -> [String:Any] {try nodoBackupVerify(archive,SymmetricKey(data:key))}
func restoreUserBackupForTesting(archive:URL,destination:URL,key:Data) throws -> [String:Any] {try nodoBackupRestore(archive,destination,SymmetricKey(data:key))}
#endif
