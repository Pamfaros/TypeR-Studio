// Draws the app's icons and launch images for iOS and Android from the brand's own icon
// (assets/brand/typer-studio-icon.png). To run again when that icon changes:
//
//   swift scripts/make-icons.swift
//
// iOS wants one square, opaque icon and rounds it itself. Android wants the picture alone, small
// enough to be cut into any shape, over a plain colour: the icon's own dark grey, read from it.

import AppKit
import CoreGraphics

let here = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
let mobile = here.deletingLastPathComponent()
let brand = mobile.deletingLastPathComponent().appendingPathComponent("assets/brand/typer-studio-icon.png")

guard let source = NSImage(contentsOf: brand)?.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    fatalError("No icon at \(brand.path)")
}

let space = CGColorSpace(name: CGColorSpace.sRGB)!
func canvas(_ width: Int, _ height: Int) -> CGContext {
    let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    context.interpolationQuality = .high
    return context
}

// The icon's dark grey, from a point inside its rounded square and outside its bubble
let probe = canvas(source.width, source.height)
probe.draw(source, in: CGRect(x: 0, y: 0, width: source.width, height: source.height))
let pixels = probe.data!.assumingMemoryBound(to: UInt8.self)
let at = (source.height / 16) * probe.bytesPerRow + (source.width / 2) * 4
let grey = CGColor(colorSpace: space, components: [CGFloat(pixels[at]) / 255, CGFloat(pixels[at + 1]) / 255, CGFloat(pixels[at + 2]) / 255, 1])!
let hex = String(format: "#%02X%02X%02X", pixels[at], pixels[at + 1], pixels[at + 2])

func save(_ context: CGContext, _ path: String, opaque: Bool = false) {
    let url = mobile.appendingPathComponent(path)
    try! FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    var image = context.makeImage()!
    if opaque {
        let flat = CGContext(data: nil, width: image.width, height: image.height, bitsPerComponent: 8, bytesPerRow: 0, space: space, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
        flat.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        image = flat.makeImage()!
    }
    let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:])!
    try! png.write(to: url)
    print(path)
}

// `scale`: how much of the canvas the icon takes; `fill`: the dark grey behind it; `round`: cut as a disc
func draw(_ width: Int, _ height: Int, scale: CGFloat, fill: Bool, round: Bool = false) -> CGContext {
    let context = canvas(width, height)
    let whole = CGRect(x: 0, y: 0, width: width, height: height)
    if round { context.addEllipse(in: whole); context.clip() }
    if fill { context.setFillColor(grey); context.fill(whole) }
    let side = CGFloat(min(width, height)) * scale
    context.draw(source, in: CGRect(x: (CGFloat(width) - side) / 2, y: (CGFloat(height) - side) / 2, width: side, height: side))
    return context
}

// iOS
save(draw(1024, 1024, scale: 1, fill: true), "ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png", opaque: true)
for name in ["splash-2732x2732.png", "splash-2732x2732-1.png", "splash-2732x2732-2.png"] {
    save(draw(2732, 2732, scale: 0.16, fill: true), "ios/App/App/Assets.xcassets/Splash.imageset/\(name)", opaque: true)
}

// Android: 48 dp for the plain icon, 108 dp for the picture of the adaptive one
for (density, factor) in [("mdpi", 1.0), ("hdpi", 1.5), ("xhdpi", 2.0), ("xxhdpi", 3.0), ("xxxhdpi", 4.0)] {
    let folder = "android/app/src/main/res/mipmap-\(density)"
    let plain = Int(48 * factor)
    let adaptive = Int(108 * factor)
    save(draw(plain, plain, scale: 1, fill: false), "\(folder)/ic_launcher.png")
    save(draw(plain, plain, scale: 1.12, fill: true, round: true), "\(folder)/ic_launcher_round.png")
    save(draw(adaptive, adaptive, scale: 0.72, fill: false), "\(folder)/ic_launcher_foreground.png")
}
let colors = """
<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">\(hex)</color>
</resources>

"""
try! colors.write(to: mobile.appendingPathComponent("android/app/src/main/res/values/ic_launcher_background.xml"), atomically: true, encoding: .utf8)
print("The icon's grey: \(hex)")
