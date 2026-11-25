#!/usr/bin/env swift
import AppKit
import Foundation

var inputPNGPath: String?
var positional: [String] = []
var idx = 1
while idx < CommandLine.arguments.count {
    let arg = CommandLine.arguments[idx]
    if arg == "--from-png", idx + 1 < CommandLine.arguments.count {
        inputPNGPath = CommandLine.arguments[idx + 1]
        idx += 2
    } else {
        positional.append(arg)
        idx += 1
    }
}

guard let outputArg = positional.first else {
    fputs("Usage: generate-icon.swift [--from-png <input.png>] <output-AppIcon.icns>\n", stderr)
    exit(1)
}

let outputICNS = URL(fileURLWithPath: outputArg)
let masterImage: NSImage? = inputPNGPath.flatMap { NSImage(contentsOfFile: $0) }
if let inputPNGPath, masterImage == nil {
    fputs("Warning: could not load PNG at \(inputPNGPath); falling back to crisp vector emblem.\n", stderr)
}

let fm = FileManager.default
let tempDir = fm.temporaryDirectory.appendingPathComponent("WorkBuddyIcon-\(UUID().uuidString)", isDirectory: true)
let iconsetDir = tempDir.appendingPathComponent("AppIcon.iconset", isDirectory: true)
try fm.createDirectory(at: iconsetDir, withIntermediateDirectories: true)
defer { try? fm.removeItem(at: tempDir) }

func drawVectorEmblem(in cardRect: NSRect, size: CGFloat) {
    // Rich sapphire-to-electric-cyan background gradient
    let bgGradient = NSGradient(colors: [
        NSColor(calibratedRed: 0.05, green: 0.09, blue: 0.24, alpha: 1.0),
        NSColor(calibratedRed: 0.07, green: 0.27, blue: 0.56, alpha: 1.0),
        NSColor(calibratedRed: 0.06, green: 0.62, blue: 0.72, alpha: 1.0)
    ])
    bgGradient?.draw(in: cardRect, angle: -42)

    // Soft glowing halo behind emblem
    let glowCenter = NSPoint(x: cardRect.midX, y: cardRect.midY)
    let haloGradient = NSGradient(
        starting: NSColor(calibratedRed: 0.22, green: 0.90, blue: 0.85, alpha: 0.34),
        ending: NSColor(calibratedRed: 0.10, green: 0.50, blue: 0.80, alpha: 0.0)
    )
    haloGradient?.draw(fromCenter: glowCenter, radius: 0, toCenter: glowCenter, radius: cardRect.width * 0.48, options: [])

    // Back translucent cyan speech-bridge card (upper-right)
    let w = cardRect.width
    let backRect = NSRect(
        x: cardRect.minX + w * 0.30,
        y: cardRect.minY + w * 0.32,
        width: w * 0.48,
        height: w * 0.40
    )
    let backPath = NSBezierPath(roundedRect: backRect, xRadius: w * 0.11, yRadius: w * 0.11)
    NSColor(calibratedRed: 0.35, green: 0.88, blue: 0.98, alpha: 0.42).setFill()
    backPath.fill()
    NSColor.white.withAlphaComponent(0.32).setStroke()
    backPath.lineWidth = max(1, size * 0.012)
    backPath.stroke()

    // Front luminous glass speech bubble (lower-left)
    let frontRect = NSRect(
        x: cardRect.minX + w * 0.20,
        y: cardRect.minY + w * 0.24,
        width: w * 0.48,
        height: w * 0.40
    )
    let frontPath = NSBezierPath(roundedRect: frontRect, xRadius: w * 0.11, yRadius: w * 0.11)
    let frontGrad = NSGradient(
        starting: NSColor.white.withAlphaComponent(0.96),
        ending: NSColor(calibratedRed: 0.84, green: 0.95, blue: 1.0, alpha: 0.88)
    )
    frontGrad?.draw(in: frontPath, angle: -65)

    // Interlocking glowing emerald-cyan four-point spark at intersection center
    let cx = cardRect.midX
    let cy = cardRect.midY
    let sparkR = w * 0.13
    let sparkInner = sparkR * 0.34
    let spark = NSBezierPath()
    spark.move(to: NSPoint(x: cx, y: cy + sparkR))
    spark.curve(to: NSPoint(x: cx + sparkR, y: cy),
                controlPoint1: NSPoint(x: cx + sparkInner, y: cy + sparkInner),
                controlPoint2: NSPoint(x: cx + sparkInner, y: cy + sparkInner))
    spark.curve(to: NSPoint(x: cx, y: cy - sparkR),
                controlPoint1: NSPoint(x: cx + sparkInner, y: cy - sparkInner),
                controlPoint2: NSPoint(x: cx + sparkInner, y: cy - sparkInner))
    spark.curve(to: NSPoint(x: cx - sparkR, y: cy),
                controlPoint1: NSPoint(x: cx - sparkInner, y: cy - sparkInner),
                controlPoint2: NSPoint(x: cx - sparkInner, y: cy - sparkInner))
    spark.curve(to: NSPoint(x: cx, y: cy + sparkR),
                controlPoint1: NSPoint(x: cx - sparkInner, y: cy + sparkInner),
                controlPoint2: NSPoint(x: cx - sparkInner, y: cy + sparkInner))
    spark.close()

    let sparkGrad = NSGradient(
        starting: NSColor(calibratedRed: 0.08, green: 0.92, blue: 0.72, alpha: 1.0),
        ending: NSColor(calibratedRed: 0.06, green: 0.56, blue: 0.98, alpha: 1.0)
    )
    sparkGrad?.draw(in: spark, angle: -45)
}

func renderIcon(size: Int) -> Data? {
    let rep = NSBitmapImageRep(
        bitmapDataPlanes: nil,
        pixelsWide: size,
        pixelsHigh: size,
        bitsPerSample: 8,
        samplesPerPixel: 4,
        hasAlpha: true,
        isPlanar: false,
        colorSpaceName: .deviceRGB,
        bytesPerRow: 0,
        bitsPerPixel: 0
    )
    guard let rep else { return nil }
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    NSGraphicsContext.current?.imageInterpolation = .high

    let s = CGFloat(size)
    let rect = NSRect(x: 0, y: 0, width: s, height: s)
    let inset = s * 0.085
    let cardRect = rect.insetBy(dx: inset, dy: inset)
    let radius = s * 0.225
    let clipPath = NSBezierPath(roundedRect: cardRect, xRadius: radius, yRadius: radius)

    if size >= 64 {
        NSGraphicsContext.saveGraphicsState()
        let shadow = NSShadow()
        shadow.shadowColor = NSColor.black.withAlphaComponent(0.28)
        shadow.shadowBlurRadius = s * 0.032
        shadow.shadowOffset = NSSize(width: 0, height: -s * 0.015)
        shadow.set()
        NSColor.black.setFill()
        clipPath.fill()
        NSGraphicsContext.restoreGraphicsState()
    }

    NSGraphicsContext.saveGraphicsState()
    clipPath.addClip()
    if let masterImage {
        let imgSize = masterImage.size
        let aspect = imgSize.width > 0 && imgSize.height > 0 ? imgSize.width / imgSize.height : 1.0
        var drawRect = cardRect
        if aspect > 1 {
            drawRect.size.width = cardRect.height * aspect
            drawRect.origin.x -= (drawRect.size.width - cardRect.width) / 2
        } else if aspect < 1 {
            drawRect.size.height = cardRect.width / aspect
            drawRect.origin.y -= (drawRect.size.height - cardRect.height) / 2
        }
        masterImage.draw(in: drawRect, from: .zero, operation: .sourceOver, fraction: 1.0)
    } else {
        drawVectorEmblem(in: cardRect, size: s)
    }
    NSGraphicsContext.restoreGraphicsState()

    // Subtle macOS inner glass rim
    NSColor.white.withAlphaComponent(0.20).setStroke()
    clipPath.lineWidth = max(1, s * 0.012)
    clipPath.stroke()

    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])
}

let specs: [(String, Int)] = [
    ("icon_16x16.png", 16),
    ("icon_16x16@2x.png", 32),
    ("icon_32x32.png", 32),
    ("icon_32x32@2x.png", 64),
    ("icon_128x128.png", 128),
    ("icon_128x128@2x.png", 256),
    ("icon_256x256.png", 256),
    ("icon_256x256@2x.png", 512),
    ("icon_512x512.png", 512),
    ("icon_512x512@2x.png", 1024),
]

for (filename, px) in specs {
    guard let data = renderIcon(size: px) else {
        fputs("Failed to render \(filename)\n", stderr)
        exit(1)
    }
    try data.write(to: iconsetDir.appendingPathComponent(filename))
}

let proc = Process()
proc.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
proc.arguments = ["-c", "icns", iconsetDir.path, "-o", outputICNS.path]
try proc.run()
proc.waitUntilExit()
if proc.terminationStatus != 0 {
    fputs("iconutil failed with code \(proc.terminationStatus)\n", stderr)
    exit(proc.terminationStatus)
}
print("Generated \(outputICNS.path)")
