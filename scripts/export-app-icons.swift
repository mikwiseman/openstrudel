#!/usr/bin/env swift
import Foundation
import CoreGraphics
import ImageIO

// Export the approved artwork without redrawing or recoloring the character.
let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
let native = root.appendingPathComponent("native/OpenStrudel")
let assets = native.appendingPathComponent("Assets.xcassets")
let sources = native.appendingPathComponent("IconSources")

func load(_ url: URL) throws -> CGImage {
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
        throw NSError(domain: "IconExport", code: 1, userInfo: [NSLocalizedDescriptionKey: "Cannot read \(url.path)"])
    }
    return image
}

func export(_ image: CGImage, size: Int, height: Int? = nil, inset: CGFloat = 0, opaque: Bool = false, to url: URL) throws {
    let alpha: CGImageAlphaInfo = opaque ? .noneSkipLast : .premultipliedLast
    guard let space = CGColorSpace(name: CGColorSpace.sRGB),
          let context = CGContext(data: nil, width: size, height: height ?? size,
              bitsPerComponent: 8, bytesPerRow: 0, space: space, bitmapInfo: alpha.rawValue) else {
        throw NSError(domain: "IconExport", code: 2)
    }
    context.interpolationQuality = .high
    let edge = CGFloat(size)
    let canvas = CGRect(x: 0, y: 0, width: edge, height: CGFloat(height ?? size))
    context.draw(image, in: canvas.insetBy(dx: edge * inset, dy: edge * inset))
    guard let output = context.makeImage(),
          let destination = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil) else {
        throw NSError(domain: "IconExport", code: 3)
    }
    CGImageDestinationAddImage(destination, output, nil)
    guard CGImageDestinationFinalize(destination) else { throw NSError(domain: "IconExport", code: 4) }
}

let approved = try load(sources.appendingPathComponent("Assistant.png"))
let square = try load(sources.appendingPathComponent("Graphite.icon/Assets/Strudel.png"))

// Trim only the transparent canvas of the template glyph. Keep its alpha so
// macOS can tint it automatically for light and dark menu bars.
let menuSource = try load(sources.appendingPathComponent("MenuTemplate.png"))
let menuWidth = menuSource.width, menuHeight = menuSource.height
let menuContext = CGContext(data: nil, width: menuWidth, height: menuHeight,
    bitsPerComponent: 8, bytesPerRow: menuWidth * 4,
    space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
menuContext.draw(menuSource, in: CGRect(x: 0, y: 0, width: menuWidth, height: menuHeight))
let pixels = menuContext.data!.assumingMemoryBound(to: UInt8.self)
var left = menuWidth, top = menuHeight, right = 0, bottom = 0
for y in 0..<menuHeight {
    for x in 0..<menuWidth where pixels[(y * menuWidth + x) * 4 + 3] > 0 {
        left = min(left, x); right = max(right, x)
        top = min(top, y); bottom = max(bottom, y)
    }
}
precondition(left <= right && top <= bottom, "Menu template is empty")
let menu = menuContext.makeImage()!.cropping(to: CGRect(x: left, y: top,
    width: right - left + 1, height: bottom - top + 1))!
for scale in 1...3 {
    try export(menu, size: 20 * scale, height: 17 * scale,
        to: assets.appendingPathComponent("MenuStrudel.imageset/menu-\(scale)x.png"))
}

// The tile fills ~92% of its source canvas. This inset gives it the ~82%
// optical footprint of neighboring macOS icons, including in the Dock.
let macInset: CGFloat = 0.06
for size in [16, 32, 64, 128, 256, 512, 1024] {
    try export(approved, size: size, inset: macInset,
               to: assets.appendingPathComponent("AppIcon.appiconset/appicon-\(size).png"))
}
for name in ["DockCream", "DockGraphite"] {
    try export(approved, size: 1024, inset: macInset,
               to: assets.appendingPathComponent("\(name).imageset/icon.png"))
}
try export(approved, size: 1024, inset: macInset,
           to: assets.appendingPathComponent("OpenStrudelMark.imageset/OpenStrudelMark.png"))

// iOS and web/PWA apply their own masks, so their artwork fills an opaque square.
for name in ["cream-1024", "graphite-1024", "icon-1024"] {
    try export(square, size: 1024, opaque: true,
               to: assets.appendingPathComponent("iOSAppIcon.appiconset/\(name).png"))
}
for name in ["strudel-cream", "strudel-graphite"] {
    try export(square, size: 512, opaque: true,
               to: root.appendingPathComponent("public/\(name).png"))
}
print("Exported OpenStrudel icons for macOS, iOS and web.")
