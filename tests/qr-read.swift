import Foundation
import Vision
import AppKit
let data=FileHandle.standardInput.readDataToEndOfFile()
let request=VNDetectBarcodesRequest()
request.symbologies=[.qr]
do {
 try VNImageRequestHandler(data:data).perform([request])
 guard request.results?.first?.payloadStringValue == "https://example.com/#room=synthetic-room-123456789&pair=00000000-0000-4000-8000-000000000000&secret=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" else {exit(1)}
 guard let bitmap=NSBitmapImageRep(data:data),let corner=bitmap.colorAt(x:0,y:0)?.usingColorSpace(.deviceRGB),corner.redComponent>0.99,corner.greenComponent>0.99,corner.blueComponent>0.99,corner.alphaComponent>0.99 else {exit(2)}
 print("PASS native Vision QR decode and opaque white quiet zone")
} catch {exit(3)}
