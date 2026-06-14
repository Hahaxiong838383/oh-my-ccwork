// 渲染 cc-monitor 的 app 图标(1024 PNG) — 蓝紫渐变 squircle + 🧠 + cc
// 用法: swiftc render-icon.swift -o /tmp/ri && /tmp/ri <输出png路径>
import AppKit

let S: CGFloat = 1024
let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "/tmp/icon.png"

let img = NSImage(size: NSSize(width: S, height: S))
img.lockFocus()

// 圆角背景 + 蓝紫渐变
let rect = NSRect(x: 0, y: 0, width: S, height: S)
let bg = NSBezierPath(roundedRect: rect, xRadius: S * 0.225, yRadius: S * 0.225)
bg.addClip()
NSGradient(colors: [
    NSColor(red: 0.16, green: 0.22, blue: 0.48, alpha: 1),
    NSColor(red: 0.40, green: 0.25, blue: 0.62, alpha: 1),
])!.draw(in: rect, angle: -55)

// 内层微高光环(科技感)
let ring = NSBezierPath(ovalIn: NSRect(x: S*0.16, y: S*0.30, width: S*0.68, height: S*0.68))
ring.lineWidth = S * 0.012
NSColor.white.withAlphaComponent(0.10).setStroke()
ring.stroke()

// 居中 🧠
let brain = "🧠" as NSString
let bFont = NSFont.systemFont(ofSize: S * 0.44)
let bSize = brain.size(withAttributes: [.font: bFont])
brain.draw(at: NSPoint(x: (S - bSize.width)/2, y: S*0.345), withAttributes: [.font: bFont])

// 底部 cc
let cc = "cc" as NSString
let cFont = NSFont.systemFont(ofSize: S * 0.17, weight: .bold)
let cAttrs: [NSAttributedString.Key: Any] = [.font: cFont, .foregroundColor: NSColor.white.withAlphaComponent(0.96)]
let cSize = cc.size(withAttributes: cAttrs)
cc.draw(at: NSPoint(x: (S - cSize.width)/2, y: S*0.135), withAttributes: cAttrs)

img.unlockFocus()

guard let tiff = img.tiffRepresentation, let bmp = NSBitmapImageRep(data: tiff),
      let png = bmp.representation(using: .png, properties: [:]) else {
    FileHandle.standardError.write("render failed\n".data(using: .utf8)!); exit(1)
}
try! png.write(to: URL(fileURLWithPath: out))
print("wrote \(out)")
