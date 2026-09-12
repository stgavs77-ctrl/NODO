import Foundation
import CoreImage
import AppKit
// Pairing URL enters only over stdin. No temporary image or secret argv/log.
let input=FileHandle.standardInput.readDataToEndOfFile()
guard input.count>0,input.count<4096,let filter=CIFilter(name:"CIQRCodeGenerator") else {exit(1)}
filter.setValue(input,forKey:"inputMessage")
filter.setValue("M",forKey:"inputCorrectionLevel")
// Four-module opaque white quiet zone is required for reliable camera scanning.
guard let raw=filter.outputImage else {exit(1)}
let bounds=raw.extent.insetBy(dx:-4,dy:-4)
let white=CIImage(color:CIColor(red:1,green:1,blue:1,alpha:1)).cropped(to:bounds)
let qr=raw.composited(over:white).transformed(by:CGAffineTransform(scaleX:8,y:8))
guard let cg=CIContext().createCGImage(qr,from:qr.extent),let png=NSBitmapImageRep(cgImage:cg).representation(using:.png,properties:[:]) else {exit(1)}
FileHandle.standardOutput.write(png)
