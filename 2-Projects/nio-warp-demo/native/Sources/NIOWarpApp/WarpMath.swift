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

struct ContentMappingResult: Equatable {
    var sourceMinimum: SIMD2<Float>
    var sourceMaximum: SIMD2<Float>
    var uniformScale: Float
    var cropFraction: SIMD2<Float>
}

enum ContentMappingMath {
    static func mapping(
        sourceWidth: Float,
        sourceHeight: Float,
        targetWidth: Float,
        targetHeight: Float,
        mode: ContentMode,
        anchor: CropAnchorConfiguration
    ) -> ContentMappingResult {
        let safeSourceWidth = max(sourceWidth, 1)
        let safeSourceHeight = max(sourceHeight, 1)
        let safeTargetWidth = max(targetWidth, 1)
        let safeTargetHeight = max(targetHeight, 1)
        let safeSourceAspect = safeSourceWidth / safeSourceHeight
        let safeTargetAspect = safeTargetWidth / safeTargetHeight
        let safeAnchor = anchor.sanitized()
        var minimum = SIMD2<Float>(repeating: 0)
        var maximum = SIMD2<Float>(repeating: 1)
        var scale: Float = 1
        var crop = SIMD2<Float>(repeating: 0)

        switch mode {
        case .stretch:
            break
        case .fit:
            scale = min(safeTargetWidth / safeSourceWidth, safeTargetHeight / safeSourceHeight)
        case .fill:
            scale = max(safeTargetWidth / safeSourceWidth, safeTargetHeight / safeSourceHeight)
            if safeSourceAspect < safeTargetAspect {
                let sampledHeight = safeSourceAspect / safeTargetAspect
                let availableCrop = 1 - sampledHeight
                let start = availableCrop * Float((safeAnchor.vertical + 1) * 0.5)
                minimum.y = start
                maximum.y = start + sampledHeight
                crop.y = availableCrop
            } else {
                let sampledWidth = safeTargetAspect / safeSourceAspect
                let availableCrop = 1 - sampledWidth
                let start = availableCrop * Float((safeAnchor.horizontal + 1) * 0.5)
                minimum.x = start
                maximum.x = start + sampledWidth
                crop.x = availableCrop
            }
        }

        return ContentMappingResult(
            sourceMinimum: minimum,
            sourceMaximum: maximum,
            uniformScale: scale,
            cropFraction: crop
        )
    }
}

enum WarpMath {
    static func extendedWarpCoreRect(configuration: WarpConfiguration) -> NormalizedRect {
        let aa = configuration.aaRect.sanitized()
        let aaPixelWidth = max(Double(configuration.displayPixelWidth) * aa.width, 1)
        let aaPixelHeight = max(Double(configuration.displayPixelHeight) * aa.height, 1)
        let coreWidth = min(aaPixelWidth / Double(max(configuration.canvas.width, 1)), 1)
        let coreHeight = min(aaPixelHeight / Double(max(configuration.canvas.height, 1)), 1)
        return NormalizedRect(
            x: (1 - coreWidth) * 0.5,
            y: (1 - coreHeight) * 0.5,
            width: coreWidth,
            height: coreHeight
        )
    }

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

    private static func trendedManualRaw(
        _ point: SIMD2<Float>,
        parameters: ManualWarpParameters,
        trend: WarpTrend
    ) -> SIMD2<Float> {
        let forward = manualRaw(point, parameters: parameters)
        return point + (forward - point) * trend.displacementMultiplier
    }

    private static func manualBounds(
        parameters: ManualWarpParameters,
        trend: WarpTrend
    ) -> (SIMD2<Float>, SIMD2<Float>) {
        guard parameters.enabled else { return (.zero, SIMD2<Float>(repeating: 1)) }
        var minimum = SIMD2<Float>(repeating: .greatestFiniteMagnitude)
        var maximum = SIMD2<Float>(repeating: -.greatestFiniteMagnitude)
        for row in 0...32 {
            for column in 0...64 {
                let warped = trendedManualRaw(
                    SIMD2<Float>(Float(column) / 64, Float(row) / 32),
                    parameters: parameters,
                    trend: trend
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
        if configuration.extendedWarpEnabled {
            return extendedLocalPhysicalPoint(
                canvasPoint: canvasPoint,
                configuration: configuration,
                manualBounds: manualBounds
            )
        }
        return warpedUnitPoint(
            canvasPoint,
            configuration: configuration,
            manualBounds: manualBounds
        )
    }

    private static func warpedUnitPoint(
        _ point: SIMD2<Float>,
        configuration: WarpConfiguration,
        manualBounds: (SIMD2<Float>, SIMD2<Float>)? = nil
    ) -> SIMD2<Float> {
        let bounds = manualBounds ?? self.manualBounds(
            parameters: configuration.manual,
            trend: configuration.warpTrend
        )
        let raw = trendedManualRaw(
            point,
            parameters: configuration.manual,
            trend: configuration.warpTrend
        )
        let range = simd_max(bounds.1 - bounds.0, SIMD2<Float>(repeating: 0.0001))
        var mapped = (raw - bounds.0) / range
        mapped = simd_clamp(mapped, SIMD2<Float>(repeating: 0), SIMD2<Float>(repeating: 1))
        let trendMultiplier = configuration.warpTrend.displacementMultiplier
        if configuration.polynomial.enabled {
            let polynomial = configuration.polynomial.normalized()
            let centeredX = Double(point.x * 2 - 1)
            let centeredY = Double(point.y * 2 - 1)
            mapped.x += trendMultiplier * Float(polynomial.evaluate(x: centeredX, y: centeredY, coefficients: polynomial.coefficientsX))
            mapped.y += trendMultiplier * Float(polynomial.evaluate(x: centeredX, y: centeredY, coefficients: polynomial.coefficientsY))
        }
        return mapped
    }

    private static func extensionWeight(_ coordinate: Float, minimum: Float, maximum: Float) -> Float {
        if coordinate < minimum {
            return minimum > 0 ? max(coordinate / minimum, 0) : 1
        }
        if coordinate > maximum {
            let margin = 1 - maximum
            return margin > 0 ? max((1 - coordinate) / margin, 0) : 1
        }
        return 1
    }

    private static func extendedLocalPhysicalPoint(
        canvasPoint: SIMD2<Float>,
        configuration: WarpConfiguration,
        manualBounds: (SIMD2<Float>, SIMD2<Float>)? = nil
    ) -> SIMD2<Float> {
        let core = extendedWarpCoreRect(configuration: configuration)
        let minimum = SIMD2<Float>(Float(core.x), Float(core.y))
        let size = SIMD2<Float>(Float(core.width), Float(core.height))
        let maximum = minimum + size
        let safeSize = simd_max(size, SIMD2<Float>(repeating: 0.0001))
        let corePoint = simd_clamp((canvasPoint - minimum) / safeSize, .zero, SIMD2<Float>(repeating: 1))
        let warpedCorePoint = warpedUnitPoint(
            corePoint,
            configuration: configuration,
            manualBounds: manualBounds
        )
        let displacement = (warpedCorePoint - corePoint) * safeSize
        let weightX = extensionWeight(canvasPoint.x, minimum: minimum.x, maximum: maximum.x)
        let weightY = extensionWeight(canvasPoint.y, minimum: minimum.y, maximum: maximum.y)
        return canvasPoint + displacement * min(weightX, weightY)
    }

    static func makeMesh(configuration: WarpConfiguration, columns: Int = 128, rows: Int = 48) -> GeneratedMesh {
        let columns = max(columns, 2)
        let rows = max(rows, 2)
        let aa = configuration.aaRect.sanitized()
        let bounds = manualBounds(parameters: configuration.manual, trend: configuration.warpTrend)
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
