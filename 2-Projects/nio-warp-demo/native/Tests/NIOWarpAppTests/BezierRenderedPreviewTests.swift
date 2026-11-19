import AppKit
import XCTest
@testable import NIOWarpApp

/// A review artifact generated from the production mapping, not an illustrative mock-up.
final class BezierRenderedPreviewTests: XCTestCase {
    func testGenerateMaximumWarpAndBezierComparisonFromActualMapping() throws {
        _ = NSApplication.shared
        var original = WarpConfiguration.defaultConfiguration(displayWidth: 5120, displayHeight: 2880)
        original.manual.strength = 2.25
        original.warpTrend = .inverse
        var corrected = original
        corrected.bezierWarp.enabled = true
        corrected.bezierWarp.horizontalRadius = 0.2
        XCTAssertTrue(corrected.bezierWarp.applyOffsetDelta(SIMD2(0, -12), at: 0))
        XCTAssertTrue(corrected.bezierWarp.applyOffsetDelta(SIMD2(0, 8), at: corrected.bezierWarp.columns - 1))
        XCTAssertTrue(corrected.bezierWarp.applyTangentDelta(SIMD2(0, -60), axis: .horizontal, at: 0))
        XCTAssertTrue(corrected.bezierWarp.applyTangentDelta(SIMD2(0, 45), axis: .horizontal, at: corrected.bezierWarp.columns - 1))
        for configuration in [original, corrected] {
            let validation = WarpMath.makeMesh(configuration: configuration, columns: 192, rows: 72).validation
            XCTAssertTrue(validation.isValid, validation.summary)
        }

        let width = 2048
        let height = 1180
        let bitmap = try XCTUnwrap(NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height,
            bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
            colorSpaceName: .deviceRGB, bytesPerRow: width * 4, bitsPerPixel: 32))
        let graphics = try XCTUnwrap(NSGraphicsContext(bitmapImageRep: bitmap))
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = graphics
        defer { NSGraphicsContext.restoreGraphicsState() }
        graphics.cgContext.setShouldAntialias(true)
        NSColor(calibratedRed: 0.035, green: 0.052, blue: 0.08, alpha: 1).setFill()
        NSRect(x: 0, y: 0, width: CGFloat(width), height: CGFloat(height)).fill()

        let cyan = NSColor(calibratedRed: 0.24, green: 0.87, blue: 0.89, alpha: 1)
        let orange = NSColor(calibratedRed: 1, green: 0.61, blue: 0.24, alpha: 1)
        let gray = NSColor(calibratedWhite: 0.58, alpha: 0.75)
        func label(_ text: String, _ x: CGFloat, _ y: CGFloat, size: CGFloat = 21, color: NSColor = .white, bold: Bool = false) {
            (text as NSString).draw(at: NSPoint(x: x, y: y), withAttributes: [
                .font: bold ? NSFont.boldSystemFont(ofSize: size) : NSFont.systemFont(ofSize: size),
                .foregroundColor: color
            ])
        }
        func panel(_ rectangle: NSRect) {
            NSColor(calibratedWhite: 0.09, alpha: 1).setFill()
            NSBezierPath(roundedRect: rectangle, xRadius: 16, yRadius: 16).fill()
        }
        label("NIO WARP  /  真实算法效果预览", 58, 1102, size: 36, bold: true)
        label("Warp 强度最高 2.25  |  反向预畸变  |  贝塞尔节点与手柄共同带动多行画面", 60, 1059, color: cyan)
        label("采用正式 WarpMath 算法计算；网格展示实际作用于画面的变形，非概念示意图。", 60, 1026, size: 19, color: gray)
        let leftPanel = NSRect(x: 48, y: 526, width: 954, height: 465)
        let rightPanel = NSRect(x: 1046, y: 526, width: 954, height: 465)
        panel(leftPanel)
        panel(rightPanel)
        label("A  仅整体 Warp", 78, 938, size: 25, bold: true)
        label("B  整体 Warp + 左右贝塞尔微调", 1076, 938, size: 25, bold: true)
        label("保留原有整体参数与最大 Warp 强度", 78, 901, size: 18, color: gray)
        label("灰色虚线：微调前   青色：微调后   橙色：两侧节点", 1076, 901, size: 18, color: gray)

        let aa = original.aaRect
        let aaOrigin = SIMD2<Float>(Float(aa.x * 5120), Float(aa.y * 2880))
        let aaSize = SIMD2<Float>(Float(aa.width * 5120), Float(aa.height * 2880))
        func transform(_ physical: SIMD2<Float>, origin: NSPoint, scale: CGFloat, worldOrigin: SIMD2<Float>) -> NSPoint {
            NSPoint(x: origin.x + CGFloat(physical.x - worldOrigin.x) * scale,
                    y: origin.y - CGFloat(physical.y - worldOrigin.y) * scale)
        }
        func line(_ points: [SIMD2<Float>], origin: NSPoint, scale: CGFloat, worldOrigin: SIMD2<Float>, color: NSColor, dashed: Bool = false, lineWidth: CGFloat = 1.6) {
            guard let first = points.first else { return }
            let path = NSBezierPath()
            path.move(to: transform(first, origin: origin, scale: scale, worldOrigin: worldOrigin))
            for point in points.dropFirst() { path.line(to: transform(point, origin: origin, scale: scale, worldOrigin: worldOrigin)) }
            path.lineWidth = lineWidth
            if dashed { path.setLineDash([6, 6], count: 2, phase: 0) }
            color.setStroke()
            path.stroke()
        }
        func grid(_ configuration: WarpConfiguration, origin: NSPoint, scale: CGFloat, worldOrigin: SIMD2<Float>, color: NSColor, dashed: Bool = false) {
            for row in 0...8 {
                let samples = (0...192).map { SIMD2<Float>(Float($0) / 192, Float(row) / 8) }
                line(WarpMath.physicalPoints(canvasPoints: samples, configuration: configuration), origin: origin, scale: scale, worldOrigin: worldOrigin, color: color, dashed: dashed)
            }
            for column in 0...16 {
                let samples = (0...72).map { SIMD2<Float>(Float(column) / 16, Float($0) / 72) }
                line(WarpMath.physicalPoints(canvasPoints: samples, configuration: configuration), origin: origin, scale: scale, worldOrigin: worldOrigin, color: color, dashed: dashed)
            }
        }
        let scale: CGFloat = 862 / CGFloat(aaSize.x)
        let leftOrigin = NSPoint(x: 92, y: 860)
        let rightOrigin = NSPoint(x: 1090, y: 860)
        grid(original, origin: leftOrigin, scale: scale, worldOrigin: aaOrigin, color: gray)
        grid(original, origin: rightOrigin, scale: scale, worldOrigin: aaOrigin, color: gray, dashed: true)
        grid(corrected, origin: rightOrigin, scale: scale, worldOrigin: aaOrigin, color: cyan)
        for u in [Float(0), 1] {
            for v in [Float(0), 0.5, 1] {
                let point = WarpMath.physicalPoints(canvasPoints: [SIMD2(u, v)], configuration: corrected)[0]
                let view = transform(point, origin: rightOrigin, scale: scale, worldOrigin: aaOrigin)
                orange.setFill()
                NSBezierPath(ovalIn: NSRect(x: view.x - 5, y: view.y - 5, width: 10, height: 10)).fill()
            }
        }
        label("两组网格验证通过：无折叠、无无效坐标", 80, 545, size: 18, color: cyan)
        label("左侧偏移 -12 px / 切线 -60     右侧偏移 +8 px / 切线 +45", 1078, 545, size: 18, color: orange)

        label("左右局部放大  /  两侧采用相同物理像素比例", 60, 466, size: 24, bold: true)
        let details = [NSRect(x: 48, y: 126, width: 954, height: 316), NSRect(x: 1046, y: 126, width: 954, height: 316)]
        for (index, rectangle) in details.enumerated() {
            panel(rectangle)
            let x: Float = index == 0 ? 0.1 : 0.9
            let sample = SIMD2<Float>(x, 0.5)
            let before = WarpMath.physicalPoints(canvasPoints: [sample], configuration: original)[0]
            let after = WarpMath.physicalPoints(canvasPoints: [sample], configuration: corrected)[0]
            label(index == 0 ? "左侧 / 上抬并微调弧度" : "右侧 / 下移并微调弧度", rectangle.minX + 30, rectangle.maxY - 43, size: 23, bold: true)
            label(String(format: "内部横线实际垂直位移：%+.2f 物理像素", after.y - before.y), rectangle.minX + 30, rectangle.maxY - 74, size: 18, color: orange)
            let crop = NSRect(x: rectangle.minX + 24, y: rectangle.minY + 22, width: rectangle.width - 48, height: 202)
            graphics.cgContext.saveGState()
            graphics.cgContext.clip(to: crop)
            let cropScale: CGFloat = 0.68
            let cropOrigin = NSPoint(x: crop.midX, y: crop.midY)
            grid(original, origin: cropOrigin, scale: cropScale, worldOrigin: before, color: gray, dashed: true)
            grid(corrected, origin: cropOrigin, scale: cropScale, worldOrigin: before, color: cyan)
            graphics.cgContext.restoreGState()
        }
        label("贯穿画面的等量联动：两侧微调同时带动上、中、下多行；中间区域保持原有形态。", 60, 70, size: 20, color: cyan)
        label("此图验证软件几何效果；外屏实际画面与玻璃反射效果仍需现场体验验收。", 60, 36, size: 18, color: gray)
        let png = try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
        try png.write(to: URL(fileURLWithPath: "/tmp/nio-bezier-actual-preview.png"), options: .atomic)
        XCTAssertGreaterThan(png.count, 10_000)
    }
}
