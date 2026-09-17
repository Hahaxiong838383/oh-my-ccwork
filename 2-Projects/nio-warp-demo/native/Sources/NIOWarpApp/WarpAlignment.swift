import Foundation
import simd

/// Alignment acts after all deformations, in physical pixels around the AA center.
/// Flags remain saved; the transform is recomputed when the source geometry changes.
struct WarpAlignmentConfiguration: Codable, Equatable {
    var centerHorizontal = false
    var centerVertical = false
    var level = false
    var snapTilt = false
    var snapHorizontalBend = false

    var isGeometricEnabled: Bool { centerHorizontal || centerVertical || level }

    static func snapped(_ value: Double, enabled: Bool, threshold: Double) -> Double {
        enabled && value.isFinite && abs(value) <= threshold ? 0 : value
    }
}

struct WarpAlignmentTransform {
    var cosine: Float = 1
    var sine: Float = 0
    var translation = SIMD2<Float>.zero
    var physicalSize = SIMD2<Float>(repeating: 1)

    func apply(_ local: SIMD2<Float>) -> SIMD2<Float> {
        if cosine == 1 && sine == 0 && translation == .zero { return local }
        let point = (local - 0.5) * physicalSize
        let rotated = SIMD2(cosine * point.x - sine * point.y, sine * point.x + cosine * point.y)
        return 0.5 + (rotated + translation) / physicalSize
    }

    static func make(configuration: WarpAlignmentConfiguration, boundary: [SIMD2<Float>],
                     axis: (SIMD2<Float>, SIMD2<Float>), size: SIMD2<Float>) -> Self {
        var result = Self()
        result.physicalSize = simd_max(size, SIMD2<Float>(repeating: 0.0001))
        if configuration.level {
            let direction = (axis.1 - axis.0) * result.physicalSize
            if simd_length(direction) > 0.0001 {
                let angle = -atan2(direction.y, direction.x)
                result.cosine = cos(angle)
                result.sine = sin(angle)
            }
        }
        let rotated = boundary.map { (result.apply($0) - 0.5) * result.physicalSize }
        if let first = rotated.first {
            let minimum = rotated.reduce(first) { simd_min($0, $1) }
            let maximum = rotated.reduce(first) { simd_max($0, $1) }
            let center = (minimum + maximum) * 0.5
            if configuration.centerHorizontal { result.translation.x = -center.x }
            if configuration.centerVertical { result.translation.y = -center.y }
        }
        return result
    }
}
