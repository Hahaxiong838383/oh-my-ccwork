import AppKit
import XCTest
@testable import NIOWarpApp

final class VisiblePointerRecoveryPolicyTests: XCTestCase {
    private typealias Screen = VisiblePointerRecoveryPolicy.Screen
    private let laptop = Screen(id: 1, frame: CGRect(x: 0, y: 0, width: 1512, height: 982),
        visibleFrame: CGRect(x: 0, y: 60, width: 1512, height: 897),
        quartzBounds: CGRect(x: 0, y: 0, width: 1512, height: 982),
        isBuiltIn: true, isActive: true, isAsleep: false, isOwned: false)
    private let output = Screen(id: 4, frame: CGRect(x: -2846, y: 982, width: 7680, height: 936),
        visibleFrame: CGRect(x: -2846, y: 982, width: 7680, height: 936),
        quartzBounds: CGRect(x: -2846, y: -936, width: 7680, height: 936),
        isBuiltIn: false, isActive: true, isAsleep: false, isOwned: false)
    private let source = Screen(id: 9, frame: CGRect(x: 1512, y: -1818, width: 7680, height: 2800),
        visibleFrame: CGRect(x: 1512, y: -1818, width: 7680, height: 2800),
        quartzBounds: CGRect(x: 1512, y: 0, width: 7680, height: 2800),
        isBuiltIn: false, isActive: true, isAsleep: false, isOwned: true)

    func testSelectionExcludesSourceSleepingAndInactiveScreensBeforeChoosingBuiltin() {
        let sleeping = Screen(id: 2, frame: laptop.frame, visibleFrame: laptop.visibleFrame,
            quartzBounds: laptop.quartzBounds, isBuiltIn: true, isActive: true, isAsleep: true, isOwned: false)
        let inactive = Screen(id: 3, frame: laptop.frame, visibleFrame: laptop.visibleFrame,
            quartzBounds: laptop.quartzBounds, isBuiltIn: true, isActive: false, isAsleep: false, isOwned: false)
        let screens = [source, sleeping, inactive, output, laptop]
        XCTAssertEqual(VisiblePointerRecoveryPolicy.physicalScreens(screens).map(\.id), [4, 1])
        XCTAssertEqual(VisiblePointerRecoveryPolicy.preferredScreen(in: screens, windowScreenID: 9)?.id, 1)
        XCTAssertEqual(VisiblePointerRecoveryPolicy.preferredScreen(in: screens, windowScreenID: 4)?.id, 1)
    }

    func testHeadlessSelectionPrefersPhysicalWindowThenFirstPhysicalScreen() {
        let other = Screen(id: 5, frame: laptop.frame, visibleFrame: laptop.visibleFrame,
            quartzBounds: laptop.quartzBounds, isBuiltIn: false, isActive: true, isAsleep: false, isOwned: false)
        XCTAssertEqual(VisiblePointerRecoveryPolicy.preferredScreen(in: [source, output, other], windowScreenID: 5)?.id, 5)
        XCTAssertEqual(VisiblePointerRecoveryPolicy.preferredScreen(in: [source, output, other], windowScreenID: 9)?.id, 4)
        XCTAssertNil(VisiblePointerRecoveryPolicy.preferredScreen(in: [source], windowScreenID: 9))
    }

    func testDestinationUsesWorkbenchVisibleIntersectionAndQuartzYAxisWithoutRetinaScaling() throws {
        let window = CGRect(x: -100, y: 800, width: 400, height: 300)
        let point = try XCTUnwrap(VisiblePointerRecoveryPolicy.destination(workbenchFrame: window, screen: laptop))
        XCTAssertEqual(point.x, 150)
        XCTAssertEqual(point.y, 103.5)
        XCTAssertTrue(laptop.quartzBounds.contains(point))
    }

    func testNegativeOriginDisplayMapsEachScreensLocalCoordinates() throws {
        let window = CGRect(x: -2000, y: 1100, width: 1000, height: 600)
        let point = try XCTUnwrap(VisiblePointerRecoveryPolicy.destination(workbenchFrame: window, screen: output))
        XCTAssertEqual(point, CGPoint(x: -1500, y: -418))
        XCTAssertTrue(output.quartzBounds.contains(point))
    }

    func testOffscreenWorkbenchFallsBackToVisiblePhysicalDesktopNotSource() throws {
        let point = try XCTUnwrap(VisiblePointerRecoveryPolicy.destination(workbenchFrame: source.frame, screen: laptop))
        XCTAssertEqual(point, CGPoint(x: 756, y: 473.5))
        XCTAssertFalse(source.quartzBounds.contains(point))
        XCTAssertNil(VisiblePointerRecoveryPolicy.destination(workbenchFrame: source.frame, screen: source))
    }

    func testGuardKeepsVisiblePointerAndReturnsHiddenPointerToLastVisiblePoint() {
        let screens = [source, laptop, output]
        let previous = CGPoint(x: 750, y: 450)
        XCTAssertFalse(VisiblePointerRecoveryPolicy.needsRecovery(point: previous, screens: screens))
        XCTAssertTrue(VisiblePointerRecoveryPolicy.needsRecovery(point: CGPoint(x: 3000, y: 1500), screens: screens))
        XCTAssertNil(VisiblePointerRecoveryPolicy.recoveryDestination(currentPoint: previous, screens: screens,
            workbenchFrame: nil, windowScreenID: 1, lastVisiblePoint: CGPoint(x: 500, y: 500)))
        XCTAssertEqual(VisiblePointerRecoveryPolicy.recoveryDestination(currentPoint: CGPoint(x: 3000, y: 1500),
            screens: screens, workbenchFrame: nil, windowScreenID: 1, lastVisiblePoint: previous), previous)
    }

    func testStaleLastVisiblePointCannotReturnToDisconnectedOrOwnedDisplay() {
        let hidden = CGPoint(x: 3000, y: 1500)
        for previous in [hidden, CGPoint(x: -1500, y: -400), CGPoint(x: CGFloat.infinity, y: 2)] {
            let point = VisiblePointerRecoveryPolicy.recoveryDestination(currentPoint: hidden, screens: [laptop, source],
                workbenchFrame: nil, windowScreenID: 9, lastVisiblePoint: previous)
            XCTAssertEqual(point, CGPoint(x: 756, y: 473.5))
        }
    }

    func testExplicitReturnForcesWorkbenchDestinationEvenWhenPointerAndLastPointAreVisible() {
        let point = VisiblePointerRecoveryPolicy.recoveryDestination(currentPoint: CGPoint(x: -1500, y: -400),
            screens: [output, source, laptop], workbenchFrame: CGRect(x: 300, y: 300, width: 600, height: 400),
            windowScreenID: 1, lastVisiblePoint: CGPoint(x: 100, y: 100), forceWorkbench: true)
        XCTAssertEqual(point, CGPoint(x: 600, y: 482))
    }

    func testNoPhysicalDestinationAndInvalidGeometryDoNotProduceUnsafeCoordinates() {
        let malformed = Screen(id: 10, frame: .zero, visibleFrame: .zero, quartzBounds: .zero,
            isBuiltIn: true, isActive: true, isAsleep: false, isOwned: false)
        XCTAssertTrue(VisiblePointerRecoveryPolicy.needsRecovery(point: CGPoint(x: CGFloat.nan, y: 1), screens: [laptop]))
        XCTAssertTrue(VisiblePointerRecoveryPolicy.needsRecovery(point: CGPoint(x: 99999, y: 99999), screens: [laptop]))
        XCTAssertNil(VisiblePointerRecoveryPolicy.recoveryDestination(currentPoint: .zero, screens: [source, malformed],
            workbenchFrame: nil, windowScreenID: 9, lastVisiblePoint: CGPoint(x: 750, y: 450), forceWorkbench: true))
        XCTAssertNil(VisiblePointerRecoveryPolicy.destination(workbenchFrame: nil, screen: malformed))
    }

    func testOwnedDisplayOverlapIsStillUnsafeDuringTopologyChange() {
        let overlappingSource = Screen(id: 9, frame: laptop.frame, visibleFrame: laptop.visibleFrame,
            quartzBounds: laptop.quartzBounds, isBuiltIn: false, isActive: true, isAsleep: false, isOwned: true)
        XCTAssertTrue(VisiblePointerRecoveryPolicy.needsRecovery(point: CGPoint(x: 750, y: 450),
            screens: [laptop, overlappingSource]))
        XCTAssertNil(VisiblePointerRecoveryPolicy.recoveryDestination(currentPoint: CGPoint(x: 750, y: 450),
            screens: [laptop, overlappingSource], workbenchFrame: nil, windowScreenID: 1,
            lastVisiblePoint: nil), "所有候选都与隐藏屏重叠时等待拓扑稳定，不能反复迁移到同一隐屏位置")
    }
}
