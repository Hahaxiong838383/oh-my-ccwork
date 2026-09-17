import AppKit
import simd

struct CanvasGeometrySummary {
    var boundary: [CGPoint]
    var referenceBoundary: [CGPoint]
    var grid = [[CGPoint]]()
    var aaRect: CGRect
    var edgeLengths = [Double]()

    init(configuration: WarpConfiguration) {
        let display = CGRect(x: 0, y: 0, width: configuration.displayPixelWidth, height: configuration.displayPixelHeight)
        aaRect = AABoundaryOverlayGeometry.borderRect(in: display, aaRect: configuration.aaRect, lineWidth: 0)
        boundary = WarpBoundaryOverlayGeometry.points(in: display, configuration: configuration, samplesPerEdge: 96)
        if configuration.extendedWarpEnabled, let reference = configuration.canvasReference {
            var base = configuration
            base.canvas = reference.canvas
            referenceBoundary = WarpBoundaryOverlayGeometry.points(in: display, configuration: base)
        } else {
            referenceBoundary = []
        }
        edgeLengths = (0..<4).map { edge in
            (0..<96).reduce(0.0) { result, sample in
                let start = boundary[edge * 96 + sample]
                let end = boundary[edge * 96 + sample + 1]
                return result + hypot(end.x - start.x, end.y - start.y)
            }
        }
        var lines = [[SIMD2<Float>]]()
        let horizontalCount = min(80, max(4, configuration.canvas.width / 250))
        let verticalCount = min(40, max(4, configuration.canvas.height / 125))
        for column in 0...horizontalCount {
            lines.append((0...48).map { SIMD2<Float>(Float(column) / Float(horizontalCount), Float($0) / 48) })
        }
        for row in 0...verticalCount {
            lines.append((0...128).map { SIMD2<Float>(Float($0) / 128, Float(row) / Float(verticalCount)) })
        }
        let mapped = WarpMath.physicalPoints(canvasPoints: lines.flatMap { $0 }, configuration: configuration)
        var offset = 0
        grid = lines.map { line in
            defer { offset += line.count }
            return mapped[offset..<(offset + line.count)].map { CGPoint(x: Double($0.x), y: Double($0.y)) }
        }
    }

    var measurementText: String {
        String(format: "屏幕上的实际边长（不是逻辑像素数）：上 %.0f / 下 %.0f / 左 %.0f / 右 %.0f px", edgeLengths[0], edgeLengths[2], edgeLengths[3], edgeLengths[1])
    }
}

final class CanvasGeometryPreviewView: NSView {
    private var summary: CanvasGeometrySummary?
    private var camera: WarpEditorViewport?
    var clipsToAA = false { didSet { needsDisplay = true } }
    override var isFlipped: Bool { true }

    private var worldBounds: CGRect {
        guard let summary else { return CGRect(x: 0, y: 0, width: 5000, height: 1500) }
        var world = summary.aaRect
        if !clipsToAA {
            for point in summary.boundary { world = world.union(CGRect(x: point.x, y: point.y, width: 0.001, height: 0.001)) }
        }
        return world
    }
    var viewport: WarpEditorViewport? {
        get {
            if let camera { return camera }
            let world = worldBounds
            let scale = min(max(bounds.width - 30, 1) / max(world.width, 1), max(bounds.height - 30, 1) / max(world.height, 1))
            return WarpEditorViewport(physicalBounds: world, pointsPerPhysicalPixel: scale)
        }
        set { camera = newValue.flatMap { $0.isValid ? $0 : nil }; needsDisplay = true }
    }
    func fit() { camera = nil; needsDisplay = true }
    override func magnify(with event: NSEvent) {
        guard var value = viewport else { return }
        value.pointsPerPhysicalPixel = max(0.000_001, (value.pointsPerPhysicalPixel ?? 1) * max(0.25, 1 + event.magnification))
        viewport = value
    }

    func update(_ configuration: WarpConfiguration) -> CanvasGeometrySummary {
        let next = CanvasGeometrySummary(configuration: configuration)
        summary = next
        needsDisplay = true
        return next
    }

    override func draw(_ dirtyRect: NSRect) {
        NSColor(calibratedWhite: 0.035, alpha: 1).setFill()
        bounds.fill()
        guard let summary else { return }
        let world = camera?.physicalBounds ?? worldBounds
        let scale = camera?.pointsPerPhysicalPixel ?? min((bounds.width - 30) / max(world.width, 1), (bounds.height - 30) / max(world.height, 1))
        let origin = CGPoint(x: bounds.midX - world.midX * scale, y: bounds.midY - world.midY * scale)
        func projected(_ point: CGPoint) -> CGPoint { CGPoint(x: origin.x + point.x * scale, y: origin.y + point.y * scale) }
        let aaRect = CGRect(origin: projected(summary.aaRect.origin), size: CGSize(width: summary.aaRect.width * scale, height: summary.aaRect.height * scale))
        func path(_ points: [CGPoint]) -> NSBezierPath {
            let result = NSBezierPath()
            if let first = points.first {
                result.move(to: projected(first))
                points.dropFirst().forEach { result.line(to: projected($0)) }
            }
            return result
        }
        func drawSurface(opacity: CGFloat) {
            NSColor.systemCyan.withAlphaComponent(opacity * 0.12).setFill()
            let area = path(summary.boundary)
            area.close()
            area.fill()
            NSColor.systemCyan.withAlphaComponent(opacity * 0.55).setStroke()
            summary.grid.forEach { points in
                let gridLine = path(points)
                gridLine.lineWidth = 0.65
                gridLine.stroke()
            }
            NSColor.systemCyan.withAlphaComponent(opacity).setStroke()
            area.lineWidth = 1.8
            area.stroke()
        }
        NSGraphicsContext.saveGraphicsState()
        if clipsToAA { NSBezierPath(rect: aaRect).addClip() }
        drawSurface(opacity: clipsToAA ? 1 : 0.4)
        NSGraphicsContext.restoreGraphicsState()
        NSGraphicsContext.saveGraphicsState()
        NSBezierPath(rect: aaRect).addClip()
        drawSurface(opacity: 1)
        NSGraphicsContext.restoreGraphicsState()
        if !clipsToAA, !summary.referenceBoundary.isEmpty {
            NSColor.lightGray.setStroke()
            let base = path(summary.referenceBoundary)
            base.setLineDash([4, 4], count: 2, phase: 0)
            base.lineWidth = 1
            base.stroke()
        }
        NSColor.systemYellow.setStroke()
        let frame = NSBezierPath(rect: aaRect)
        frame.lineWidth = 1.8
        frame.stroke()
    }
}
