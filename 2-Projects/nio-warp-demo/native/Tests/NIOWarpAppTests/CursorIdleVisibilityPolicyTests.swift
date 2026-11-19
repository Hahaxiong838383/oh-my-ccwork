import XCTest
@testable import NIOWarpApp

final class CursorIdleVisibilityPolicyTests: XCTestCase {
    private func tick(_ value: inout CursorIdleVisibilityPolicy, _ time: Double,
                      enabled: Bool = true, delay: Double = 3) {
        value.update(now: time, enabled: enabled, delay: delay)
    }

    func testDefaultDeadlineAndPollingDoNotPostponeHiding() {
        var p = CursorIdleVisibilityPolicy()
        p.setScope(owned: true, now: 100)
        for t in [100.2, 101, 102.999] {
            p.setScope(owned: true, now: t)
            p.setPageHidden(false)
            tick(&p, t)
            XCTAssertFalse(p.wantsHidden)
        }
        tick(&p, 103)
        XCTAssertTrue(p.idleHidden)
        XCTAssertTrue(p.wantsHidden)
        p.setPageHidden(false)
        tick(&p, 104)
        XCTAssertTrue(p.wantsHidden, "CSS refresh must not undo idle hiding")
    }

    func testMoveWheelAndFirstClickWakeImmediately() {
        let events: [MouseCaptureEvent] = [.move(dx: 1, dy: 0, modifiers: 0),
            .wheel(dx: 0, dy: 20, modifiers: 0),
            .button(down: true, number: 0, clickCount: 1, modifiers: 0)]
        for event in events {
            var p = CursorIdleVisibilityPolicy()
            p.setScope(owned: true, now: 0); tick(&p, 3)
            XCTAssertTrue(p.wantsHidden)
            p.receiveMouse(event, now: 4)
            XCTAssertFalse(p.wantsHidden)
            XCTAssertEqual(p.lastMouseActivity, 4)
        }
    }

    func testStationaryLongPressAndMultipleButtonsWaitForFinalRelease() {
        var p = CursorIdleVisibilityPolicy()
        p.setScope(owned: true, now: 0)
        p.receiveMouse(.button(down: true, number: 0, clickCount: 1, modifiers: 0), now: 1)
        p.receiveMouse(.button(down: true, number: 1, clickCount: 1, modifiers: 0), now: 2)
        tick(&p, 40)
        XCTAssertEqual(p.heldButtons, 3)
        XCTAssertFalse(p.wantsHidden)
        p.receiveMouse(.button(down: false, number: 0, clickCount: 1, modifiers: 0), now: 41)
        tick(&p, 50)
        XCTAssertEqual(p.heldButtons, 2)
        XCTAssertFalse(p.wantsHidden)
        p.receiveMouse(.button(down: false, number: 1, clickCount: 1, modifiers: 0), now: 51)
        tick(&p, 53.999); XCTAssertFalse(p.wantsHidden)
        tick(&p, 54); XCTAssertTrue(p.wantsHidden)
    }

    func testDragAndEdgePushAreActivityWithoutAnyCoordinateDependency() {
        var p = CursorIdleVisibilityPolicy()
        p.setScope(owned: true, now: 0)
        // Real delta can be nonzero while the AA-constrained destination is fixed.
        for t in stride(from: 2.0, through: 20.0, by: 2) {
            p.receiveMouse(.move(dx: 900, dy: -900, modifiers: 0), now: t)
            tick(&p, t + 1)
            XCTAssertFalse(p.wantsHidden)
        }
        tick(&p, 23); XCTAssertTrue(p.wantsHidden)
    }

    func testZeroAndNonfiniteDeltasDoNotWakeOrRenewIdleTimer() {
        var p = CursorIdleVisibilityPolicy()
        p.setScope(owned: true, now: 0); tick(&p, 3)
        for event in [MouseCaptureEvent.move(dx: 0, dy: 0, modifiers: 0),
                      .move(dx: .nan, dy: 1, modifiers: 0),
                      .wheel(dx: 1, dy: .infinity, modifiers: 0),
                      .wheel(dx: 0, dy: 0, modifiers: 0),
                      .button(down: true, number: 4, clickCount: 1, modifiers: 0)] {
            p.receiveMouse(event, now: 4)
            XCTAssertTrue(p.wantsHidden)
            XCTAssertEqual(p.lastMouseActivity, 0)
        }
        p.receiveMouse(.move(dx: 1, dy: 0, modifiers: 0), now: .nan)
        XCTAssertTrue(p.wantsHidden)
    }

    func testPageAndIdleHidingRemainIndependent() {
        var p = CursorIdleVisibilityPolicy()
        p.setScope(owned: true, now: 0)
        p.setPageHidden(true)
        p.receiveMouse(.move(dx: 1, dy: 1, modifiers: 0), now: 1)
        XCTAssertFalse(p.idleHidden)
        XCTAssertTrue(p.wantsHidden)
        tick(&p, 4)
        p.setPageHidden(false)
        XCTAssertTrue(p.wantsHidden)
        p.receiveMouse(.move(dx: 1, dy: 0, modifiers: 0), now: 5)
        XCTAssertFalse(p.wantsHidden)
    }

    func testLeaveRestoresAndLatePageUpdatesCannotRehide() {
        var p = CursorIdleVisibilityPolicy()
        p.setScope(owned: true, now: 0)
        p.setPageHidden(true)
        p.receiveMouse(.button(down: true, number: 0, clickCount: 1, modifiers: 0), now: 1)
        p.setScope(owned: false, now: 2)
        XCTAssertFalse(p.wantsHidden)
        XCTAssertEqual(p.heldButtons, 0)
        XCTAssertNil(p.lastMouseActivity)
        p.setPageHidden(true)
        p.receiveMouse(.move(dx: 1, dy: 0, modifiers: 0), now: 5)
        tick(&p, 20)
        XCTAssertFalse(p.wantsHidden)
        p.setScope(owned: false, now: 21)
        XCTAssertFalse(p.wantsHidden)
        p.setScope(owned: true, now: 22)
        tick(&p, 24.9); XCTAssertFalse(p.wantsHidden)
        tick(&p, 25); XCTAssertTrue(p.wantsHidden)
    }

    func testDisabledAutoHideKeepsNativePagePolicy() {
        var p = CursorIdleVisibilityPolicy()
        p.setScope(owned: true, now: 0)
        tick(&p, 10); XCTAssertTrue(p.wantsHidden)
        tick(&p, 10, enabled: false); XCTAssertFalse(p.wantsHidden)
        p.setPageHidden(true)
        tick(&p, 11, enabled: false); XCTAssertTrue(p.wantsHidden)
        XCTAssertFalse(p.idleHidden)
    }

    func testDelayClampingAndMonotonicClockDefenses() {
        for (delay, threshold) in [(Double.nan, 3.0), (.infinity, 3), (-1, 1), (100, 30), (6, 6)] {
            var p = CursorIdleVisibilityPolicy()
            p.setScope(owned: true, now: 100)
            tick(&p, 100 + threshold - 0.01, delay: delay)
            XCTAssertFalse(p.wantsHidden)
            tick(&p, 100 + threshold, delay: delay)
            XCTAssertTrue(p.wantsHidden)
            tick(&p, 99, delay: delay); XCTAssertFalse(p.wantsHidden)
            tick(&p, .nan, delay: delay); XCTAssertFalse(p.wantsHidden)
        }
    }
}
