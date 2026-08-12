import XCTest
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
        XCTAssertEqual(configuration.contentMode, .stretch)
        XCTAssertEqual(configuration.aaRect.y, 0.26)
        let mesh = WarpMath.makeMesh(configuration: configuration, columns: 32, rows: 16)
        XCTAssertEqual(mesh.validation.foldedCellCount, 0)
        XCTAssertEqual(mesh.vertices.count, 33 * 17)
        XCTAssertEqual(mesh.indices.count, 32 * 16 * 6)
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
        XCTAssertEqual(migrated.schemaVersion, 3)
        XCTAssertEqual(migrated.aaRect.y, 0.26)
        XCTAssertEqual(migrated.contentMode, .stretch)
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
        let configuration = store.load(displayWidth: 5120, displayHeight: 2880)
        XCTAssertNotNil(defaults.data(forKey: "nioWarpConfiguration.v1"))
        XCTAssertEqual(configuration.canvas, CanvasConfiguration(width: 7680, height: 936))
        XCTAssertEqual(configuration.contentMode, .stretch)
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
        XCTAssertEqual(migrated.schemaVersion, 3)
        XCTAssertEqual(migrated.render, RenderConfiguration())
        XCTAssertEqual(migrated.aaRect, NormalizedRect(x: 0.06, y: 0.26, width: 0.88, height: 0.48))
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
        XCTAssertFalse(PerformancePolicy.shouldFallback(snapshot: slow, currentMode: .performance))
        let shortSample = PerformanceSnapshot(framesPerSecond: 10, averageGPUTimeMilliseconds: 20, p95GPUTimeMilliseconds: 30, sampleCount: 10)
        XCTAssertFalse(PerformancePolicy.shouldFallback(snapshot: shortSample, currentMode: .quality))
    }
}
