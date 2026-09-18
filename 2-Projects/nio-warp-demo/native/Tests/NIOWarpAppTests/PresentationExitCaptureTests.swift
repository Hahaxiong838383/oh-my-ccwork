import AppKit
import XCTest
@testable import NIOWarpApp

final class PresentationExitCaptureTests: XCTestCase {
    func testOrdinaryEscapeRequestsExitOnceAndDrainsRepeatAndReleaseAfterProviderTurnsFalse() {
        var capture = PresentationEscapeOwnership()
        XCTAssertEqual(capture.receive(type: .keyDown, keyCode: 53, flags: [], allowExit: true),
            .init(consumed: true, requestsExit: true))
        XCTAssertTrue(capture.ownsEscape)
        for _ in 0..<5 {
            XCTAssertEqual(capture.receive(type: .keyDown, keyCode: 53, flags: [], allowExit: false),
                .init(consumed: true, requestsExit: false))
        }
        XCTAssertEqual(capture.receive(type: .keyUp, keyCode: 53, flags: [], allowExit: false),
            .init(consumed: true, requestsExit: false))
        XCTAssertFalse(capture.ownsEscape)
        XCTAssertEqual(capture.receive(type: .keyUp, keyCode: 53, flags: [], allowExit: false),
            .init(consumed: false, requestsExit: false))
    }

    func testOrdinaryDesktopEscapePassesThroughInBothDirections() {
        var capture = PresentationEscapeOwnership()
        for type: CGEventType in [.keyDown, .keyDown, .keyUp] {
            XCTAssertEqual(capture.receive(type: type, keyCode: 53, flags: [], allowExit: false),
                .init(consumed: false, requestsExit: false))
        }
        XCTAssertFalse(capture.ownsEscape)
    }

    func testOtherKeysAndMouseInputAreNeverCapturedEvenWhenExitIsAllowed() {
        var capture = PresentationEscapeOwnership()
        for code: Int64 in [0, 18, 19, 20, 29, 36, 48, 55, 56, 58, 123, 124, 65535] {
            for type: CGEventType in [.keyDown, .keyUp, .flagsChanged] {
                XCTAssertEqual(capture.receive(type: type, keyCode: code, flags: [], allowExit: true),
                    .init(consumed: false, requestsExit: false))
            }
        }
        for type: CGEventType in [.mouseMoved, .leftMouseDown, .leftMouseUp, .scrollWheel, .flagsChanged] {
            XCTAssertEqual(capture.receive(type: type, keyCode: 53, flags: [], allowExit: true),
                .init(consumed: false, requestsExit: false))
        }
        XCTAssertFalse(capture.ownsEscape)
    }

    func testModifiedEscapeKeepsAllSystemShortcutsIncludingEmergencyExitAvailable() {
        for flags: CGEventFlags in [.maskCommand, .maskControl, .maskAlternate, .maskShift, .maskSecondaryFn,
                                   [.maskCommand, .maskControl, .maskAlternate]] {
            var capture = PresentationEscapeOwnership()
            XCTAssertFalse(PresentationEscapeOwnership.isOrdinaryEscape(flags))
            for type: CGEventType in [.keyDown, .keyUp] {
                XCTAssertEqual(capture.receive(type: type, keyCode: 53, flags: flags, allowExit: true),
                    .init(consumed: false, requestsExit: false))
            }
            XCTAssertFalse(capture.ownsEscape)
        }
    }

    func testOwnedPhysicalReleaseStillDrainsIfModifiersChangeWhileHeld() {
        var capture = PresentationEscapeOwnership()
        _ = capture.receive(type: .keyDown, keyCode: 53, flags: [], allowExit: true)
        XCTAssertEqual(capture.receive(type: .keyUp, keyCode: 53, flags: .maskCommand, allowExit: false),
            .init(consumed: true, requestsExit: false))
        XCTAssertFalse(capture.ownsEscape)
        XCTAssertEqual(capture.receive(type: .keyDown, keyCode: 53, flags: .maskCommand, allowExit: true),
            .init(consumed: false, requestsExit: false))
    }

    func testUnownedReleaseCannotTriggerExitAndANewGestureCanExitAgain() {
        var capture = PresentationEscapeOwnership()
        XCTAssertEqual(capture.receive(type: .keyUp, keyCode: 53, flags: [], allowExit: true),
            .init(consumed: false, requestsExit: false))
        for _ in 0..<2 {
            XCTAssertEqual(capture.receive(type: .keyDown, keyCode: 53, flags: [], allowExit: true),
                .init(consumed: true, requestsExit: true))
            _ = capture.receive(type: .keyUp, keyCode: 53, flags: [], allowExit: false)
        }
    }

    func testCapsLockStateDoesNotDisablePlainEscape() {
        var capture = PresentationEscapeOwnership()
        XCTAssertTrue(PresentationEscapeOwnership.isOrdinaryEscape(.maskAlphaShift))
        XCTAssertEqual(capture.receive(type: .keyDown, keyCode: 53, flags: .maskAlphaShift, allowExit: true),
            .init(consumed: true, requestsExit: true))
    }
}
