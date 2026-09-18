import AppKit
import XCTest
@testable import NIOWarpApp

final class NativeMouseScopeTests: XCTestCase {
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
}
