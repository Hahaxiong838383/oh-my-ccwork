import Foundation
import XCTest
@testable import NIOWarpApp

final class MouseWarpDeltaCompensatorTests: XCTestCase {
    private func primed() -> MouseWarpDeltaCompensator {
        var value = MouseWarpDeltaCompensator()
        let first = value.compensate(raw: SIMD2(27, -300), timestamp: 1, isHardware: true)
        XCTAssertTrue(first.primed)
        XCTAssertEqual(first.corrected, .zero)
        return value
    }

    func testFirstHardwareMoveDropsUntrackedOldOrExternalWarp() {
        var value = MouseWarpDeltaCompensator()
        value.recordWarp(delta: SIMD2(-50, 374), timestamp: 10)
        let first = value.compensate(raw: SIMD2(-56, 372), timestamp: 20, isHardware: true)
        XCTAssertTrue(first.primed)
        XCTAssertEqual(first.corrected, .zero)
        XCTAssertEqual(first.correction, SIMD2(-50, 374))
        let next = value.compensate(raw: SIMD2(6, -2), timestamp: 30, isHardware: true)
        XCTAssertFalse(next.primed)
        XCTAssertEqual(next.corrected, SIMD2(6, -2))
        XCTAssertEqual(next.correction, .zero)
    }

    func testObservedQuantizedWarpIsRemovedFromBothAxes() {
        var value = primed()
        // Hardware trace: actual OS cursor was warped from (1044,-608) to
        // (994,-234), then the next event reported (-56,+372).
        let before = SIMD2<Double>(1044, -608), after = SIMD2<Double>(994, -234)
        value.recordWarp(delta: after - before, timestamp: 10)
        let next = value.compensate(raw: SIMD2(-56, 372), timestamp: 20, isHardware: true)
        XCTAssertEqual(next.correction, SIMD2(-50, 374))
        XCTAssertEqual(next.corrected, SIMD2(-6, -2))
    }

    func testVerticalFeedbackTraceRecoversSmallHandMotion() {
        var value = primed()
        // Recorded baseline sequence: event y advances by the preceding warp,
        // while reported dy progressively grows despite only small hand drift.
        let raw = [-3, -4, -5, -6, -7, -8, -9, -10, -11, -12, -13, -13, -14, -14, -15, -15]
        let warp = [-1, -3, -4, -5, -6, -7, -8, -9, -10, -11, -12, -13, -13, -14, -14, -15]
        let expected = [-2, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 0, -1, 0, -1, 0]
        var total = 0.0
        for index in raw.indices {
            value.recordWarp(delta: SIMD2(0, Double(warp[index])), timestamp: UInt64(index * 10 + 10))
            let result = value.compensate(raw: SIMD2(0, Double(raw[index])),
                timestamp: UInt64(index * 10 + 20), isHardware: true)
            XCTAssertEqual(result.corrected, SIMD2(0, Double(expected[index])))
            total += result.corrected.y
        }
        XCTAssertEqual(total, Double(expected.reduce(0, +)))
        XCTAssertTrue(abs(total) < Double(abs(raw.reduce(0, +))) / 5)
    }

    func testHorizontalReversalDoesNotSuppressSubsequentHandMovement() {
        var value = primed()
        for index in 0..<20 {
            // A real +5 dx can be cancelled in the event by the preceding -5
            // cursor warp. Recover it before the controller applies reversal.
            value.recordWarp(delta: SIMD2(-5, 0), timestamp: UInt64(index * 10 + 10))
            let result = value.compensate(raw: .zero, timestamp: UInt64(index * 10 + 20), isHardware: true)
            XCTAssertEqual(result.corrected, SIMD2(5, 0))
        }
    }

    func testMultipleWarpsAccumulateAndAreConsumedOnlyOnce() {
        var value = primed()
        value.recordWarp(delta: SIMD2(-10, 5), timestamp: 10)
        value.recordWarp(delta: SIMD2(3, 7), timestamp: 20)
        value.recordWarp(delta: SIMD2(-0.5, 0), timestamp: 30)
        let first = value.compensate(raw: SIMD2(-3.5, 10), timestamp: 40, isHardware: true)
        XCTAssertEqual(first.correction, SIMD2(-7.5, 12))
        XCTAssertEqual(first.corrected, SIMD2(4, -2))
        let second = value.compensate(raw: SIMD2(2, 0), timestamp: 50, isHardware: true)
        XCTAssertEqual(second.correction, .zero)
        XCTAssertEqual(second.corrected, SIMD2(2, 0))
    }

    func testQueuedOlderEventDoesNotConsumeFutureWarp() {
        var value = primed()
        value.recordWarp(delta: SIMD2(5, 6), timestamp: 30)
        let queued = value.compensate(raw: SIMD2(4, 2), timestamp: 20, isHardware: true)
        XCTAssertEqual(queued.correction, .zero)
        XCTAssertEqual(queued.corrected, SIMD2(4, 2))
        let subsequent = value.compensate(raw: SIMD2(7, 9), timestamp: 40, isHardware: true)
        XCTAssertEqual(subsequent.correction, SIMD2(5, 6))
        XCTAssertEqual(subsequent.corrected, SIMD2(2, 3))
    }

    func testPrimingKeepsWarpsNewerThanQueuedFirstEvent() {
        var value = MouseWarpDeltaCompensator()
        value.recordWarp(delta: SIMD2(-50, 374), timestamp: 30)
        let first = value.compensate(raw: SIMD2(0, -200), timestamp: 20, isHardware: true)
        XCTAssertTrue(first.primed)
        XCTAssertEqual(first.correction, .zero)
        let next = value.compensate(raw: SIMD2(-56, 372), timestamp: 40, isHardware: true)
        XCTAssertEqual(next.corrected, SIMD2(-6, -2))
    }

    func testSyntheticDeltaBypassesCorrectionAndReprimesHardware() {
        var value = primed()
        value.recordWarp(delta: SIMD2(100, 200), timestamp: 10)
        let synthetic = value.compensate(raw: SIMD2(80, 0), timestamp: 20, isHardware: false)
        XCTAssertEqual(synthetic.corrected, SIMD2(80, 0))
        XCTAssertEqual(synthetic.correction, .zero)
        value.recordWarp(delta: SIMD2(-80, 0), timestamp: 30)
        let hardware = value.compensate(raw: SIMD2(-75, 6), timestamp: 40, isHardware: true)
        XCTAssertTrue(hardware.primed)
        XCTAssertEqual(hardware.corrected, .zero)
        XCTAssertEqual(hardware.correction, SIMD2(-80, 0))
        XCTAssertEqual(value.compensate(raw: SIMD2(5, 0), timestamp: 50, isHardware: true).corrected, SIMD2(5, 0))
    }

    func testRestartOrSurfaceLeaveClearsOldWarpAndPrimesAgain() {
        var value = primed()
        value.recordWarp(delta: SIMD2(-50, 374), timestamp: 100)
        value.reset()
        let first = value.compensate(raw: SIMD2(-56, 372), timestamp: 110, isHardware: true)
        XCTAssertTrue(first.primed)
        XCTAssertEqual(first.corrected, .zero)
        XCTAssertEqual(first.correction, .zero)
        let next = value.compensate(raw: SIMD2(2, -1), timestamp: 120, isHardware: true)
        XCTAssertEqual(next.corrected, SIMD2(2, -1))
    }
}
