import AppKit
import XCTest
@testable import NIOWarpApp

final class NativeKeyboardOwnershipTests: XCTestCase {
    private func key(_ code: UInt16 = 0, down: Bool = true, text: String = "a", plain: String = "a",
                     modifiers: Int = 0, repeatKey: Bool = false) -> MouseKeyboardInput {
        MouseKeyboardInput(down: down, keyCode: code, text: text, unmodifiedText: plain,
            modifiers: modifiers, isAutoRepeat: repeatKey)
    }

    func testFocusedGestureForwardsDownRepeatAndMatchingUp() {
        var ownership = NativeKeyboardOwnership()
        let down = ownership.receive(key(), canCapture: true, isSystemShortcut: false)
        XCTAssertTrue(down.consumed)
        XCTAssertEqual(down.forwarded.count, 1)
        let repeated = ownership.receive(key(repeatKey: true), canCapture: true, isSystemShortcut: false)
        XCTAssertTrue(repeated.consumed)
        XCTAssertTrue(repeated.forwarded[0].isAutoRepeat)
        let up = ownership.receive(key(down: false, text: ""), canCapture: true, isSystemShortcut: false)
        XCTAssertTrue(up.consumed)
        XCTAssertEqual(up.forwarded[0].kind, .up)
        XCTAssertFalse(ownership.hasPendingReleases)
    }

    func testOrdinaryDesktopKeysAndOrphanRepeatsAreNeverCaptured() {
        var ownership = NativeKeyboardOwnership()
        XCTAssertFalse(ownership.receive(key(), canCapture: false, isSystemShortcut: false).consumed)
        XCTAssertFalse(ownership.receive(key(repeatKey: true), canCapture: true, isSystemShortcut: false).consumed)
        XCTAssertFalse(ownership.receive(key(down: false), canCapture: true, isSystemShortcut: false).consumed)
        XCTAssertFalse(ownership.hasPendingReleases)
    }

    func testFocusLossReleasesPageOnceAndDrainsPhysicalRepeatAndUp() {
        var ownership = NativeKeyboardOwnership()
        _ = ownership.receive(key(), canCapture: true, isSystemShortcut: false)
        let release = ownership.releaseAll()
        XCTAssertEqual(release.count, 1)
        XCTAssertEqual(release[0].kind, .up)
        XCTAssertEqual(ownership.releaseAll().count, 0)
        XCTAssertTrue(ownership.hasPendingReleases)
        let repeated = ownership.receive(key(repeatKey: true), canCapture: false, isSystemShortcut: false)
        XCTAssertTrue(repeated.consumed)
        XCTAssertTrue(repeated.forwarded.isEmpty)
        let up = ownership.receive(key(down: false), canCapture: false, isSystemShortcut: false)
        XCTAssertTrue(up.consumed)
        XCTAssertTrue(up.forwarded.isEmpty)
        XCTAssertFalse(ownership.hasPendingReleases)
    }

    func testScopeLossDuringRepeatReleasesWithoutLeakingTheGesture() {
        var ownership = NativeKeyboardOwnership()
        _ = ownership.receive(key(), canCapture: true, isSystemShortcut: false)
        let repeated = ownership.receive(key(repeatKey: true), canCapture: false, isSystemShortcut: false)
        XCTAssertTrue(repeated.consumed)
        XCTAssertEqual(repeated.forwarded.count, 1)
        XCTAssertEqual(repeated.forwarded[0].kind, .up)
        XCTAssertTrue(ownership.receive(key(down: false), canCapture: false, isSystemShortcut: false).consumed)
    }

    func testCommandAndControlShortcutsRemainSystemOwned() {
        for modifiers in [2, 4] {
            var ownership = NativeKeyboardOwnership()
            let shortcut = ownership.receive(key(modifiers: modifiers), canCapture: true, isSystemShortcut: true)
            XCTAssertFalse(shortcut.consumed)
            XCTAssertTrue(shortcut.forwarded.isEmpty)
            XCTAssertFalse(ownership.receive(key(down: false, modifiers: modifiers), canCapture: true,
                isSystemShortcut: true).consumed)
            XCTAssertFalse(ownership.hasPendingReleases)
        }
    }

    func testShortcutAfterCapturedDownReleasesPageAndOwnsItsNewSystemUp() {
        var ownership = NativeKeyboardOwnership()
        _ = ownership.receive(key(), canCapture: true, isSystemShortcut: false)
        let shortcut = ownership.receive(key(modifiers: 4), canCapture: true, isSystemShortcut: true)
        XCTAssertFalse(shortcut.consumed)
        XCTAssertEqual(shortcut.forwarded.count, 1)
        XCTAssertEqual(shortcut.forwarded[0].kind, .up)
        XCTAssertFalse(ownership.receive(key(down: false, modifiers: 4), canCapture: false,
            isSystemShortcut: true).consumed)
        XCTAssertFalse(ownership.hasPendingReleases)
    }

    func testReleasePreservesTheOriginalShiftedKeyIdentity() {
        for loseFocus in [false, true] {
            var ownership = NativeKeyboardOwnership()
            _ = ownership.receive(key(text: "A", plain: "a", modifiers: 8), canCapture: true, isSystemShortcut: false)
            let release = loseFocus ? ownership.releaseAll()
                : ownership.receive(key(down: false, text: "", plain: "a"), canCapture: true,
                    isSystemShortcut: false).forwarded
            XCTAssertEqual(release.count, 1)
            XCTAssertEqual(release[0].text, "A")
            XCTAssertEqual(release[0].unmodifiedText, "a")
            XCTAssertFalse(release[0].isAutoRepeat)
        }
    }

    func testUnsupportedKeysPassThroughWithoutTakingKeyboardOwnership() {
        for code: UInt16 in [53, 54, 55, 57, 59, 62, 63, 65535] {
            var ownership = NativeKeyboardOwnership()
            let input = key(code, text: "", plain: "")
            XCTAssertFalse(MouseKeyboardEvent.isSupported(input))
            let result = ownership.receive(input, canCapture: MouseKeyboardEvent.isSupported(input),
                isSystemShortcut: false)
            XCTAssertFalse(result.consumed)
            XCTAssertTrue(result.forwarded.isEmpty)
            XCTAssertFalse(ownership.hasPendingReleases)
        }
    }

    func testHeldPhysicalUpRemainsDeliverableWhenSystemModifierChanged() {
        var ownership = NativeKeyboardOwnership()
        _ = ownership.receive(key(), canCapture: true, isSystemShortcut: false)
        let up = ownership.receive(key(down: false, text: "", modifiers: 4), canCapture: false,
            isSystemShortcut: true)
        XCTAssertTrue(up.consumed)
        XCTAssertEqual(up.forwarded.count, 1)
        XCTAssertEqual(up.forwarded[0].modifiers, 0)
        XCTAssertTrue(MouseKeyboardEvent.isSupported(up.forwarded[0]))
    }

    func testModifierFlagsBecomePageShiftAndOptionGesturesOnly() throws {
        for (code, flag, modifier) in [(UInt16(56), CGEventFlags.maskShift, 8), (60, .maskShift, 8),
                                      (58, .maskAlternate, 1), (61, .maskAlternate, 1)] {
            let event = try XCTUnwrap(CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true))
            event.type = .flagsChanged
            event.flags = flag
            let down = try XCTUnwrap(NativeMouseInputCapture.keyboardInput(.flagsChanged, event))
            XCTAssertEqual(down.kind, .down)
            XCTAssertEqual(down.modifiers, modifier)
            XCTAssertTrue(MouseKeyboardEvent.isSupported(down))
            event.flags = []
            XCTAssertEqual(NativeMouseInputCapture.keyboardInput(.flagsChanged, event)?.kind, .up)
        }
        for code: UInt16 in [54, 55, 57, 59, 62, 63] {
            let event = try XCTUnwrap(CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true))
            event.type = .flagsChanged
            XCTAssertNil(NativeMouseInputCapture.keyboardInput(.flagsChanged, event))
        }
    }
}
