import AppKit
import XCTest
@testable import NIOWarpApp

final class NativeMouseScopeTests: XCTestCase {
    private let outputBounds = CGRect(x: -7680, y: -936, width: 7680, height: 936)

    private func window(owner: String = "Window Server", layer: Int = Int(CGWindowLevelForKey(.cursorWindow)),
                        sharing: Int = 0) -> [String: Any] {
        [kCGWindowOwnerName as String: owner,
         kCGWindowLayer as String: NSNumber(value: layer),
         kCGWindowSharingState as String: NSNumber(value: sharing)]
    }

    func testNonshareableWindowServerCursorIsNotAnOccluder() {
        XCTAssertTrue(NativeMouseInputCapture.isSystemCursorWindow(window()))
    }

    func testChromeAndMenusRemainOccluders() {
        XCTAssertFalse(NativeMouseInputCapture.isSystemCursorWindow(window(owner: "Google Chrome", layer: 0)))
        XCTAssertFalse(NativeMouseInputCapture.isSystemCursorWindow(window(layer: 24)))
    }

    func testShareableStatusIndicatorAtCursorLevelRemainsAnOccluder() {
        XCTAssertFalse(NativeMouseInputCapture.isSystemCursorWindow(window(sharing: 1)))
        XCTAssertFalse(NativeMouseInputCapture.isSystemCursorWindow(window(sharing: 2)))
    }

    func testOtherOwnersAtCursorLevelAreNotMistakenForSystemCursor() {
        for owner in ["Google Chrome", "NIOWarpApp", "Dock", "StatusIndicator", ""] {
            XCTAssertFalse(NativeMouseInputCapture.isSystemCursorWindow(window(owner: owner)), owner)
        }
    }

    func testIncompleteOrMalformedMetadataDoesNotHideAnOccluder() {
        for key in [kCGWindowOwnerName, kCGWindowLayer, kCGWindowSharingState] {
            var incomplete = window()
            incomplete.removeValue(forKey: key as String)
            XCTAssertFalse(NativeMouseInputCapture.isSystemCursorWindow(incomplete))
            var malformed = window()
            malformed[key as String] = ["unexpected": "value"]
            XCTAssertFalse(NativeMouseInputCapture.isSystemCursorWindow(malformed))
        }
    }

    private func surfaceWindow(_ id: CGWindowID, owner: String = "NIOWarpApp", alpha: Double = 1,
                               bounds: CGRect? = nil) -> [String: Any] {
        [kCGWindowNumber as String: NSNumber(value: id),
         kCGWindowOwnerName as String: owner,
         kCGWindowLayer as String: NSNumber(value: 0),
         kCGWindowSharingState as String: NSNumber(value: 1),
         kCGWindowAlpha as String: NSNumber(value: alpha),
         kCGWindowBounds as String: (bounds ?? outputBounds).dictionaryRepresentation]
    }

    private func owns(_ windows: [(CGWindowID, CGRect)], target: CGWindowID,
                      point: CGPoint = CGPoint(x: -3840, y: -468), frontPID: pid_t? = 42,
                      active: Bool = true, outputOwned: Bool = true, outputWindowIsKey: Bool = true) -> Bool {
        NativeMouseInputCapture.surfaceIsOwned(isActive: active, point: point, displayBounds: outputBounds,
            frontProcessID: frontPID, processID: 42, targetWindow: target, windows: windows,
            outputOwned: outputOwned, outputWindowIsKey: outputWindowIsKey)
    }

    func testLegacyOverlayPassesThroughToChromeButOutputModeOwnsTheTopWindow() {
        let entries = [surfaceWindow(101), surfaceWindow(202, owner: "Google Chrome")]
        let legacy = NativeMouseInputCapture.scopeWindows(entries, outputWindow: 101, outputOwned: false)
        XCTAssertEqual(legacy.map { $0.0 }, [202])
        XCTAssertTrue(owns(legacy, target: 202, outputOwned: false, outputWindowIsKey: false))
        let output = NativeMouseInputCapture.scopeWindows(entries, outputWindow: 101, outputOwned: true)
        XCTAssertEqual(output.map { $0.0 }, [101, 202])
        XCTAssertTrue(owns(output, target: 101))
        XCTAssertFalse(owns(output, target: 202))
    }

    func testOutputScopeCannotOwnAnotherApplicationOrOrdinaryInternalScreen() {
        let windows = NativeMouseInputCapture.scopeWindows([surfaceWindow(101)], outputWindow: 101, outputOwned: true)
        XCTAssertFalse(owns(windows, target: 101, frontPID: 43))
        XCTAssertFalse(owns(windows, target: 101, frontPID: nil))
        XCTAssertFalse(owns(windows, target: 101, point: CGPoint(x: 200, y: 200)))
        XCTAssertFalse(owns(windows, target: 101, active: false))
    }

    func testOutputScopeDoesNotReachThroughAnOverlappingWindow() {
        let entries = [surfaceWindow(303, owner: "Other App"), surfaceWindow(101)]
        let windows = NativeMouseInputCapture.scopeWindows(entries, outputWindow: 101, outputOwned: true)
        XCTAssertEqual(windows.map { $0.0 }, [303, 101])
        XCTAssertFalse(owns(windows, target: 101))
    }

    func testInternalWorkbenchKeyboardFocusCannotKeepAStaleOutputPlacementEngaged() {
        let windows = NativeMouseInputCapture.scopeWindows([surfaceWindow(101)], outputWindow: 101, outputOwned: true)
        // Same frontmost NIO process and remembered output point, but its internal
        // workbench now owns keyboard focus: do not consume its clicks or keys.
        XCTAssertFalse(owns(windows, target: 101, outputWindowIsKey: false))
        XCTAssertTrue(owns(windows, target: 101, outputWindowIsKey: true))
    }

    func testFirstDesktopClickOrWheelEscapesBeforeTheKeyWindowChanges() {
        let outputPoint = CGPoint(x: -3840, y: -468)
        let desktopPoint = CGPoint(x: 200, y: 200)
        let windows = NativeMouseInputCapture.scopeWindows([surfaceWindow(101)], outputWindow: 101, outputOwned: true)
        let point = NativeMouseInputCapture.scopePoint(eventLocation: desktopPoint, placement: outputPoint,
            engaged: true, outputOwned: true, movement: false)
        XCTAssertEqual(point, desktopPoint)
        XCTAssertFalse(owns(windows, target: 101, point: point, outputWindowIsKey: true))
    }

    func testMirroredMovementStillUsesCorrectedPlacementWithoutChangingLegacyClicks() {
        let corrected = CGPoint(x: -1, y: -468)
        let rawPastEdge = CGPoint(x: 2, y: -468)
        XCTAssertEqual(NativeMouseInputCapture.scopePoint(eventLocation: rawPastEdge, placement: corrected,
            engaged: true, outputOwned: true, movement: true), corrected)
        XCTAssertEqual(NativeMouseInputCapture.scopePoint(eventLocation: rawPastEdge, placement: corrected,
            engaged: true, outputOwned: false, movement: false), corrected)
        XCTAssertEqual(NativeMouseInputCapture.scopePoint(eventLocation: rawPastEdge, placement: corrected,
            engaged: false, outputOwned: true, movement: true), rawPastEdge)
    }

    func testSystemCursorAndInvisibleWindowsDoNotMaskTheOutputTarget() {
        var cursor = window()
        cursor[kCGWindowNumber as String] = NSNumber(value: 404)
        cursor[kCGWindowBounds as String] = outputBounds.dictionaryRepresentation
        let entries = [cursor, surfaceWindow(303, alpha: 0), surfaceWindow(101)]
        let windows = NativeMouseInputCapture.scopeWindows(entries, outputWindow: 101, outputOwned: true)
        XCTAssertEqual(windows.map { $0.0 }, [101])
        XCTAssertTrue(owns(windows, target: 101))
    }

    func testOutputEscapeBelongsOnlyToTheCurrentlyOwnedSurface() {
        let windows = NativeMouseInputCapture.scopeWindows([surfaceWindow(101)], outputWindow: 101, outputOwned: true)
        XCTAssertTrue(NativeMouseInputCapture.shouldConsumeEscape(outputOwned: true,
            surfaceOwned: owns(windows, target: 101), outputWindowIsKey: true))
        XCTAssertFalse(NativeMouseInputCapture.shouldConsumeEscape(outputOwned: true,
            surfaceOwned: owns(windows, target: 101, point: CGPoint(x: 100, y: 100)), outputWindowIsKey: true))
        XCTAssertFalse(NativeMouseInputCapture.shouldConsumeEscape(outputOwned: true,
            surfaceOwned: owns(windows, target: 101, frontPID: 43), outputWindowIsKey: true))
        XCTAssertFalse(NativeMouseInputCapture.shouldConsumeEscape(outputOwned: true,
            surfaceOwned: owns(windows, target: 101), outputWindowIsKey: false))
        XCTAssertTrue(NativeMouseInputCapture.shouldConsumeEscape(outputOwned: false, surfaceOwned: false,
            outputWindowIsKey: false))
    }

    func testRetinaAABottomEdgeStaysInsideAfterWindowServerQuantization() throws {
        // Physical AA [0.5,0.5 ... 3839.5,799.5] on the live display
        // Quartz rect (-221,-1200,1920,1200), at two pixels per point.
        let bounds = CGRect(x: -220.75, y: -1199.75, width: 1919.5, height: 399.5)
        let requested = CGPoint(x: 800.375, y: -800.24997)
        let confined = try XCTUnwrap(NativeMouseInputCapture.confinedCursorPoint(requested, within: bounds))
        XCTAssertEqual(confined, CGPoint(x: 800.375, y: -801))
        for quantizedY in [confined.y.rounded(.down), confined.y.rounded(.up), confined.y.rounded(.towardZero), confined.y.rounded()] {
            let physicalY = (quantizedY + 1200) * 2
            XCTAssertGreaterThanOrEqual(physicalY, 0.5)
            XCTAssertLessThanOrEqual(physicalY, 799.5)
        }
    }

    func testConfinementHandlesAllCornersAcrossPositiveAndNegativeOrigins() throws {
        for origin in [CGPoint(x: 100.25, y: 200.25), CGPoint(x: -100.75, y: -200.75), CGPoint(x: -100.75, y: 200.25)] {
            let bounds = CGRect(origin: origin, size: CGSize(width: 30.5, height: 20.5))
            for x in [bounds.minX, bounds.maxX] {
                for y in [bounds.minY, bounds.maxY] {
                    let point = try XCTUnwrap(NativeMouseInputCapture.confinedCursorPoint(CGPoint(x: x, y: y), within: bounds))
                    XCTAssertEqual(point.x, x == bounds.minX ? bounds.minX.rounded(.up) : bounds.maxX.rounded(.down))
                    XCTAssertEqual(point.y, y == bounds.minY ? bounds.minY.rounded(.up) : bounds.maxY.rounded(.down))
                    XCTAssertLessThan(abs(point.x - x), 1)
                    XCTAssertLessThan(abs(point.y - y), 1)
                }
            }
        }
    }

    func testConfinementPreservesInteriorFractionsAndIntegralEdges() throws {
        let bounds = CGRect(x: -200, y: -100, width: 500, height: 300)
        for point in [CGPoint(x: -199.875, y: -99.625), CGPoint(x: -0.75, y: 0.125),
                      CGPoint(x: 299.875, y: 199.625), CGPoint(x: -200, y: -100), CGPoint(x: 300, y: 200)] {
            XCTAssertEqual(try XCTUnwrap(NativeMouseInputCapture.confinedCursorPoint(point, within: bounds)), point)
        }
    }

    func testFarOutsideCandidatesClampWithoutCreatingAnOutsideHotspot() throws {
        let bounds = CGRect(x: -2.75, y: 10.25, width: 6.5, height: 5.5)
        XCTAssertEqual(try XCTUnwrap(NativeMouseInputCapture.confinedCursorPoint(CGPoint(x: -1_000_000, y: 1_000_000), within: bounds)),
                       CGPoint(x: -2, y: 15))
        XCTAssertEqual(try XCTUnwrap(NativeMouseInputCapture.confinedCursorPoint(CGPoint(x: 1_000_000, y: -1_000_000), within: bounds)),
                       CGPoint(x: 3, y: 11))
    }

    func testSubPointBoundsRequireAnIntegerDestinationOnBothAxes() throws {
        XCTAssertNil(NativeMouseInputCapture.confinedCursorPoint(.zero, within: CGRect(x: 0.1, y: 0, width: 0.8, height: 10)))
        XCTAssertNil(NativeMouseInputCapture.confinedCursorPoint(.zero, within: CGRect(x: 0, y: -0.9, width: 10, height: 0.8)))
        XCTAssertEqual(try XCTUnwrap(NativeMouseInputCapture.confinedCursorPoint(CGPoint(x: 0.9, y: -1.1),
            within: CGRect(x: 0.75, y: -1.25, width: 0.5, height: 0.5))), CGPoint(x: 1, y: -1))
        // Inclusive limits can describe exactly one physical pixel centre.
        XCTAssertEqual(try XCTUnwrap(NativeMouseInputCapture.confinedCursorPoint(.zero,
            within: CGRect(x: 2, y: -3, width: 0, height: 0))), CGPoint(x: 2, y: -3))
    }

    func testConfinementRejectsNonfiniteAndMalformedBounds() {
        let bounds = CGRect(x: 0, y: 0, width: 10, height: 10)
        XCTAssertNil(NativeMouseInputCapture.confinedCursorPoint(CGPoint(x: CGFloat.nan, y: 1), within: bounds))
        XCTAssertNil(NativeMouseInputCapture.confinedCursorPoint(CGPoint(x: 1, y: CGFloat.infinity), within: bounds))
        for invalid in [CGRect.null, CGRect.infinite, CGRect(x: CGFloat.nan, y: 0, width: 10, height: 10),
                        CGRect(x: 0, y: 0, width: -1, height: 10), CGRect(x: 0, y: 0, width: 10, height: -1)] {
            XCTAssertNil(NativeMouseInputCapture.confinedCursorPoint(.zero, within: invalid))
        }
    }
}
