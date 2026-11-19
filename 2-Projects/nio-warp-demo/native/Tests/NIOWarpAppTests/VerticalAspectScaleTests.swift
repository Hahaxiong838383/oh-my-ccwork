import XCTest
import simd
@testable import NIOWarpApp

final class VerticalAspectScaleTests: XCTestCase {
    private let samples: [SIMD2<Float>] = [
        SIMD2(0, 0), SIMD2(1, 1), SIMD2(0.25, 0.25),
        SIMD2(0.5, 0.5), SIMD2(0.75, 0.75), SIMD2(0.1, 0.8)
    ]

    func testLegacyJSONKeepsOldVerticalCalibrationIncludingValuesOutsideFormerSliderRange() throws {
        for legacyValue in [0.2, 0.6, 0.83, 1.1, 1.5, 2.0] {
            var original = WarpConfiguration.defaultConfiguration(displayWidth: 5120, displayHeight: 2880)
            original.manual.verticalScale = legacyValue
            var json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(original)) as? [String: Any])
            json["schemaVersion"] = 12
            var manual = try XCTUnwrap(json["manual"] as? [String: Any])
            manual.removeValue(forKey: "verticalAspectScale")
            json["manual"] = manual
            let decoded = try JSONDecoder().decode(WarpConfiguration.self, from: JSONSerialization.data(withJSONObject: json))
            let migrated = decoded.sanitized(forDisplayWidth: 5120, height: 2880)
            XCTAssertEqual(migrated.schemaVersion, WarpConfiguration.currentSchemaVersion)
            XCTAssertEqual(migrated.manual.verticalScale, legacyValue)
            XCTAssertEqual(migrated.manual.verticalAspectScale, 1)
            XCTAssertEqual(WarpMath.physicalPoints(canvasPoints: samples, configuration: migrated),
                           WarpMath.physicalPoints(canvasPoints: samples, configuration: original))
        }
    }

    func testIndependentScaleChangesActualHeightWithoutTrendOrStrengthReversal() {
        for trend in [WarpTrend.forward, .inverse] {
            for strength in [0.0, 1.0, 2.25] {
                var baseline = WarpConfiguration.defaultConfiguration(displayWidth: 5120, displayHeight: 2880)
                baseline.warpTrend = trend
                baseline.manual.strength = strength
                baseline.manual.arch = 3
                baseline.manual.verticalScale = 1
                baseline.manual.asymmetry = 0
                baseline.manual.horizontalBend = 0
                baseline.manual.tilt = 0
                let before = WarpMath.localPhysicalPoints(canvasPoints: samples, configuration: baseline)
                for scale in [0.12, 1.0, 5.5] {
                    var changed = baseline
                    changed.manual.verticalAspectScale = scale
                    let after = WarpMath.localPhysicalPoints(canvasPoints: samples, configuration: changed)
                    for (old, new) in zip(before, after) {
                        XCTAssertEqual(new.x, old.x)
                        XCTAssertEqual(new.y, 0.5 + (old.y - 0.5) * Float(scale), accuracy: 0.00001)
                    }
                    let mesh = WarpMath.makeMesh(configuration: changed, columns: 192, rows: 72)
                    XCTAssertTrue(mesh.validation.isValid, "\(trend) / \(strength) / \(scale): \(mesh.validation.summary)")
                }
            }
        }
    }

    func testScaleIncludesLocalAndBezierCorrections() {
        var original = WarpConfiguration.defaultConfiguration(displayWidth: 5120, displayHeight: 2880)
        original = original.preparedForLocalEditing()
        original.localWarp.enabled = true
        original.localWarp.setOffset(SIMD2(3, 8), at: .zero)
        original.bezierWarp.enabled = true
        XCTAssertTrue(original.bezierWarp.applyOffsetDelta(SIMD2(0, -12), at: 0))
        let before = WarpMath.localPhysicalPoints(canvasPoints: samples, configuration: original)
        var changed = original
        changed.manual.verticalAspectScale = 5.5
        let after = WarpMath.localPhysicalPoints(canvasPoints: samples, configuration: changed)
        for (old, new) in zip(before, after) {
            XCTAssertEqual(new.x, old.x)
            XCTAssertEqual(new.y, 0.5 + (old.y - 0.5) * 5.5, accuracy: 0.00001)
        }
        XCTAssertEqual(changed.localWarp, original.localWarp)
        XCTAssertEqual(changed.bezierWarp, original.bezierWarp)
    }

    func testAutomaticAlignmentStillCentersAndLevelsScaledSurface() {
        var configuration = WarpConfiguration.defaultConfiguration(displayWidth: 5120, displayHeight: 2880)
        configuration.manual.verticalAspectScale = 5.5
        configuration.manual.tilt = 0.08
        configuration.alignment.centerHorizontal = true
        configuration.alignment.centerVertical = true
        configuration.alignment.level = true
        let dimensions = WarpMath.meshDimensions(configuration: configuration)
        let mesh = WarpMath.makeMesh(configuration: configuration, columns: dimensions.columns, rows: dimensions.rows)
        XCTAssertTrue(mesh.validation.isValid, mesh.validation.summary)
        let local = mesh.vertices.map { vertex in
            SIMD2((vertex.position.x + 1) * 0.5, (1 - vertex.position.y) * 0.5)
        }
        let minimum = local.reduce(SIMD2<Float>(repeating: .greatestFiniteMagnitude)) { simd_min($0, $1) }
        let maximum = local.reduce(SIMD2<Float>(repeating: -.greatestFiniteMagnitude)) { simd_max($0, $1) }
        XCTAssertEqual((minimum.x + maximum.x) * 0.5, Float(configuration.aaRect.x + configuration.aaRect.width * 0.5), accuracy: 0.00001)
        XCTAssertEqual((minimum.y + maximum.y) * 0.5, Float(configuration.aaRect.y + configuration.aaRect.height * 0.5), accuracy: 0.00001)
        let axis = WarpMath.physicalPoints(canvasPoints: [SIMD2(0, 0.5), SIMD2(1, 0.5)], configuration: configuration)
        XCTAssertEqual(axis[0].y, axis[1].y, accuracy: 0.002)
    }

    func testDisabledManualWarpBypassesHeightScaleWithoutDiscardingValue() {
        var original = WarpConfiguration.defaultConfiguration(displayWidth: 5120, displayHeight: 2880)
        original.manual.enabled = false
        var changed = original
        changed.manual.verticalAspectScale = 5.5
        XCTAssertEqual(WarpMath.physicalPoints(canvasPoints: samples, configuration: changed),
                       WarpMath.physicalPoints(canvasPoints: samples, configuration: original))
        XCTAssertEqual(changed.manual.verticalAspectScale, 5.5)
    }

    func testSanitizationAndJSONKeepIndependentAndLegacyValuesSeparate() throws {
        for scale in [0.12, 1.0, 5.5] {
            var configuration = WarpConfiguration.defaultConfiguration(displayWidth: 5120, displayHeight: 2880)
            configuration.manual = ManualWarpParameters(verticalScale: 1.5, verticalAspectScale: scale)
            let decoded = try JSONDecoder().decode(WarpConfiguration.self, from: JSONEncoder().encode(configuration))
            let sanitized = decoded.sanitized(forDisplayWidth: 5120, height: 2880)
            XCTAssertEqual(sanitized.manual.verticalScale, 1.5)
            XCTAssertEqual(sanitized.manual.verticalAspectScale, scale)
            XCTAssertEqual(decoded, configuration)
        }
        var configuration = WarpConfiguration.defaultConfiguration(displayWidth: 5120, displayHeight: 2880)
        configuration.manual.verticalAspectScale = 10
        configuration.manual.verticalScale = 10
        var sanitized = configuration.sanitized(forDisplayWidth: 5120, height: 2880)
        XCTAssertEqual(sanitized.manual.verticalAspectScale, 5.5)
        XCTAssertEqual(sanitized.manual.verticalScale, 2)
        configuration.manual.verticalAspectScale = 0
        configuration.manual.verticalScale = 0
        sanitized = configuration.sanitized(forDisplayWidth: 5120, height: 2880)
        XCTAssertEqual(sanitized.manual.verticalAspectScale, 0.12)
        XCTAssertEqual(sanitized.manual.verticalScale, 0.2)
    }

    func testPositiveAspectScaleDoesNotBypassFoldProtection() {
        var configuration = WarpConfiguration.defaultConfiguration(displayWidth: 5120, displayHeight: 2880)
        configuration.manual.arch = 1.5
        configuration.manual.strength = 2.25
        configuration.manual.verticalScale = 0.6
        configuration.manual.horizontalBend = 0.08
        for scale in [0.12, 1.0, 5.5] {
            configuration.manual.verticalAspectScale = scale
            let mesh = WarpMath.makeMesh(configuration: configuration, columns: 192, rows: 72)
            XCTAssertFalse(mesh.validation.isValid)
            XCTAssertGreaterThan(mesh.validation.foldedCellCount, 0)
        }
    }
}
