import Foundation
import simd

struct CalibrationGridConfiguration: Codable, Equatable {
    var columns = 10
    var rows = 10
    var lineWidthPixels = 2.0

    var isValid: Bool {
        (1...200).contains(columns) && (1...200).contains(rows)
            && lineWidthPixels.isFinite && (1...32).contains(lineWidthPixels)
    }

    var shaderParameters: SIMD4<Float> {
        SIMD4(Float(columns), Float(rows), Float(lineWidthPixels), 0)
    }
}

extension WarpConfiguration {
    var calibrationGridBaseCanvas: CanvasConfiguration {
        extendedWarpEnabled ? (canvasReference?.gridCanvas ?? canvas) : canvas
    }

    var calibrationGridCellSize: SIMD2<Double> {
        let base = calibrationGridBaseCanvas
        return SIMD2(Double(base.width) / Double(render.calibrationGrid.columns), Double(base.height) / Double(render.calibrationGrid.rows))
    }

    var calibrationGridCoverage: SIMD2<Float> {
        gridUVScale * SIMD2(Float(render.calibrationGrid.columns), Float(render.calibrationGrid.rows))
    }

    var calibrationGridSummary: String {
        let base = calibrationGridBaseCanvas
        let size = calibrationGridCellSize
        let coverage = calibrationGridCoverage
        return String(
            format: "网格基准画布：%d × %d；每个大格：%.2f × %.2f 逻辑像素。\n当前完整画布覆盖约 %.2f 列 × %.2f 行；含边缘不完整格，不是 AA 内可见格数。",
            base.width, base.height, size.x, size.y, Double(coverage.x), Double(coverage.y)
        )
    }
}
