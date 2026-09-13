import Foundation
import Security
import CryptoKit
let service="NODO Release Signing",account="ed25519-v1"
let q:[String:Any]=[kSecClass as String:kSecClassGenericPassword,kSecAttrService as String:service,kSecAttrAccount as String:account,kSecReturnData as String:true]
var result:CFTypeRef?;let status=SecItemCopyMatching(q as CFDictionary,&result)
let key:Curve25519.Signing.PrivateKey
if status==errSecSuccess,let data=result as? Data,let str=String(data:data,encoding:.utf8),let der=Data(base64Encoded:str),der.count==48 {
    key=try Curve25519.Signing.PrivateKey(rawRepresentation:der.suffix(32))
}else if status==errSecItemNotFound {
    key=Curve25519.Signing.PrivateKey()
    let prefix=Data([0x30,0x2e,0x02,0x01,0x00,0x30,0x05,0x06,0x03,0x2b,0x65,0x70,0x04,0x22,0x04,0x20])
    let value=Data((prefix+key.rawRepresentation).base64EncodedString().utf8)
    let add:[String:Any]=[kSecClass as String:kSecClassGenericPassword,kSecAttrService as String:service,kSecAttrAccount as String:account,kSecValueData as String:value,kSecAttrAccessible as String:kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
    guard SecItemAdd(add as CFDictionary,nil)==errSecSuccess else{exit(2)}
}else{fputs("Release signing Keychain unavailable\n",stderr);exit(3)}
let prefix=Data([0x30,0x2a,0x30,0x05,0x06,0x03,0x2b,0x65,0x70,0x03,0x21,0x00])
print((prefix+key.publicKey.rawRepresentation).base64EncodedString())
