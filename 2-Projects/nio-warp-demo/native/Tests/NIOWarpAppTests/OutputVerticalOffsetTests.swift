import Foundation
import XCTest
import simd
@testable import NIOWarpApp

final class OutputVerticalOffsetTests: XCTestCase {
    private func configuration() -> WarpConfiguration {
        var value = WarpConfiguration.defaultConfiguration(displayWidth: 1200, displayHeight: 600)
        value.canvas = CanvasConfiguration(width: 1200, height: 600)
        value.aaRect = NormalizedRect(x: 0.05, y: 0.1, width: 0.9, height: 0.8)
        value.manual.strength = 0.35
        value.manual.arch = 0.4
        value.contentMode = .stretch
        return value
    }

    func testLegacyConfigurationWithoutOffsetKeepsIdenticalVerticesAndUVs() throws {
        let original = configuration()
        var json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(original)) as? [String: Any])
        json["schemaVersion"] = 13
        json.removeValue(forKey: "outputVerticalOffsetPixels")
        let decoded = try JSONDecoder().decode(WarpConfiguration.self, from: JSONSerialization.data(withJSONObject: json))
        let migrated = decoded.sanitized(forDisplayWidth: 1200, height: 600)
        XCTAssertEqual(decoded.outputVerticalOffsetPixels, 0)
        XCTAssertEqual(migrated.schemaVersion, WarpConfiguration.currentSchemaVersion)
        let before = WarpMath.makeMesh(configuration: original, columns: 24, rows: 12)
        let after = WarpMath.makeMesh(configuration: migrated, columns: 24, rows: 12)
        XCTAssertEqual(before.vertices.map(\.position), after.vertices.map(\.position))
        XCTAssertEqual(before.vertices.map(\.uv), after.vertices.map(\.uv))
        XCTAssertEqual(before.indices, after.indices)
        XCTAssertEqual(before.validation, after.validation)
    }

    func testFinalPixelShiftPreservesEveryShapeStageAndMirroredTextureCoordinates() {
        for extended in [false, true] {
            for trend in [WarpTrend.forward, .inverse] {
                var original = configuration().preparedForLocalEditing()
                original.warpTrend = trend
                original.manual.verticalAspectScale = 1.5
                original.localWarp.enabled = true
                original.localWarp.setOffset(SIMD2(3, 6), at: .zero)
                original.bezierWarp.enabled = true
                XCTAssertTrue(original.bezierWarp.applyOffsetDelta(SIMD2(0, -8), at: 0))
                original.alignment.centerHorizontal = true
                original.alignment.centerVertical = true
                original.alignment.level = true
                original.mirror.horizontal = true; original.mirror.vertical = true
                if extended {
                    original.enableCanvasGrowth()
                    original.canvas.width = 1500; original.canvas.height = 900
                }
                let before = WarpMath.makeMesh(configuration: original, columns: 24, rows: 12)
                for shift in [-111.25, 93.5] {
                    var changed = original; changed.outputVerticalOffsetPixels = shift
                    let after = WarpMath.makeMesh(configuration: changed, columns: 24, rows: 12)
                    XCTAssertEqual(after.indices, before.indices)
                    XCTAssertEqual(after.validation.foldedCellCount, before.validation.foldedCellCount)
                    XCTAssertEqual(after.validation.unsafeScaleCount, before.validation.unsafeScaleCount)
                    XCTAssertEqual(after.validation.intersectingBoundaryCount, before.validation.intersectingBoundaryCount)
                    for (old, new) in zip(before.vertices, after.vertices) {
                        XCTAssertEqual(new.uv, old.uv)
                        XCTAssertEqual(new.position.x, old.position.x)
                        XCTAssertEqual(new.position.y, old.position.y - Float(2 * shift / 600), accuracy: 0.000002)
                    }
                    let points: [SIMD2<Float>] = [SIMD2(0, 0), SIMD2(0.5, 0.5), SIMD2(1, 1)]
                    let oldPoints = WarpMath.physicalPoints(canvasPoints: points, configuration: original)
                    let newPoints = WarpMath.physicalPoints(canvasPoints: points, configuration: changed)
                    for (old, new) in zip(oldPoints, newPoints) {
                        XCTAssertEqual(new.x, old.x)
                        XCTAssertEqual(new.y, old.y + Float(shift), accuracy: 0.002)
                    }
                    changed.outputVerticalOffsetPixels = 0
                    XCTAssertEqual(changed, original, "平移不能改写曲面、AA、镜像或画布基准")
                }
            }
        }
    }

    func testShiftIsPhysicalPixelsIndependentOfAAHeightAndManualEnablement() {
        for height in [0.02, 0.4, 0.8] {
            for manualEnabled in [false, true] {
                var original = configuration()
                original.aaRect = NormalizedRect(x: 0.1, y: 0.1, width: 0.8, height: height)
                original.manual.enabled = manualEnabled
                var changed = original; changed.outputVerticalOffsetPixels = 37.25
                let uv = SIMD2<Float>(0.35, 0.6)
                let before = WarpMath.physicalPoints(canvasPoints: [uv], configuration: original)[0]
                let after = WarpMath.physicalPoints(canvasPoints: [uv], configuration: changed)[0]
                XCTAssertEqual(after.x, before.x)
                XCTAssertEqual(after.y, before.y + 37.25, accuracy: 0.001)
                let local = WarpMath.localPhysicalPoint(canvasPoint: uv, configuration: changed)
                XCTAssertEqual(local, WarpMath.localPhysicalPoints(canvasPoints: [uv], configuration: changed)[0])
            }
        }
    }

    func testTranslationOutsideAADoesNotClampOrInvalidateTheSurface() {
        var original = configuration(); original.manual.enabled = false
        original.aaRect = NormalizedRect(x: 0.1, y: 0.1, width: 0.8, height: 0.02)
        let before = WarpMath.makeMesh(configuration: original, columns: 8, rows: 4)
        var changed = original; changed.outputVerticalOffsetPixels = 600
        let after = WarpMath.makeMesh(configuration: changed, columns: 8, rows: 4)
        XCTAssertTrue(after.validation.isValid)
        XCTAssertEqual(after.validation.outOfAASampleCount, after.vertices.count)
        for (old, new) in zip(before.vertices, after.vertices) {
            XCTAssertEqual(new.position.y, old.position.y - 2, accuracy: 0.000001)
        }
        XCTAssertEqual(changed.aaRect, original.aaRect)
    }

    func testMouseAndMeshInverseFollowShiftAndRejectClippedArea() throws {
        var config = configuration()
        config.manual.enabled = false; config.aaRect = .full
        config.mirror.horizontal = false; config.mirror.vertical = false
        config.outputVerticalOffsetPixels = 120
        let mesh = WarpMath.makeMesh(configuration: config, columns: 12, rows: 6)
        let region = MouseMappingRegion(mesh: mesh, configuration: config, sourceWidth: 1200, sourceHeight: 600)
        XCTAssertTrue(region.isValid)
        let uv = SIMD2<Float>(0.5, 0.25)
        let physical = try XCTUnwrap(region.physicalPoint(forSourceUV: uv))
        XCTAssertEqual(physical.x, 600, accuracy: 0.002)
        XCTAssertEqual(physical.y, 270, accuracy: 0.002)
        let inverse = try XCTUnwrap(region.sourceUV(forPhysicalPoint: physical))
        XCTAssertEqual(inverse.x, uv.x, accuracy: 0.00001)
        XCTAssertEqual(inverse.y, uv.y, accuracy: 0.00001)
        let meshUV = try XCTUnwrap(mesh.sourceUV(at: physical, width: 1200, height: 600))
        XCTAssertEqual(meshUV.x, uv.x, accuracy: 0.00001)
        XCTAssertEqual(meshUV.y, uv.y, accuracy: 0.00001)
        XCTAssertNil(region.sourceUV(forPhysicalPoint: SIMD2(600, 60)))
        XCTAssertFalse(region.containsSourceUV(SIMD2(0.5, 0.9)))
    }

    func testOffsetRoundTripsThroughConfigurationPresetsAndHistory() throws {
        let domain = "NIOWarp.OutputOffset.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: domain))
        defer { defaults.removePersistentDomain(forName: domain) }
        let original = configuration()
        var changed = original; changed.outputVerticalOffsetPixels = -93.5
        XCTAssertEqual(try JSONDecoder().decode(WarpConfiguration.self, from: JSONEncoder().encode(changed)), changed)
        let store = ConfigurationStore(defaults: defaults)
        _ = store.load(displayIdentifier: "offset-test", displayWidth: 1200, displayHeight: 600)
        store.save(changed)
        XCTAssertEqual(store.load(displayIdentifier: "offset-test", displayWidth: 1200, displayHeight: 600), changed)
        let presets = PresetStore(defaults: defaults)
        try presets.save(name: "整幅平移", configuration: changed)
        XCTAssertEqual(PresetStore(defaults: defaults).all().first?.configuration, changed)
        let history = ConfigurationHistoryStore(defaults: defaults)
        XCTAssertTrue(history.record(original, reason: "平移前", force: true))
        XCTAssertTrue(history.record(changed, reason: "平移后", force: true))
        XCTAssertEqual(history.popLatest()?.configuration, changed)
        XCTAssertEqual(history.popLatest()?.configuration, original)
    }

    func testRangeSanitizationAndRawCalibrationDoNotDamageSavedGeometry() {
        var config = configuration()
        XCTAssertEqual(config.outputVerticalOffsetRange, -600...600)
        for value in [Double.nan, .infinity, -.infinity] {
            config.outputVerticalOffsetPixels = value
            XCTAssertTrue(config.validationErrors().contains { $0.contains("上下位置") })
            XCTAssertEqual(config.sanitized(forDisplayWidth: 1200, height: 600).outputVerticalOffsetPixels, 0)
        }
        config.outputVerticalOffsetPixels = 900
        XCTAssertEqual(config.sanitized(forDisplayWidth: 1200, height: 600).outputVerticalOffsetPixels, 600)
        config.outputVerticalOffsetPixels = -900
        XCTAssertEqual(config.sanitized(forDisplayWidth: 1200, height: 600).outputVerticalOffsetPixels, -600)
        config.outputVerticalOffsetPixels = 95.5
        XCTAssertEqual(config.rawReflectionCalibrationConfiguration().outputVerticalOffsetPixels, 0)
        XCTAssertEqual(config.antiAliasingComparisonConfiguration().outputVerticalOffsetPixels, 0)
        XCTAssertEqual(config.outputVerticalOffsetPixels, 95.5)
    }
}
