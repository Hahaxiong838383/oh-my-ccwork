import XCTest
import MetalKit
@testable import NIOWarpApp

final class WarpConfigurationTests: XCTestCase {
    func testNumericInputParsesGroupedIntegersWithoutTruncation() {
        XCTAssertEqual(NumericInput.integer(from: "4,405"), 4405)
        XCTAssertEqual(NumericInput.integer(from: "7，680"), 7680)
        XCTAssertEqual(NumericInput.integer(from: " 2 880 "), 2880)
    }

    func testNumericInputParsesAndFormatsDecimalValues() {
        XCTAssertEqual(NumericInput.double(from: "-0.00150000"), -0.0015)
        XCTAssertEqual(NumericInput.formattedDouble(-0.0015), "-0.0015")
        XCTAssertEqual(NumericInput.formattedDouble(0), "0")
    }

    func testPolynomialTermCounts() {
        XCTAssertEqual(PolynomialWarpConfiguration.coefficientCount(order: 2), 6)
        XCTAssertEqual(PolynomialWarpConfiguration.coefficientCount(order: 3), 10)
        XCTAssertEqual(PolynomialWarpConfiguration.coefficientCount(order: 5), 21)
    }

    func testPolynomialEvaluationUsesDocumentedTermOrder() {
        var polynomial = PolynomialWarpConfiguration()
        polynomial.order = 2
        polynomial.coefficientsX = [1, 2, 3, 4, 5, 6]
        let value = polynomial.evaluate(x: 2, y: 3, coefficients: polynomial.coefficientsX)
        let expected = 1.0 + 4.0 + 9.0 + 16.0 + 30.0 + 54.0
        XCTAssertEqual(value, expected, accuracy: 0.000_001)
    }

    func testAARectSanitizesInsideDisplay() {
        let rect = NormalizedRect(x: -0.2, y: 0.9, width: 1.4, height: 0.8).sanitized()
        XCTAssertEqual(rect.x, 0)
        XCTAssertEqual(rect.y, 0.9)
        XCTAssertEqual(rect.width, 1)
        XCTAssertEqual(rect.height, 0.1, accuracy: 0.000_001)
    }

    func testDefaultMeshHasNoFoldedCells() {
        let configuration = WarpConfiguration.defaultConfiguration(displayWidth: 5120, displayHeight: 2880)
        XCTAssertEqual(configuration.contentMode, .fill)
        XCTAssertEqual(configuration.capture.sourceMode, .automaticFullscreenWindow)
        XCTAssertEqual(configuration.cropAnchor, CropAnchorConfiguration())
        XCTAssertEqual(configuration.aaRect.y, 0.26)
        let mesh = WarpMath.makeMesh(configuration: configuration, columns: 32, rows: 16)
        XCTAssertEqual(mesh.validation.foldedCellCount, 0)
        XCTAssertEqual(mesh.vertices.count, 33 * 17)
        XCTAssertEqual(mesh.indices.count, 32 * 16 * 6)
    }

    func testLegacyConfigurationUsesAutomaticFullscreenCaptureDefault() throws {
        var configuration = WarpConfiguration.defaultConfiguration(displayWidth: 5120, displayHeight: 2880)
        configuration.schemaVersion = 5
        let encoded = try JSONEncoder().encode(configuration)
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        object.removeValue(forKey: "capture")
        let legacyData = try JSONSerialization.data(withJSONObject: object)

        let decoded = try JSONDecoder().decode(WarpConfiguration.self, from: legacyData)

        XCTAssertEqual(decoded.capture.sourceMode, .automaticFullscreenWindow)
        XCTAssertEqual(decoded.sanitized(forDisplayWidth: 5120, height: 2880).schemaVersion, 6)
    }

    func testAutomaticWindowSelectorPrefersActiveLargeWindow() {
        let display = CGRect(x: 1920, y: 0, width: 1920, height: 1080)
        let inactive = CaptureWindowDescriptor(
            windowID: 10,
            frame: display,
            applicationName: "Preview",
            title: "image.png",
            isActive: false
        )
        let active = CaptureWindowDescriptor(
            windowID: 20,
            frame: CGRect(x: 1940, y: 10, width: 1880, height: 1060),
            applicationName: "IINA",
            title: "demo.mp4",
            isActive: true
        )

        let result = AutomaticWindowSelector.bestCandidate(
            from: [inactive, active],
            displayFrame: display,
            minimumCoverage: 0.82
        )

        XCTAssertEqual(result?.descriptor.windowID, 20)
    }

    func testAutomaticWindowSelectorRejectsSmallWindow() {
        let display = CGRect(x: 0, y: 0, width: 1920, height: 1080)
        let window = CaptureWindowDescriptor(
            windowID: 10,
            frame: CGRect(x: 100, y: 100, width: 1000, height: 700),
            applicationName: "QuickTime Player",
            title: "demo.mov",
            isActive: true
        )

        XCTAssertNil(AutomaticWindowSelector.bestCandidate(
            from: [window],
            displayFrame: display,
            minimumCoverage: 0.82
        ))
    }

    func testOutputWindowCanJoinOtherApplicationsFullscreenSpaces() {
        let behavior = OutputWindowBehavior.crossApplicationFullscreen

        XCTAssertTrue(behavior.contains(.canJoinAllSpaces))
        XCTAssertTrue(behavior.contains(.canJoinAllApplications))
        XCTAssertFalse(behavior.contains(.fullScreenAuxiliary))
        XCTAssertTrue(behavior.contains(.stationary))
        XCTAssertTrue(behavior.contains(.ignoresCycle))
    }

    func testAppRunsAsAccessoryForCrossApplicationFullscreenOverlay() {
        XCTAssertEqual(AppPresentationPolicy.activationPolicy, .accessory)
    }

    func testPolynomialCanMovePhysicalMesh() {
        var configuration = WarpConfiguration.defaultConfiguration(displayWidth: 5120, displayHeight: 2880)
        configuration.manual.enabled = false
        configuration.polynomial.enabled = true
        configuration.polynomial.order = 2
        configuration.polynomial = configuration.polynomial.normalized()
        configuration.polynomial.coefficientsX[0] = 0.1
        let point = WarpMath.localPhysicalPoint(canvasPoint: SIMD2<Float>(0.5, 0.5), configuration: configuration)
        XCTAssertEqual(point.x, 0.6, accuracy: 0.000_001)
        XCTAssertEqual(point.y, 0.5, accuracy: 0.000_001)
    }

    func testConfigurationJSONRoundTrip() throws {
        let suiteName = "NIOWarpAppTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let store = ConfigurationStore(defaults: defaults)
        var configuration = WarpConfiguration.defaultConfiguration(displayWidth: 5120, displayHeight: 2880)
        configuration.mirror.horizontal = true
        configuration.polynomial.enabled = true
        let data = try store.exportData(configuration)
        let decoded = try store.importData(data, displayWidth: 5120, displayHeight: 2880)
        XCTAssertEqual(decoded, configuration)
    }

    func testLegacyConfigurationMigratesToVersionTwoDefaults() {
        var configuration = WarpConfiguration.defaultConfiguration(displayWidth: 5120, displayHeight: 2880)
        configuration.schemaVersion = 1
        configuration.aaRect = NormalizedRect(x: 0.06, y: 0.18, width: 0.88, height: 0.48)
        configuration.contentMode = .fit
        let migrated = configuration.sanitized(forDisplayWidth: 5120, height: 2880)
        XCTAssertEqual(migrated.schemaVersion, WarpConfiguration.currentSchemaVersion)
        XCTAssertEqual(migrated.aaRect.y, 0.26)
        XCTAssertEqual(migrated.contentMode, .fill)
    }

    func testLegacyCustomFitConfigurationIsPreserved() {
        var configuration = WarpConfiguration.defaultConfiguration(displayWidth: 5120, displayHeight: 2880)
        configuration.schemaVersion = 1
        configuration.aaRect = NormalizedRect(x: 0.1, y: 0.2, width: 0.7, height: 0.4)
        configuration.contentMode = .fit
        let migrated = configuration.sanitized(forDisplayWidth: 5120, height: 2880)
        XCTAssertEqual(migrated.contentMode, .fit)
        XCTAssertEqual(migrated.aaRect, configuration.aaRect)
    }

    func testPolynomialOnlyJSONImport() throws {
        let suiteName = "NIOWarpAppTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let store = ConfigurationStore(defaults: defaults)
        var polynomial = PolynomialWarpConfiguration()
        polynomial.enabled = true
        polynomial.coefficientsX[0] = 0.05
        let data = try JSONEncoder().encode(polynomial)
        let base = WarpConfiguration.defaultConfiguration(displayWidth: 5120, displayHeight: 2880)
        let imported = try store.importData(data, baseConfiguration: base, displayWidth: 5120, displayHeight: 2880)
        XCTAssertTrue(imported.polynomial.enabled)
        XCTAssertEqual(imported.polynomial.coefficientsX[0], 0.05)
        XCTAssertEqual(imported.canvas, base.canvas)
    }

    func testFirstLoadPersistsDefaultConfiguration() throws {
        let suiteName = "NIOWarpAppTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let store = ConfigurationStore(defaults: defaults)
        let configuration = store.load(
            displayIdentifier: "vendor-1-model-2-serial-3",
            displayWidth: 5120,
            displayHeight: 2880
        )
        XCTAssertNotNil(defaults.data(forKey: "nioWarpConfiguration.v2.vendor-1-model-2-serial-3"))
        XCTAssertEqual(configuration.canvas, CanvasConfiguration(width: 7680, height: 936))
        XCTAssertEqual(configuration.contentMode, .fill)
    }

    func testDifferentDisplayGetsIndependentSafeDefaultConfiguration() throws {
        let suiteName = "NIOWarpAppTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let store = ConfigurationStore(defaults: defaults)

        var firstDisplay = store.load(
            displayIdentifier: "display-a",
            displayWidth: 5120,
            displayHeight: 2880
        )
        firstDisplay.manual.arch = 0.42
        firstDisplay.aaRect = NormalizedRect(x: 0.1, y: 0.2, width: 0.7, height: 0.4)
        store.save(firstDisplay)

        let secondDisplay = store.load(
            displayIdentifier: "display-b",
            displayWidth: 3840,
            displayHeight: 2400
        )
        XCTAssertEqual(secondDisplay, WarpConfiguration.defaultConfiguration(displayWidth: 3840, displayHeight: 2400))

        let reloadedFirstDisplay = store.load(
            displayIdentifier: "display-a",
            displayWidth: 5120,
            displayHeight: 2880
        )
        XCTAssertEqual(reloadedFirstDisplay.manual.arch, 0.42)
        XCTAssertEqual(reloadedFirstDisplay.aaRect, firstDisplay.aaRect)
    }

    func testLegacyConfigurationMigratesOnlyToMatchingDisplayResolution() throws {
        let suiteName = "NIOWarpAppTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        var legacy = WarpConfiguration.defaultConfiguration(displayWidth: 5120, displayHeight: 2880)
        legacy.manual.arch = 0.31
        defaults.set(try JSONEncoder().encode(legacy), forKey: "nioWarpConfiguration.v1")
        let store = ConfigurationStore(defaults: defaults)

        let differentDisplay = store.load(
            displayIdentifier: "display-b",
            displayWidth: 3840,
            displayHeight: 2400
        )
        XCTAssertEqual(
            differentDisplay.manual.arch,
            WarpConfiguration.defaultConfiguration(displayWidth: 3840, displayHeight: 2400).manual.arch
        )

        let matchingDisplay = store.load(
            displayIdentifier: "display-a",
            displayWidth: 5120,
            displayHeight: 2880
        )
        XCTAssertEqual(matchingDisplay.manual.arch, 0.31)
    }

    func testSchemaTwoConfigurationGetsPhaseOneDefaults() throws {
        let json = """
        {
          "schemaVersion": 2,
          "displayPixelWidth": 5120,
          "displayPixelHeight": 2880,
          "aaRect": {"x": 0.06, "y": 0.26, "width": 0.88, "height": 0.48},
          "canvas": {"width": 7680, "height": 936},
          "mirror": {"horizontal": false, "vertical": false},
          "contentMode": "stretch",
          "manual": {"enabled": true, "strength": 1, "arch": 0.105, "verticalScale": 0.83, "asymmetry": 0.08, "tilt": 0.025, "horizontalBend": 0.018},
          "polynomial": {"enabled": false, "order": 3, "coefficientsX": [0,0,0,0,0,0,0,0,0,0], "coefficientsY": [0,0,0,0,0,0,0,0,0,0]}
        }
        """
        let decoded = try JSONDecoder().decode(WarpConfiguration.self, from: Data(json.utf8))
        let migrated = decoded.sanitized(forDisplayWidth: 5120, height: 2880)
        XCTAssertEqual(migrated.schemaVersion, WarpConfiguration.currentSchemaVersion)
        XCTAssertEqual(migrated.warpTrend, .forward)
        XCTAssertEqual(migrated.render, RenderConfiguration())
        XCTAssertEqual(migrated.cropAnchor, CropAnchorConfiguration())
        XCTAssertEqual(migrated.aaRect, NormalizedRect(x: 0.06, y: 0.26, width: 0.88, height: 0.48))
    }

    func testLegacyAntiAliasingOffMigratesToDisabledSwitch() throws {
        let json = """
        {
          "schemaVersion": 3,
          "displayPixelWidth": 5120,
          "displayPixelHeight": 2880,
          "aaRect": {"x": 0.06, "y": 0.26, "width": 0.88, "height": 0.48},
          "canvas": {"width": 7680, "height": 936},
          "contentMode": "fill",
          "render": {"antiAliasing": "off", "automaticPerformanceFallback": true, "testPattern": "off"}
        }
        """
        let decoded = try JSONDecoder().decode(WarpConfiguration.self, from: Data(json.utf8))
        XCTAssertFalse(decoded.render.antiAliasingEnabled)
        XCTAssertEqual(decoded.render.antiAliasing, .performance)
    }

    func testSchemaThreeStretchMigratesToFillWithoutChangingWarp() {
        var configuration = WarpConfiguration.defaultConfiguration(displayWidth: 5120, displayHeight: 2880)
        configuration.schemaVersion = 3
        configuration.contentMode = .stretch
        configuration.manual.strength = 0.61
        configuration.manual.arch = 0.175
        configuration.polynomial.enabled = true
        let migrated = configuration.sanitized(forDisplayWidth: 5120, height: 2880)
        XCTAssertEqual(migrated.contentMode, .fill)
        XCTAssertEqual(migrated.manual.strength, 0.61)
        XCTAssertEqual(migrated.manual.arch, 0.175)
        XCTAssertTrue(migrated.polynomial.enabled)
    }

    func testCropAnchorSanitizesToSupportedRange() {
        var configuration = WarpConfiguration.defaultConfiguration(displayWidth: 5120, displayHeight: 2880)
        configuration.cropAnchor = CropAnchorConfiguration(horizontal: -2, vertical: 4)
        let sanitized = configuration.sanitized(forDisplayWidth: 5120, height: 2880)
        XCTAssertEqual(sanitized.cropAnchor.horizontal, -1)
        XCTAssertEqual(sanitized.cropAnchor.vertical, 1)
    }

    func testFillMappingPreservesUniformScaleAndMovesCropAnchor() {
        let centered = ContentMappingMath.mapping(
            sourceWidth: 5120,
            sourceHeight: 2880,
            targetWidth: 7680,
            targetHeight: 936,
            mode: .fill,
            anchor: CropAnchorConfiguration()
        )
        XCTAssertEqual(centered.uniformScale, 1.5, accuracy: 0.000_001)
        XCTAssertEqual(centered.sourceMinimum.x, 0, accuracy: 0.000_001)
        XCTAssertGreaterThan(centered.cropFraction.y, 0)
        XCTAssertEqual(centered.sourceMinimum.y, centered.cropFraction.y * 0.5, accuracy: 0.000_001)
        XCTAssertEqual(centered.sourceMaximum.y - centered.sourceMinimum.y, 1 - centered.cropFraction.y, accuracy: 0.000_001)

        let bottomAnchored = ContentMappingMath.mapping(
            sourceWidth: 5120,
            sourceHeight: 2880,
            targetWidth: 7680,
            targetHeight: 936,
            mode: .fill,
            anchor: CropAnchorConfiguration(horizontal: 0, vertical: 1)
        )
        XCTAssertEqual(bottomAnchored.sourceMinimum.y, bottomAnchored.cropFraction.y, accuracy: 0.000_001)
        XCTAssertEqual(bottomAnchored.sourceMaximum.y, 1, accuracy: 0.000_001)
        XCTAssertEqual(bottomAnchored.uniformScale, centered.uniformScale, accuracy: 0.000_001)
    }

    func testRawReflectionCalibrationConfigurationDoesNotMutateOriginal() {
        var original = WarpConfiguration.defaultConfiguration(displayWidth: 5120, displayHeight: 2880)
        original.manual.enabled = true
        original.polynomial.enabled = true
        original.mirror.horizontal = true
        original.aaRect = NormalizedRect(x: 0.1, y: 0.2, width: 0.7, height: 0.4)

        let preview = original.rawReflectionCalibrationConfiguration()

        XCTAssertFalse(preview.manual.enabled)
        XCTAssertFalse(preview.polynomial.enabled)
        XCTAssertEqual(preview.render.testPattern, .calibrationGrid)
        XCTAssertEqual(preview.contentMode, .fill)
        XCTAssertEqual(preview.aaRect, original.aaRect)
        XCTAssertEqual(preview.mirror, original.mirror)
        XCTAssertTrue(original.manual.enabled)
        XCTAssertTrue(original.polynomial.enabled)
        XCTAssertEqual(original.render.testPattern, .off)
    }

    func testAntiAliasingComparisonConfigurationUsesUnwarpedGeometryWithoutMutatingOriginal() {
        var original = WarpConfiguration.defaultConfiguration(displayWidth: 5120, displayHeight: 2880)
        original.manual.enabled = true
        original.polynomial.enabled = true
        original.render.antiAliasingEnabled = false
        original.render.antiAliasing = .quality
        original.mirror.vertical = true

        let preview = original.antiAliasingComparisonConfiguration()

        XCTAssertFalse(preview.manual.enabled)
        XCTAssertFalse(preview.polynomial.enabled)
        XCTAssertTrue(preview.render.antiAliasingEnabled)
        XCTAssertEqual(preview.render.antiAliasing, .quality)
        XCTAssertEqual(preview.render.testPattern, .antiAliasingComparison)
        XCTAssertEqual(preview.contentMode, .fill)
        XCTAssertEqual(preview.mirror, original.mirror)
        XCTAssertTrue(original.manual.enabled)
        XCTAssertTrue(original.polynomial.enabled)
        XCTAssertFalse(original.render.antiAliasingEnabled)
        XCTAssertEqual(original.render.testPattern, .off)
    }

    func testInverseWarpTrendReversesManualCurvatureAndStillFillsAA() {
        var forward = WarpConfiguration.defaultConfiguration(displayWidth: 5120, displayHeight: 2880)
        forward.polynomial.enabled = false
        forward.warpTrend = .forward
        var inverse = forward
        inverse.warpTrend = .inverse
        let topLeft = SIMD2<Float>(0, 0)
        let topCenter = SIMD2<Float>(0.5, 0)
        let topRight = SIMD2<Float>(1, 0)
        let forwardCurvature = WarpMath.localPhysicalPoint(canvasPoint: topCenter, configuration: forward).y
            - 0.5 * (
                WarpMath.localPhysicalPoint(canvasPoint: topLeft, configuration: forward).y
                    + WarpMath.localPhysicalPoint(canvasPoint: topRight, configuration: forward).y
            )
        let inverseCurvature = WarpMath.localPhysicalPoint(canvasPoint: topCenter, configuration: inverse).y
            - 0.5 * (
                WarpMath.localPhysicalPoint(canvasPoint: topLeft, configuration: inverse).y
                    + WarpMath.localPhysicalPoint(canvasPoint: topRight, configuration: inverse).y
            )
        let inverseMesh = WarpMath.makeMesh(configuration: inverse)

        XCTAssertLessThan(forwardCurvature * inverseCurvature, 0)
        XCTAssertEqual(inverseMesh.validation.foldedCellCount, 0)
        XCTAssertEqual(inverseMesh.validation.outOfAASampleCount, 0)
    }

    func testInverseWarpTrendAlsoReversesPolynomialIncrement() {
        var forward = WarpConfiguration.defaultConfiguration(displayWidth: 5120, displayHeight: 2880)
        forward.manual.enabled = false
        forward.polynomial.enabled = true
        forward.polynomial = forward.polynomial.normalized()
        forward.polynomial.coefficientsX[0] = 0.04
        forward.polynomial.coefficientsY[0] = -0.03
        forward.warpTrend = .forward
        var inverse = forward
        inverse.warpTrend = .inverse
        let point = SIMD2<Float>(0.4, 0.6)

        let forwardPoint = WarpMath.localPhysicalPoint(canvasPoint: point, configuration: forward)
        let inversePoint = WarpMath.localPhysicalPoint(canvasPoint: point, configuration: inverse)

        XCTAssertEqual(inversePoint.x, 2 * point.x - forwardPoint.x, accuracy: 0.000_001)
        XCTAssertEqual(inversePoint.y, 2 * point.y - forwardPoint.y, accuracy: 0.000_001)
    }

    func testPresetStoreReplacesSameName() throws {
        let suiteName = "NIOWarpPresetTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let store = PresetStore(defaults: defaults)
        var first = WarpConfiguration.defaultConfiguration(displayWidth: 5120, displayHeight: 2880)
        var second = first
        second.mirror.horizontal = true
        try store.save(name: "玻璃 A", configuration: first)
        try store.save(name: "玻璃 A", configuration: second)
        XCTAssertEqual(store.all().count, 1)
        XCTAssertEqual(store.all().first?.configuration.mirror.horizontal, true)
        first.mirror.vertical = true
        try store.save(name: "玻璃 B", configuration: first)
        XCTAssertEqual(store.all().count, 2)
    }

    func testHistoryStoreCapsAndPopsLatest() throws {
        let suiteName = "NIOWarpHistoryTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let store = ConfigurationHistoryStore(defaults: defaults, maximumCount: 2, minimumInterval: 0)
        var configuration = WarpConfiguration.defaultConfiguration(displayWidth: 5120, displayHeight: 2880)
        XCTAssertTrue(store.record(configuration, reason: "A", force: true))
        configuration.mirror.horizontal = true
        XCTAssertTrue(store.record(configuration, reason: "B", force: true))
        configuration.mirror.vertical = true
        XCTAssertTrue(store.record(configuration, reason: "C", force: true))
        XCTAssertEqual(store.count, 2)
        XCTAssertEqual(store.popLatest()?.reason, "C")
        XCTAssertEqual(store.count, 1)
    }

    func testPerformancePolicyOnlyFallsBackFromQuality() {
        let slow = PerformanceSnapshot(framesPerSecond: 50, averageGPUTimeMilliseconds: 10, p95GPUTimeMilliseconds: 16, sampleCount: 120)
        XCTAssertTrue(PerformancePolicy.shouldFallback(snapshot: slow, currentMode: .quality))
        XCTAssertFalse(PerformancePolicy.shouldFallback(snapshot: slow, antiAliasingEnabled: false, currentMode: .quality))
        XCTAssertFalse(PerformancePolicy.shouldFallback(snapshot: slow, currentMode: .performance))
        let shortSample = PerformanceSnapshot(framesPerSecond: 10, averageGPUTimeMilliseconds: 20, p95GPUTimeMilliseconds: 30, sampleCount: 10)
        XCTAssertFalse(PerformancePolicy.shouldFallback(snapshot: shortSample, currentMode: .quality))
    }

    func testRendererCompilesMetalShaderWithoutExternalDisplay() {
        let view = MTKView(frame: CGRect(x: 0, y: 0, width: 640, height: 360))
        let configuration = WarpConfiguration.defaultConfiguration(displayWidth: 5120, displayHeight: 2880)
        XCTAssertNotNil(WarpRenderer(view: view, frameStore: LatestFrameStore(), configuration: configuration))
    }
}
