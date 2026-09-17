import AppKit
import MetalKit
import XCTest
@testable import NIOWarpApp

final class LocalWarpTests: XCTestCase {
    private func baseline() -> WarpConfiguration {
        var config = WarpConfiguration.defaultConfiguration(displayWidth: 5120, displayHeight: 2880)
        config.canvas = CanvasConfiguration(width: 5000, height: 1000)
        config.aaRect = NormalizedRect(x: 0, y: 0, width: 5000.0 / 5120, height: 1300.0 / 2880)
        config.warpTrend = .inverse
        config.render.calibrationGrid = CalibrationGridConfiguration(columns: 13, rows: 7, lineWidthPixels: 4)
        config.enableCanvasGrowth()
        config = config.preparedForLocalEditing()
        config.localWarp.enabled = true
        return config
    }

    func testFieldHitsAllAnchorsAndHasCompactSupport() {
        var config = baseline()
        config.localWarp.setOffset(SIMD2(3.5, -1.25), at: SIMD2(-500, 0))
        config.localWarp.setOffset(SIMD2(-2, 4), at: SIMD2(0, 0))
        let field = LocalWarpField(config.localWarp)
        XCTAssertNil(field.error)
        for anchor in config.localWarp.anchors {
            XCTAssertLessThan(simd_length(field.displacement(at: anchor.coordinate) - anchor.offset), 1e-8)
        }
        XCTAssertEqual(field.displacement(at: SIMD2(2200, 300)), .zero)
        XCTAssertEqual(field.displacement(at: SIMD2(-2500, 0)), .zero)
    }

    func testSmoothnessKernelsMatchNormalizedValuesAndDifferBetweenAnchors() {
        let expectedMidpoints = [0.1875, 0.10807291666666667, 0.0595703125]
        for (index, smoothness) in LocalWarpSmoothness.allCases.enumerated() {
            XCTAssertEqual(smoothness.kernel(at: 0), 1)
            XCTAssertEqual(smoothness.kernel(at: 1), 0)
            XCTAssertEqual(smoothness.kernel(at: 1.1), 0)
            XCTAssertEqual(smoothness.kernel(at: 0.5), expectedMidpoints[index], accuracy: 1e-12)
            var config = baseline()
            config.localWarp.smoothness = smoothness
            config.localWarp.setOffset(SIMD2(8, -4), at: .zero)
            let field = LocalWarpField(config.localWarp)
            XCTAssertNil(field.error)
            let reference = config.localWarp.reference!
            let middle = SIMD2(reference.cellWidth * config.localWarp.radiusCells * 0.5, 0)
            XCTAssertEqual(field.displacement(at: middle).x, 8 * expectedMidpoints[index], accuracy: 1e-10)
        }
    }

    func testAllSmoothnessLevelsPreserveAnchorsBoundaryAndRenderPositions() throws {
        for smoothness in LocalWarpSmoothness.allCases {
            var config = baseline()
            config.localWarp.smoothness = smoothness
            config.localWarp.setOffset(SIMD2(3.5, -1.25), at: SIMD2(-500, 0))
            config.localWarp.setOffset(SIMD2(-2, 4), at: .zero)
            let field = LocalWarpField(config.localWarp)
            XCTAssertNil(field.error)
            var base = config
            base.localWarp.enabled = false
            let mesh = WarpMath.makeMesh(configuration: config, columns: 192, rows: 72)
            XCTAssertTrue(mesh.validation.isValid, mesh.validation.summary)
            for anchor in config.localWarp.anchors {
                XCTAssertLessThan(simd_length(field.displacement(at: anchor.coordinate) - anchor.offset), 1e-8)
                let uv = config.canvasUV(for: anchor.coordinate)
                let original = WarpMath.physicalPoints(canvasPoints: [uv], configuration: base)[0]
                let rendered = try XCTUnwrap(mesh.renderedPhysicalPoint(at: uv, width: 5120, height: 2880))
                XCTAssertEqual(Double(rendered.x - original.x), anchor.offsetX, accuracy: 0.002)
                XCTAssertEqual(Double(rendered.y - original.y), anchor.offsetY, accuracy: 0.002)
            }
            XCTAssertEqual(field.displacement(at: SIMD2(2200, 300)), .zero)
            XCTAssertEqual(field.displacement(at: SIMD2(-2500, 0)), .zero)
            let decoded = try JSONDecoder().decode(WarpConfiguration.self, from: JSONEncoder().encode(config))
            XCTAssertEqual(decoded, config)
        }
    }

    func testSchemaTenDefaultsToOriginalKernelWithoutMovingSavedAnchors() throws {
        var config = baseline()
        config.localWarp.setOffset(SIMD2(3, -2), at: .zero)
        var json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(config)) as? [String: Any])
        json["schemaVersion"] = 10
        var local = try XCTUnwrap(json["localWarp"] as? [String: Any])
        local.removeValue(forKey: "smoothness")
        json["localWarp"] = local
        let decoded = try JSONDecoder().decode(WarpConfiguration.self, from: JSONSerialization.data(withJSONObject: json))
        XCTAssertEqual(decoded.localWarp, config.localWarp)
        XCTAssertEqual(decoded.polynomial, config.polynomial)
        XCTAssertEqual(decoded.sanitized(forDisplayWidth: 5120, height: 2880).schemaVersion, WarpConfiguration.currentSchemaVersion)
        for coordinate in [SIMD2<Double>.zero, SIMD2(150, 30), SIMD2(-600, 80)] {
            XCTAssertEqual(LocalWarpField(decoded.localWarp).displacement(at: coordinate), LocalWarpField(config.localWarp).displacement(at: coordinate))
        }
        local["smoothness"] = "unsupported"
        json["localWarp"] = local
        XCTAssertThrowsError(try JSONDecoder().decode(WarpConfiguration.self, from: JSONSerialization.data(withJSONObject: json)))
    }

    func testSelectedAnchorIsAnActualRenderVertexAndMovesInPhysicalPixels() throws {
        var original = baseline()
        let uv = SIMD2<Float>(5.0 / 13, 3.0 / 7)
        let coordinate = original.localCoordinate(at: uv)
        let before = WarpMath.physicalPoints(canvasPoints: [uv], configuration: original)[0]
        original.localWarp.setOffset(SIMD2(1, -0.1), at: coordinate)
        let mesh = WarpMath.makeMesh(configuration: original, columns: 192, rows: 72)
        XCTAssertTrue(mesh.validation.isValid, mesh.validation.summary)
        XCTAssertTrue(mesh.horizontalAxis.contains(uv.x))
        XCTAssertTrue(mesh.verticalAxis.contains(uv.y))
        let after = try XCTUnwrap(mesh.renderedPhysicalPoint(at: uv, width: 5120, height: 2880))
        XCTAssertEqual(after.x - before.x, 1, accuracy: 0.01)
        XCTAssertEqual(after.y - before.y, -0.1, accuracy: 0.01)
        let inverted = try XCTUnwrap(mesh.sourceUV(at: after, width: 5120, height: 2880))
        XCTAssertEqual(inverted.x, uv.x, accuracy: 0.00001)
        XCTAssertEqual(inverted.y, uv.y, accuracy: 0.00001)
    }

    func testGrowthRebaseRefillAndAACropPreserveTheLocalField() {
        var original = baseline()
        original.localWarp.setOffset(SIMD2(6, -4), at: SIMD2(-400, 50))
        let coordinate = original.localWarp.anchors[0].coordinate
        let before = WarpMath.physicalPoints(canvasPoints: [original.canvasUV(for: coordinate)], configuration: original)[0]
        var expanded = original
        expanded.canvas = CanvasConfiguration(width: 8000, height: 2000)
        expanded.rebaseCanvasGrowth()
        expanded.refillContentCanvas()
        expanded.aaRect = NormalizedRect(x: 0.1, y: 0.2, width: 0.5, height: 0.5)
        expanded.render.calibrationGrid.columns = 29
        expanded.render.calibrationGrid.rows = 19
        let after = WarpMath.physicalPoints(canvasPoints: [expanded.canvasUV(for: coordinate)], configuration: expanded)[0]
        XCTAssertLessThan(simd_length(after - before), 0.01)
        XCTAssertEqual(expanded.localWarp, original.localWarp)
        XCTAssertEqual(LocalWarpField(expanded.localWarp).displacement(at: SIMD2(0, 50)), LocalWarpField(original.localWarp).displacement(at: SIMD2(0, 50)))
    }

    func testEnablingGrowthAfterLegacyCanvasChangeDoesNotMoveLocalAnchor() {
        var config = baseline()
        config.extendedWarpEnabled = false
        config.canvasReference = nil
        config.localWarp.setOffset(SIMD2(4, 2), at: SIMD2(500, 0))
        config.canvas = CanvasConfiguration(width: 7000, height: 1800)
        let coordinate = config.localWarp.anchors[0].coordinate
        let before = WarpMath.physicalPoints(canvasPoints: [config.canvasUV(for: coordinate)], configuration: config)[0]
        config.enableCanvasGrowth()
        let after = WarpMath.physicalPoints(canvasPoints: [config.canvasUV(for: coordinate)], configuration: config)[0]
        XCTAssertLessThan(simd_length(before - after), 0.01)
    }

    func testRawAndABDisableLocalCorrectionWithoutDeletingItsData() {
        var config = baseline()
        config.localWarp.setOffset(SIMD2(8, 12), at: .zero)
        let raw = config.rawReflectionCalibrationConfiguration()
        let comparison = config.antiAliasingComparisonConfiguration()
        XCTAssertFalse(raw.localWarp.enabled)
        XCTAssertFalse(comparison.localWarp.enabled)
        XCTAssertEqual(raw.localWarp.anchors, config.localWarp.anchors)
        XCTAssertEqual(raw.localWarp.reference, config.localWarp.reference)
        XCTAssertTrue(config.localWarp.enabled)
        var zero = raw
        zero.localWarp = LocalWarpConfiguration()
        XCTAssertEqual(WarpMath.makeMesh(configuration: raw).vertices.map(\.position), WarpMath.makeMesh(configuration: zero).vertices.map(\.position))
    }

    func testJSONMigrationAndExpandedStrengthLimitKeepOldValues() throws {
        var config = baseline()
        config.manual.strength = 2.2
        config.manual.arch = 0.3
        let sanitized = config.sanitized(forDisplayWidth: 5120, height: 2880)
        XCTAssertEqual(sanitized.manual.strength, 2.2)
        XCTAssertEqual(sanitized.manual.arch, 0.3)
        XCTAssertTrue(WarpMath.makeMesh(configuration: sanitized).validation.isValid)
        config.localWarp.setOffset(SIMD2(2, 1), at: .zero)
        let roundTrip = try JSONDecoder().decode(WarpConfiguration.self, from: JSONEncoder().encode(config))
        XCTAssertEqual(roundTrip.localWarp, config.localWarp)
        var json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(config)) as? [String: Any])
        json.removeValue(forKey: "localWarp")
        json["schemaVersion"] = 9
        let old = try JSONDecoder().decode(WarpConfiguration.self, from: JSONSerialization.data(withJSONObject: json))
        XCTAssertEqual(old.localWarp, LocalWarpConfiguration())
        XCTAssertEqual(old.manual, config.manual)
        XCTAssertEqual(old.polynomial, config.polynomial)
    }

    func testInvalidLocalDataAndFoldedMovesAreRejected() {
        var config = baseline()
        config.localWarp.setOffset(SIMD2(1, 0), at: SIMD2(2500, 0))
        XCTAssertFalse(config.validationErrors().isEmpty)
        config.localWarp.lockBoundary = false
        XCTAssertTrue(config.validationErrors().isEmpty)
        config.localWarp.anchors.append(config.localWarp.anchors[0])
        XCTAssertFalse(config.validationErrors().isEmpty)
        config = baseline()
        config.localWarp.radiusCells = 1
        config.localWarp.setOffset(SIMD2(0, -900), at: .zero)
        XCTAssertFalse(WarpMath.makeMesh(configuration: config).validation.isValid)
        config.localWarp.anchors[0].offsetY = .nan
        XCTAssertFalse(config.validationErrors().isEmpty)
    }

    func testNonUniformAxisDoesNotRejectAnOtherwiseSafeThinCell() {
        var config = baseline()
        config.localWarp.setOffset(SIMD2(1, 0), at: config.localCoordinate(at: SIMD2(0.50001, 0.50001)))
        let mesh = WarpMath.makeMesh(configuration: config, columns: 192, rows: 72)
        XCTAssertTrue(mesh.validation.isValid, mesh.validation.summary)
    }

    private final class Fixture {
        let suite = "NIOWarp.Local.\(UUID().uuidString)"
        let defaults: UserDefaults
        let store: ConfigurationStore
        let history: ConfigurationHistoryStore
        let renderer: WarpRenderer?
        let panel: ControlPanelController
        let editor: LocalWarpEditorController

        init(active: Bool = true) throws {
            _ = NSApplication.shared
            defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
            store = ConfigurationStore(defaults: defaults)
            history = ConfigurationHistoryStore(defaults: defaults)
            var config = WarpConfiguration.defaultConfiguration(displayWidth: 5120, displayHeight: 2880)
            config.canvas = CanvasConfiguration(width: 5000, height: 1000)
            config.enableCanvasGrowth()
            store.save(config)
            if active {
                guard MTLCreateSystemDefaultDevice() != nil else { throw XCTSkip("需要 Metal 设备") }
                renderer = try XCTUnwrap(WarpRenderer(view: MTKView(frame: .zero), frameStore: LatestFrameStore(), configuration: config))
            } else { renderer = nil }
            panel = ControlPanelController(
                renderer: renderer, store: store, configuration: config, sourceScreen: nil, outputScreen: nil,
                setWarpVisible: { _ in XCTFail("局部编辑不能改变输出显隐") }, isWarpVisible: { true },
                applyCaptureConfiguration: { _ in XCTFail("局部编辑不能重启捕获") },
                updateAABoundary: { _, _ in }, updateWarpBoundary: { _, _ in }, presentWindow: false,
                historyStore: history, presetStore: PresetStore(defaults: defaults)
            )
            editor = panel.showLocalEditor(presentWindow: false)
            panel.selectModule("local")
            let content = try XCTUnwrap(panel.window?.contentView)
            let tabs = try XCTUnwrap(descendants(content).compactMap { $0 as? NSTabView }.first)
            let localPage = try XCTUnwrap(tabs.tabViewItems.first { $0.identifier as? String == "local" }?.view)
            let picker = try XCTUnwrap(descendants(localPage).compactMap { $0 as? NSSegmentedControl }.first { $0.accessibilityIdentifier() == "nio-local-tool-picker" })
            picker.selectedSegment = 1
            picker.sendAction(try XCTUnwrap(picker.action), to: picker.target)
            content.layoutSubtreeIfNeeded()
        }

        deinit { panel.close(); defaults.removePersistentDomain(forName: suite) }

        func descendants(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(descendants) }

        func editorButton(_ title: String) throws -> NSButton {
            try XCTUnwrap(descendants(editor.embeddedInspector).compactMap { $0 as? NSButton }.first { $0.title == title })
        }

        func primaryButton(_ title: String) throws -> NSButton {
            let tabs = try XCTUnwrap(descendants(try XCTUnwrap(panel.window?.contentView)).compactMap { $0 as? NSTabView }.first)
            return try XCTUnwrap(tabs.tabViewItems.compactMap(\.view).flatMap(descendants).compactMap { $0 as? NSButton }.first { $0.title == title })
        }
    }

    private func wait(_ condition: () -> Bool, timeout: TimeInterval = 5, file: StaticString = #filePath, line: UInt = #line) {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition(), Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.01)) }
        XCTAssertTrue(condition(), file: file, line: line)
    }

    func testOpeningEditorIsReadOnlyUntilEnabledAndWindowCanBeReused() throws {
        let fixture = try Fixture()
        let saved = fixture.store.offlineConfiguration()
        XCTAssertNil(saved.localWarp.reference)
        XCTAssertTrue(fixture.panel.showLocalEditor(presentWindow: false) === fixture.editor)
        fixture.editor.select(.zero)
        fixture.editor.nudge(dx: 1, dy: 0)
        XCTAssertEqual(fixture.store.offlineConfiguration(), saved)
        XCTAssertEqual(fixture.history.count, 0)
        XCTAssertNil(fixture.editor.window, "内嵌编辑器不能分配第二个窗口")
        fixture.editor.close()
        XCTAssertNotNil(fixture.panel.window)
    }

    func testLiveNudgeIsAtomicCoalescedAndDoesNotChangeOriginalPolynomial() throws {
        let fixture = try Fixture()
        let original = fixture.panel.configurationForOfflinePreview
        try fixture.editorButton("启用局部修正").performClick(nil)
        wait { fixture.panel.configurationForOfflinePreview.localWarp.enabled }
        fixture.editor.select(.zero)
        let revision = fixture.renderer?.meshRevision
        for index in 0..<5 { fixture.editor.nudge(dx: 0.1, dy: -1, isRepeat: index > 0) }
        wait { fixture.panel.configurationForOfflinePreview.localWarp.anchors.count == 1 }
        let saved = fixture.panel.configurationForOfflinePreview
        XCTAssertEqual(saved.localWarp.anchors[0].offsetX, 0.5, accuracy: 1e-8)
        XCTAssertEqual(saved.localWarp.anchors[0].offsetY, -5, accuracy: 1e-8)
        XCTAssertEqual(fixture.renderer?.meshRevision, (revision ?? 0) + 1)
        XCTAssertEqual(saved.polynomial, original.polynomial)
        XCTAssertEqual(saved.manual, original.manual)
        XCTAssertEqual(saved.aaRect, original.aaRect)
        XCTAssertEqual(fixture.history.count, 2)
        XCTAssertEqual(fixture.store.offlineConfiguration().localWarp, saved.localWarp)
        try fixture.editorButton("撤销上一次设置").performClick(nil)
        XCTAssertTrue(fixture.panel.configurationForOfflinePreview.localWarp.anchors.isEmpty)
    }

    func testRawPreviewAndClosingWorkbenchCancelPendingResults() throws {
        let fixture = try Fixture()
        try fixture.editorButton("启用局部修正").performClick(nil)
        wait { fixture.panel.configurationForOfflinePreview.localWarp.enabled }
        fixture.editor.select(.zero)
        fixture.editor.nudge(dx: 5, dy: 5)
        try fixture.primaryButton("临时显示未校正网格").performClick(nil)
        RunLoop.current.run(until: Date().addingTimeInterval(0.2))
        XCTAssertTrue(fixture.panel.configurationForOfflinePreview.localWarp.anchors.isEmpty)
        XCTAssertFalse(try XCTUnwrap(fixture.renderer).activeConfiguration.localWarp.enabled)
        XCTAssertFalse(try fixture.editorButton("启用局部修正").isEnabled)
        try fixture.primaryButton("返回校正画面").performClick(nil)
        fixture.editor.select(.zero)
        fixture.editor.nudge(dx: 2, dy: 2)
        fixture.panel.close()
        RunLoop.current.run(until: Date().addingTimeInterval(0.2))
        XCTAssertTrue(fixture.panel.configurationForOfflinePreview.localWarp.anchors.isEmpty)
    }

    func testOfflineEditorCannotModifyParametersAndItsControlsFitTheWindow() throws {
        let fixture = try Fixture(active: false)
        let original = fixture.store.offlineConfiguration()
        XCTAssertFalse(try fixture.editorButton("启用局部修正").isEnabled)
        XCTAssertFalse(try fixture.editorButton("撤销上一次设置").isEnabled)
        fixture.editor.select(.zero)
        fixture.editor.nudge(dx: 8, dy: 8)
        XCTAssertEqual(fixture.store.offlineConfiguration(), original)
        XCTAssertEqual(fixture.history.count, 0)
        let window = try XCTUnwrap(fixture.panel.window)
        window.setContentSize(NSSize(width: 1040, height: 650))
        let content = try XCTUnwrap(window.contentView)
        content.layoutSubtreeIfNeeded()
        XCTAssertGreaterThan(fixture.editor.canvasView.bounds.width, 400)
        XCTAssertGreaterThan(fixture.editor.canvasView.bounds.height, 200)
        for control in fixture.descendants(content).compactMap({ $0 as? NSControl }) {
            let rect = control.convert(control.bounds, to: content)
            XCTAssertGreaterThanOrEqual(rect.minX, -1, control.description)
            XCTAssertLessThanOrEqual(rect.maxX, content.bounds.width + 1, control.description)
        }
    }

    func testCanvasSelectionUsesTheProductionMeshInverse() throws {
        let fixture = try Fixture()
        let canvas = fixture.editor.canvasView
        let coordinate = SIMD2<Double>.zero
        let physical = try XCTUnwrap(canvas.physicalPoint(for: coordinate))
        let selected = try XCTUnwrap(canvas.pick(at: canvas.viewPoint(for: physical)))
        XCTAssertLessThan(simd_length(selected - coordinate), 0.001)
        canvas.changeZoom(by: 4)
        let zoomed = try XCTUnwrap(canvas.pick(at: canvas.viewPoint(for: physical)))
        XCTAssertLessThan(simd_length(zoomed - coordinate), 0.001)
    }

    func testDirectionPadStaysSymmetricAcrossWindowSizes() throws {
        let fixture = try Fixture(active: false)
        let window = try XCTUnwrap(fixture.panel.window)
        let content = try XCTUnwrap(window.contentView)
        let up = try fixture.editorButton("↑")
        let down = try fixture.editorButton("↓")
        let left = try fixture.editorButton("←")
        let right = try fixture.editorButton("→")
        for size in [NSSize(width: 1040, height: 650), NSSize(width: 1120, height: 720), NSSize(width: 1280, height: 820)] {
            window.setContentSize(size)
            content.layoutSubtreeIfNeeded()
            let upRect = up.convert(up.bounds, to: content)
            let downRect = down.convert(down.bounds, to: content)
            let leftRect = left.convert(left.bounds, to: content)
            let rightRect = right.convert(right.bounds, to: content)
            XCTAssertEqual(upRect.midX, downRect.midX, accuracy: 0.5)
            XCTAssertEqual(leftRect.midY, rightRect.midY, accuracy: 0.5)
            XCTAssertEqual(upRect.midX - leftRect.midX, rightRect.midX - upRect.midX, accuracy: 0.5)
            XCTAssertLessThanOrEqual(rightRect.maxX - leftRect.minX, 180)
        }
    }

    func testSmoothnessPickerUpdatesLiveAndUndoRestoresWithoutChangingPolynomial() throws {
        let fixture = try Fixture()
        try fixture.editorButton("启用局部修正").performClick(nil)
        wait { fixture.panel.configurationForOfflinePreview.localWarp.enabled }
        fixture.editor.select(.zero)
        fixture.editor.nudge(dx: 8, dy: 4)
        wait { fixture.panel.configurationForOfflinePreview.localWarp.anchors.count == 1 }
        let original = fixture.panel.configurationForOfflinePreview
        let picker = try XCTUnwrap(fixture.descendants(fixture.editor.embeddedInspector).compactMap { $0 as? NSPopUpButton }.first { $0.accessibilityIdentifier() == "nio-local-smoothness" })
        for level in [1, 2] {
            picker.selectItem(at: level)
            picker.sendAction(try XCTUnwrap(picker.action), to: picker.target)
            wait { fixture.panel.configurationForOfflinePreview.localWarp.smoothness == LocalWarpSmoothness.allCases[level] }
            let saved = fixture.store.offlineConfiguration()
            XCTAssertEqual(saved.localWarp.anchors, original.localWarp.anchors)
            XCTAssertEqual(saved.localWarp.reference, original.localWarp.reference)
            XCTAssertEqual(saved.localWarp.radiusCells, original.localWarp.radiusCells)
            XCTAssertEqual(saved.polynomial, original.polynomial)
            XCTAssertEqual(saved.manual, original.manual)
            XCTAssertEqual(saved.canvasReference, original.canvasReference)
            XCTAssertEqual(fixture.renderer?.activeConfiguration.localWarp.smoothness, LocalWarpSmoothness.allCases[level])
        }
        try fixture.editorButton("撤销上一次设置").performClick(nil)
        XCTAssertEqual(fixture.store.offlineConfiguration().localWarp.smoothness, .higher)
    }

    func testPolynomialNavigationIsReadOnlyAndAvailableOffline() throws {
        let fixture = try Fixture(active: false)
        let original = fixture.store.offlineConfiguration()
        let content = fixture.editor.embeddedInspector
        let picker = try XCTUnwrap(fixture.descendants(content).compactMap { $0 as? NSPopUpButton }.first { $0.accessibilityIdentifier() == "nio-local-smoothness" })
        XCTAssertFalse(picker.isEnabled)
        fixture.editor.onShowPolynomial = { fixture.panel.showGlobalPolynomialSettings(presentWindow: false) }
        try fixture.editorButton("打开全局多项式设置").performClick(nil)
        XCTAssertEqual(fixture.panel.selectedModuleIdentifier, "global")
        XCTAssertEqual(fixture.store.offlineConfiguration(), original)
        XCTAssertEqual(fixture.history.count, 0)
        fixture.editor.onShowPolynomial = nil
    }

    func testRejectedLiveMoveRetainsLastMeshAndDoesNotAddHistory() throws {
        let fixture = try Fixture()
        try fixture.editorButton("启用局部修正").performClick(nil)
        wait { fixture.panel.configurationForOfflinePreview.localWarp.enabled }
        fixture.editor.select(.zero)
        let original = fixture.panel.configurationForOfflinePreview
        let revision = fixture.renderer?.meshRevision
        let history = fixture.history.count
        fixture.editor.nudge(dx: 0, dy: -900)
        wait { fixture.editor.statusText.contains("没有应用") }
        XCTAssertEqual(fixture.panel.configurationForOfflinePreview, original)
        XCTAssertEqual(fixture.renderer?.meshRevision, revision)
        XCTAssertEqual(fixture.history.count, history)
        fixture.editor.nudge(dx: 1, dy: 0)
        wait { fixture.panel.configurationForOfflinePreview.localWarp.anchors.count == 1 }
        XCTAssertEqual(fixture.panel.configurationForOfflinePreview.localWarp.anchors[0].offsetX, 1)
    }

    func testPresetRoundTripPreservesLocalAnchorsAndOriginalPolynomial() throws {
        let fixture = try Fixture()
        var config = baseline()
        config.localWarp.setOffset(SIMD2(4.2, -3.1), at: .zero)
        let saved = try PresetStore(defaults: fixture.defaults).save(name: "局部测试", configuration: config)
        XCTAssertEqual(saved.configuration.localWarp, config.localWarp)
        XCTAssertEqual(saved.configuration.polynomial, config.polynomial)
    }

    func testFirstSubpixelNudgeUsesTheCurrentlyRenderedPosition() throws {
        let fixture = try Fixture()
        try fixture.editorButton("启用局部修正").performClick(nil)
        wait { fixture.panel.configurationForOfflinePreview.localWarp.enabled }
        let selected = fixture.editor.draftConfiguration.localCoordinate(at: SIMD2(5.0 / 13, 3.0 / 7))
        fixture.editor.select(selected)
        let before = try XCTUnwrap(fixture.editor.canvasView.physicalPoint(for: selected))
        fixture.editor.nudge(dx: 1, dy: -0.1)
        wait { fixture.panel.configurationForOfflinePreview.localWarp.anchors.count == 1 }
        let after = try XCTUnwrap(fixture.editor.canvasView.physicalPoint(for: selected))
        XCTAssertEqual(after.x - before.x, 1, accuracy: 0.01)
        XCTAssertEqual(after.y - before.y, -0.1, accuracy: 0.01)
    }

    func testMagnifierDrawingCannotSpillIntoSiblingViews() throws {
        _ = NSApplication.shared
        let config = baseline()
        let view = LocalWarpCanvasView(frame: NSRect(x: 0, y: 0, width: 200, height: 200))
        view.magnified = true
        view.update(configuration: config, mesh: WarpMath.makeMesh(configuration: config))
        view.selectedCoordinate = .zero
        let bitmap = try XCTUnwrap(NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 400, pixelsHigh: 400, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 1600, bitsPerPixel: 32))
        let context = try XCTUnwrap(NSGraphicsContext(bitmapImageRep: bitmap))
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = context
        NSColor.magenta.setFill()
        NSBezierPath(rect: NSRect(x: 0, y: 0, width: 400, height: 400)).fill()
        context.cgContext.translateBy(x: 100, y: 100)
        view.draw(view.bounds)
        NSGraphicsContext.restoreGraphicsState()
        var changed = 0
        for row in 0..<400 {
            for column in 0..<400 where column < 98 || column > 301 || row < 98 || row > 301 {
                let color = try XCTUnwrap(bitmap.colorAt(x: column, y: row)?.usingColorSpace(.deviceRGB))
                if color.redComponent < 0.99 || color.greenComponent > 0.01 || color.blueComponent < 0.99 { changed += 1 }
            }
        }
        XCTAssertEqual(changed, 0, "放大图不能覆盖旁边的主预览或控件")
    }
    func testLeveledExistingLocalAnchorUsesVisiblePhysicalPixelDirections() throws {
        _ = NSApplication.shared
        var configuration = baseline()
        configuration.manual.tilt = 0.12
        configuration.alignment.level = true
        configuration.alignment.centerHorizontal = true
        configuration.alignment.centerVertical = true
        configuration.bezierWarp.enabled = true
        XCTAssertTrue(configuration.bezierWarp.applyOffsetDelta(SIMD2(0, -8), at: 0))
        let coordinate = SIMD2<Double>(-500, -100)
        configuration.localWarp.setOffset(SIMD2(5, -2), at: coordinate)
        let uv = configuration.canvasUV(for: coordinate)
        let mesh = WarpMath.makeMesh(configuration: configuration, columns: 192, rows: 72)
        XCTAssertTrue(mesh.validation.isValid, mesh.validation.summary)
        let editor = LocalWarpEditorController(configuration: configuration, renderedConfiguration: configuration, mesh: mesh, available: true, screen: nil)
        defer { editor.close() }
        editor.select(coordinate)
        let before = try XCTUnwrap(mesh.renderedPhysicalPoint(at: uv, width: 5120, height: 2880))
        editor.nudge(dx: 10, dy: 0)
        let after = editor.draftConfiguration
        let moved = WarpMath.physicalPoints(canvasPoints: [uv], configuration: after)[0] - before
        XCTAssertEqual(moved.x, 10, accuracy: 0.005)
        XCTAssertEqual(moved.y, 0, accuracy: 0.005, "归正后按右箭头不得沿模型旋转后的斜轴移动")
        XCTAssertEqual(after.bezierWarp, configuration.bezierWarp)
        XCTAssertEqual(after.manual, configuration.manual)
        XCTAssertEqual(after.alignment, configuration.alignment)
        let updatedMesh = WarpMath.makeMesh(configuration: after, columns: 192, rows: 72)
        editor.synchronize(configuration: after, renderedConfiguration: after, mesh: updatedMesh, available: true)
        editor.nudge(dx: 0, dy: -1)
        let movedAgain = WarpMath.physicalPoints(canvasPoints: [uv], configuration: editor.draftConfiguration)[0] - before - moved
        XCTAssertEqual(movedAgain.x, 0, accuracy: 0.005)
        XCTAssertEqual(movedAgain.y, -1, accuracy: 0.005)
    }

    func testNewLocalAnchorPreservesDisplayedPointUnderBezierAndGeometricAlignment() throws {
        _ = NSApplication.shared
        var configuration = baseline()
        configuration.manual.tilt = 0.12
        configuration.alignment.level = true
        configuration.alignment.centerHorizontal = true
        configuration.alignment.centerVertical = true
        configuration.bezierWarp.enabled = true
        XCTAssertTrue(configuration.bezierWarp.applyOffsetDelta(SIMD2(0, -10), at: 0))
        XCTAssertTrue(configuration.bezierWarp.applyTangentDelta(SIMD2(0, 45), axis: .horizontal, at: 1))
        configuration.localWarp.setOffset(SIMD2(12, 8), at: SIMD2(-400, 0))
        let coordinate = SIMD2<Double>(-250, 50)
        XCTAssertNil(configuration.localWarp.anchor(at: coordinate))
        XCTAssertGreaterThan(simd_length(LocalWarpField(configuration.localWarp).displacement(at: coordinate)), 1)
        let uv = configuration.canvasUV(for: coordinate)
        let mesh = WarpMath.makeMesh(configuration: configuration, columns: 192, rows: 72)
        XCTAssertTrue(mesh.validation.isValid, mesh.validation.summary)
        let editor = LocalWarpEditorController(configuration: configuration, renderedConfiguration: configuration, mesh: mesh, available: true, screen: nil)
        defer { editor.close() }
        editor.select(coordinate)
        let before = try XCTUnwrap(mesh.renderedPhysicalPoint(at: uv, width: 5120, height: 2880))
        // Creating an anchor with zero movement must preserve the actual rendered point,
        // including mesh interpolation, rather than mixing pre/post-alignment coordinates.
        editor.nudge(dx: 0, dy: 0)
        let after = editor.draftConfiguration
        XCTAssertNotNil(after.localWarp.anchor(at: coordinate))
        let afterMesh = WarpMath.makeMesh(configuration: after, columns: 192, rows: 72)
        XCTAssertTrue(afterMesh.validation.isValid, afterMesh.validation.summary)
        let point = try XCTUnwrap(afterMesh.renderedPhysicalPoint(at: uv, width: 5120, height: 2880))
        XCTAssertEqual(point.x, before.x, accuracy: 0.005)
        XCTAssertEqual(point.y, before.y, accuracy: 0.005)
        XCTAssertEqual(after.bezierWarp, configuration.bezierWarp)
        XCTAssertEqual(after.alignment, configuration.alignment)
        editor.synchronize(configuration: after, renderedConfiguration: after, mesh: afterMesh, available: true)
        editor.nudge(dx: 2, dy: 0)
        let moved = WarpMath.physicalPoints(canvasPoints: [uv], configuration: editor.draftConfiguration)[0] - before
        XCTAssertEqual(moved.x, 2, accuracy: 0.005)
        XCTAssertEqual(moved.y, 0, accuracy: 0.005)
    }

}
