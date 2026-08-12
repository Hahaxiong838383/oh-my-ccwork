import Foundation
import simd

struct MeshVertex {
    var position: SIMD2<Float>
    var uv: SIMD2<Float>
}

struct MeshValidation: Equatable {
    var foldedCellCount: Int
    var outOfAASampleCount: Int
    var totalSampleCount: Int

    var isValid: Bool { foldedCellCount == 0 }

    var summary: String {
        if foldedCellCount > 0 {
            return "网格折叠 \(foldedCellCount) 个单元，请减小系数"
        }
        if outOfAASampleCount > 0 {
            return "\(outOfAASampleCount)/\(totalSampleCount) 个采样点越出 AA，将被硬裁剪"
        }
        return "网格有效，无折叠、无 AA 越界"
    }
}

struct GeneratedMesh {
    var vertices: [MeshVertex]
    var indices: [UInt32]
    var validation: MeshValidation
}

enum WarpMath {
    private static func manualRaw(_ point: SIMD2<Float>, parameters: ManualWarpParameters) -> SIMD2<Float> {
        guard parameters.enabled else { return point }
        let strength = Float(parameters.strength)
        let centeredX = point.x * 2 - 1
        let centeredY = point.y * 2 - 1
        let horizontalScale = 1 + (0.97 - 1) * strength - 0.07 * strength * centeredY + 0.025 * strength * centeredX
        let warpedX = 0.5
            + 0.5 * centeredX * horizontalScale
            + Float(parameters.horizontalBend) * strength * centeredY * (1 - centeredX * centeredX)
        let verticalScale = 1 + (Float(parameters.verticalScale) - 1) * strength
        let warpedY = 0.5
            + 0.5 * centeredY * (verticalScale + Float(parameters.asymmetry) * strength * centeredX)
            - Float(parameters.arch) * strength * (1 - centeredX * centeredX)
            + Float(parameters.tilt) * strength * centeredX
            + 0.018 * strength * centeredX * centeredY
        return SIMD2<Float>(warpedX, warpedY)
    }

    private static func manualBounds(parameters: ManualWarpParameters) -> (SIMD2<Float>, SIMD2<Float>) {
        guard parameters.enabled else { return (.zero, SIMD2<Float>(repeating: 1)) }
        var minimum = SIMD2<Float>(repeating: .greatestFiniteMagnitude)
        var maximum = SIMD2<Float>(repeating: -.greatestFiniteMagnitude)
        for row in 0...32 {
            for column in 0...64 {
                let warped = manualRaw(
                    SIMD2<Float>(Float(column) / 64, Float(row) / 32),
                    parameters: parameters
                )
                minimum = simd_min(minimum, warped)
                maximum = simd_max(maximum, warped)
            }
        }
        return (minimum, maximum)
    }

    static func localPhysicalPoint(
        canvasPoint: SIMD2<Float>,
        configuration: WarpConfiguration,
        manualBounds: (SIMD2<Float>, SIMD2<Float>)? = nil
    ) -> SIMD2<Float> {
        let bounds = manualBounds ?? self.manualBounds(parameters: configuration.manual)
        let raw = manualRaw(canvasPoint, parameters: configuration.manual)
        let range = simd_max(bounds.1 - bounds.0, SIMD2<Float>(repeating: 0.0001))
        var mapped = (raw - bounds.0) / range
        if configuration.polynomial.enabled {
            let polynomial = configuration.polynomial.normalized()
            let centeredX = Double(canvasPoint.x * 2 - 1)
            let centeredY = Double(canvasPoint.y * 2 - 1)
            mapped.x += Float(polynomial.evaluate(x: centeredX, y: centeredY, coefficients: polynomial.coefficientsX))
            mapped.y += Float(polynomial.evaluate(x: centeredX, y: centeredY, coefficients: polynomial.coefficientsY))
        }
        return mapped
    }

    static func makeMesh(configuration: WarpConfiguration, columns: Int = 128, rows: Int = 48) -> GeneratedMesh {
        let columns = max(columns, 2)
        let rows = max(rows, 2)
        let aa = configuration.aaRect.sanitized()
        let bounds = manualBounds(parameters: configuration.manual)
        var vertices = [MeshVertex]()
        var localPoints = [SIMD2<Float>]()
        vertices.reserveCapacity((columns + 1) * (rows + 1))
        localPoints.reserveCapacity((columns + 1) * (rows + 1))
        var outOfAA = 0

        for row in 0...rows {
            let y = Float(row) / Float(rows)
            for column in 0...columns {
                let x = Float(column) / Float(columns)
                let local = localPhysicalPoint(
                    canvasPoint: SIMD2<Float>(x, y),
                    configuration: configuration,
                    manualBounds: bounds
                )
                localPoints.append(local)
                if local.x < 0 || local.x > 1 || local.y < 0 || local.y > 1 { outOfAA += 1 }
                let screenX = Float(aa.x) + local.x * Float(aa.width)
                let screenY = Float(aa.y) + local.y * Float(aa.height)
                vertices.append(
                    MeshVertex(
                        position: SIMD2<Float>(screenX * 2 - 1, 1 - screenY * 2),
                        uv: SIMD2<Float>(x, y)
                    )
                )
            }
        }

        var indices = [UInt32]()
        indices.reserveCapacity(columns * rows * 6)
        var folded = 0
        let stride = columns + 1
        for row in 0..<rows {
            for column in 0..<columns {
                let topLeftIndex = row * stride + column
                let topRightIndex = topLeftIndex + 1
                let bottomLeftIndex = (row + 1) * stride + column
                let bottomRightIndex = bottomLeftIndex + 1
                let topLeft = UInt32(topLeftIndex)
                let topRight = UInt32(topRightIndex)
                let bottomLeft = UInt32(bottomLeftIndex)
                let bottomRight = UInt32(bottomRightIndex)
                indices.append(contentsOf: [topLeft, topRight, bottomRight, topLeft, bottomRight, bottomLeft])

                let a = localPoints[topLeftIndex]
                let b = localPoints[topRightIndex]
                let c = localPoints[bottomLeftIndex]
                let cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
                if cross <= 0 { folded += 1 }
            }
        }

        return GeneratedMesh(
            vertices: vertices,
            indices: indices,
            validation: MeshValidation(
                foldedCellCount: folded,
                outOfAASampleCount: outOfAA,
                totalSampleCount: vertices.count
            )
        )
    }
}
