import AppKit
import XCTest
@testable import NIOWarpApp

private final class PointerCursorRectWindow: NSWindow {
    private(set) var invalidatedViews = [ObjectIdentifier]()

    override func invalidateCursorRects(for view: NSView) {
        invalidatedViews.append(ObjectIdentifier(view))
        super.invalidateCursorRects(for: view)
    }
}

final class IndependentPointerPresentationTests: XCTestCase {
    @MainActor private func cursorFixture() throws -> NSCursor {
        let bitmap = try XCTUnwrap(NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 12, pixelsHigh: 10,
            bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
            colorSpaceName: .deviceRGB, bytesPerRow: 48, bitsPerPixel: 32))
        let bytes = try XCTUnwrap(bitmap.bitmapData)
        for y in 0..<10 {
            for x in 0..<12 {
                let offset = y * bitmap.bytesPerRow + x * 4
                bytes[offset] = UInt8(x * 16)
                bytes[offset + 1] = UInt8(y * 20)
                bytes[offset + 2] = 90
                bytes[offset + 3] = 255
            }
        }
        let image = NSImage(size: NSSize(width: 12, height: 10))
        image.addRepresentation(bitmap)
        return NSCursor(image: image, hotSpot: NSPoint(x: 3, y: 4))
    }

    @MainActor private func mouseEvent(_ type: NSEvent.EventType, window: NSWindow) throws -> NSEvent {
        try XCTUnwrap(NSEvent.mouseEvent(with: type, location: NSPoint(x: 20, y: 20),
            modifierFlags: [], timestamp: 1, windowNumber: window.windowNumber,
            context: nil, eventNumber: 1, clickCount: 1, pressure: type == .leftMouseDown ? 1 : 0))
    }

    func testOutputSurfaceAcceptsFirstClickOnlyWhileArmedAndDoesNotPaintAPointer() throws {
        try MainActor.assumeIsolated {
            _ = NSApplication.shared
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 240, height: 120),
                styleMask: [.borderless], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            defer { window.close() }
            let surface = MouseCursorOverlay(frame: NSRect(x: 0, y: 0, width: 240, height: 120))
            window.contentView = surface
            var activations = 0
            surface.onActivate = { activations += 1 }
            let down = try mouseEvent(.leftMouseDown, window: window)
            let up = try mouseEvent(.leftMouseUp, window: window)
            XCTAssertFalse(surface.acceptsFirstResponder)
            XCTAssertFalse(surface.acceptsFirstMouse(for: down))
            XCTAssertNil(surface.hitTest(NSPoint(x: 20, y: 20)))
            surface.mouseDown(with: down)
            XCTAssertEqual(activations, 0)

            surface.receivesInput = true
            XCTAssertTrue(surface.acceptsFirstResponder)
            XCTAssertTrue(surface.acceptsFirstMouse(for: down), "未激活输出窗口的首次点击必须能唤醒输入")
            XCTAssertTrue(surface.hitTest(NSPoint(x: 20, y: 20)) === surface)
            XCTAssertNil(surface.hitTest(NSPoint(x: 241, y: 20)))
            surface.mouseDown(with: down)
            surface.mouseUp(with: up)
            XCTAssertEqual(activations, 1, "首次按下只激活一次，抬起不能重新启动输入")
            XCTAssertNil(surface.physicalPoint, "使用系统光标时不能激活旧的圆圈十字绘制")
            surface.onActivate = nil
            surface.mouseDown(with: down)
            XCTAssertEqual(activations, 1, "启动中的输出层仍接收首击余下事件，但不能重复启动")
            surface.receivesInput = false
            XCTAssertFalse(surface.acceptsFirstMouse(for: down))
            XCTAssertNil(surface.hitTest(NSPoint(x: 20, y: 20)))
        }
    }

    func testOriginalCursorImageAndHotspotSurviveAssignmentAndCursorRectRefresh() throws {
        try MainActor.assumeIsolated {
            _ = NSApplication.shared
            let window = PointerCursorRectWindow(contentRect: NSRect(x: 0, y: 0, width: 240, height: 120),
                styleMask: [.borderless], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            defer { window.close() }
            let surface = MouseCursorOverlay(frame: NSRect(x: 0, y: 0, width: 240, height: 120))
            window.contentView = surface
            surface.receivesInput = true
            let original = try cursorFixture()
            let imageData = try XCTUnwrap(original.image.tiffRepresentation)
            let previousInvalidations = window.invalidatedViews.count
            surface.sourceCursor = original
            XCTAssertTrue(surface.sourceCursor === original, "必须保留页面光标资产，不能重新生成相似图形")
            XCTAssertEqual(surface.sourceCursor?.hotSpot, NSPoint(x: 3, y: 4))
            XCTAssertEqual(surface.sourceCursor?.image.size, NSSize(width: 12, height: 10))
            XCTAssertEqual(surface.sourceCursor?.image.tiffRepresentation, imageData)
            XCTAssertGreaterThan(window.invalidatedViews.count, previousInvalidations)
            XCTAssertEqual(window.invalidatedViews.last, ObjectIdentifier(surface))
            surface.resetCursorRects()
            XCTAssertTrue(surface.sourceCursor === original)

            let bitmap = try XCTUnwrap(NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 240, pixelsHigh: 120,
                bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                colorSpaceName: .deviceRGB, bytesPerRow: 960, bitsPerPixel: 32))
            let bytes = try XCTUnwrap(bitmap.bitmapData)
            let count = bitmap.bytesPerRow * bitmap.pixelsHigh
            bytes.initialize(repeating: 0, count: count)
            let context = try XCTUnwrap(NSGraphicsContext(bitmapImageRep: bitmap))
            NSGraphicsContext.saveGraphicsState()
            NSGraphicsContext.current = context
            surface.draw(surface.bounds)
            NSGraphicsContext.restoreGraphicsState()
            XCTAssertTrue(UnsafeBufferPointer(start: bytes, count: count).allSatisfy { $0 == 0 },
                "CSS 资产只交给系统光标，输出层必须保持透明，不能出现第二个圆圈")

            let beforeClear = window.invalidatedViews.count
            surface.sourceCursor = nil
            surface.receivesInput = false
            surface.resetCursorRects()
            XCTAssertNil(surface.sourceCursor)
            XCTAssertGreaterThan(window.invalidatedViews.count, beforeClear)
            XCTAssertNil(surface.physicalPoint)
        }
    }

    func testAppKitInstallsTheSameSystemCursorAssetAndRestoresPreviousCursor() throws {
        try MainActor.assumeIsolated {
            _ = NSApplication.shared
            let previous = NSCursor.current
            defer { previous.set() }
            let original = try cursorFixture()
            let imageData = try XCTUnwrap(original.image.tiffRepresentation)
            original.set()
            XCTAssertEqual(NSCursor.current.hotSpot, original.hotSpot)
            XCTAssertEqual(NSCursor.current.image.size, original.image.size)
            XCTAssertEqual(NSCursor.current.image.tiffRepresentation, imageData)
            NSCursor.arrow.set()
            XCTAssertEqual(NSCursor.current.hotSpot, NSCursor.arrow.hotSpot)
        }
    }

    func testOutputWindowCanBecomeKeyOnlyForMappedInputAndNeverBecomesMain() {
        MainActor.assumeIsolated {
            _ = NSApplication.shared
            let window = OutputWindow(contentRect: NSRect(x: 0, y: 0, width: 240, height: 120),
                styleMask: [.borderless], backing: .buffered, defer: false)
            defer { window.close() }
            XCTAssertFalse(window.canBecomeKey)
            XCTAssertFalse(window.canBecomeMain)
            window.acceptsMappedInput = true
            XCTAssertTrue(window.canBecomeKey)
            XCTAssertFalse(window.canBecomeMain, "输出接管输入时仍不能替代内屏工作台的主窗口身份")
            window.acceptsMappedInput = false
            XCTAssertFalse(window.canBecomeKey)
            XCTAssertFalse(window.canBecomeMain)
        }
    }
}
