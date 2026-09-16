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
    var nonFiniteSampleCount = 0
    var intersectingBoundaryCount = 0
    var unsafeScaleCount = 0

    var isValid: Bool { foldedCellCount == 0 && nonFiniteSampleCount == 0 && intersectingBoundaryCount == 0 && unsafeScaleCount == 0 }

    var summary: String {
        if nonFiniteSampleCount > 0 { return "出现无效坐标，已拒绝应用；请缩小画布或减小系数" }
        if intersectingBoundaryCount > 0 { return "画布边界相交，已拒绝应用；请缩小画布或减小系数" }
        if unsafeScaleCount > 0 { return "局部缩放过大或网格过于狭窄，已拒绝应用；请缩小画布或减小系数" }
        if foldedCellCount > 0 {
            return "网格折叠 \(foldedCellCount) 个单元，请减小系数"
        }
        if outOfAASampleCount > 0 {
            return "曲面有效；\(outOfAASampleCount)/\(totalSampleCount) 个采样点在 AA 外，仅裁切显示，不压回边界"
        }
        return "网格有效，无折叠、无 AA 越界"
    }
}

struct GeneratedMesh {
    var vertices: [MeshVertex]
    var indices: [UInt32]
    var validation: MeshValidation
    var horizontalAxis = [Float]()
    var verticalAxis = [Float]()

    func renderedPhysicalPoint(at uv: SIMD2<Float>, width: Int, height: Int) -> SIMD2<Float>? {
        guard horizontalAxis.count > 1, verticalAxis.count > 1,
              uv.x.isFinite, uv.y.isFinite, uv.x >= 0, uv.x <= 1, uv.y >= 0, uv.y <= 1 else { return nil }
        func interval(_ axis: [Float], _ value: Float) -> Int {
            var lower = 0
            var upper = axis.count - 1
            while upper - lower > 1 {
                let middle = (lower + upper) / 2
                if axis[middle] <= value { lower = middle } else { upper = middle }
            }
            return lower
        }
        let column = interval(horizontalAxis, uv.x)
        let row = interval(verticalAxis, uv.y)
        let horizontal = (uv.x - horizontalAxis[column]) / (horizontalAxis[column + 1] - horizontalAxis[column])
        let vertical = (uv.y - verticalAxis[row]) / (verticalAxis[row + 1] - verticalAxis[row])
        let index = row * horizontalAxis.count + column
        guard index + horizontalAxis.count + 1 < vertices.count else { return nil }
        let topLeft = vertices[index].position
        let topRight = vertices[index + 1].position
        let bottomLeft = vertices[index + horizontalAxis.count].position
        let bottomRight = vertices[index + horizontalAxis.count + 1].position
        let position = horizontal >= vertical
            ? topLeft * (1 - horizontal) + topRight * (horizontal - vertical) + bottomRight * vertical
            : topLeft * (1 - vertical) + bottomRight * horizontal + bottomLeft * (vertical - horizontal)
        return SIMD2((position.x + 1) * 0.5 * Float(width), (1 - position.y) * 0.5 * Float(height))
    }

    func sourceUV(at physical: SIMD2<Float>, width: Int, height: Int) -> SIMD2<Float>? {
        let point = SIMD2(physical.x / Float(width) * 2 - 1, 1 - physical.y / Float(height) * 2)
        func cross(_ first: SIMD2<Float>, _ second: SIMD2<Float>) -> Float { first.x * second.y - first.y * second.x }
        for index in stride(from: 0, to: indices.count, by: 3) {
            let first = vertices[Int(indices[index])]
            let second = vertices[Int(indices[index + 1])]
            let third = vertices[Int(indices[index + 2])]
            let minimum = simd_min(first.position, simd_min(second.position, third.position))
            let maximum = simd_max(first.position, simd_max(second.position, third.position))
            if point.x < minimum.x || point.x > maximum.x || point.y < minimum.y || point.y > maximum.y { continue }
            let horizontal = second.position - first.position
            let vertical = third.position - first.position
            let determinant = cross(horizontal, vertical)
            if abs(determinant) < 1e-15 { continue }
            let offset = point - first.position
            let secondWeight = cross(offset, vertical) / determinant
            let thirdWeight = cross(horizontal, offset) / determinant
            if secondWeight >= -0.00001 && thirdWeight >= -0.00001 && secondWeight + thirdWeight <= 1.00001 {
                return first.uv * (1 - secondWeight - thirdWeight) + second.uv * secondWeight + third.uv * thirdWeight
            }
        }
        return nil
    }
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
        var localField: LocalWarpField? = nil
    }

    static func extendedWarpCoreRect(configuration: WarpConfiguration) -> NormalizedRect {
        let reference = configuration.canvasReference?.canvas ?? configuration.canvas
        let coreWidth = Double(reference.width) / Double(max(configuration.canvas.width, 1))
        let coreHeight = Double(reference.height) / Double(max(configuration.canvas.height, 1))
        return NormalizedRect(x: (1 - coreWidth) * 0.5, y: (1 - coreHeight) * 0.5, width: coreWidth, height: coreHeight)
    }

    private static func legacyExtendedWarpCoreRect(configuration: WarpConfiguration) -> NormalizedRect {
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
        let core = legacyExtendedWarpCoreRect(configuration: configuration)
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

    private static func legacyMappingContext(configuration: WarpConfiguration) -> MappingContext {
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

    static func captureCanvasReference(configuration: WarpConfiguration, preservingLegacyExtension: Bool = false) -> CanvasWarpReference {
        let aa = configuration.aaRect.sanitized()
        var reference = CanvasWarpReference(
            canvas: configuration.canvas,
            contentCanvas: configuration.canvas,
            gridCanvas: configuration.canvas,
            physicalX: aa.x * Double(configuration.displayPixelWidth),
            physicalY: aa.y * Double(configuration.displayPixelHeight),
            physicalWidth: aa.width * Double(configuration.displayPixelWidth),
            physicalHeight: aa.height * Double(configuration.displayPixelHeight)
        )
        if preservingLegacyExtension, configuration.extendedWarpEnabled {
            let context = legacyMappingContext(configuration: configuration)
            let domain = extendedDomain(configuration: configuration)
            reference.domain = WarpMappingBounds(minimum: domain.minimum, maximum: domain.maximum)
            reference.outputBounds = WarpMappingBounds(minimum: context.extendedMinimum, maximum: context.extendedMaximum)
            reference.legacyOutputClampDomain = reference.domain
            reference.clampsOriginalManualDomain = false
        }
        return reference
    }

    private static func mappingContext(configuration: WarpConfiguration) -> MappingContext {
        let manual = manualBounds(parameters: configuration.manual, trend: configuration.warpTrend)
        let output = configuration.canvasReference?.outputBounds ?? .unit
        return MappingContext(manualMinimum: manual.0, manualMaximum: manual.1, extendedMinimum: output.minimum, extendedMaximum: output.maximum,
                              localField: configuration.localWarp.enabled && !configuration.localWarp.anchors.isEmpty ? LocalWarpField(configuration.localWarp) : nil)
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
        let base = baseLocalPhysicalPoint(canvasPoint: canvasPoint, configuration: configuration, context: context)
        guard let field = context.localField else { return base }
        let delta = field.displacement(at: configuration.localCoordinate(at: canvasPoint))
        let aa = configuration.aaRect.sanitized()
        return base + SIMD2(Float(delta.x / (aa.width * Double(configuration.displayPixelWidth))), Float(delta.y / (aa.height * Double(configuration.displayPixelHeight))))
    }

    private static func baseLocalPhysicalPoint(
        canvasPoint: SIMD2<Float>, configuration: WarpConfiguration, context: MappingContext
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
        let reference = configuration.canvasReference ?? captureCanvasReference(configuration: configuration)
        let domain = reference.expandedDomain(for: configuration.canvas)
        let domainPoint = domain.minimum + canvasPoint * domain.range
        let extended = normalizedBaseWarpPoint(
            domainPoint,
            configuration: configuration,
            manualMinimum: context.manualMinimum,
            manualMaximum: context.manualMaximum,
            clampManualResult: reference.clampsOriginalManualDomain && WarpMappingBounds.unit.contains(domainPoint)
        )
        let range = simd_max(
            context.extendedMaximum - context.extendedMinimum,
            SIMD2<Float>(repeating: 0.0001)
        )
        var mapped = (extended - context.extendedMinimum) / range
        if reference.legacyOutputClampDomain?.contains(domainPoint) == true {
            mapped = simd_clamp(mapped, .zero, SIMD2<Float>(repeating: 1))
        }
        let physical = SIMD2<Float>(Float(reference.physicalX), Float(reference.physicalY))
            + mapped * SIMD2<Float>(Float(reference.physicalWidth), Float(reference.physicalHeight))
        let aa = configuration.aaRect.sanitized()
        let origin = SIMD2<Float>(Float(aa.x * Double(configuration.displayPixelWidth)), Float(aa.y * Double(configuration.displayPixelHeight)))
        let size = SIMD2<Float>(Float(aa.width * Double(configuration.displayPixelWidth)), Float(aa.height * Double(configuration.displayPixelHeight)))
        return (physical - origin) / size
    }

    static func physicalPoints(canvasPoints: [SIMD2<Float>], configuration: WarpConfiguration) -> [SIMD2<Float>] {
        let aa = configuration.aaRect.sanitized()
        let size = SIMD2<Float>(Float(configuration.displayPixelWidth), Float(configuration.displayPixelHeight))
        return localPhysicalPoints(canvasPoints: canvasPoints, configuration: configuration).map {
            (SIMD2<Float>(Float(aa.x), Float(aa.y)) + $0 * SIMD2<Float>(Float(aa.width), Float(aa.height))) * size
        }
    }

    static func meshDimensions(configuration: WarpConfiguration) -> (columns: Int, rows: Int) {
        let scale = configuration.extendedWarpEnabled ? configuration.gridUVScale : SIMD2<Float>(repeating: 1)
        return (min(512, max(192, Int(ceil(192 * scale.x)))), min(256, max(72, Int(ceil(72 * scale.y)))))
    }

    static func makeMesh(configuration: WarpConfiguration, columns: Int = 128, rows: Int = 48) -> GeneratedMesh {
        let anchorUVs = configuration.localWarp.enabled ? configuration.localWarp.anchors.map { configuration.canvasUV(for: $0.coordinate) } : []
        func axis(_ count: Int, _ anchors: [Float]) -> [Float] {
            let anchors = Array(Set(anchors.filter { $0.isFinite && $0 >= 0 && $0 <= 1 })).sorted()
            let count = max(count, 2)
            let samples: [Float] = (0...count).map { Float($0) / Float(count) }
            let regular = samples.filter { sample in
                sample == 0 || sample == 1 || !anchors.contains(where: { abs($0 - sample) < Float(0.000001) })
            }
            return Array(Set(regular + anchors)).sorted()
        }
        let horizontalAxis = axis(columns, anchorUVs.map(\.x))
        let verticalAxis = axis(rows, anchorUVs.map(\.y))
        let columns = horizontalAxis.count - 1
        let rows = verticalAxis.count - 1
        let aa = configuration.aaRect.sanitized()
        let context = mappingContext(configuration: configuration)
        var vertices = [MeshVertex]()
        var localPoints = [SIMD2<Float>]()
        vertices.reserveCapacity((columns + 1) * (rows + 1))
        localPoints.reserveCapacity((columns + 1) * (rows + 1))
        var outOfAA = 0
        var nonFinite = 0
        var unsafeScale = 0

        for row in 0...rows {
            let y = verticalAxis[row]
            for column in 0...columns {
                let x = horizontalAxis[column]
                let local = localPhysicalPoint(
                    canvasPoint: SIMD2<Float>(x, y),
                    configuration: configuration,
                    context: context
                )
                localPoints.append(local)
                if !local.x.isFinite || !local.y.isFinite { nonFinite += 1 }
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

                let topLeftPoint = localPoints[topLeftIndex]
                let topRightPoint = localPoints[topRightIndex]
                let bottomLeftPoint = localPoints[bottomLeftIndex]
                let bottomRightPoint = localPoints[bottomRightIndex]
                let firstArea = cross(topRightPoint - topLeftPoint, bottomRightPoint - topLeftPoint)
                let secondArea = cross(bottomRightPoint - topLeftPoint, bottomLeftPoint - topLeftPoint)
                if firstArea <= 0 || secondArea <= 0 { folded += 1 }
                let horizontal = (topRightPoint - topLeftPoint) / (horizontalAxis[column + 1] - horizontalAxis[column])
                let vertical = (bottomLeftPoint - topLeftPoint) / (verticalAxis[row + 1] - verticalAxis[row])
                let condition = simd_length_squared(horizontal) + simd_length_squared(vertical)
                if condition / max(abs(cross(horizontal, vertical)), 0.000000000001) > 10000
                    || abs(topLeftPoint.x) > 128 || abs(topLeftPoint.y) > 128 { unsafeScale += 1 }
            }
        }

        return GeneratedMesh(
            vertices: vertices,
            indices: indices,
            validation: MeshValidation(
                foldedCellCount: folded,
                outOfAASampleCount: outOfAA,
                totalSampleCount: vertices.count,
                nonFiniteSampleCount: nonFinite,
                intersectingBoundaryCount: nonFinite == 0 ? boundaryIntersections(points: localPoints, columns: columns, rows: rows) : 0,
                unsafeScaleCount: unsafeScale
            ),
            horizontalAxis: horizontalAxis,
            verticalAxis: verticalAxis
        )
    }

    private static func cross(_ first: SIMD2<Float>, _ second: SIMD2<Float>) -> Float {
        first.x * second.y - first.y * second.x
    }

    private static func boundaryIntersections(points: [SIMD2<Float>], columns: Int, rows: Int) -> Int {
        let stride = columns + 1
        let perimeter = (0...columns).map { points[$0] }
            + (1...rows).map { points[$0 * stride + columns] }
            + (0..<columns).reversed().map { points[rows * stride + $0] }
            + (1..<rows).reversed().map { points[$0 * stride] }
        var count = 0
        for firstIndex in perimeter.indices {
            if firstIndex + 2 >= perimeter.count { continue }
            let firstStart = perimeter[firstIndex]
            let firstEnd = perimeter[(firstIndex + 1) % perimeter.count]
            for secondIndex in (firstIndex + 2)..<perimeter.count {
                if firstIndex == 0 && secondIndex == perimeter.count - 1 { continue }
                let secondStart = perimeter[secondIndex]
                let secondEnd = perimeter[(secondIndex + 1) % perimeter.count]
                if cross(firstEnd - firstStart, secondStart - firstStart) * cross(firstEnd - firstStart, secondEnd - firstStart) < -0.000000000001
                    && cross(secondEnd - secondStart, firstStart - secondStart) * cross(secondEnd - secondStart, firstEnd - secondStart) < -0.000000000001 { count += 1 }
            }
        }
        return count
    }
}
