import Foundation
import XCTest
@testable import NIOWarpApp

final class WorkbenchWindowPlacementTests: XCTestCase {
    func testDevMacWindowReturnsFromExternalDisplayWithRoomForMenuAndDock() {
        let visible = CGRect(x: 0, y: 90, width: 1512, height: 859)
        let externalWindow = CGRect(x: 1900, y: 46, width: 1120, height: 752)
        let result = WorkbenchWindowPlacement.containedFrame(externalWindow, in: visible)
        XCTAssertEqual(result, CGRect(x: 384, y: 98, width: 1120, height: 752))
        XCTAssertTrue(visible.insetBy(dx: 8, dy: 8).contains(result))
    }

    func testExistingWindowSizeAndPositionArePreservedWhenInsideMargins() {
        let frame = CGRect(x: 80, y: 110, width: 1120, height: 752)
        XCTAssertEqual(WorkbenchWindowPlacement.containedFrame(frame, in: CGRect(x: 0, y: 90, width: 1512, height: 859)), frame)
    }

    func testOversizedRestoredWindowShrinksToNewVisibleFrame() {
        let visible = CGRect(x: 40, y: 50, width: 1200, height: 620)
        let result = WorkbenchWindowPlacement.containedFrame(CGRect(x: -800, y: 1000, width: 2200, height: 1600), in: visible)
        XCTAssertEqual(result, visible.insetBy(dx: 8, dy: 8))
    }

    func testNegativeDisplayCoordinatesRemainValid() {
        let visible = CGRect(x: -1512, y: -200, width: 1512, height: 859)
        let result = WorkbenchWindowPlacement.containedFrame(CGRect(x: 20, y: 700, width: 1120, height: 752), in: visible)
        XCTAssertEqual(result, CGRect(x: -1128, y: -101, width: 1120, height: 752))
        XCTAssertTrue(visible.insetBy(dx: 8, dy: 8).contains(result))
    }

    func testShorterScreenReducesContentMinimumByTitlebarHeight() {
        let result = WorkbenchWindowPlacement.minimumContentSize(in: CGRect(x: 0, y: 0, width: 1024, height: 620), frameDecoration: CGSize(width: 0, height: 32))
        XCTAssertEqual(result, CGSize(width: 1008, height: 572))
    }

    func testLargerScreenRestoresPreferredMinimumRatherThanPreviousSmallLimit() {
        let result = WorkbenchWindowPlacement.minimumContentSize(in: CGRect(x: 0, y: 90, width: 1512, height: 859), frameDecoration: CGSize(width: 0, height: 32))
        XCTAssertEqual(result, CGSize(width: 1040, height: 650))
    }

    func testTinyTransientFrameDoesNotProduceNegativeDimensions() {
        let visible = CGRect(x: 5, y: 6, width: 1, height: 1)
        XCTAssertEqual(WorkbenchWindowPlacement.containedFrame(CGRect(x: 500, y: 600, width: 1120, height: 752), in: visible), visible)
        XCTAssertEqual(WorkbenchWindowPlacement.minimumContentSize(in: visible, frameDecoration: CGSize(width: 0, height: 32)), CGSize(width: 1, height: 1))
    }
}
