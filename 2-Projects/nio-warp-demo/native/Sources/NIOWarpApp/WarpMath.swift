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
    private struct MappingContext {
        var manualMinimum: SIMD2<Float>
        var manualMaximum: SIMD2<Float>
        var extendedMinimum: SIMD2<Float>
        var extendedMaximum: SIMD2<Float>
    }

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

    private static func polynomialDisplacement(
        at point: SIMD2<Float>,
        configuration: WarpConfiguration
    ) -> SIMD2<Float> {
        guard configuration.polynomial.enabled else { return .zero }
        let polynomial = configuration.polynomial.normalized()
        let centeredX = Double(point.x * 2 - 1)
        let centeredY = Double(point.y * 2 - 1)
        let multiplier = configuration.warpTrend.displacementMultiplier
        return SIMD2<Float>(
            multiplier * Float(polynomial.evaluate(x: centeredX, y: centeredY, coefficients: polynomial.coefficientsX)),
            multiplier * Float(polynomial.evaluate(x: centeredX, y: centeredY, coefficients: polynomial.coefficientsY))
        )
    }

    private static func normalizedBaseWarpPoint(
        _ point: SIMD2<Float>,
        configuration: WarpConfiguration,
        manualMinimum: SIMD2<Float>,
        manualMaximum: SIMD2<Float>,
        clampManualResult: Bool
    ) -> SIMD2<Float> {
        let raw = trendedManualRaw(
            point,
            parameters: configuration.manual,
            trend: configuration.warpTrend
        )
        let range = simd_max(manualMaximum - manualMinimum, SIMD2<Float>(repeating: 0.0001))
        var mapped = (raw - manualMinimum) / range
        if clampManualResult {
            mapped = simd_clamp(mapped, .zero, SIMD2<Float>(repeating: 1))
        }
        return mapped + polynomialDisplacement(at: point, configuration: configuration)
    }

    private static func extendedDomain(
        configuration: WarpConfiguration
    ) -> (minimum: SIMD2<Float>, maximum: SIMD2<Float>) {
        let core = extendedWarpCoreRect(configuration: configuration)
        let minimum = SIMD2<Float>(
            -Float(core.x) / Float(core.width),
            -Float(core.y) / Float(core.height)
        )
        let maximum = SIMD2<Float>(
            Float(1 - core.x) / Float(core.width),
            Float(1 - core.y) / Float(core.height)
        )
        return (minimum, maximum)
    }

    private static func mappingContext(configuration: WarpConfiguration) -> MappingContext {
        let manual = manualBounds(
            parameters: configuration.manual,
            trend: configuration.warpTrend
        )
        guard configuration.extendedWarpEnabled else {
            return MappingContext(
                manualMinimum: manual.0,
                manualMaximum: manual.1,
                extendedMinimum: .zero,
                extendedMaximum: SIMD2<Float>(repeating: 1)
            )
        }
        let domain = extendedDomain(configuration: configuration)
        var minimum = SIMD2<Float>(repeating: .greatestFiniteMagnitude)
        var maximum = SIMD2<Float>(repeating: -.greatestFiniteMagnitude)
        for row in 0...96 {
            let y = mix(domain.minimum.y, domain.maximum.y, t: Float(row) / 96)
            for column in 0...192 {
                let x = mix(domain.minimum.x, domain.maximum.x, t: Float(column) / 192)
                let mapped = normalizedBaseWarpPoint(
                    SIMD2<Float>(x, y),
                    configuration: configuration,
                    manualMinimum: manual.0,
                    manualMaximum: manual.1,
                    clampManualResult: false
                )
                minimum = simd_min(minimum, mapped)
                maximum = simd_max(maximum, mapped)
            }
        }
        return MappingContext(
            manualMinimum: manual.0,
            manualMaximum: manual.1,
            extendedMinimum: minimum,
            extendedMaximum: maximum
        )
    }

    private static func mix(_ minimum: Float, _ maximum: Float, t: Float) -> Float {
        minimum + (maximum - minimum) * t
    }

    static func localPhysicalPoint(
        canvasPoint: SIMD2<Float>,
        configuration: WarpConfiguration
    ) -> SIMD2<Float> {
        localPhysicalPoint(
            canvasPoint: canvasPoint,
            configuration: configuration,
            context: mappingContext(configuration: configuration)
        )
    }

    static func localPhysicalPoints(
        canvasPoints: [SIMD2<Float>],
        configuration: WarpConfiguration
    ) -> [SIMD2<Float>] {
        let context = mappingContext(configuration: configuration)
        return canvasPoints.map {
            localPhysicalPoint(canvasPoint: $0, configuration: configuration, context: context)
        }
    }

    private static func localPhysicalPoint(
        canvasPoint: SIMD2<Float>,
        configuration: WarpConfiguration,
        context: MappingContext
    ) -> SIMD2<Float> {
        guard configuration.extendedWarpEnabled else {
            return normalizedBaseWarpPoint(
                canvasPoint,
                configuration: configuration,
                manualMinimum: context.manualMinimum,
                manualMaximum: context.manualMaximum,
                clampManualResult: true
            )
        }
        let domain = extendedDomain(configuration: configuration)
        let domainPoint = domain.minimum + canvasPoint * (domain.maximum - domain.minimum)
        let extended = normalizedBaseWarpPoint(
            domainPoint,
            configuration: configuration,
            manualMinimum: context.manualMinimum,
            manualMaximum: context.manualMaximum,
            clampManualResult: false
        )
        let range = simd_max(
            context.extendedMaximum - context.extendedMinimum,
            SIMD2<Float>(repeating: 0.0001)
        )
        return simd_clamp(
            (extended - context.extendedMinimum) / range,
            .zero,
            SIMD2<Float>(repeating: 1)
        )
    }

    static func makeMesh(configuration: WarpConfiguration, columns: Int = 128, rows: Int = 48) -> GeneratedMesh {
        let columns = max(columns, 2)
        let rows = max(rows, 2)
        let aa = configuration.aaRect.sanitized()
        let context = mappingContext(configuration: configuration)
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
                    context: context
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
