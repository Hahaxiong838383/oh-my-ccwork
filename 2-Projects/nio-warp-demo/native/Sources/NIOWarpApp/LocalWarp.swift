import Foundation
import simd

struct LocalWarpReference: Codable, Equatable {
    var canvas: CanvasConfiguration
    var bounds: WarpMappingBounds
    var cellWidth: Double
    var cellHeight: Double

    var isValid: Bool {
        (64...32768).contains(canvas.width) && (64...32768).contains(canvas.height)
            && bounds.isValid && [bounds.minimumX, bounds.minimumY, bounds.maximumX, bounds.maximumY, cellWidth, cellHeight].allSatisfy(\.isFinite)
            && max(max(abs(bounds.minimumX), abs(bounds.maximumX)), max(abs(bounds.minimumY), abs(bounds.maximumY))) <= 5_000_000
            && cellWidth >= 0.0001 && cellHeight >= 0.0001 && cellWidth <= 32768 && cellHeight <= 32768
    }
}

struct LocalWarpAnchor: Codable, Equatable, Identifiable {
    var id = UUID()
    var x: Double
    var y: Double
    var offsetX: Double
    var offsetY: Double
    var coordinate: SIMD2<Double> { SIMD2(x, y) }
    var offset: SIMD2<Double> { SIMD2(offsetX, offsetY) }
}

struct LocalWarpConfiguration: Codable, Equatable {
    var enabled = false
    var lockBoundary = true
    var radiusCells = 2.0
    var reference: LocalWarpReference?
    var anchors = [LocalWarpAnchor]()

    func boundaryWeight(at point: SIMD2<Double>) -> Double {
        guard lockBoundary, let reference else { return 1 }
        let distance = min(min(
            (point.x - reference.bounds.minimumX) / reference.cellWidth,
            (reference.bounds.maximumX - point.x) / reference.cellWidth), min(
            (point.y - reference.bounds.minimumY) / reference.cellHeight,
            (reference.bounds.maximumY - point.y) / reference.cellHeight
        ))
        let fraction = min(max(distance, 0), 1)
        return fraction * fraction * (3 - 2 * fraction)
    }

    func anchor(at point: SIMD2<Double>) -> LocalWarpAnchor? {
        anchors.first { simd_length($0.coordinate - point) < 0.0001 }
    }

    mutating func setOffset(_ offset: SIMD2<Double>, at point: SIMD2<Double>) {
        if let index = anchors.firstIndex(where: { simd_length($0.coordinate - point) < 0.0001 }) {
            anchors[index].offsetX = offset.x
            anchors[index].offsetY = offset.y
        } else {
            anchors.append(LocalWarpAnchor(x: point.x, y: point.y, offsetX: offset.x, offsetY: offset.y))
        }
    }

    func validationErrors() -> [String] {
        var errors = [String]()
        if !radiusCells.isFinite || !(0.5...4).contains(radiusCells) { errors.append("局部影响范围须为 0.5～4 个参考大格") }
        if anchors.count > 64 { errors.append("最多保留 64 个局部锚点，请复用已有点或清理不需要的点") }
        if let reference, !reference.isValid { errors.append("局部参考坐标无效") }
        if !anchors.isEmpty && reference == nil { errors.append("局部锚点缺少参考坐标") }
        if Set(anchors.map(\.id)).count != anchors.count { errors.append("局部锚点 ID 重复") }
        for (index, anchor) in anchors.enumerated() {
            if ![anchor.x, anchor.y, anchor.offsetX, anchor.offsetY].allSatisfy(\.isFinite)
                || max(abs(anchor.x), abs(anchor.y)) > 5_000_000
                || max(abs(anchor.offsetX), abs(anchor.offsetY)) > 1000 {
                errors.append("局部点坐标无效，偏移须在 ±1000 个物理像素内")
            }
            if anchors.prefix(index).contains(where: { simd_length($0.coordinate - anchor.coordinate) < 0.0001 }) { errors.append("局部锚点位置重复") }
            if boundaryWeight(at: anchor.coordinate) < 0.000001 && simd_length(anchor.offset) > 0.000001 {
                errors.append("参考边界已锁定；先复位边界点或解锁边界，数据没有被清空")
            }
        }
        return errors
    }
}

struct LocalWarpField {
    private let configuration: LocalWarpConfiguration
    private var centers = [SIMD2<Double>]()
    private var coefficients = [SIMD2<Double>]()
    private(set) var error: String?

    init(_ configuration: LocalWarpConfiguration) {
        self.configuration = configuration
        if let error = configuration.validationErrors().first { self.error = error; return }
        guard let reference = configuration.reference else { return }
        let anchors = configuration.anchors.filter { configuration.boundaryWeight(at: $0.coordinate) >= 0.000001 }
        centers = anchors.map(\.coordinate)
        let count = anchors.count
        guard count > 0 else { return }
        var matrix = [[Double]]()
        for anchor in anchors {
            var row = anchors.map { center in Self.kernel(anchor.coordinate - center.coordinate, reference: reference, radius: configuration.radiusCells) }
            let target = anchor.offset / configuration.boundaryWeight(at: anchor.coordinate)
            row.append(contentsOf: [target.x, target.y])
            matrix.append(row)
        }
        for column in 0..<count {
            let pivot = (column..<count).max { abs(matrix[$0][column]) < abs(matrix[$1][column]) }!
            guard abs(matrix[pivot][column]) > 1e-9 else { error = "局部控制点过于接近，无法稳定求解"; return }
            matrix.swapAt(column, pivot)
            let divisor = matrix[column][column]
            for entry in column..<(count + 2) { matrix[column][entry] /= divisor }
            for row in 0..<count where row != column {
                let factor = matrix[row][column]
                for entry in column..<(count + 2) { matrix[row][entry] -= factor * matrix[column][entry] }
            }
        }
        coefficients = matrix.map { SIMD2($0[count], $0[count + 1]) }
        if coefficients.contains(where: { !$0.x.isFinite || !$0.y.isFinite }) { error = "局部求解出现无效数值" }
    }

    private static func kernel(_ difference: SIMD2<Double>, reference: LocalWarpReference, radius: Double) -> Double {
        let scaled = difference / SIMD2(reference.cellWidth * radius, reference.cellHeight * radius)
        let squared = simd_length_squared(scaled)
        guard squared < 1 else { return 0 }
        let distance = sqrt(squared)
        let remaining = 1 - distance
        return remaining * remaining * remaining * remaining * (4 * distance + 1)
    }

    func displacement(at point: SIMD2<Double>) -> SIMD2<Double> {
        guard error == nil else { return SIMD2(repeating: .nan) }
        guard let reference = configuration.reference else { return .zero }
        let boundary = configuration.boundaryWeight(at: point)
        guard boundary > 0 else { return .zero }
        var offset = SIMD2<Double>.zero
        for index in centers.indices { offset += coefficients[index] * Self.kernel(point - centers[index], reference: reference, radius: configuration.radiusCells) }
        return offset * boundary
    }
}

extension WarpConfiguration {
    var localCoordinateScale: SIMD2<Double> {
        let basis = localWarp.reference?.canvas ?? calibrationGridBaseCanvas
        let gridBase = calibrationGridBaseCanvas
        let scale = extendedWarpEnabled ? SIMD2(Double(canvas.width) / Double(gridBase.width), Double(canvas.height) / Double(gridBase.height)) : SIMD2(repeating: 1)
        return SIMD2(Double(basis.width), Double(basis.height)) * scale
    }

    func localCoordinate(at canvasUV: SIMD2<Float>) -> SIMD2<Double> {
        (SIMD2(Double(canvasUV.x), Double(canvasUV.y)) - 0.5) * localCoordinateScale
    }

    func canvasUV(for localCoordinate: SIMD2<Double>) -> SIMD2<Float> {
        let point = 0.5 + localCoordinate / localCoordinateScale
        return SIMD2(Float(point.x), Float(point.y))
    }

    func preparedForLocalEditing() -> WarpConfiguration {
        guard localWarp.reference == nil else { return self }
        var copy = self
        let extent = localCoordinateScale
        let base = calibrationGridBaseCanvas
        copy.localWarp.reference = LocalWarpReference(
            canvas: base,
            bounds: WarpMappingBounds(minimumX: -extent.x / 2, minimumY: -extent.y / 2, maximumX: extent.x / 2, maximumY: extent.y / 2),
            cellWidth: Double(base.width) / Double(render.calibrationGrid.columns),
            cellHeight: Double(base.height) / Double(render.calibrationGrid.rows)
        )
        return copy
    }
}
