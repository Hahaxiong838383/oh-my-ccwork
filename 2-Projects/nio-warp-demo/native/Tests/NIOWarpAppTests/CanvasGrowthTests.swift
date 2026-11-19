import XCTest
import simd
import MetalKit
@testable import NIOWarpApp

final class CanvasGrowthTests: XCTestCase {
    private func baseline() -> WarpConfiguration {
        var config = WarpConfiguration.defaultConfiguration(displayWidth: 5120, displayHeight: 2880)
        config.aaRect = NormalizedRect(x: 0, y: 0, width: 5000.0 / 5120, height: 1300.0 / 2880)
        config.canvas = CanvasConfiguration(width: 5000, height: 1000)
        config.warpTrend = .inverse
        config.manual.strength = 0.838159442204301
        config.manual.arch = 0.11481854838709678
        return config
    }

    private func at(_ point: SIMD2<Float>, in config: WarpConfiguration) -> SIMD2<Float> {
        WarpMath.physicalPoints(canvasPoints: [point], configuration: config)[0]
    }

    private func assertSamePoints(_ before: WarpConfiguration, _ after: WarpConfiguration, file: StaticString = #filePath, line: UInt = #line) {
        for vertical in stride(from: Float(0), through: 1, by: 0.125) {
            for horizontal in stride(from: Float(0), through: 1, by: 0.125) {
                let point = SIMD2<Float>(horizontal, vertical)
                XCTAssertLessThan(simd_length(at(point, in: before) - at(point, in: after)), 0.003, file: file, line: line)
            }
        }
    }

    func testEnableDoesNotJumpOrRecaptureExistingReference() {
        let original = baseline()
        var config = original
        config.enableCanvasGrowth()
        assertSamePoints(original, config)
        let reference = config.canvasReference
        config.canvas = CanvasConfiguration(width: 8000, height: 2000)
        config.extendedWarpEnabled = false
        config.enableCanvasGrowth()
        XCTAssertEqual(config.canvasReference, reference)
    }

    func testWidthHeightAndCombinedGrowthKeepEveryOldLogicalPointFixed() {
        for size in [CanvasConfiguration(width: 8000, height: 1000), CanvasConfiguration(width: 5000, height: 2000), CanvasConfiguration(width: 8000, height: 2000)] {
            var config = baseline()
            config.enableCanvasGrowth()
            let original = config
            config.canvas = size
            let ratio = SIMD2<Float>(Float(size.width) / 5000, Float(size.height) / 1000)
            for point in [SIMD2<Float>(0, 0), SIMD2<Float>(0.5, 0.5), SIMD2<Float>(1, 1), SIMD2<Float>(1, 0), SIMD2<Float>(0, 1)] {
                XCTAssertLessThan(simd_length(at(point, in: original) - at(0.5 + (point - 0.5) / ratio, in: config)), 0.003)
            }
            let mesh = WarpMath.makeMesh(configuration: config)
            XCTAssertTrue(mesh.validation.isValid, mesh.validation.summary)
            XCTAssertGreaterThan(mesh.validation.outOfAASampleCount, 0)
            if size.width == 8000 {
                XCTAssertLessThan(at(SIMD2(0, 1), in: config).x, -1400)
                XCTAssertGreaterThan(at(SIMD2(1, 1), in: config).x, 6400)
            }
            if size.height == 2000 {
                XCTAssertLessThan(at(SIMD2(0, 0), in: config).y, -400)
                XCTAssertGreaterThan(at(SIMD2(0.5, 1), in: config).y, 1800)
            }
        }
    }

    func testAAOnlyCropsAndCannotRescaleCurve() {
        var config = baseline()
        config.enableCanvasGrowth()
        config.canvas = CanvasConfiguration(width: 8000, height: 2000)
        let original = config
        config.aaRect = NormalizedRect(x: 0.1, y: 0.3, width: 0.5, height: 0.4)
        assertSamePoints(original, config)
    }

    func testIndependentHeightScaleKeepsPhysicalGeometryFixedWhenAACropMoves() {
        for scale in [0.12, 1.0, 5.5] {
            var configuration = baseline()
            configuration.manual.verticalAspectScale = scale
            let beforeGrowth = configuration
            configuration.enableCanvasGrowth()
            assertSamePoints(beforeGrowth, configuration)
            configuration.canvas = CanvasConfiguration(width: 8000, height: 2000)
            let original = configuration
            for crop in [
                NormalizedRect(x: 0.1, y: 0.3, width: 0.5, height: 0.4),
                NormalizedRect(x: 0.2, y: 0.05, width: 0.65, height: 0.8),
                NormalizedRect.full
            ] {
                var cropped = original
                cropped.aaRect = crop
                assertSamePoints(original, cropped)
                XCTAssertEqual(cropped.canvasReference, original.canvasReference)
                XCTAssertEqual(cropped.manual, original.manual)
            }
        }
    }

    func testIndependentHeightScaleKeepsPhysicalGeometryFixedWhenExpandedCanvasIsRebased() {
        for scale in [0.12, 1.0, 5.5] {
            var configuration = baseline()
            configuration.manual.verticalAspectScale = scale
            configuration.enableCanvasGrowth()
            configuration.canvas = CanvasConfiguration(width: 8000, height: 2000)
            configuration.aaRect = NormalizedRect(x: 0.1, y: 0.3, width: 0.5, height: 0.4)
            let original = configuration
            configuration.rebaseCanvasGrowth()
            assertSamePoints(original, configuration)
            XCTAssertEqual(configuration.canvasReference?.physicalY, original.canvasReference?.physicalY)
            XCTAssertEqual(configuration.canvasReference?.physicalHeight, original.canvasReference?.physicalHeight)
            XCTAssertEqual(configuration.canvasReference?.canvas, configuration.canvas)
        }
    }

    func testExplicitRebasePreservesGeometryAndContentScale() {
        var config = baseline()
        config.enableCanvasGrowth()
        config.canvas = CanvasConfiguration(width: 8000, height: 2000)
        let original = config
        config.rebaseCanvasGrowth()
        assertSamePoints(original, config)
        XCTAssertEqual(config.canvasReference?.canvas, config.canvas)
        XCTAssertEqual(config.contentCanvas, original.contentCanvas)
    }

    func testContentScaleChangesOnlyWithExplicitRefill() {
        var config = baseline()
        config.enableCanvasGrowth()
        config.canvas = CanvasConfiguration(width: 8000, height: 2000)
        XCTAssertEqual(config.contentCanvas, CanvasConfiguration(width: 5000, height: 1000))
        XCTAssertEqual(config.contentUVScale.x, 1.6, accuracy: 0.00001)
        XCTAssertEqual(config.contentUVScale.y, 2, accuracy: 0.00001)
        let original = config
        config.refillContentCanvas()
        XCTAssertEqual(config.contentCanvas, config.canvas)
        assertSamePoints(original, config)
    }

    func testShrinkRestoreAndJSONRoundTripKeepReference() throws {
        var config = baseline()
        config.enableCanvasGrowth()
        let original = config
        config.canvas = CanvasConfiguration(width: 1000, height: 500)
        XCTAssertGreaterThan(WarpMath.extendedWarpCoreRect(configuration: config).width, 1)
        config.canvas = original.canvas
        assertSamePoints(original, config)
        let restored = try JSONDecoder().decode(WarpConfiguration.self, from: JSONEncoder().encode(config))
        XCTAssertEqual(restored, original)
    }

    func testLegacyDisabledConfigAndDiagnosticPreviewsPreserveSavedState() {
        var legacy = baseline()
        legacy.schemaVersion = 7
        let migrated = legacy.sanitized(forDisplayWidth: 5120, height: 2880)
        XCTAssertNil(migrated.canvasReference)
        assertSamePoints(legacy, migrated)
        var config = migrated
        config.enableCanvasGrowth()
        XCTAssertFalse(config.rawReflectionCalibrationConfiguration().extendedWarpEnabled)
        XCTAssertFalse(config.antiAliasingComparisonConfiguration().extendedWarpEnabled)
        XCTAssertTrue(config.extendedWarpEnabled)
    }

    func testLegacyEnabledConfigCapturesOldDomainAndNormalizationOnce() {
        var legacy = baseline()
        legacy.schemaVersion = 7
        legacy.extendedWarpEnabled = true
        legacy.canvas = CanvasConfiguration(width: 8000, height: 2000)
        let migrated = legacy.sanitized(forDisplayWidth: 5120, height: 2880)
        XCTAssertEqual(migrated.canvasReference?.canvas, legacy.canvas)
        XCTAssertEqual(migrated.canvasReference?.domain.minimumX ?? 0, -0.3, accuracy: 0.00001)
        XCTAssertEqual(migrated.canvasReference?.domain.maximumY ?? 0, 1.26923077, accuracy: 0.00001)
        XCTAssertNotNil(migrated.canvasReference?.legacyOutputClampDomain)
        XCTAssertEqual(migrated, migrated.sanitized(forDisplayWidth: 5120, height: 2880))
    }

    func testPolynomialTrendContinuesOutsideReference() {
        var config = baseline()
        config.polynomial.enabled = true
        config.polynomial.coefficientsY[3] = 0.02
        config.enableCanvasGrowth()
        config.canvas = CanvasConfiguration(width: 8000, height: 2000)
        let polynomialPoint = at(SIMD2(0, 0.5), in: config)
        config.polynomial.enabled = false
        XCTAssertEqual(polynomialPoint.y - at(SIMD2(0, 0.5), in: config).y, -66.56, accuracy: 0.01)
    }

    func testInvalidReferenceAndFoldedPolynomialAreRejected() {
        var config = baseline()
        config.enableCanvasGrowth()
        config.polynomial.enabled = true
        config.polynomial.coefficientsX[1] = 5
        XCTAssertFalse(WarpMath.makeMesh(configuration: config).validation.isValid)
        config.canvasReference?.physicalWidth = -1
        XCTAssertFalse(config.validationErrors().isEmpty)
    }

    func testMeshResolutionIsIndependentOfAAQuality() {
        var config = baseline()
        config.enableCanvasGrowth()
        config.canvas = CanvasConfiguration(width: 8000, height: 2000)
        let before = WarpMath.meshDimensions(configuration: config)
        config.render.antiAliasing = .off
        let after = WarpMath.meshDimensions(configuration: config)
        XCTAssertEqual(before.columns, after.columns)
        XCTAssertEqual(before.rows, after.rows)
        XCTAssertGreaterThan(before.columns, 192)
    }

    func testMigrationMatchesGoldenCoordinatesFromUnmodifiedVersion051() {
        var legacy = baseline()
        legacy.schemaVersion = 7
        legacy.extendedWarpEnabled = true
        legacy.canvas = CanvasConfiguration(width: 8000, height: 2000)
        legacy.polynomial.enabled = true
        legacy.polynomial.coefficientsX[4] = 0.005
        legacy.polynomial.coefficientsY[3] = 0.02
        let migrated = legacy.sanitized(forDisplayWidth: 5120, height: 2880)
        let golden: [[Float]] = [
            [0, 0, 0.02578291, 0], [0.5, 0, 0.50786310, 0.18302605], [1, 0, 0.89183015, 0.07922600],
            [0, 0.5, 0.01289147, 0.45919371], [0.5, 0.5, 0.49466011, 0.58718854], [1, 0.5, 0.94591504, 0.42835724],
            [0, 1, 0, 0.91838741], [0.5, 1, 0.48145705, 0.99135095], [1, 1, 1, 0.77748847],
        ]
        for sample in golden {
            let point = WarpMath.localPhysicalPoint(canvasPoint: SIMD2(sample[0], sample[1]), configuration: migrated)
            XCTAssertEqual(point.x, sample[2], accuracy: 0.000001)
            XCTAssertEqual(point.y, sample[3], accuracy: 0.000001)
        }
    }

    func testRebaseDoesNotChangeGridSpacing() {
        var config = baseline()
        config.enableCanvasGrowth()
        config.canvas = CanvasConfiguration(width: 8000, height: 2000)
        let spacing = config.gridUVScale
        config.rebaseCanvasGrowth()
        XCTAssertEqual(config.gridUVScale, spacing)
    }

    func testPreviewMeasuresCurvesOutsideThePhysicalAA() {
        var config = baseline()
        config.enableCanvasGrowth()
        config.canvas = CanvasConfiguration(width: 8000, height: 2000)
        let summary = CanvasGeometrySummary(configuration: config)
        XCTAssertEqual(summary.aaRect.width, 5000, accuracy: 0.001)
        XCTAssertEqual(summary.aaRect.height, 1300, accuracy: 0.001)
        XCTAssertTrue(summary.boundary.contains { !summary.aaRect.contains($0) })
        XCTAssertEqual(summary.edgeLengths.count, 4)
        XCTAssertGreaterThan(summary.edgeLengths[2], summary.edgeLengths[0])
        XCTAssertFalse(summary.referenceBoundary.isEmpty)
        XCTAssertFalse(summary.grid.isEmpty)
    }

    func testRendererKeepsLastValidConfigurationOnRejectedEdit() throws {
        guard MTLCreateSystemDefaultDevice() != nil else { throw XCTSkip("需要 Metal 设备") }
        var config = baseline()
        config.enableCanvasGrowth()
        let renderer = try XCTUnwrap(WarpRenderer(view: MTKView(frame: .zero), frameStore: LatestFrameStore(), configuration: config))
        var invalid = config
        invalid.polynomial.enabled = true
        invalid.polynomial.coefficientsX[1] = 5
        XCTAssertFalse(renderer.updateConfiguration(invalid).isValid)
        XCTAssertEqual(renderer.activeConfiguration, config)
        invalid.canvasReference?.physicalWidth = -1
        XCTAssertFalse(renderer.updateConfiguration(invalid).isValid)
        XCTAssertEqual(renderer.activeConfiguration, config)
    }

    func testNumericDimensionsRejectUnrepresentableValues() {
        XCTAssertNil(NumericInput.integer(from: "1e300"))
        XCTAssertNil(NumericInput.integer(from: "-1e300"))
        XCTAssertEqual(NumericInput.integer(from: "8000"), 8000)
    }

    func testStrongArchPresetAlsoAllowsRequestedGrowth() {
        var config = baseline()
        config.aaRect.width = 1
        config.aaRect.height = 936.0 / 2880
        config.manual.strength = 1.5
        config.manual.arch = 0.2
        config.manual.verticalScale = 0.9375610529396462
        config.manual.asymmetry = -0.05584381142328587
        config.manual.tilt = -0.01226601341195515
        config.manual.horizontalBend = 0.006157258064516125
        config.enableCanvasGrowth()
        config.canvas = CanvasConfiguration(width: 8000, height: 2000)
        let mesh = WarpMath.makeMesh(configuration: config)
        XCTAssertTrue(mesh.validation.isValid, mesh.validation.summary)
        XCTAssertGreaterThan(mesh.validation.outOfAASampleCount, 0)
    }
}
