import Foundation
import simd

/// Input follows the same affine texture sampling steps as fragmentMain, in the same order.
/// Geometry itself comes exclusively from the mesh installed in the renderer.
struct MouseContentTransform {
    private let scale: SIMD2<Double>
    private let offset: SIMD2<Double>

    init(configuration: WarpConfiguration, sourceWidth: Int, sourceHeight: Int) {
        // Preserve the Float aspect/scale uniforms used by Metal before doing clipping in Double.
        let sourceAspect = Float(max(sourceWidth, 1)) / Float(max(sourceHeight, 1))
        let canvasAspect = configuration.contentCanvas.aspect
        let growth = configuration.contentUVScale
        var scale = SIMD2<Double>(Double(growth.x), Double(growth.y))
        var offset = SIMD2<Double>(repeating: 0.5) - scale * 0.5
        switch configuration.contentMode {
        case .fit:
            if sourceAspect < canvasAspect {
                let visibleWidth = Double(sourceAspect / canvasAspect)
                scale.x /= visibleWidth
                offset.x = (offset.x - (1 - visibleWidth) * 0.5) / visibleWidth
            } else {
                let visibleHeight = Double(canvasAspect / sourceAspect)
                scale.y /= visibleHeight
                offset.y = (offset.y - (1 - visibleHeight) * 0.5) / visibleHeight
            }
        case .fill:
            if sourceAspect < canvasAspect {
                let sampledHeight = Double(sourceAspect / canvasAspect)
                scale.y *= sampledHeight
                offset.y = offset.y * sampledHeight
                    + (1 - sampledHeight) * Double(Float(configuration.cropAnchor.vertical) + 1) * 0.5
            } else {
                let sampledWidth = Double(canvasAspect / sourceAspect)
                scale.x *= sampledWidth
                offset.x = offset.x * sampledWidth
                    + (1 - sampledWidth) * Double(Float(configuration.cropAnchor.horizontal) + 1) * 0.5
            }
        case .stretch:
            break
        }
        if configuration.mirror.horizontal { scale.x = -scale.x; offset.x = 1 - offset.x }
        if configuration.mirror.vertical { scale.y = -scale.y; offset.y = 1 - offset.y }
        self.scale = scale
        self.offset = offset
    }

    var isValid: Bool {
        scale.x.isFinite && scale.y.isFinite && offset.x.isFinite && offset.y.isFinite
            && abs(scale.x) > 1e-15 && abs(scale.y) > 1e-15
    }

    func sourceUV(forCanvasUV uv: SIMD2<Float>) -> SIMD2<Float> {
        SIMD2<Float>(sourceUV(doubleCanvasUV: SIMD2<Double>(uv)))
    }

    func canvasUV(forSourceUV uv: SIMD2<Float>) -> SIMD2<Float> {
        SIMD2<Float>((SIMD2<Double>(uv) - offset) / scale)
    }

    fileprivate func sourceUV(doubleCanvasUV uv: SIMD2<Double>) -> SIMD2<Double> {
        uv * scale + offset
    }
}

/// Exact union of the rendered, source-backed triangle footprints, clipped at pixel centres.
/// No inset rectangle, cursor-radius margin, or percentage shrink is used. The hotspot may reach
/// the edge even when the pointer artwork itself extends beyond it.
final class MouseMappingRegion {
    private typealias Point = SIMD2<Double>
    private static let tolerance = 0.002 // Pixel-sized numerical tolerance only, never a UI margin.

    let sourceSize: SIMD2<Float>
    let physicalSize: SIMD2<Float>
    private(set) var isValid = false
    var visiblePolygonCount: Int { polygons.count }

    /// The renderer's inclusive AA pixel-centre limits, before desktop scaling.
    var physicalCursorBounds: CGRect? {
        guard let bounds = physicalIndex?.bounds else { return nil }
        return CGRect(x: bounds.minimum.x, y: bounds.minimum.y,
                      width: bounds.maximum.x - bounds.minimum.x,
                      height: bounds.maximum.y - bounds.minimum.y)
    }

    private struct Vertex {
        var physical: Point
        var source: Point // Source pixel coordinates: tangential motion uses a pixel, not UV, metric.
        static func interpolate(_ first: Vertex, _ second: Vertex, fraction: Double) -> Vertex {
            Vertex(physical: first.physical + (second.physical - first.physical) * fraction,
                   source: first.source + (second.source - first.source) * fraction)
        }
    }

    private struct Bounds {
        var minimum: Point
        var maximum: Point
        init(_ points: [Point]) {
            minimum = points.reduce(Point(repeating: .greatestFiniteMagnitude), simd_min)
            maximum = points.reduce(Point(repeating: -.greatestFiniteMagnitude), simd_max)
        }
        init(from: Point, to: Point) { minimum = simd_min(from, to); maximum = simd_max(from, to) }
        func contains(_ point: Point, tolerance: Double) -> Bool {
            point.x >= minimum.x - tolerance && point.x <= maximum.x + tolerance
                && point.y >= minimum.y - tolerance && point.y <= maximum.y + tolerance
        }
    }

    private struct Polygon {
        var vertices: [Vertex]
        var physicalBounds: Bounds
        var sourceBounds: Bounds
        var original: [Vertex]
        func points(in space: Space) -> [Point] {
            vertices.map { space == .source ? $0.source : $0.physical }
        }
        func map(_ point: Point, from space: Space) -> Point {
            let first = space == .source ? original[0].source : original[0].physical
            let second = space == .source ? original[1].source : original[1].physical
            let third = space == .source ? original[2].source : original[2].physical
            let determinant = MouseMappingRegion.cross(second - first, third - first)
            let secondWeight = MouseMappingRegion.cross(point - first, third - first) / determinant
            let thirdWeight = MouseMappingRegion.cross(second - first, point - first) / determinant
            let targetFirst = space == .source ? original[0].physical : original[0].source
            let targetSecond = space == .source ? original[1].physical : original[1].source
            let targetThird = space == .source ? original[2].physical : original[2].source
            return targetFirst + (targetSecond - targetFirst) * secondWeight + (targetThird - targetFirst) * thirdWeight
        }
    }

    private enum Space { case source, physical }

    /// Both coordinate spaces have independent, immutable uniform-grid indexes. Short mouse
    /// moves query nearby polygons; they do not scan the complete ~55k-triangle rendering mesh.
    private struct SpatialIndex {
        let bounds: Bounds
        let columns: Int
        let rows: Int
        let step: Point
        var buckets: [[Int]]

        init(bounds: Bounds, polygonBounds: [Bounds]) {
            self.bounds = bounds
            let extent = simd_max(bounds.maximum - bounds.minimum, Point(repeating: 1))
            let aspect = min(max(extent.x / extent.y, 0.125), 8)
            let cells = Double(max(polygonBounds.count / 3, 1))
            columns = min(max(Int(ceil(sqrt(cells * aspect))), 1), 256)
            rows = min(max(Int(ceil(sqrt(cells / aspect))), 1), 256)
            step = extent / Point(Double(columns), Double(rows))
            buckets = Array(repeating: [], count: columns * rows)
            for (index, rectangle) in polygonBounds.enumerated() {
                let range = cellRange(rectangle)
                for row in range.minY...range.maxY {
                    for column in range.minX...range.maxX { buckets[row * columns + column].append(index) }
                }
            }
        }

        private func cellRange(_ rectangle: Bounds) -> (minX: Int, maxX: Int, minY: Int, maxY: Int) {
            let lower = (rectangle.minimum - bounds.minimum - Point(repeating: MouseMappingRegion.tolerance)) / step
            let upper = (rectangle.maximum - bounds.minimum + Point(repeating: MouseMappingRegion.tolerance)) / step
            return (max(0, min(columns - 1, Int(min(max(floor(lower.x), 0), Double(columns - 1))))),
                    max(0, min(columns - 1, Int(min(max(floor(upper.x), 0), Double(columns - 1))))),
                    max(0, min(rows - 1, Int(min(max(floor(lower.y), 0), Double(rows - 1))))),
                    max(0, min(rows - 1, Int(min(max(floor(upper.y), 0), Double(rows - 1))))))
        }

        func candidates(in rectangle: Bounds) -> [Int] {
            let range = cellRange(rectangle)
            if range.minX == range.maxX && range.minY == range.maxY {
                return buckets[range.minY * columns + range.minX]
            }
            var found = Set<Int>()
            for row in range.minY...range.maxY {
                for column in range.minX...range.maxX { found.formUnion(buckets[row * columns + column]) }
            }
            return Array(found)
        }
    }

    private struct Interval {
        var lower: Double
        var upper: Double
        var exitTangent: Point
    }

    private var polygons = [Polygon]()
    private var sourceIndex: SpatialIndex?
    private var physicalIndex: SpatialIndex?
    private let sourceScale: Point

    init(mesh: GeneratedMesh, configuration: WarpConfiguration, sourceWidth: Int, sourceHeight: Int) {
        sourceSize = SIMD2(Float(sourceWidth), Float(sourceHeight))
        physicalSize = SIMD2(Float(configuration.displayPixelWidth), Float(configuration.displayPixelHeight))
        sourceScale = Point(Double(sourceWidth), Double(sourceHeight))
        guard mesh.validation.isValid, configuration.validationErrors().isEmpty,
              sourceWidth > 0, sourceHeight > 0,
              !mesh.indices.isEmpty, mesh.indices.count.isMultiple(of: 3),
              mesh.indices.allSatisfy({ Int($0) < mesh.vertices.count }),
              mesh.vertices.allSatisfy({ $0.position.x.isFinite && $0.position.y.isFinite && $0.uv.x.isFinite && $0.uv.y.isFinite }) else { return }
        let transform = MouseContentTransform(configuration: configuration, sourceWidth: sourceWidth, sourceHeight: sourceHeight)
        guard transform.isValid else { return }
        let width = configuration.displayPixelWidth
        let height = configuration.displayPixelHeight
        // Exactly the renderer's rounded/clamped MTLScissorRect, then actual drawable pixel centres.
        let aa = configuration.aaRect.sanitized()
        let scissorX = min(max(Int((aa.x * Double(width)).rounded()), 0), width - 1)
        let scissorY = min(max(Int((aa.y * Double(height)).rounded()), 0), height - 1)
        let scissorWidth = min(max(Int((aa.width * Double(width)).rounded()), 1), width - scissorX)
        let scissorHeight = min(max(Int((aa.height * Double(height)).rounded()), 1), height - scissorY)
        let physicalMinimum = Point(Double(scissorX) + 0.5, Double(scissorY) + 0.5)
        let physicalMaximum = Point(Double(scissorX + scissorWidth) - 0.5, Double(scissorY + scissorHeight) - 0.5)
        for index in stride(from: 0, to: mesh.indices.count, by: 3) {
            let triangle = (0..<3).map { offset -> Vertex in
                let vertex = mesh.vertices[Int(mesh.indices[index + offset])]
                let physical = Point((Double(vertex.position.x) + 1) * 0.5 * Double(width),
                                     (1 - Double(vertex.position.y)) * 0.5 * Double(height))
                return Vertex(physical: physical,
                              source: transform.sourceUV(doubleCanvasUV: Point(vertex.uv)) * sourceScale)
            }
            guard abs(Self.cross(triangle[1].physical - triangle[0].physical, triangle[2].physical - triangle[0].physical)) > 1e-12,
                  abs(Self.cross(triangle[1].source - triangle[0].source, triangle[2].source - triangle[0].source)) > 1e-12 else {
                polygons.removeAll()
                return
            }
            var clipped = triangle
            for axis in 0...1 {
                clipped = Self.clip(clipped, value: { $0.physical[axis] - physicalMinimum[axis] })
                clipped = Self.clip(clipped, value: { physicalMaximum[axis] - $0.physical[axis] })
                clipped = Self.clip(clipped, value: { $0.source[axis] })
                clipped = Self.clip(clipped, value: { sourceScale[axis] - $0.source[axis] })
            }
            guard clipped.count >= 3,
                  abs(Self.signedArea(clipped.map(\.physical))) > 1e-10,
                  abs(Self.signedArea(clipped.map(\.source))) > 1e-10 else { continue }
            polygons.append(Polygon(vertices: clipped,
                                    physicalBounds: Bounds(clipped.map(\.physical)),
                                    sourceBounds: Bounds(clipped.map(\.source)), original: triangle))
        }
        guard !polygons.isEmpty else { return }
        sourceIndex = SpatialIndex(bounds: Bounds(from: .zero, to: sourceScale), polygonBounds: polygons.map(\.sourceBounds))
        physicalIndex = SpatialIndex(bounds: Bounds(from: physicalMinimum, to: physicalMaximum), polygonBounds: polygons.map(\.physicalBounds))
        isValid = true
    }

    func physicalPoint(forSourceUV uv: SIMD2<Float>) -> SIMD2<Float>? {
        guard Self.finite(uv), let point = mapped(Point(uv) * sourceScale, from: .source) else { return nil }
        return SIMD2<Float>(point)
    }

    func sourceUV(forPhysicalPoint point: SIMD2<Float>) -> SIMD2<Float>? {
        guard Self.finite(point), let source = mapped(Point(point), from: .physical) else { return nil }
        return SIMD2<Float>(source / sourceScale)
    }

    func containsSourceUV(_ uv: SIMD2<Float>) -> Bool { physicalPoint(forSourceUV: uv) != nil }

    func nearestVisibleSourceUV(to uv: SIMD2<Float>) -> SIMD2<Float>? {
        guard Self.finite(uv), let nearest = nearestPoint(to: Point(uv) * sourceScale, in: .source) else { return nil }
        return SIMD2<Float>(nearest / sourceScale)
    }

    func nearestVisiblePhysicalPoint(to point: SIMD2<Float>) -> SIMD2<Float>? {
        guard Self.finite(point), let nearest = nearestPoint(to: Point(point), in: .physical) else { return nil }
        return SIMD2<Float>(nearest)
    }

    func constrainedSourceMove(from: SIMD2<Float>, to: SIMD2<Float>) -> SIMD2<Float> {
        guard Self.finite(from), Self.finite(to), isValid else { return from }
        return SIMD2<Float>(constrainedMove(from: Point(from) * sourceScale, to: Point(to) * sourceScale, in: .source) / sourceScale)
    }

    func constrainedPhysicalMove(from: SIMD2<Float>, to: SIMD2<Float>) -> SIMD2<Float> {
        guard Self.finite(from), Self.finite(to), isValid else { return from }
        return SIMD2<Float>(constrainedMove(from: Point(from), to: Point(to), in: .physical))
    }

    private static func finite(_ point: SIMD2<Float>) -> Bool { point.x.isFinite && point.y.isFinite }
    private static func cross(_ first: Point, _ second: Point) -> Double { first.x * second.y - first.y * second.x }
    private static func signedArea(_ points: [Point]) -> Double {
        guard points.count > 2 else { return 0 }
        // Translating to the first vertex avoids cancellation on tiny clipped polygons near 8K edges.
        return (1..<(points.count - 1)).reduce(0) { $0 + cross(points[$1] - points[0], points[$1 + 1] - points[0]) }
    }

    private static func clip(_ vertices: [Vertex], value: (Vertex) -> Double) -> [Vertex] {
        guard let last = vertices.last else { return [] }
        var result = [Vertex]()
        var previous = last
        var previousValue = value(last)
        for current in vertices {
            let currentValue = value(current)
            if (currentValue >= 0) != (previousValue >= 0) {
                result.append(Vertex.interpolate(previous, current, fraction: previousValue / (previousValue - currentValue)))
            }
            if currentValue >= 0 { result.append(current) }
            previous = current
            previousValue = currentValue
        }
        // Clipping directly through a triangle corner can produce consecutive duplicate vertices.
        var distinct = [Vertex]()
        for vertex in result where distinct.last.map({ simd_length_squared($0.physical - vertex.physical) > 1e-20 }) ?? true {
            distinct.append(vertex)
        }
        if distinct.count > 1, simd_length_squared(distinct[0].physical - distinct[distinct.count - 1].physical) <= 1e-20 {
            distinct.removeLast()
        }
        return distinct
    }

    private func index(for space: Space) -> SpatialIndex? { space == .source ? sourceIndex : physicalIndex }

    private func mapped(_ point: Point, from space: Space, tolerance: Double = MouseMappingRegion.tolerance) -> Point? {
        guard isValid, let index = index(for: space), index.bounds.contains(point, tolerance: tolerance) else { return nil }
        for candidate in index.candidates(in: Bounds(from: point, to: point)) {
            let polygon = polygons[candidate]
            let bounds = space == .source ? polygon.sourceBounds : polygon.physicalBounds
            guard bounds.contains(point, tolerance: tolerance) else { continue }
            let vertices = polygon.points(in: space)
            let sign = Self.signedArea(vertices) >= 0 ? 1.0 : -1.0
            var inside = true
            for edge in vertices.indices {
                let delta = vertices[(edge + 1) % vertices.count] - vertices[edge]
                if Self.cross(delta, point - vertices[edge]) * sign < -tolerance * simd_length(delta) {
                    inside = false
                    break
                }
            }
            if inside { return polygon.map(point, from: space) }
        }
        return nil
    }

    private func nearestPoint(to point: Point, in space: Space) -> Point? {
        guard isValid else { return nil }
        if mapped(point, from: space, tolerance: 0) != nil { return point }
        var nearest: Point?
        var bestDistance = Double.greatestFiniteMagnitude
        func consider(_ polygon: Polygon) {
            let bounds = space == .source ? polygon.sourceBounds : polygon.physicalBounds
            let boxDistance = simd_length_squared(point - simd_clamp(point, bounds.minimum, bounds.maximum))
            if boxDistance > bestDistance { return }
            let vertices = polygon.points(in: space)
            for edge in vertices.indices {
                let first = vertices[edge]
                let delta = vertices[(edge + 1) % vertices.count] - first
                let lengthSquared = simd_length_squared(delta)
                guard lengthSquared > 1e-20 else { continue }
                let fraction = min(max(simd_dot(point - first, delta) / lengthSquared, 0), 1)
                let projected = first + delta * fraction
                let distance = simd_length_squared(point - projected)
                if distance < bestDistance { bestDistance = distance; nearest = projected }
            }
        }
        // A Float cursor rounded a fraction of a pixel outside an edge is projected back onto
        // that exact edge using only nearby polygons. Keeping it merely "within tolerance"
        // would make its next tangential segment parallel but outside, causing sticky edges.
        if let index = index(for: space) {
            for candidate in index.candidates(in: Bounds(from: point, to: point)) { consider(polygons[candidate]) }
            if bestDistance <= Self.tolerance * Self.tolerance { return nearest }
        }
        // Full recovery is only needed on entry/reconfiguration or for an explicitly outside point.
        for polygon in polygons { consider(polygon) }
        return nearest
    }

    private func segmentInterval(from start: Point, to end: Point, vertices: [Point]) -> Interval? {
        let delta = end - start
        let sign = Self.signedArea(vertices) >= 0 ? 1.0 : -1.0
        var lower = 0.0
        var upper = 1.0
        var exitTangent = Point.zero
        for edge in vertices.indices {
            let first = vertices[edge]
            let tangent = vertices[(edge + 1) % vertices.count] - first
            let edgeLength = simd_length(tangent)
            guard edgeLength > 1e-12 else { continue }
            let measuredOffset = Self.cross(tangent, start - first) * sign / edgeLength
            let offset = abs(measuredOffset) < 1e-9 ? 0 : measuredOffset
            let slope = Self.cross(tangent, delta) * sign / edgeLength
            if abs(slope) < 1e-12 {
                if offset < -1e-8 { return nil }
                continue
            }
            let intersection = -offset / slope
            if slope > 0 { lower = max(lower, intersection) }
            else if intersection < upper { upper = intersection; exitTangent = tangent / edgeLength }
            if upper < lower - 1e-8 / max(simd_length(delta), 1) { return nil }
        }
        guard upper >= -1e-8 / max(simd_length(delta), 1), lower <= 1 else { return nil }
        return Interval(lower: max(0, lower), upper: min(1, max(0, upper)), exitTangent: exitTangent)
    }

    /// The union of intervals, not just endpoint membership, determines the FIRST exit. An endpoint
    /// on the opposite bank of an invisible concavity must never teleport the cursor across it.
    private func firstExit(from start: Point, to end: Point, in space: Space) -> (fraction: Double, tangent: Point) {
        guard let index = index(for: space) else { return (0, .zero) }
        let intervals = index.candidates(in: Bounds(from: start, to: end)).compactMap { candidate in
            segmentInterval(from: start, to: end, vertices: polygons[candidate].points(in: space))
        }.sorted { $0.lower == $1.lower ? $0.upper > $1.upper : $0.lower < $1.lower }
        let tolerance = 1e-8 / max(simd_length(end - start), 1)
        var reach = 0.0
        var tangent = Point.zero
        for interval in intervals {
            if interval.lower > reach + tolerance { break }
            if interval.upper >= reach {
                reach = interval.upper
                tangent = interval.exitTangent
            }
            if reach >= 1 { return (1, .zero) }
        }
        return (reach, tangent)
    }

    /// At a clipped triangle vertex the first limiting edge may be an INTERNAL mesh seam.
    /// Consider all incident edges and retain only a projected direction that can actually
    /// advance inside the union. This prevents alternation between an internal diagonal and
    /// the real silhouette when gliding across the tens of thousands of mesh facets.
    private func slidingDelta(at point: Point, remaining: Point, in space: Space) -> Point {
        guard let index = index(for: space) else { return .zero }
        var tangents = [Point]()
        for candidate in index.candidates(in: Bounds(from: point, to: point)) {
            let vertices = polygons[candidate].points(in: space)
            for edge in vertices.indices {
                let first = vertices[edge]
                let delta = vertices[(edge + 1) % vertices.count] - first
                let length = simd_length(delta)
                guard length > 1e-12 else { continue }
                let tangent = delta / length
                let projection = simd_dot(point - first, tangent)
                guard projection >= -1e-7, projection <= length + 1e-7,
                      abs(Self.cross(tangent, point - first)) <= 1e-7 else { continue }
                if !tangents.contains(where: { abs(simd_dot($0, tangent)) > 1 - 1e-14 }) { tangents.append(tangent) }
            }
        }
        var best = Point.zero
        var bestLengthSquared = 0.0
        for tangent in tangents {
            let projected = tangent * simd_dot(remaining, tangent)
            let lengthSquared = simd_length_squared(projected)
            guard lengthSquared > bestLengthSquared + 1e-16 else { continue }
            let available = firstExit(from: point, to: point + projected, in: space).fraction
            if available * sqrt(lengthSquared) > 1e-8 {
                best = projected
                bestLengthSquared = lengthSquared
            }
        }
        return best
    }

    private func constrainedMove(from start: Point, to target: Point, in space: Space) -> Point {
        guard var current = nearestPoint(to: start, in: space) else { return start }
        var remaining = target - current
        // Enough to traverse many small edge segments on one event, with a bounded work budget.
        for _ in 0..<64 {
            if simd_length_squared(remaining) < 1e-16 { return current }
            let exit = firstExit(from: current, to: current + remaining, in: space)
            if exit.fraction >= 1 { return current + remaining }
            let next = current + remaining * exit.fraction
            let unused = remaining * (1 - exit.fraction)
            let slide = slidingDelta(at: next, remaining: unused, in: space)
            if simd_length_squared(slide) < 1e-16 { return next }
            // At a corner a tangent can point straight into the next boundary. Do not oscillate.
            if simd_length_squared(next - current) < 1e-16,
               simd_length_squared(slide - remaining) < 1e-16 { return current }
            current = next
            remaining = slide
        }
        return current
    }
}
