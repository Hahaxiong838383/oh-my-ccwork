import AppKit
import simd
import XCTest
@testable import NIOWarpApp

final class VerticalAspectEditorTests: XCTestCase {
    private func configuration(scale: Double, manualEnabled: Bool, leveled: Bool) -> WarpConfiguration {
        var value = WarpConfiguration.defaultConfiguration(displayWidth: 5120, displayHeight: 2880)
        value.manual = ManualWarpParameters(enabled: manualEnabled, strength: 1, arch: 0.1, verticalScale: 1, asymmetry: 0, tilt: 0.08, horizontalBend: 0, verticalAspectScale: scale)
        value.enableCanvasGrowth()
        value = value.preparedForLocalEditing()
        value.localWarp.enabled = true
        value.alignment.level = leveled
        value.bezierWarp.scope = .region
        value.bezierWarp.horizontalRadius = 0.05
        value.bezierWarp.verticalRadius = 0.05
        return value
    }

    private func eachConfiguration(_ body: (WarpConfiguration) throws -> Void) rethrows {
        for scale in [0.12, 1.0, 5.5] {
            for manualEnabled in [false, true] {
                for leveled in [false, true] {
                    try autoreleasepool { try body(configuration(scale: scale, manualEnabled: manualEnabled, leveled: leveled)) }
                }
            }
        }
    }

    private func mesh(_ configuration: WarpConfiguration) -> GeneratedMesh {
        WarpMath.makeMesh(configuration: configuration, columns: 192, rows: 72)
    }

    private func physical(_ configuration: WarpConfiguration, coordinate: SIMD2<Double>) -> SIMD2<Float> {
        WarpMath.physicalPoints(canvasPoints: [configuration.canvasUV(for: coordinate)], configuration: configuration)[0]
    }

    private func nodePhysical(_ configuration: WarpConfiguration, index: Int) -> SIMD2<Float> {
        let uv = configuration.bezierWarp.coordinate(at: index)
        return WarpMath.physicalPoints(canvasPoints: [SIMD2(Float(uv.x), Float(uv.y))], configuration: configuration)[0]
    }

    private func event(_ type: NSEvent.EventType, at point: NSPoint, canvas: BezierWarpCanvasView) throws -> NSEvent {
        try XCTUnwrap(NSEvent.mouseEvent(with: type, location: canvas.convert(point, to: nil), modifierFlags: [], timestamp: 1, windowNumber: canvas.window?.windowNumber ?? 0, context: nil, eventNumber: 1, clickCount: 1, pressure: 1))
    }

    func testLocalExistingAnchorNudgesInPhysicalPixelsAtEveryAspectScale() throws {
        _ = NSApplication.shared
        try eachConfiguration { initial in
            var original = initial
            original.alignment.centerHorizontal = true
            original.alignment.centerVertical = true
            let coordinate = SIMD2<Double>(-300, 70)
            original.localWarp.setOffset(SIMD2(5, -2), at: coordinate)
            let originalMesh = mesh(original)
            XCTAssertTrue(originalMesh.validation.isValid, originalMesh.validation.summary)
            let editor = LocalWarpEditorController(configuration: original, renderedConfiguration: original, mesh: originalMesh, available: true, screen: nil, embedded: true)
            editor.select(coordinate)
            let before = physical(original, coordinate: coordinate)
            editor.nudge(dx: 1, dy: -1)
            let result = editor.draftConfiguration
            let delta = physical(result, coordinate: coordinate) - before
            XCTAssertEqual(delta.x, 1, accuracy: 0.005)
            XCTAssertEqual(delta.y, -1, accuracy: 0.005)
            XCTAssertEqual(result.manual, original.manual)
            XCTAssertTrue(mesh(result).validation.isValid)
        }
    }

    func testFirstLocalAnchorRetainsRenderedPointWithoutScalingExistingOffsetTwice() throws {
        _ = NSApplication.shared
        try eachConfiguration { initial in
            var original = initial
            original.localWarp.setOffset(SIMD2(12, 8), at: SIMD2(-400, 0))
            let coordinate = SIMD2<Double>(-250, 50)
            XCTAssertNil(original.localWarp.anchor(at: coordinate))
            XCTAssertGreaterThan(simd_length(LocalWarpField(original.localWarp).displacement(at: coordinate)), 1)
            let originalMesh = mesh(original)
            let editor = LocalWarpEditorController(configuration: original, renderedConfiguration: original, mesh: originalMesh, available: true, screen: nil, embedded: true)
            editor.select(coordinate)
            let before = try XCTUnwrap(editor.canvasView.physicalPoint(for: coordinate))
            editor.nudge(dx: 0, dy: 0)
            let anchored = editor.draftConfiguration
            let anchoredMesh = mesh(anchored)
            XCTAssertTrue(anchoredMesh.validation.isValid, anchoredMesh.validation.summary)
            let anchoredPoint = try XCTUnwrap(anchoredMesh.renderedPhysicalPoint(at: anchored.canvasUV(for: coordinate), width: 5120, height: 2880))
            XCTAssertEqual(anchoredPoint.x, before.x, accuracy: 0.005)
            XCTAssertEqual(anchoredPoint.y, before.y, accuracy: 0.005)
            editor.synchronize(configuration: anchored, renderedConfiguration: anchored, mesh: anchoredMesh, available: true)
            editor.nudge(dx: 0, dy: 1)
            let delta = physical(editor.draftConfiguration, coordinate: coordinate) - anchoredPoint
            XCTAssertEqual(delta.x, 0, accuracy: 0.005)
            XCTAssertEqual(delta.y, 1, accuracy: 0.005)
        }
    }

    func testBezierNudgeUsesPhysicalPixelsWithScalingAndLeveling() throws {
        _ = NSApplication.shared
        try eachConfiguration { initial in
            var original = initial
            original.bezierWarp.enabled = true
            let editor = BezierWarpEditorController(configuration: original, available: true, embedded: true)
            editor.selectNode(6)
            let before = nodePhysical(original, index: 6)
            editor.nudge(dx: 1, dy: -1)
            let result = editor.draftConfiguration
            let delta = nodePhysical(result, index: 6) - before
            XCTAssertEqual(delta.x, 1, accuracy: 0.005)
            XCTAssertEqual(delta.y, -1, accuracy: 0.005)
            XCTAssertEqual(result.manual, original.manual)
            XCTAssertTrue(mesh(result).validation.isValid)
        }
    }

    func testBezierOffsetFieldsReadAndWriteVisiblePhysicalPixels() throws {
        _ = NSApplication.shared
        func descendants(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(descendants) }
        try eachConfiguration { initial in
            var original = initial
            original.bezierWarp.enabled = true
            let editor = BezierWarpEditorController(configuration: original, available: true, embedded: true)
            editor.selectNode(6)
            let controls = descendants(editor.embeddedInspector)
            let x = try XCTUnwrap(controls.compactMap { $0 as? NSTextField }.first { $0.accessibilityIdentifier() == "nio-bezier-offset-x" })
            let y = try XCTUnwrap(controls.compactMap { $0 as? NSTextField }.first { $0.accessibilityIdentifier() == "nio-bezier-offset-y" })
            let button = try XCTUnwrap(controls.compactMap { $0 as? NSButton }.first { $0.accessibilityIdentifier() == "nio-bezier-set-offset" })
            let before = nodePhysical(original, index: 6)
            x.stringValue = "1"
            y.stringValue = "2"
            button.performClick(nil)
            let after = nodePhysical(editor.draftConfiguration, index: 6)
            XCTAssertEqual(after.x - before.x, 1, accuracy: 0.005)
            XCTAssertEqual(after.y - before.y, 2, accuracy: 0.005)
            XCTAssertEqual(try XCTUnwrap(NumericInput.double(from: x.stringValue)), 1, accuracy: 0.0001)
            XCTAssertEqual(try XCTUnwrap(NumericInput.double(from: y.stringValue)), 2, accuracy: 0.0001)
            editor.nudge(dx: 1, dy: 0)
            XCTAssertEqual(try XCTUnwrap(NumericInput.double(from: x.stringValue)), 2, accuracy: 0.0001)
            XCTAssertEqual(try XCTUnwrap(NumericInput.double(from: y.stringValue)), 2, accuracy: 0.0001)
        }
    }

    func testBezierMouseDragsKeepNodesAndHandlesUnderPointerAtEveryAspectScale() throws {
        _ = NSApplication.shared
        try eachConfiguration { initial in
            var original = initial
            original.bezierWarp.enabled = true
            let canvas = BezierWarpCanvasView(frame: NSRect(x: 0, y: 0, width: 800, height: 500))
            canvas.update(configuration: original)
            canvas.viewport = WarpEditorViewport(physicalBounds: NSRect(x: 0, y: 0, width: 5120, height: 2880), pointsPerPhysicalPixel: 0.5)
            let before = nodePhysical(original, index: 6)
            let start = canvas.viewPoint(for: before)
            canvas.mouseDown(with: try event(.leftMouseDown, at: start, canvas: canvas))
            XCTAssertEqual(canvas.selectedIndex, 6)
            let end = NSPoint(x: start.x + 1, y: start.y - 1)
            canvas.mouseDragged(with: try event(.leftMouseDragged, at: end, canvas: canvas))
            let moved = try XCTUnwrap(canvas.configuration)
            let delta = nodePhysical(moved, index: 6) - before
            XCTAssertEqual(delta.x, 2, accuracy: 0.005)
            XCTAssertEqual(delta.y, -2, accuracy: 0.005)
            canvas.mouseUp(with: try event(.leftMouseUp, at: end, canvas: canvas))

            let handle = try XCTUnwrap(canvas.handles(at: 6).first { $0.horizontal && $0.sign > 0 })
            let handleStart = canvas.viewPoint(for: handle.point)
            canvas.mouseDown(with: try event(.leftMouseDown, at: handleStart, canvas: canvas))
            let handleEnd = NSPoint(x: handleStart.x, y: handleStart.y + 1)
            canvas.mouseDragged(with: try event(.leftMouseDragged, at: handleEnd, canvas: canvas))
            let changed = try XCTUnwrap(canvas.handles(at: 6).first { $0.horizontal && $0.sign > 0 })
            XCTAssertEqual(changed.point.x - handle.point.x, 0, accuracy: 0.02)
            XCTAssertEqual(changed.point.y - handle.point.y, 2, accuracy: 0.02)
            XCTAssertEqual(try XCTUnwrap(canvas.configuration).bezierWarp.nodes[6].offset, moved.bezierWarp.nodes[6].offset)
            canvas.mouseUp(with: try event(.leftMouseUp, at: handleEnd, canvas: canvas))
        }
    }

    func testBezierHandleTangentsMatchScaledSurfaceDerivative() throws {
        _ = NSApplication.shared
        try eachConfiguration { initial in
            var original = initial
            original.bezierWarp.enabled = true
            XCTAssertTrue(original.bezierWarp.applyTangentDelta(SIMD2(15, -25), axis: .horizontal, at: 6))
            XCTAssertTrue(original.bezierWarp.applyTangentDelta(SIMD2(-10, 30), axis: .vertical, at: 6))
            let canvas = BezierWarpCanvasView(frame: NSRect(x: 0, y: 0, width: 800, height: 500))
            canvas.update(configuration: original)
            let uv = original.bezierWarp.coordinate(at: 6)
            for horizontal in [true, false] {
                let handle = try XCTUnwrap(canvas.handles(at: 6).first { $0.horizontal == horizontal && $0.sign > 0 })
                let epsilon = SIMD2<Float>(horizontal ? 0.0005 : 0, horizontal ? 0 : 0.0005)
                let center = SIMD2(Float(uv.x), Float(uv.y))
                let points = WarpMath.physicalPoints(canvasPoints: [center, center - epsilon, center + epsilon], configuration: original)
                let expected = points[0] + (points[2] - points[1]) / 0.001 * Float(handle.interval / 3)
                XCTAssertEqual(handle.point.x, expected.x, accuracy: 0.15)
                XCTAssertEqual(handle.point.y, expected.y, accuracy: 0.15)
            }
        }
    }
}
