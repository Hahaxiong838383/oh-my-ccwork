import AppKit
import MetalKit
import XCTest
@testable import NIOWarpApp

final class CalibrationGridTests: XCTestCase {
    private func baseline() -> WarpConfiguration {
        var config = WarpConfiguration.defaultConfiguration(displayWidth: 5120, displayHeight: 2880)
        config.canvas = CanvasConfiguration(width: 5000, height: 1000)
        config.render.calibrationGrid = CalibrationGridConfiguration(columns: 20, rows: 8, lineWidthPixels: 4)
        config.enableCanvasGrowth()
        return config
    }

    func testGrowthOnlyAddsCellsAndKeepsOldGridIntersectionsFixed() {
        let original = baseline()
        for canvas in [CanvasConfiguration(width: 8000, height: 1000), CanvasConfiguration(width: 5000, height: 2000), CanvasConfiguration(width: 8000, height: 2000)] {
            var expanded = original
            expanded.canvas = canvas
            XCTAssertEqual(expanded.calibrationGridCellSize, SIMD2(250, 125))
            XCTAssertEqual(expanded.calibrationGridBaseCanvas, original.canvas)
            XCTAssertEqual(expanded.calibrationGridCoverage.x, Float(canvas.width) / 250, accuracy: 0.00001)
            XCTAssertEqual(expanded.calibrationGridCoverage.y, Float(canvas.height) / 125, accuracy: 0.00001)
            for column in 0...20 {
                for row in 0...8 {
                    let point = SIMD2(Float(column) / 20, Float(row) / 8)
                    let grownUV = 0.5 + (point - 0.5) / expanded.gridUVScale
                    let before = WarpMath.physicalPoints(canvasPoints: [point], configuration: original)[0]
                    let after = WarpMath.physicalPoints(canvasPoints: [grownUV], configuration: expanded)[0]
                    XCTAssertLessThan(simd_length(before - after), 0.003)
                }
            }
        }
    }

    func testAARebaseRefillAndJSONCannotChangeTheGridPitch() throws {
        var config = baseline()
        config.canvas = CanvasConfiguration(width: 8000, height: 2000)
        config.rebaseCanvasGrowth()
        config.refillContentCanvas()
        config.aaRect = NormalizedRect(x: 0.1, y: 0.2, width: 0.7, height: 0.3)
        let decoded = try JSONDecoder().decode(WarpConfiguration.self, from: JSONEncoder().encode(config))
        XCTAssertEqual(decoded.calibrationGridCellSize, SIMD2(250, 125))
        XCTAssertEqual(decoded.render.calibrationGrid, config.render.calibrationGrid)
        XCTAssertEqual(decoded.calibrationGridCoverage, SIMD2(32, 16))
        XCTAssertEqual(decoded.canvasReference?.gridCanvas, CanvasConfiguration(width: 5000, height: 1000))
    }

    func testLegacyConfigurationGetsTenByTenWithoutChangingItsGrowthBase() throws {
        var original = baseline()
        original.canvas = CanvasConfiguration(width: 8000, height: 2000)
        var json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(original)) as? [String: Any])
        var render = try XCTUnwrap(json["render"] as? [String: Any])
        render.removeValue(forKey: "calibrationGrid")
        json["render"] = render
        json["schemaVersion"] = 8
        let decoded = try JSONDecoder().decode(WarpConfiguration.self, from: JSONSerialization.data(withJSONObject: json))
        let migrated = decoded.sanitized(forDisplayWidth: 5120, height: 2880)
        XCTAssertEqual(migrated.render.calibrationGrid, CalibrationGridConfiguration())
        XCTAssertEqual(migrated.gridUVScale, original.gridUVScale)
        XCTAssertEqual(migrated.canvasReference, original.canvasReference)
        XCTAssertEqual(migrated.schemaVersion, WarpConfiguration.currentSchemaVersion)
    }

    func testInvalidGridValuesAreRejectedInsteadOfClamped() {
        for grid in [
            CalibrationGridConfiguration(columns: 0), CalibrationGridConfiguration(columns: 201),
            CalibrationGridConfiguration(rows: -1), CalibrationGridConfiguration(rows: 201),
            CalibrationGridConfiguration(lineWidthPixels: 0), CalibrationGridConfiguration(lineWidthPixels: 33),
            CalibrationGridConfiguration(lineWidthPixels: .infinity), CalibrationGridConfiguration(lineWidthPixels: .nan),
        ] {
            var config = baseline()
            config.render.calibrationGrid = grid
            XCTAssertFalse(grid.isValid)
            XCTAssertFalse(config.validationErrors().isEmpty)
        }
    }

    private final class Fixture {
        let suite = "NIOWarp.Grid.\(UUID().uuidString)"
        let defaults: UserDefaults
        let store: ConfigurationStore
        let history: ConfigurationHistoryStore
        let renderer: WarpRenderer?
        let panel: ControlPanelController

        init(active: Bool = true, expanded: Bool = false) throws {
            _ = NSApplication.shared
            defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
            store = ConfigurationStore(defaults: defaults)
            history = ConfigurationHistoryStore(defaults: defaults)
            var config = WarpConfiguration.defaultConfiguration(displayWidth: 5120, displayHeight: 2880)
            config.canvas = CanvasConfiguration(width: 5000, height: 1000)
            config.enableCanvasGrowth()
            if expanded { config.canvas = CanvasConfiguration(width: 8000, height: 2000) }
            store.save(config)
            if active {
                guard MTLCreateSystemDefaultDevice() != nil else { throw XCTSkip("需要 Metal 设备") }
                renderer = try XCTUnwrap(WarpRenderer(view: MTKView(frame: .zero), frameStore: LatestFrameStore(), configuration: config))
            } else { renderer = nil }
            panel = ControlPanelController(
                renderer: renderer, store: store, configuration: config, sourceScreen: nil, outputScreen: nil,
                setWarpVisible: { _ in XCTFail("网格编辑不能改变输出可见性") }, isWarpVisible: { false },
                applyCaptureConfiguration: { _ in XCTFail("网格编辑不能重启捕获") },
                updateAABoundary: { _, _ in XCTFail("网格编辑不能改变 AA") }, updateWarpBoundary: { _, _ in },
                presentWindow: false, historyStore: history, presetStore: PresetStore(defaults: defaults)
            )
        }

        deinit {
            panel.close()
            defaults.removePersistentDomain(forName: suite)
        }

        func descendants(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(descendants) }

        var views: [NSView] {
            let tabs = descendants(panel.window!.contentView!).compactMap { $0 as? NSTabView }.first!
            return tabs.tabViewItems.compactMap(\.view).flatMap(descendants)
        }

        func field(_ identifier: String) throws -> NSTextField {
            try XCTUnwrap(views.compactMap { $0 as? NSTextField }.first { $0.accessibilityIdentifier() == identifier })
        }

        func button(_ title: String) throws -> NSButton {
            try XCTUnwrap(views.compactMap { $0 as? NSButton }.first { $0.title == title })
        }

        func edit(_ identifier: String, _ value: String) throws {
            let control = try field(identifier)
            control.stringValue = value
            panel.controlTextDidChange(Notification(name: NSControl.textDidChangeNotification, object: control))
        }
    }

    func testLiveEditsPreserveGeometryOtherInputTextAndCoalesceHistory() throws {
        let fixture = try Fixture()
        let renderer = try XCTUnwrap(fixture.renderer)
        let original = renderer.activeConfiguration
        let meshRevision = renderer.meshRevision
        let pendingCanvas = try XCTUnwrap(fixture.views.compactMap { $0 as? NSTextField }.first { $0.isEditable && $0.stringValue == "5000" })
        pendingCanvas.stringValue = "8123"
        let columns = try fixture.field("nio-grid-columns")
        fixture.panel.controlTextDidBeginEditing(Notification(name: NSControl.textDidBeginEditingNotification, object: columns))
        try fixture.edit("nio-grid-columns", "2")
        try fixture.edit("nio-grid-columns", "20")
        XCTAssertEqual(renderer.activeConfiguration.render.calibrationGrid.columns, 20)
        XCTAssertEqual(fixture.history.count, 1)
        fixture.panel.controlTextDidEndEditing(Notification(name: NSControl.textDidEndEditingNotification, object: columns))
        try fixture.edit("nio-grid-rows", "8")
        try fixture.edit("nio-grid-line-width", "4.5")
        XCTAssertEqual(renderer.activeConfiguration.render.calibrationGrid, CalibrationGridConfiguration(columns: 20, rows: 8, lineWidthPixels: 4.5))
        XCTAssertEqual(renderer.meshRevision, meshRevision)
        XCTAssertEqual(pendingCanvas.stringValue, "8123")
        var unchanged = renderer.activeConfiguration
        unchanged.render.calibrationGrid = original.render.calibrationGrid
        XCTAssertEqual(unchanged, original)
        XCTAssertEqual(fixture.store.offlineConfiguration().render.calibrationGrid, renderer.activeConfiguration.render.calibrationGrid)
        XCTAssertEqual(fixture.history.count, 2)
    }

    func testInvalidAndPartialTextNeverChangesTheOtherFieldOrLastValidFrame() throws {
        let fixture = try Fixture()
        try fixture.edit("nio-grid-columns", "20")
        let original = try XCTUnwrap(fixture.renderer).activeConfiguration
        let saved = fixture.defaults.persistentDomain(forName: fixture.suite) as NSDictionary?
        for value in ["", "0", "201", "2.2", "not-a-number"] {
            try fixture.edit("nio-grid-rows", value)
            XCTAssertEqual(fixture.renderer?.activeConfiguration, original)
            XCTAssertEqual(try fixture.field("nio-grid-columns").stringValue, "20")
            XCTAssertEqual(try fixture.field("nio-grid-rows").stringValue, value)
            XCTAssertEqual(fixture.defaults.persistentDomain(forName: fixture.suite) as NSDictionary?, saved)
        }
    }

    func testNativeFieldEditorUpdatesGridBeforeLosingFocus() throws {
        let fixture = try Fixture()
        let window = try XCTUnwrap(fixture.panel.window)
        fixture.panel.selectModule("quality")
        let columns = try fixture.field("nio-grid-columns")
        columns.selectText(nil)
        let editor = try XCTUnwrap(columns.currentEditor() as? NSTextView)
        editor.insertText("20", replacementRange: NSRange(location: 0, length: editor.string.utf16.count))
        XCTAssertEqual(editor.string, "20")
        XCTAssertEqual(fixture.renderer?.activeConfiguration.render.calibrationGrid.columns, 20)
        let rows = try fixture.field("nio-grid-rows")
        rows.selectText(nil)
        let rowEditor = try XCTUnwrap(rows.currentEditor() as? NSTextView)
        rowEditor.insertText("8", replacementRange: NSRange(location: 0, length: rowEditor.string.utf16.count))
        XCTAssertEqual(columns.stringValue, "20")
        XCTAssertEqual(fixture.renderer?.activeConfiguration.render.calibrationGrid.rows, 8)
        rowEditor.insertText("8.5", replacementRange: NSRange(location: 0, length: rowEditor.string.utf16.count))
        XCTAssertEqual(rowEditor.string, "8.5")
        XCTAssertEqual(fixture.renderer?.activeConfiguration.render.calibrationGrid.rows, 8)
        window.makeFirstResponder(nil)
        XCTAssertEqual(rows.stringValue, "8.5")
        XCTAssertEqual(fixture.renderer?.activeConfiguration.render.calibrationGrid.rows, 8)
    }

    func testGridEditsInRawPreviewDoNotExitItOrPersistTemporaryWarpFlags() throws {
        let fixture = try Fixture(expanded: true)
        let original = fixture.panel.configurationForOfflinePreview
        try fixture.button("临时显示未校正网格").performClick(nil)
        XCTAssertTrue(fixture.views.compactMap { $0 as? NSTextField }.contains { $0.stringValue.contains("网格基准画布：5000 × 1000") })
        let renderer = try XCTUnwrap(fixture.renderer)
        let revision = renderer.meshRevision
        XCTAssertFalse(renderer.activeConfiguration.manual.enabled)
        try fixture.edit("nio-grid-columns", "24")
        XCTAssertEqual(renderer.meshRevision, revision)
        XCTAssertEqual(renderer.activeConfiguration.render.testPattern, .calibrationGrid)
        XCTAssertFalse(renderer.activeConfiguration.extendedWarpEnabled)
        XCTAssertFalse(renderer.activeConfiguration.manual.enabled)
        var saved = fixture.store.offlineConfiguration()
        saved.render.calibrationGrid = original.render.calibrationGrid
        XCTAssertEqual(saved, original)
        try fixture.button("返回校正画面").performClick(nil)
        XCTAssertTrue(renderer.activeConfiguration.manual.enabled)
        XCTAssertTrue(renderer.activeConfiguration.extendedWarpEnabled)
        XCTAssertEqual(renderer.activeConfiguration.render.calibrationGrid.columns, 24)
        XCTAssertEqual(fixture.history.count, 1)
    }

    func testStepperUpdatesImmediatelyWithoutRebuildingAndOfflineEditingStaysDisabled() throws {
        let active = try Fixture()
        let width = try active.field("nio-grid-line-width")
        let plus = try XCTUnwrap(width.superview?.subviews.compactMap { $0 as? NSButton }.first { $0.title == "+" })
        let revision = active.renderer?.meshRevision
        plus.performClick(nil)
        XCTAssertEqual(active.renderer?.activeConfiguration.render.calibrationGrid.lineWidthPixels, 3)
        XCTAssertEqual(active.renderer?.meshRevision, revision)
        try active.edit("nio-grid-columns", "1")
        let columns = try active.field("nio-grid-columns")
        let minus = try XCTUnwrap(columns.superview?.subviews.compactMap { $0 as? NSButton }.first { $0.title == "−" })
        minus.performClick(nil)
        XCTAssertEqual(columns.stringValue, "1")
        XCTAssertEqual(active.renderer?.activeConfiguration.render.calibrationGrid.columns, 1)
        let offline = try Fixture(active: false)
        let saved = offline.store.offlineConfiguration()
        for identifier in ["nio-grid-columns", "nio-grid-rows", "nio-grid-line-width"] {
            XCTAssertFalse(try offline.field(identifier).isEnabled)
            try offline.edit(identifier, "30")
        }
        XCTAssertEqual(offline.store.offlineConfiguration(), saved)
        XCTAssertEqual(offline.history.count, 0)
    }

    func testPresetsRoundTripAllGridParameters() throws {
        let fixture = try Fixture()
        let presets = PresetStore(defaults: fixture.defaults)
        var config = baseline()
        config.canvas = CanvasConfiguration(width: 8000, height: 2000)
        let saved = try presets.save(name: "网格测试", configuration: config)
        XCTAssertEqual(saved.configuration.render.calibrationGrid, config.render.calibrationGrid)
        XCTAssertEqual(saved.configuration.calibrationGridCellSize, SIMD2(250, 125))
    }
}
