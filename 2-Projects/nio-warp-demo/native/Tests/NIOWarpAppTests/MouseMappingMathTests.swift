import Foundation
import XCTest
import simd
@testable import NIOWarpApp

final class MouseMappingMathTests: XCTestCase {
    private func flatConfiguration(width: Int = 1200, height: Int = 600) -> WarpConfiguration {
        var configuration = WarpConfiguration.defaultConfiguration(displayWidth: width, displayHeight: height)
        configuration.canvas = CanvasConfiguration(width: width, height: height)
        configuration.aaRect = NormalizedRect(x: 0, y: 0, width: 1, height: 1)
        configuration.contentMode = .stretch
        configuration.manual.enabled = false
        configuration.mirror.horizontal = false
        configuration.mirror.vertical = false
        return configuration
    }

    private func flatMesh() -> GeneratedMesh {
        GeneratedMesh(vertices: [
            MeshVertex(position: SIMD2(-1, 1), uv: SIMD2(0, 0)),
            MeshVertex(position: SIMD2(1, 1), uv: SIMD2(1, 0)),
            MeshVertex(position: SIMD2(-1, -1), uv: SIMD2(0, 1)),
            MeshVertex(position: SIMD2(1, -1), uv: SIMD2(1, 1))
        ], indices: [0, 1, 3, 0, 3, 2], validation: MeshValidation(foldedCellCount: 0, outOfAASampleCount: 0, totalSampleCount: 4))
    }

    /// Independent literal CPU interpretation of fragmentMain; checks transform order, rather
    /// than comparing two directions that could share an incorrect but invertible formula.
    private func shaderSourceUV(_ canvas: SIMD2<Float>, configuration: WarpConfiguration, width: Int, height: Int) -> SIMD2<Float> {
        var uv = SIMD2<Float>(repeating: 0.5) + (canvas - SIMD2<Float>(repeating: 0.5)) * configuration.contentUVScale
        let sourceAspect = Float(width) / Float(height)
        let canvasAspect = configuration.contentCanvas.aspect
        if configuration.contentMode == .fit {
            if sourceAspect < canvasAspect {
                let visible = sourceAspect / canvasAspect
                uv.x = (uv.x - (1 - visible) * 0.5) / visible
            } else {
                let visible = canvasAspect / sourceAspect
                uv.y = (uv.y - (1 - visible) * 0.5) / visible
            }
        } else if configuration.contentMode == .fill {
            if sourceAspect < canvasAspect {
                let sampled = sourceAspect / canvasAspect
                uv.y = uv.y * sampled + (1 - sampled) * (Float(configuration.cropAnchor.vertical) + 1) * 0.5
            } else {
                let sampled = canvasAspect / sourceAspect
                uv.x = uv.x * sampled + (1 - sampled) * (Float(configuration.cropAnchor.horizontal) + 1) * 0.5
            }
        }
        if configuration.mirror.horizontal { uv.x = 1 - uv.x }
        if configuration.mirror.vertical { uv.y = 1 - uv.y }
        return uv
    }

    func testFourMirrorsAndContentModesMatchShaderIncludingCropAndGrowth() throws {
        for mode in ContentMode.allCases {
            for horizontal in [false, true] {
                for vertical in [false, true] {
                    for dimensions in [(1800, 500), (500, 1800)] {
                        var configuration = flatConfiguration()
                        configuration.contentMode = mode
                        configuration.mirror.horizontal = horizontal
                        configuration.mirror.vertical = vertical
                        configuration.cropAnchor.horizontal = -0.63
                        configuration.cropAnchor.vertical = 0.71
                        configuration.enableCanvasGrowth()
                        configuration.canvas.width = 1680
                        configuration.canvas.height = 840
                        let transform = MouseContentTransform(configuration: configuration, sourceWidth: dimensions.0, sourceHeight: dimensions.1)
                        let region = MouseMappingRegion(mesh: flatMesh(), configuration: configuration, sourceWidth: dimensions.0, sourceHeight: dimensions.1)
                        XCTAssertTrue(region.isValid)
                        var validCount = 0
                        for row in 1..<10 {
                            for column in 1..<10 {
                                let canvas = SIMD2(Float(column) / 10, Float(row) / 10)
                                let expected = shaderSourceUV(canvas, configuration: configuration, width: dimensions.0, height: dimensions.1)
                                let actual = transform.sourceUV(forCanvasUV: canvas)
                                XCTAssertEqual(actual.x, expected.x, accuracy: 0.000002)
                                XCTAssertEqual(actual.y, expected.y, accuracy: 0.000002)
                                let recovered = transform.canvasUV(forSourceUV: actual)
                                XCTAssertEqual(recovered.x, canvas.x, accuracy: 0.000002)
                                XCTAssertEqual(recovered.y, canvas.y, accuracy: 0.000002)
                                let physical = SIMD2(canvas.x * 1200, canvas.y * 600)
                                if expected.x >= 0, expected.x <= 1, expected.y >= 0, expected.y <= 1 {
                                    let source = try XCTUnwrap(region.sourceUV(forPhysicalPoint: physical))
                                    XCTAssertEqual(source.x, expected.x, accuracy: 0.000002)
                                    XCTAssertEqual(source.y, expected.y, accuracy: 0.000002)
                                    let roundtrip = try XCTUnwrap(region.physicalPoint(forSourceUV: source))
                                    XCTAssertEqual(roundtrip.x, physical.x, accuracy: 0.002)
                                    XCTAssertEqual(roundtrip.y, physical.y, accuracy: 0.002)
                                    validCount += 1
                                } else {
                                    XCTAssertNil(region.sourceUV(forPhysicalPoint: physical), "fit/growth 留黑不能成为可点击区域")
                                }
                            }
                        }
                        XCTAssertGreaterThan(validCount, 0)
                    }
                }
            }
        }
    }

    func testHotspotReachesFirstAndLastPixelCentresWithoutCursorMargin() throws {
        let configuration = flatConfiguration()
        let region = MouseMappingRegion(mesh: flatMesh(), configuration: configuration, sourceWidth: 1200, sourceHeight: 600)
        let cases: [(SIMD2<Float>, SIMD2<Float>)] = [
            (SIMD2(-1, 0.5), SIMD2(0.5, 300)), (SIMD2(2, 0.5), SIMD2(1199.5, 300)),
            (SIMD2(0.5, -1), SIMD2(600, 0.5)), (SIMD2(0.5, 2), SIMD2(600, 599.5))
        ]
        for (outside, expected) in cases {
            let source = try XCTUnwrap(region.nearestVisibleSourceUV(to: outside))
            let physical = try XCTUnwrap(region.physicalPoint(forSourceUV: source))
            XCTAssertEqual(physical.x, expected.x, accuracy: 0.01)
            XCTAssertEqual(physical.y, expected.y, accuracy: 0.01)
        }
        XCTAssertNil(region.sourceUV(forPhysicalPoint: SIMD2(0, 300)))
        XCTAssertNil(region.sourceUV(forPhysicalPoint: SIMD2(1200, 300)))
        XCTAssertNil(region.sourceUV(forPhysicalPoint: SIMD2(600, 0)))
        XCTAssertNil(region.sourceUV(forPhysicalPoint: SIMD2(600, 600)))
    }

    func testAAUsesSameRoundedScissorPixelCentresAsRenderer() throws {
        var configuration = flatConfiguration()
        configuration.aaRect = NormalizedRect(x: 0.1234, y: 0.1828, width: 0.71, height: 0.64)
        let region = MouseMappingRegion(mesh: flatMesh(), configuration: configuration, sourceWidth: 1200, sourceHeight: 600)
        let left = try XCTUnwrap(region.nearestVisiblePhysicalPoint(to: SIMD2(-100, 300)))
        let right = try XCTUnwrap(region.nearestVisiblePhysicalPoint(to: SIMD2(2000, 300)))
        let top = try XCTUnwrap(region.nearestVisiblePhysicalPoint(to: SIMD2(600, -100)))
        let bottom = try XCTUnwrap(region.nearestVisiblePhysicalPoint(to: SIMD2(600, 1000)))
        XCTAssertEqual(left.x, 148.5, accuracy: 0.001)
        XCTAssertEqual(right.x, 999.5, accuracy: 0.001)
        XCTAssertEqual(top.y, 110.5, accuracy: 0.001)
        XCTAssertEqual(bottom.y, 493.5, accuracy: 0.001)
        XCTAssertNil(region.sourceUV(forPhysicalPoint: SIMD2(148, 300)))
    }

    func testContinuousTangentialSlidingAlongEdgesAndCornersInBothSpaces() throws {
        let region = MouseMappingRegion(mesh: flatMesh(), configuration: flatConfiguration(), sourceWidth: 1200, sourceHeight: 600)
        var physical = SIMD2<Float>(600, 599.5)
        for _ in 0..<30 {
            let previous = physical
            physical = region.constrainedPhysicalMove(from: physical, to: physical + SIMD2(10, 50))
            XCTAssertGreaterThan(physical.x, previous.x)
            XCTAssertEqual(physical.y, 599.5, accuracy: 0.01)
            XCTAssertNotNil(region.sourceUV(forPhysicalPoint: physical))
        }
        XCTAssertEqual(physical.x, 900, accuracy: 0.01)
        let corner = region.constrainedPhysicalMove(from: physical, to: SIMD2(2000, 900))
        XCTAssertEqual(corner.x, 1199.5, accuracy: 0.01)
        XCTAssertEqual(corner.y, 599.5, accuracy: 0.01)
        var source = try XCTUnwrap(region.sourceUV(forPhysicalPoint: SIMD2(1199.5, 100)))
        for _ in 0..<30 {
            let previous = source
            source = region.constrainedSourceMove(from: source, to: source + SIMD2(0.1, 0.01))
            XCTAssertGreaterThan(source.y, previous.y)
            XCTAssertTrue(region.containsSourceUV(source))
        }
        XCTAssertEqual(try XCTUnwrap(region.physicalPoint(forSourceUV: source)).y, 280, accuracy: 0.01)
        // A move away from an edge must immediately resume, not stick to that edge.
        let inward = region.constrainedSourceMove(from: source, to: source - SIMD2(0.1, 0))
        XCTAssertEqual(inward.x, source.x - 0.1, accuracy: 0.00001)
    }

    private func notchedMesh() -> GeneratedMesh {
        // A continuous unfolded mesh extends below the drawable near its middle. Clipping leaves
        // two lower arms and a central concavity; no internal rectangle describes this footprint.
        var vertices = [MeshVertex]()
        for y in [Float(0), 1] {
            for x in [Float(0), 0.5, 1] {
                let physicalY = y * (x == 0.5 ? 2 : 1)
                vertices.append(MeshVertex(position: SIMD2(x * 2 - 1, 1 - physicalY * 2), uv: SIMD2(x, y)))
            }
        }
        return GeneratedMesh(vertices: vertices, indices: [0, 1, 4, 0, 4, 3, 1, 2, 5, 1, 5, 4],
                             validation: MeshValidation(foldedCellCount: 0, outOfAASampleCount: 1, totalSampleCount: 6))
    }

    func testConcavityKeepsBothArmsAndCannotTeleportAcrossInvisibleGap() throws {
        let region = MouseMappingRegion(mesh: notchedMesh(), configuration: flatConfiguration(), sourceWidth: 1200, sourceHeight: 600)
        XCTAssertTrue(region.isValid)
        let left = SIMD2<Float>(0.05, 0.8)
        let right = SIMD2<Float>(0.95, 0.8)
        XCTAssertTrue(region.containsSourceUV(left))
        XCTAssertTrue(region.containsSourceUV(right))
        XCTAssertFalse(region.containsSourceUV(SIMD2(0.5, 0.8)))
        let moved = region.constrainedSourceMove(from: left, to: right)
        XCTAssertTrue(region.containsSourceUV(moved))
        XCTAssertLessThan(moved.y, 0.799, "终点虽可见，也必须沿轨迹遇到的首个边界滑行，不能跨凹区跳到另一侧")
        var source = left
        for _ in 0..<160 {
            let previous = source
            source = region.constrainedSourceMove(from: source, to: source + SIMD2(0.006, 0.004))
            XCTAssertTrue(region.containsSourceUV(source))
            let distance = simd_length((source - previous) * SIMD2<Float>(1200, 600))
            XCTAssertLessThanOrEqual(distance, simd_length(SIMD2<Float>(0.006 * 1200, 0.004 * 600)) + 0.01)
        }
        XCTAssertGreaterThan(source.x, 0.5, "沿弯曲边界连续滑行，不应在网格分段处粘住")
    }

    private func acceptedConfiguration() throws -> WarpConfiguration {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let url = root.appendingPathComponent("calibrations/20260918-AUO-v0117-accepted.json")
        return try JSONDecoder().decode(WarpConfiguration.self, from: Data(contentsOf: url))
    }

    func testDenseAcceptedMeshSlidesBothWaysAcrossClippedTriangleSeamsWithoutSticking() throws {
        let configuration = try acceptedConfiguration()
        let dimensions = WarpMath.meshDimensions(configuration: configuration)
        let mesh = WarpMath.makeMesh(configuration: configuration, columns: dimensions.columns, rows: dimensions.rows)
        let region = MouseMappingRegion(mesh: mesh, configuration: configuration, sourceWidth: 7680, sourceHeight: 936)
        for direction: Float in [-1, 1] {
            var source = try XCTUnwrap(region.nearestVisibleSourceUV(to: SIMD2(direction > 0 ? 0.2 : 0.8, 0.99)))
            let delta = SIMD2<Float>(direction * 3 / 7680, 2 / 936)
            for _ in 0..<1000 {
                let previous = source
                source = region.constrainedSourceMove(from: source, to: source + delta)
                XCTAssertTrue(region.containsSourceUV(source))
                XCTAssertGreaterThan((source.x - previous.x) * direction, 0.00001, "必须连续穿过裁切三角形的相邻边，不能被内部网格对角线卡住")
                XCTAssertLessThanOrEqual(simd_length((source - previous) * SIMD2<Float>(7680, 936)), sqrt(13) + 0.01)
            }
        }
    }

    func testAcceptedCalibrationPreservesActualBottomConcavityAndPixelEdge() throws {
        let configuration = try acceptedConfiguration()
        let dimensions = WarpMath.meshDimensions(configuration: configuration)
        let mesh = WarpMath.makeMesh(configuration: configuration, columns: dimensions.columns, rows: dimensions.rows)
        let region = MouseMappingRegion(mesh: mesh, configuration: configuration, sourceWidth: 7680, sourceHeight: 936)
        XCTAssertTrue(region.isValid, mesh.validation.summary)
        XCTAssertFalse(region.containsSourceUV(SIMD2(0.5, 0.8)))
        XCTAssertTrue(region.containsSourceUV(SIMD2(0.15, 0.8)))
        XCTAssertTrue(region.containsSourceUV(SIMD2(0.85, 0.8)))
        let limited = region.constrainedSourceMove(from: SIMD2(0.15, 0.8), to: SIMD2(0.85, 0.8))
        XCTAssertTrue(region.containsSourceUV(limited))
        XCTAssertLessThan(limited.y, 0.8)
        let bottom = try XCTUnwrap(region.nearestVisibleSourceUV(to: SIMD2(0.5, 0.99)))
        let physical = try XCTUnwrap(region.physicalPoint(forSourceUV: bottom))
        XCTAssertEqual(physical.y, 935.5, accuracy: 0.01, "使用至最后一行像素中心，不能为鼠标图标留百分比安全边")
        var checked = 0
        for row in 0...20 {
            for column in 0...40 {
                let source = SIMD2(Float(column) / 40, Float(row) / 20)
                guard let output = region.physicalPoint(forSourceUV: source) else { continue }
                let recovered = try XCTUnwrap(region.sourceUV(forPhysicalPoint: output))
                XCTAssertLessThan(simd_length((recovered - source) * SIMD2<Float>(7680, 936)), 0.5)
                checked += 1
            }
        }
        XCTAssertGreaterThan(checked, 400)
    }

    func testInvalidMeshOrNonfiniteInputsFailClosed() {
        var mesh = flatMesh()
        mesh.validation.foldedCellCount = 1
        let rejected = MouseMappingRegion(mesh: mesh, configuration: flatConfiguration(), sourceWidth: 1200, sourceHeight: 600)
        XCTAssertFalse(rejected.isValid)
        XCTAssertNil(rejected.physicalPoint(forSourceUV: SIMD2(0.5, 0.5)))
        mesh = flatMesh()
        mesh.indices.append(999)
        XCTAssertFalse(MouseMappingRegion(mesh: mesh, configuration: flatConfiguration(), sourceWidth: 1200, sourceHeight: 600).isValid)
        let valid = MouseMappingRegion(mesh: flatMesh(), configuration: flatConfiguration(), sourceWidth: 1200, sourceHeight: 600)
        XCTAssertNil(valid.sourceUV(forPhysicalPoint: SIMD2(.nan, 300)))
        XCTAssertNil(valid.nearestVisibleSourceUV(to: SIMD2(.infinity, 0)))
        let start = SIMD2<Float>(0.5, 0.5)
        XCTAssertEqual(valid.constrainedSourceMove(from: start, to: SIMD2(.nan, 0)), start)
        XCTAssertNotNil(valid.physicalPoint(forSourceUV: valid.constrainedSourceMove(from: start, to: SIMD2(Float.greatestFiniteMagnitude, 0.5))))
    }
}
