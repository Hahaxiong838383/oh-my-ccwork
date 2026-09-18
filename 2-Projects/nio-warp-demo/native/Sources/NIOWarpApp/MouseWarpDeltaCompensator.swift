import Foundation

/// CGWarp does not post an event, but its displacement can be included in the
/// next physical mouse delta. Keep only warps completed before that event was
/// created; queued older events must not consume future cursor movement.
struct MouseWarpDeltaCompensator {
    struct Result: Equatable {
        let corrected: SIMD2<Double>
        let correction: SIMD2<Double>
        let primed: Bool
    }

    private struct Warp {
        let delta: SIMD2<Double>
        let timestamp: UInt64
    }
    private var pending: [Warp] = []
    private var needsPriming = true

    mutating func reset() {
        pending.removeAll(keepingCapacity: true)
        needsPriming = true
    }

    mutating func recordWarp(delta: SIMD2<Double>, timestamp: UInt64) {
        guard delta.x.isFinite, delta.y.isFinite, timestamp != 0 else {
            reset(); return
        }
        if delta != .zero { pending.append(Warp(delta: delta, timestamp: timestamp)) }
    }

    mutating func compensate(raw: SIMD2<Double>, timestamp: UInt64, isHardware: Bool) -> Result {
        guard isHardware else {
            // Injected events carry explicit deltas. A following physical event
            // must prime again instead of inheriting that injection's warps.
            reset()
            return Result(corrected: raw, correction: .zero, primed: false)
        }
        var correction = SIMD2<Double>.zero
        pending.removeAll { warp in
            guard warp.timestamp < timestamp else { return false }
            correction += warp.delta
            return true
        }
        if needsPriming {
            needsPriming = false
            return Result(corrected: .zero, correction: correction, primed: true)
        }
        return Result(corrected: raw - correction, correction: correction, primed: false)
    }
}
