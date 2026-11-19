import Foundation
import XCTest
@testable import NIOWarpApp

final class NativePointerActivityTests: XCTestCase {
    func testFirstHardwareMovementWakesWithoutChangingPrimedMapping() {
        var compensator = MouseWarpDeltaCompensator()
        compensator.recordWarp(delta: SIMD2(-50, 374), timestamp: 10)
        let raw = SIMD2<Double>(-56, 372)
        let result = compensator.compensate(raw: raw, timestamp: 20, isHardware: true)
        XCTAssertTrue(result.primed)
        XCTAssertEqual(result.corrected, .zero)
        XCTAssertEqual(NativeMouseInputCapture.pointerActivityDelta(raw: raw, compensation: result), SIMD2(-6, -2))
        XCTAssertEqual(result.corrected, .zero, "唤醒不能把首帧活动重新作为映射位移")
    }

    func testPrimedWarpOnlyAndStationaryInputDoNotWake() {
        var compensator = MouseWarpDeltaCompensator()
        let warp = SIMD2<Double>(-50, 374)
        compensator.recordWarp(delta: warp, timestamp: 10)
        let result = compensator.compensate(raw: warp, timestamp: 20, isHardware: true)
        XCTAssertTrue(result.primed)
        XCTAssertNil(NativeMouseInputCapture.pointerActivityDelta(raw: warp, compensation: result))
        var stationary = MouseWarpDeltaCompensator()
        let stationaryResult = stationary.compensate(raw: .zero, timestamp: 20, isHardware: true)
        XCTAssertNil(NativeMouseInputCapture.pointerActivityDelta(raw: .zero, compensation: stationaryResult))
    }

    func testNormalMovementUsesCompensatedDelta() {
        var compensator = MouseWarpDeltaCompensator()
        _ = compensator.compensate(raw: .zero, timestamp: 1, isHardware: true)
        compensator.recordWarp(delta: SIMD2(-5, 0), timestamp: 10)
        // Hand movement can cancel the previous reverse-direction warp in raw
        // input. It still counts as activity, including when AA clamps position.
        let result = compensator.compensate(raw: .zero, timestamp: 20, isHardware: true)
        XCTAssertFalse(result.primed)
        XCTAssertEqual(NativeMouseInputCapture.pointerActivityDelta(raw: .zero, compensation: result), SIMD2(5, 0))
    }

    func testNormalWarpOnlyAndZeroDeltasDoNotWake() {
        var compensator = MouseWarpDeltaCompensator()
        _ = compensator.compensate(raw: .zero, timestamp: 1, isHardware: true)
        let warp = SIMD2<Double>(24, -16)
        compensator.recordWarp(delta: warp, timestamp: 10)
        let result = compensator.compensate(raw: warp, timestamp: 20, isHardware: true)
        XCTAssertFalse(result.primed)
        XCTAssertNil(NativeMouseInputCapture.pointerActivityDelta(raw: warp, compensation: result))
        let next = compensator.compensate(raw: .zero, timestamp: 30, isHardware: true)
        XCTAssertNil(NativeMouseInputCapture.pointerActivityDelta(raw: .zero, compensation: next))
    }

    func testInvalidActivityIsIgnoredForPrimedAndNormalEvents() {
        for invalid in [Double.nan, Double.infinity, -Double.infinity] {
            for raw in [SIMD2(invalid, 0), SIMD2(0, invalid)] {
                let primed = MouseWarpDeltaCompensator.Result(corrected: .zero, correction: .zero, primed: true)
                XCTAssertNil(NativeMouseInputCapture.pointerActivityDelta(raw: raw, compensation: primed))
                let normal = MouseWarpDeltaCompensator.Result(corrected: raw, correction: .zero, primed: false)
                XCTAssertNil(NativeMouseInputCapture.pointerActivityDelta(raw: raw, compensation: normal))
            }
        }
    }

    func testSyntheticMovementRetainsItsExplicitDelta() {
        var compensator = MouseWarpDeltaCompensator()
        compensator.recordWarp(delta: SIMD2(100, 200), timestamp: 10)
        let raw = SIMD2<Double>(80, -3)
        let result = compensator.compensate(raw: raw, timestamp: 20, isHardware: false)
        XCTAssertFalse(result.primed)
        XCTAssertEqual(NativeMouseInputCapture.pointerActivityDelta(raw: raw, compensation: result), raw)
    }
}
