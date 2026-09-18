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
}
