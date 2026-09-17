import Foundation
import simd

/// Each component is measured in output physical pixels. Derivatives use normalized canvas UV,
/// so a cubic Bezier handle is `offset ± tangent * neighbouringKnotDistance / 3`.
struct BezierWarpNode: Codable, Equatable, Identifiable {
    var id = UUID()
    var offset = SIMD2<Double>.zero
    var tangentU = SIMD2<Double>.zero
    var tangentV = SIMD2<Double>.zero
    var mixedDerivative = SIMD2<Double>.zero
}

enum BezierWarpAxis: String, Codable, CaseIterable {
    case horizontal, vertical
}

enum BezierWarpScope: String, Codable, CaseIterable {
    case wholeCanvas, region
    var title: String { self == .wholeCanvas ? "贯穿画面" : "指定分区" }
}

enum BezierWarpLinkage: String, Codable, CaseIterable {
    case uniform, gradient
    var title: String { self == .uniform ? "等量联动" : "渐变联动" }
}

/// A C1 tensor cubic Hermite displacement surface, added after the existing global warp.
/// A single node or handle change can propagate through multiple rows. The X/Y edit ranges
/// control propagation to neighbouring nodes; interpolation smoothly reaches the next unchanged
/// node. They do not crop the existing field, so changing edit range never moves saved geometry.
struct BezierWarpConfiguration: Codable, Equatable {
    var enabled = false
    var horizontalKnots: [Double]
    var verticalKnots: [Double]
    var nodes: [BezierWarpNode]
    var scope = BezierWarpScope.wholeCanvas
    var linkage = BezierWarpLinkage.uniform
    var horizontalRadius = 0.35
    var verticalRadius = 0.7

    var columns: Int { horizontalKnots.count }
    var rows: Int { verticalKnots.count }
    var hasEdits: Bool {
        nodes.contains { $0.offset != .zero || $0.tangentU != .zero || $0.tangentV != .zero || $0.mixedDerivative != .zero }
    }

    init(columns: Int = 5, rows: Int = 3) {
        let safeColumns = min(max(columns, 2), 9)
        let safeRows = min(max(rows, 2), 7)
        horizontalKnots = Self.uniformKnots(safeColumns)
        verticalKnots = Self.uniformKnots(safeRows)
        // Identical pristine configurations must compare equal (presets, migrations, renderer state).
        nodes = (0..<(safeColumns * safeRows)).map { index in
            let suffix = String(format: "%012X", safeColumns * 10_000 + safeRows * 100 + index)
            return BezierWarpNode(id: UUID(uuidString: "B3A1E000-0000-4000-8000-" + suffix)!)
        }
    }

    private enum CodingKeys: String, CodingKey {
        case enabled, horizontalKnots, verticalKnots, nodes, scope, linkage, horizontalRadius, verticalRadius
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.init()
        enabled = try container.decodeIfPresent(Bool.self, forKey: .enabled) ?? false
        let hasTopology = container.contains(.horizontalKnots) || container.contains(.verticalKnots) || container.contains(.nodes)
        if hasTopology {
            // Partial topology is malformed, rather than silently replacing saved calibration.
            horizontalKnots = try container.decode([Double].self, forKey: .horizontalKnots)
            verticalKnots = try container.decode([Double].self, forKey: .verticalKnots)
            nodes = try container.decode([BezierWarpNode].self, forKey: .nodes)
        }
        scope = try container.decodeIfPresent(BezierWarpScope.self, forKey: .scope) ?? .wholeCanvas
        linkage = try container.decodeIfPresent(BezierWarpLinkage.self, forKey: .linkage) ?? .uniform
        horizontalRadius = try container.decodeIfPresent(Double.self, forKey: .horizontalRadius) ?? 0.35
        verticalRadius = try container.decodeIfPresent(Double.self, forKey: .verticalRadius) ?? 0.7
        if let error = validationErrors().first {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: error))
        }
    }

    static func uniformKnots(_ count: Int) -> [Double] {
        guard count >= 2 else { return [0, 1] }
        return (0..<count).map { Double($0) / Double(count - 1) }
    }

    func coordinate(at index: Int) -> SIMD2<Double> {
        guard nodes.indices.contains(index), columns >= 2, rows >= 2,
              index / columns < rows else { return SIMD2(repeating: .nan) }
        return SIMD2(horizontalKnots[index % columns], verticalKnots[index / columns])
    }

    func validationErrors() -> [String] {
        var errors = [String]()
        func validKnots(_ knots: [Double], count: ClosedRange<Int>) -> Bool {
            guard count.contains(knots.count), knots.first == 0, knots.last == 1,
                  knots.allSatisfy({ $0.isFinite && (0...1).contains($0) }) else { return false }
            return zip(knots, knots.dropFirst()).allSatisfy { $1 - $0 >= 0.0001 }
        }
        if !validKnots(horizontalKnots, count: 2...9) { errors.append("贝塞尔控制列须为 2～9 列，坐标必须递增且覆盖整幅画面") }
        if !validKnots(verticalKnots, count: 2...7) { errors.append("贝塞尔控制行须为 2～7 行，坐标必须递增且覆盖整幅画面") }
        if nodes.count != columns * rows || nodes.count > 63 { errors.append("贝塞尔控制点数量与控制网不一致") }
        if Set(nodes.map(\.id)).count != nodes.count { errors.append("贝塞尔控制点 ID 重复") }
        if !horizontalRadius.isFinite || !(0.05...1).contains(horizontalRadius)
            || !verticalRadius.isFinite || !(0.05...1).contains(verticalRadius) {
            errors.append("贝塞尔横向和纵向影响范围须在 5%～100% 内")
        }
        func valid(_ vector: SIMD2<Double>, limit: Double) -> Bool {
            vector.x.isFinite && vector.y.isFinite && abs(vector.x) <= limit && abs(vector.y) <= limit
        }
        for node in nodes {
            if !valid(node.offset, limit: 1000) || !valid(node.tangentU, limit: 20_000)
                || !valid(node.tangentV, limit: 20_000) || !valid(node.mixedDerivative, limit: 1_000_000) {
                errors.append("贝塞尔偏移须在 ±1000 物理像素内，切线和混合导数必须有限且在安全范围内")
                break
            }
        }
        return errors
    }

    func displacement(at uv: SIMD2<Double>) -> SIMD2<Double> {
        BezierWarpField(self).displacement(at: uv)
    }

    /// Editing a point transports a smooth displacement field, including its derivatives.
    /// This keeps linked rows parallel in uniform mode and avoids sharp transitions in gradient mode.
    @discardableResult
    mutating func applyOffsetDelta(_ delta: SIMD2<Double>, at index: Int) -> Bool {
        guard validationErrors().isEmpty, nodes.indices.contains(index), delta.x.isFinite, delta.y.isFinite else { return false }
        let origin = coordinate(at: index)
        var candidate = self
        for target in nodes.indices {
            let uv = coordinate(at: target)
            let wx = Self.falloff(uv.x - origin.x, radius: horizontalRadius, plateau: 0)
            let wy = verticalWeight(at: uv.y, origin: origin.y)
            candidate.nodes[target].offset += delta * (wx.value * wy.value)
            candidate.nodes[target].tangentU += delta * (wx.derivative * wy.value)
            candidate.nodes[target].tangentV += delta * (wx.value * wy.derivative)
            candidate.nodes[target].mixedDerivative += delta * (wx.derivative * wy.derivative)
        }
        guard candidate.validationErrors().isEmpty else { return false }
        self = candidate
        return true
    }

    /// Changes Bezier handles and propagates curvature through the selected depth.
    /// Node positions stay fixed. The same Hermite curve on every row gives equal linkage;
    /// differentiated Y weights provide smooth gradient linkage between rows.
    @discardableResult
    mutating func applyTangentDelta(_ delta: SIMD2<Double>, axis: BezierWarpAxis, at index: Int) -> Bool {
        guard validationErrors().isEmpty, nodes.indices.contains(index), delta.x.isFinite, delta.y.isFinite else { return false }
        let origin = coordinate(at: index)
        var candidate = self
        for target in nodes.indices {
            let uv = coordinate(at: target)
            let wx = Self.falloff(uv.x - origin.x, radius: horizontalRadius, plateau: 0)
            let wy = verticalWeight(at: uv.y, origin: origin.y)
            switch axis {
            case .horizontal:
                candidate.nodes[target].tangentU += delta * (wx.value * wy.value)
                candidate.nodes[target].mixedDerivative += delta * (wx.value * wy.derivative)
            case .vertical:
                candidate.nodes[target].tangentV += delta * (wx.value * wy.value)
                candidate.nodes[target].mixedDerivative += delta * (wx.derivative * wy.value)
            }
        }
        guard candidate.validationErrors().isEmpty else { return false }
        self = candidate
        return true
    }

    private func verticalWeight(at coordinate: Double, origin: Double) -> (value: Double, derivative: Double) {
        if scope == .wholeCanvas && linkage == .uniform { return (1, 0) }
        let radius = scope == .wholeCanvas ? 1.0 : verticalRadius
        return Self.falloff(coordinate - origin, radius: radius, plateau: linkage == .uniform ? 0.65 : 0)
    }

    /// C2 smootherstep compact support. Uniform regional linkage has an equal-displacement
    /// central plateau and a smooth transition to the first unmodified surrounding row.
    private static func falloff(_ distance: Double, radius: Double, plateau: Double) -> (value: Double, derivative: Double) {
        let normalized = abs(distance) / radius
        if normalized <= plateau { return (1, 0) }
        if normalized >= 1 { return (0, 0) }
        let t = (normalized - plateau) / (1 - plateau)
        let value = 1 - t * t * t * (10 + t * (-15 + 6 * t))
        let derivative = -30 * t * t * (1 - t) * (1 - t) / (radius * (1 - plateau)) * (distance < 0 ? -1 : 1)
        return (value, derivative)
    }

    /// Shape-preserving subdivision samples value, both derivatives and the mixed derivative.
    /// Retaining old knots is essential: replacing the whole grid with equally-spaced points
    /// would silently change an existing piecewise cubic curve.
    @discardableResult
    mutating func insertColumn(at coordinate: Double) -> Bool {
        insertKnot(coordinate, axis: .horizontal)
    }

    @discardableResult
    mutating func insertRow(at coordinate: Double) -> Bool {
        insertKnot(coordinate, axis: .vertical)
    }

    private mutating func insertKnot(_ coordinate: Double, axis: BezierWarpAxis) -> Bool {
        guard validationErrors().isEmpty, coordinate.isFinite, coordinate > 0, coordinate < 1 else { return false }
        let knots = axis == .horizontal ? horizontalKnots : verticalKnots
        guard knots.count < (axis == .horizontal ? 9 : 7),
              knots.allSatisfy({ abs($0 - coordinate) >= 0.0001 }) else { return false }
        let field = BezierWarpField(self)
        var candidate = self
        if axis == .horizontal { candidate.horizontalKnots.append(coordinate); candidate.horizontalKnots.sort() }
        else { candidate.verticalKnots.append(coordinate); candidate.verticalKnots.sort() }
        candidate.nodes = []
        for v in candidate.verticalKnots {
            for u in candidate.horizontalKnots {
                if let x = horizontalKnots.firstIndex(of: u), let y = verticalKnots.firstIndex(of: v) {
                    candidate.nodes.append(nodes[y * columns + x])
                } else {
                    let sample = field.sample(at: SIMD2(u, v))
                    candidate.nodes.append(BezierWarpNode(offset: sample.value, tangentU: sample.du, tangentV: sample.dv, mixedDerivative: sample.duv))
                }
            }
        }
        guard candidate.validationErrors().isEmpty else { return false }
        self = candidate
        return true
    }

    /// Increasing counts preserves the surface. Decreasing edited grids is intentionally refused
    /// until the UI explicitly confirms reset; there is no silent approximate decimation.
    @discardableResult
    mutating func resize(columns newColumns: Int, rows newRows: Int, allowReset: Bool = false) -> Bool {
        guard (2...9).contains(newColumns), (2...7).contains(newRows), validationErrors().isEmpty else { return false }
        if newColumns == columns && newRows == rows { return true }
        if newColumns < columns || newRows < rows {
            guard allowReset || !hasEdits else { return false }
            let fresh = Self(columns: newColumns, rows: newRows)
            horizontalKnots = fresh.horizontalKnots
            verticalKnots = fresh.verticalKnots
            nodes = fresh.nodes
            return true
        }
        var candidate = self
        func midpointOfLongest(_ knots: [Double]) -> Double {
            var index = 0
            for candidate in 1..<(knots.count - 1) {
                if knots[candidate + 1] - knots[candidate] > knots[index + 1] - knots[index] { index = candidate }
            }
            return (knots[index] + knots[index + 1]) * 0.5
        }
        while candidate.columns < newColumns {
            guard candidate.insertColumn(at: midpointOfLongest(candidate.horizontalKnots)) else { return false }
        }
        while candidate.rows < newRows {
            guard candidate.insertRow(at: midpointOfLongest(candidate.verticalKnots)) else { return false }
        }
        self = candidate
        return true
    }

    mutating func resetDeformation() {
        for index in nodes.indices {
            nodes[index].offset = .zero
            nodes[index].tangentU = .zero
            nodes[index].tangentV = .zero
            nodes[index].mixedDerivative = .zero
        }
    }
}

/// Prepared, validated surface for sampling in the hot render path. Invalid fields return NaN
/// so the existing mesh validator rejects them; disabled valid fields have no visual effect.
struct BezierWarpField {
    private let configuration: BezierWarpConfiguration
    private(set) var error: String?

    init(_ configuration: BezierWarpConfiguration) {
        self.configuration = configuration
        error = configuration.validationErrors().first
    }

    func displacement(at uv: SIMD2<Double>) -> SIMD2<Double> {
        guard error == nil else { return SIMD2(repeating: .nan) }
        guard configuration.enabled else { return .zero }
        return sample(at: uv).value
    }

    struct Sample {
        var value = SIMD2<Double>.zero
        var du = SIMD2<Double>.zero
        var dv = SIMD2<Double>.zero
        var duv = SIMD2<Double>.zero
    }

    /// Also samples a disabled surface for shape-preserving topology edits.
    func sample(at uv: SIMD2<Double>) -> Sample {
        guard error == nil, uv.x.isFinite, uv.y.isFinite else {
            let invalid = SIMD2<Double>(repeating: .nan)
            return Sample(value: invalid, du: invalid, dv: invalid, duv: invalid)
        }
        // Outside UV is clamped to the endpoint displacement; the base warp still defines
        // the output geometry. Normal rendering evaluates only [0,1]².
        let u = min(max(uv.x, 0), 1)
        let v = min(max(uv.y, 0), 1)
        func interval(_ knots: [Double], at value: Double) -> Int {
            min(max((knots.firstIndex(where: { $0 > value }) ?? knots.count) - 1, 0), knots.count - 2)
        }
        let column = interval(configuration.horizontalKnots, at: u)
        let row = interval(configuration.verticalKnots, at: v)
        let width = configuration.horizontalKnots[column + 1] - configuration.horizontalKnots[column]
        let height = configuration.verticalKnots[row + 1] - configuration.verticalKnots[row]
        let bu = Self.basis((u - configuration.horizontalKnots[column]) / width, scale: width)
        let bv = Self.basis((v - configuration.verticalKnots[row]) / height, scale: height)
        var sample = Sample()
        for y in 0...1 {
            for x in 0...1 {
                let node = configuration.nodes[(row + y) * configuration.columns + column + x]
                let terms = [node.offset, node.tangentU, node.tangentV, node.mixedDerivative]
                let ix = [x, x + 2, x, x + 2]
                let iy = [y, y, y + 2, y + 2]
                for term in 0..<4 {
                    sample.value += terms[term] * (bu.value[ix[term]] * bv.value[iy[term]])
                    sample.du += terms[term] * (bu.derivative[ix[term]] * bv.value[iy[term]])
                    sample.dv += terms[term] * (bu.value[ix[term]] * bv.derivative[iy[term]])
                    sample.duv += terms[term] * (bu.derivative[ix[term]] * bv.derivative[iy[term]])
                }
            }
        }
        return sample
    }

    private static func basis(_ t: Double, scale: Double) -> (value: [Double], derivative: [Double]) {
        let t2 = t * t
        let t3 = t2 * t
        return (
            [2 * t3 - 3 * t2 + 1, -2 * t3 + 3 * t2, (t3 - 2 * t2 + t) * scale, (t3 - t2) * scale],
            [(6 * t2 - 6 * t) / scale, (-6 * t2 + 6 * t) / scale, 3 * t2 - 4 * t + 1, 3 * t2 - 2 * t]
        )
    }
}
