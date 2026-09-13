import Foundation
import Security
import CryptoKit

// Dedicated relay credential. Never place its value in arguments, output or files.
let service = "NODO Remote/Relay"
let account = "nodo-remote-relay"
let query: [String: Any] = [kSecClass as String:kSecClassGenericPassword,
    kSecAttrService as String:service,kSecAttrAccount as String:account,
    kSecReturnData as String:true,kSecMatchLimit as String:kSecMatchLimitOne]
var item: CFTypeRef?
let status = SecItemCopyMatching(query as CFDictionary, &item)
let data: Data
if status == errSecSuccess, let existing = item as? Data { data = existing }
else if status == errSecItemNotFound {
    var bytes = [UInt8](repeating:0,count:32)
    guard SecRandomCopyBytes(kSecRandomDefault,bytes.count,&bytes) == errSecSuccess else { exit(2) }
    let key=Data(bytes).base64EncodedString().replacingOccurrences(of:"+",with:"-").replacingOccurrences(of:"/",with:"_").replacingOccurrences(of:"=",with:"")
    data=Data(key.utf8)
    let add:[String:Any]=[kSecClass as String:kSecClassGenericPassword,kSecAttrService as String:service,
        kSecAttrAccount as String:account,kSecAttrLabel as String:"NODO Remote - Relay host authentication",
        kSecValueData as String:data,kSecAttrAccessible as String:kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
    guard SecItemAdd(add as CFDictionary,nil) == errSecSuccess else { exit(3) }
} else { fputs("NODO Remote Keychain is unavailable\n",stderr);exit(4) }
// Digest is a verifier, not the bearer credential. No existing item is overwritten.
print(SHA256.hash(data:data).map{String(format:"%02x",$0)}.joined())
