import AppKit
import XCTest
@testable import NIOWarpApp

final class EmbeddedWarpEditorTests: XCTestCase {
    private func configuration() -> WarpConfiguration {
        var configuration = WarpConfiguration.defaultConfiguration(displayWidth: 5120, displayHeight: 2880).preparedForLocalEditing()
        configuration.bezierWarp.enabled = true
        configuration.localWarp.enabled = true
        return configuration
    }

    private func localEditor(_ configuration: WarpConfiguration) -> LocalWarpEditorController {
        LocalWarpEditorController(configuration: configuration, renderedConfiguration: configuration,
                                  mesh: WarpMath.makeMesh(configuration: configuration, columns: 48, rows: 24),
                                  available: true, screen: nil, embedded: true)
    }

    private func descendants(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(descendants) }

    private func mouseEvent(_ type: NSEvent.EventType, at point: NSPoint, in canvas: NSView) throws -> NSEvent {
        try XCTUnwrap(NSEvent.mouseEvent(with: type, location: canvas.convert(point, to: nil), modifierFlags: [],
                                        timestamp: 1, windowNumber: canvas.window?.windowNumber ?? 0,
                                        context: nil, eventNumber: 1, clickCount: 1, pressure: 1))
    }

    private func host(_ preview: NSView, inspector: NSView) -> NSWindow {
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1120, height: 720),
                              styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        let content = window.contentView!
        for view in [preview, inspector] { view.translatesAutoresizingMaskIntoConstraints = false; content.addSubview(view) }
        NSLayoutConstraint.activate([
            preview.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 12),
            preview.topAnchor.constraint(equalTo: content.topAnchor, constant: 12),
            preview.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -12),
            preview.trailingAnchor.constraint(equalTo: inspector.leadingAnchor, constant: -16),
            inspector.topAnchor.constraint(equalTo: preview.topAnchor),
            inspector.bottomAnchor.constraint(equalTo: preview.bottomAnchor),
            inspector.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -12),
            inspector.widthAnchor.constraint(equalToConstant: 302),
        ])
        content.layoutSubtreeIfNeeded()
        return window
    }

    func testEmbeddedEditorsDoNotCreateOrShowAdditionalWindows() {
        _ = NSApplication.shared
        let original = configuration()
        let bezier = BezierWarpEditorController(configuration: original, available: true, embedded: true)
        let local = localEditor(original)
        XCTAssertNil(bezier.window)
        XCTAssertNil(local.window)
        XCTAssertFalse(bezier.embeddedPreview.subviews.isEmpty)
        XCTAssertFalse(local.embeddedInspector.documentView?.subviews.isEmpty ?? true)
        bezier.showWindow(nil); local.showWindow(nil)
        bezier.prepareForEmbedding(); local.prepareForEmbedding()
        XCTAssertNil(bezier.window)
        XCTAssertNil(local.window)
        XCTAssertEqual(bezier.draftConfiguration, original)
        XCTAssertEqual(local.draftConfiguration, original)
    }

    func testLegacyWindowCanMigrateWithoutClosingEditorState() throws {
        _ = NSApplication.shared
        let editor = BezierWarpEditorController(configuration: configuration(), available: true)
        let originalWindow = try XCTUnwrap(editor.window)
        XCTAssertEqual(originalWindow.level, .normal)
        editor.selectNode(6)
        let preview = editor.embeddedPreview
        var closed = false
        editor.onClose = { closed = true }
        editor.prepareForEmbedding()
        editor.prepareForEmbedding()
        XCTAssertNil(editor.window)
        XCTAssertTrue(editor.embeddedPreview === preview)
        XCTAssertEqual(editor.canvasView.selectedIndex, 6)
        XCTAssertNil(preview.superview)
        XCTAssertFalse(closed)
        originalWindow.close()
    }

    func testNavigatingAwayCancelsUncommittedDragWithoutChangingOutput() throws {
        _ = NSApplication.shared
        let original = configuration()
        let editor = BezierWarpEditorController(configuration: original, available: true, embedded: true)
        let window = host(editor.embeddedPreview, inspector: editor.embeddedInspector)
        defer { window.close() }
        let canvas = editor.canvasView
        var commits = 0, closes = 0
        editor.onChange = { _, _ in commits += 1 }
        editor.onClose = { closes += 1 }
        let point = original.bezierWarp.coordinate(at: 6)
        let physical = WarpMath.physicalPoints(canvasPoints: [SIMD2(Float(point.x), Float(point.y))], configuration: original)[0]
        let start = canvas.viewPoint(for: physical)
        canvas.mouseDown(with: try mouseEvent(.leftMouseDown, at: start, in: canvas))
        canvas.mouseDragged(with: try mouseEvent(.leftMouseDragged, at: NSPoint(x: start.x + 2, y: start.y - 1), in: canvas))
        XCTAssertNotEqual(editor.draftConfiguration.bezierWarp, original.bezierWarp)
        editor.deactivateInteraction()
        canvas.mouseUp(with: try mouseEvent(.leftMouseUp, at: start, in: canvas))
        XCTAssertEqual(editor.draftConfiguration, original)
        XCTAssertEqual(editor.canvasView.selectedIndex, 6)
        XCTAssertEqual(commits, 0)
        XCTAssertEqual(closes, 0)
    }

    func testNavigationPreservesAlreadySubmittedChangesAwaitingValidation() {
        _ = NSApplication.shared
        let original = configuration()
        let bezier = BezierWarpEditorController(configuration: original, available: true, embedded: true)
        let local = localEditor(original)
        var changes = 0, closes = 0
        bezier.onChange = { _, _ in changes += 1 }; local.onChange = { _, _ in changes += 1 }
        bezier.onClose = { closes += 1 }; local.onClose = { closes += 1 }
        bezier.selectNode(6); bezier.nudge(dx: 2, dy: 0)
        local.select(.zero); local.nudge(dx: 1, dy: 0)
        let bezierPending = bezier.draftConfiguration
        let localPending = local.draftConfiguration
        bezier.deactivateInteraction(); local.deactivateInteraction()
        XCTAssertEqual(changes, 2)
        XCTAssertEqual(closes, 0)
        XCTAssertEqual(bezier.draftConfiguration, bezierPending)
        XCTAssertEqual(local.draftConfiguration, localPending)
        XCTAssertEqual(local.canvasView.selectedCoordinate, .zero)
        XCTAssertTrue(local.statusText.contains("正在验证"))
    }

    func testMouseUpSubmissionCannotBeRolledBackByNavigationInsideCallback() throws {
        _ = NSApplication.shared
        let original = configuration()
        let editor = BezierWarpEditorController(configuration: original, available: true, embedded: true)
        let window = host(editor.embeddedPreview, inspector: editor.embeddedInspector)
        defer { window.close() }
        let canvas = editor.canvasView
        var submitted: BezierWarpConfiguration?
        editor.onChange = { value, _ in
            submitted = value
            editor.deactivateInteraction()
            editor.setEditingAvailable(false)
        }
        defer { editor.onChange = nil }
        let point = original.bezierWarp.coordinate(at: 6)
        let physical = WarpMath.physicalPoints(canvasPoints: [SIMD2(Float(point.x), Float(point.y))], configuration: original)[0]
        let start = canvas.viewPoint(for: physical)
        let end = NSPoint(x: start.x + 2, y: start.y - 1)
        canvas.mouseDown(with: try mouseEvent(.leftMouseDown, at: start, in: canvas))
        canvas.mouseDragged(with: try mouseEvent(.leftMouseDragged, at: end, in: canvas))
        canvas.mouseUp(with: try mouseEvent(.leftMouseUp, at: end, in: canvas))
        XCTAssertNotNil(submitted)
        XCTAssertNotEqual(submitted, original.bezierWarp)
        XCTAssertEqual(editor.draftConfiguration.bezierWarp, submitted)
        XCTAssertFalse(canvas.editable)
    }

    func testTextDraftSurvivesNavigationAndAppliedConfigurationRefresh() throws {
        _ = NSApplication.shared
        let original = configuration()
        let editor = BezierWarpEditorController(configuration: original, available: true, embedded: true)
        let fields = descendants(editor.embeddedInspector).compactMap { $0 as? NSTextField }
        let columns = try XCTUnwrap(fields.first { $0.accessibilityIdentifier() == "nio-bezier-columns" })
        let radius = try XCTUnwrap(fields.first { $0.accessibilityIdentifier() == "nio-bezier-radius-x" })
        var commits = 0
        editor.onChange = { _, _ in commits += 1 }
        columns.stringValue = "7"
        radius.stringValue = "-"
        for field in [columns, radius] {
            editor.controlTextDidChange(Notification(name: NSControl.textDidChangeNotification, object: field))
            XCTAssertFalse(field.cell?.sendsActionOnEndEditing ?? true)
        }
        editor.deactivateInteraction()
        var changed = original
        changed.manual.strength = 0.5
        editor.synchronize(configuration: changed, available: true)
        XCTAssertEqual(columns.stringValue, "7")
        XCTAssertEqual(radius.stringValue, "-")
        XCTAssertEqual(editor.draftConfiguration.bezierWarp, original.bezierWarp)
        XCTAssertEqual(commits, 0)
        let apply = try XCTUnwrap(descendants(editor.embeddedInspector).compactMap { $0 as? NSButton }.first { $0.accessibilityIdentifier() == "nio-bezier-resize" })
        apply.performClick(nil)
        XCTAssertEqual(editor.draftConfiguration.bezierWarp.columns, 7)
        XCTAssertEqual(radius.stringValue, "-", "应用点数不能清除其他未提交输入")
        XCTAssertEqual(commits, 1)
    }

    func testViewportRoundTripsBetweenDifferentPreviewSizesWithoutZoomDrift() throws {
        _ = NSApplication.shared
        let original = configuration()
        let bezier = BezierWarpEditorController(configuration: original, available: true, embedded: true)
        let local = localEditor(original)
        bezier.canvasView.frame = NSRect(x: 0, y: 0, width: 760, height: 510)
        local.canvasView.frame = NSRect(x: 0, y: 0, width: 700, height: 320)
        bezier.canvasView.changeZoom(by: 2)
        let initial = try XCTUnwrap(bezier.viewport)
        for _ in 0..<20 { local.viewport = bezier.viewport; bezier.viewport = local.viewport }
        let final = try XCTUnwrap(bezier.viewport)
        XCTAssertEqual(final.physicalBounds.midX, initial.physicalBounds.midX, accuracy: 1e-7)
        XCTAssertEqual(final.physicalBounds.midY, initial.physicalBounds.midY, accuracy: 1e-7)
        XCTAssertEqual(final.physicalBounds.width, initial.physicalBounds.width, accuracy: 1e-7)
        XCTAssertEqual(final.physicalBounds.height, initial.physicalBounds.height, accuracy: 1e-7)
        XCTAssertEqual(try XCTUnwrap(final.pointsPerPhysicalPixel), try XCTUnwrap(initial.pointsPerPhysicalPixel), accuracy: 1e-10)
    }
}
