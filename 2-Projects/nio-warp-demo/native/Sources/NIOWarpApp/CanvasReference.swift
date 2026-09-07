import Foundation
import simd

struct WarpMappingBounds: Codable, Equatable {
    var minimumX = 0.0
    var minimumY = 0.0
    var maximumX = 1.0
    var maximumY = 1.0

    static let unit = WarpMappingBounds()
    var minimum: SIMD2<Float> { SIMD2(Float(minimumX), Float(minimumY)) }
    var maximum: SIMD2<Float> { SIMD2(Float(maximumX), Float(maximumY)) }
    var range: SIMD2<Float> { maximum - minimum }
    var isValid: Bool {
        [minimumX, minimumY, maximumX, maximumY].allSatisfy(\.isFinite)
            && maximumX - minimumX > 0.00001 && maximumY - minimumY > 0.00001
    }

    init(minimumX: Double = 0, minimumY: Double = 0, maximumX: Double = 1, maximumY: Double = 1) {
        self.minimumX = minimumX
        self.minimumY = minimumY
        self.maximumX = maximumX
        self.maximumY = maximumY
    }

    init(minimum: SIMD2<Float>, maximum: SIMD2<Float>) {
        self.init(minimumX: Double(minimum.x), minimumY: Double(minimum.y), maximumX: Double(maximum.x), maximumY: Double(maximum.y))
    }

    func contains(_ point: SIMD2<Float>) -> Bool {
        point.x >= minimum.x && point.y >= minimum.y && point.x <= maximum.x && point.y <= maximum.y
    }
}

struct CanvasWarpReference: Codable, Equatable {
    var canvas: CanvasConfiguration
    var contentCanvas: CanvasConfiguration
    var gridCanvas: CanvasConfiguration
    var physicalX: Double
    var physicalY: Double
    var physicalWidth: Double
    var physicalHeight: Double
    var domain = WarpMappingBounds.unit
    var outputBounds = WarpMappingBounds.unit
    var legacyOutputClampDomain: WarpMappingBounds?
    var clampsOriginalManualDomain = true

    var isValid: Bool {
        [canvas.width, canvas.height, contentCanvas.width, contentCanvas.height, gridCanvas.width, gridCanvas.height].allSatisfy { (64...32768).contains($0) }
            && [physicalX, physicalY, physicalWidth, physicalHeight].allSatisfy(\.isFinite)
            && abs(physicalX) <= 1_000_000 && abs(physicalY) <= 1_000_000
            && physicalWidth >= 1 && physicalWidth <= 1_000_000
            && physicalHeight >= 1 && physicalHeight <= 1_000_000
            && domain.isValid && outputBounds.isValid
            && (legacyOutputClampDomain?.isValid ?? true)
    }

    func expandedDomain(for size: CanvasConfiguration) -> WarpMappingBounds {
        let ratio = SIMD2(Float(size.width) / Float(canvas.width), Float(size.height) / Float(canvas.height))
        let center = (domain.minimum + domain.maximum) * 0.5
        return WarpMappingBounds(minimum: center - domain.range * ratio * 0.5, maximum: center + domain.range * ratio * 0.5)
    }
}

extension WarpConfiguration {
    var contentCanvas: CanvasConfiguration {
        extendedWarpEnabled ? (canvasReference?.contentCanvas ?? canvas) : canvas
    }

    var contentUVScale: SIMD2<Float> {
        SIMD2(Float(canvas.width) / Float(contentCanvas.width), Float(canvas.height) / Float(contentCanvas.height))
    }

    var gridUVScale: SIMD2<Float> {
        guard extendedWarpEnabled, let reference = canvasReference else { return SIMD2(repeating: 1) }
        return SIMD2(Float(canvas.width) / Float(reference.gridCanvas.width), Float(canvas.height) / Float(reference.gridCanvas.height))
    }

    mutating func enableCanvasGrowth() {
        if canvasReference == nil { canvasReference = WarpMath.captureCanvasReference(configuration: self) }
        extendedWarpEnabled = true
    }

    mutating func rebaseCanvasGrowth() {
        if extendedWarpEnabled, var reference = canvasReference {
            reference.domain = reference.expandedDomain(for: canvas)
            reference.canvas = canvas
            canvasReference = reference
        } else {
            canvasReference = WarpMath.captureCanvasReference(configuration: self)
        }
    }

    mutating func refillContentCanvas() {
        if canvasReference != nil { canvasReference?.contentCanvas = canvas }
    }
}
