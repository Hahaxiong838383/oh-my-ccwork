import AppKit
import MetalKit
import XCTest
@testable import NIOWarpApp

final class BezierWarpEditorTests: XCTestCase {
    private func configuration() -> WarpConfiguration {
        var config = WarpConfiguration.defaultConfiguration(displayWidth: 5120, displayHeight: 2880)
        config.bezierWarp.enabled = true
        return config
    }

    private func editor(available: Bool = true) throws -> BezierWarpEditorController {
        _ = NSApplication.shared
        let editor = BezierWarpEditorController(configuration: configuration(), available: available)
        let window = try XCTUnwrap(editor.window)
        window.contentView?.layoutSubtreeIfNeeded()
        return editor
    }

    private func descendants(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(descendants) }

    private func button(_ id: String, in editor: BezierWarpEditorController) throws -> NSButton {
        let content = try XCTUnwrap(editor.window?.contentView)
        return try XCTUnwrap(descendants(content).compactMap { $0 as? NSButton }.first { $0.accessibilityIdentifier() == id })
    }

    private func event(_ type: NSEvent.EventType, at point: NSPoint, canvas: BezierWarpCanvasView) throws -> NSEvent {
        let location = canvas.convert(point, to: nil)
        return try XCTUnwrap(NSEvent.mouseEvent(with: type, location: location, modifierFlags: [], timestamp: 1, windowNumber: canvas.window?.windowNumber ?? 0, context: nil, eventNumber: 1, clickCount: 1, pressure: 1))
    }

    func testOfflineEditorCannotMutateAndOpeningPreservesBaseline() throws {
        let editor = try editor(available: false)
        defer { editor.close() }
        let original = editor.draftConfiguration
        var changes = 0
        editor.onChange = { _, _ in changes += 1 }
        editor.selectNode(0)
        editor.nudge(dx: 2, dy: 3)
        XCTAssertEqual(editor.draftConfiguration, original)
        XCTAssertEqual(changes, 0)
        XCTAssertFalse(try button("nio-bezier-enabled", in: editor).isEnabled)
        XCTAssertFalse(try button("nio-bezier-add-column", in: editor).isEnabled)
    }

    func testNudgePropagatesAcrossRowsAndRecordsSingleHistory() throws {
        let editor = try editor()
        defer { editor.close() }
        let original = editor.draftConfiguration
        var historyFlags = [Bool]()
        editor.onChange = { _, record in historyFlags.append(record) }
        editor.selectNode(1)
        editor.nudge(dx: 1, dy: -0.1)
        editor.nudge(dx: 1, dy: -0.1, isRepeat: true)
        let result = editor.draftConfiguration
        XCTAssertEqual(historyFlags, [true, false])
        for row in 0..<result.bezierWarp.rows {
            XCTAssertEqual(result.bezierWarp.nodes[row * result.bezierWarp.columns + 1].offset.x, 2, accuracy: 0.0001)
            XCTAssertEqual(result.bezierWarp.nodes[row * result.bezierWarp.columns + 1].offset.y, -0.2, accuracy: 0.0001)
        }
        XCTAssertEqual(result.manual, original.manual)
        XCTAssertEqual(result.localWarp, original.localWarp)
    }

    func testNodeMouseDragPreviewsLocallyThenCommitsExactlyOnce() throws {
        let editor = try editor()
        defer { editor.close() }
        let canvas = editor.canvasView
        var commits = [BezierWarpConfiguration]()
        editor.onChange = { value, record in XCTAssertTrue(record); commits.append(value) }
        let selected = 6
        let coordinate = editor.draftConfiguration.bezierWarp.coordinate(at: selected)
        let physical = WarpMath.physicalPoints(canvasPoints: [SIMD2(Float(coordinate.x), Float(coordinate.y))], configuration: editor.draftConfiguration)[0]
        let start = canvas.viewPoint(for: physical)
        canvas.mouseDown(with: try event(.leftMouseDown, at: start, canvas: canvas))
        XCTAssertEqual(canvas.selectedIndex, selected)
        let moved = NSPoint(x: start.x + 1, y: start.y - 2)
        canvas.mouseDragged(with: try event(.leftMouseDragged, at: moved, canvas: canvas))
        XCTAssertTrue(commits.isEmpty, "拖动中不能提交历史或外屏输出")
        XCTAssertNotEqual(editor.draftConfiguration.bezierWarp.nodes[selected].offset, .zero)
        canvas.mouseUp(with: try event(.leftMouseUp, at: moved, canvas: canvas))
        XCTAssertEqual(commits.count, 1)
        XCTAssertEqual(commits[0], editor.draftConfiguration.bezierWarp)
    }

    func testBezierHandleDragChangesMultipleRowsWithoutMovingNodes() throws {
        let editor = try editor()
        defer { editor.close() }
        editor.selectNode(6)
        let canvas = editor.canvasView
        let original = editor.draftConfiguration
        let handle = try XCTUnwrap(canvas.handles(at: 6).first { $0.horizontal && $0.sign > 0 })
        let start = canvas.viewPoint(for: handle.point)
        var changes = 0
        editor.onChange = { _, _ in changes += 1 }
        canvas.mouseDown(with: try event(.leftMouseDown, at: start, canvas: canvas))
        let moved = NSPoint(x: start.x, y: start.y - 2)
        canvas.mouseDragged(with: try event(.leftMouseDragged, at: moved, canvas: canvas))
        XCTAssertEqual(changes, 0)
        canvas.mouseUp(with: try event(.leftMouseUp, at: moved, canvas: canvas))
        XCTAssertEqual(changes, 1)
        let result = editor.draftConfiguration
        for row in 0..<result.bezierWarp.rows {
            let index = row * result.bezierWarp.columns + 1
            XCTAssertEqual(result.bezierWarp.nodes[index].offset, original.bezierWarp.nodes[index].offset)
            XCTAssertLessThan(result.bezierWarp.nodes[index].tangentU.y, 0)
        }
    }

    func testEscapeCancelsDragWithoutSubmittingHistory() throws {
        let editor = try editor()
        defer { editor.close() }
        let original = editor.draftConfiguration
        let canvas = editor.canvasView
        var commits = 0
        editor.onChange = { _, _ in commits += 1 }
        let coordinate = original.bezierWarp.coordinate(at: 6)
        let physical = WarpMath.physicalPoints(canvasPoints: [SIMD2(Float(coordinate.x), Float(coordinate.y))], configuration: original)[0]
        let start = canvas.viewPoint(for: physical)
        canvas.mouseDown(with: try event(.leftMouseDown, at: start, canvas: canvas))
        canvas.mouseDragged(with: try event(.leftMouseDragged, at: NSPoint(x: start.x + 2, y: start.y), canvas: canvas))
        let escape = try XCTUnwrap(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: 1, windowNumber: editor.window?.windowNumber ?? 0, context: nil, characters: "\u{1b}", charactersIgnoringModifiers: "\u{1b}", isARepeat: false, keyCode: 53))
        canvas.keyDown(with: escape)
        canvas.mouseUp(with: try event(.leftMouseUp, at: start, canvas: canvas))
        XCTAssertEqual(editor.draftConfiguration, original)
        XCTAssertEqual(commits, 0)
    }

    func testInsertionPreservesEditedSurfaceAndUndoCanRestoreIt() throws {
        let editor = try editor()
        defer { editor.close() }
        editor.selectNode(6)
        editor.nudge(dx: 2, dy: -3)
        let original = editor.draftConfiguration
        let samples = (0...20).map { SIMD2(Double($0) / 20, 0.34) }
        var history = [WarpConfiguration]()
        editor.onChange = { _, record in if record { history.append(original) } }
        editor.onUndo = { if let previous = history.popLast() { editor.synchronize(configuration: previous, available: true) } }
        try button("nio-bezier-add-column", in: editor).performClick(nil)
        XCTAssertEqual(editor.draftConfiguration.bezierWarp.columns, original.bezierWarp.columns + 1)
        for uv in samples {
            let delta = editor.draftConfiguration.bezierWarp.displacement(at: uv) - original.bezierWarp.displacement(at: uv)
            XCTAssertLessThan(simd_length(delta), 1e-8)
        }
        try button("nio-bezier-undo", in: editor).performClick(nil)
        XCTAssertEqual(editor.draftConfiguration, original)
        editor.onUndo = nil
    }

    func testHandleDirectionsIncludeFinalGeometricLeveling() throws {
        let editor = try editor()
        defer { editor.close() }
        var config = editor.draftConfiguration
        config.manual.tilt = 0.06
        config.alignment.level = true
        editor.synchronize(configuration: config, available: true)
        editor.selectNode(6)
        let handle = try XCTUnwrap(editor.canvasView.handles(at: 6).first { $0.horizontal && $0.sign > 0 })
        let uv = config.bezierWarp.coordinate(at: 6)
        let samples = WarpMath.physicalPoints(canvasPoints: [SIMD2(Float(uv.x), Float(uv.y)), SIMD2(Float(uv.x - 0.0005), Float(uv.y)), SIMD2(Float(uv.x + 0.0005), Float(uv.y))], configuration: config)
        let expected = samples[0] + (samples[2] - samples[1]) / 0.001 * Float(handle.interval / 3)
        XCTAssertEqual(handle.point.x, expected.x, accuracy: 0.15)
        XCTAssertEqual(handle.point.y, expected.y, accuracy: 0.15)
        let delta = editor.canvasView.modelDelta(forPhysicalDelta: SIMD2(1, 0))
        XCTAssertEqual(simd_length(delta), 1, accuracy: 1e-8)
    }

    func testControlPanelAppliesValidatedBezierMeshSavesHistoryAndUndoRestores() throws {
        _ = NSApplication.shared
        guard MTLCreateSystemDefaultDevice() != nil else { throw XCTSkip("需要 Metal 设备") }
        let suite = "NIOWarp.BezierEditor.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = ConfigurationStore(defaults: defaults)
        let history = ConfigurationHistoryStore(defaults: defaults)
        let original = configuration()
        store.save(original)
        let renderer = try XCTUnwrap(WarpRenderer(view: MTKView(frame: .zero), frameStore: LatestFrameStore(), configuration: original))
        let panel = ControlPanelController(renderer: renderer, store: store, configuration: original, sourceScreen: nil, outputScreen: nil,
            setWarpVisible: { _ in XCTFail("曲面编辑不应改变输出显隐") }, isWarpVisible: { true },
            applyCaptureConfiguration: { _ in XCTFail("曲面编辑不应重启捕获") }, updateAABoundary: { _, _ in }, updateWarpBoundary: { _, _ in }, presentWindow: false,
            historyStore: history, presetStore: PresetStore(defaults: defaults))
        defer { panel.close() }
        let editor = panel.showBezierEditor(presentWindow: false)
        editor.selectNode(6)
        editor.nudge(dx: 2, dy: -1)
        let deadline = Date().addingTimeInterval(8)
        while renderer.activeConfiguration.bezierWarp.nodes[6].offset == .zero, Date() < deadline {
            RunLoop.current.run(until: Date().addingTimeInterval(0.01))
        }
        let applied = renderer.activeConfiguration
        XCTAssertEqual(applied.bezierWarp.nodes[6].offset, SIMD2(2, -1))
        XCTAssertEqual(store.offlineConfiguration().bezierWarp, applied.bezierWarp)
        XCTAssertEqual(panel.configurationForOfflinePreview.bezierWarp, applied.bezierWarp)
        XCTAssertEqual(history.count, 1)
        XCTAssertTrue(try XCTUnwrap(renderer.currentMesh).validation.isValid)
        try button("nio-bezier-undo", in: editor).performClick(nil)
        XCTAssertEqual(store.offlineConfiguration().bezierWarp, original.bezierWarp)
        XCTAssertEqual(renderer.activeConfiguration.bezierWarp, original.bezierWarp)
        XCTAssertEqual(editor.draftConfiguration.bezierWarp, original.bezierWarp)
    }
}
