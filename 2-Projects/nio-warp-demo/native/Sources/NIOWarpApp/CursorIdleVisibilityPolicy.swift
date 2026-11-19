import Foundation

/// Visibility only: never changes focus, coordinates, input ownership or delivery.
/// Times are monotonic uptime; CSS polling and our own warps are not activity.
struct CursorIdleVisibilityPolicy {
    private(set) var scopeOwned = false
    private(set) var pageHidden = false
    private(set) var idleHidden = false
    private(set) var heldButtons = 0
    private(set) var lastMouseActivity: TimeInterval?

    var wantsHidden: Bool { scopeOwned && (pageHidden || idleHidden) }

    mutating func setScope(owned: Bool, now: TimeInterval) {
        guard owned != scopeOwned else { return }
        scopeOwned = owned
        pageHidden = false; idleHidden = false; heldButtons = 0
        lastMouseActivity = owned && now.isFinite ? now : nil
    }

    mutating func setPageHidden(_ hidden: Bool) {
        guard scopeOwned else { return }
        pageHidden = hidden
    }

    /// Receives compensated movement, before geometry clamps it at the AA edge.
    /// Track buttons even in movement-only preview; a held gesture stays visible.
    mutating func receiveMouse(_ event: MouseCaptureEvent, now: TimeInterval) {
        guard scopeOwned, now.isFinite else { return }
        switch event {
        case .move(let dx, let dy, _), .wheel(let dx, let dy, _):
            guard dx.isFinite, dy.isFinite, dx != 0 || dy != 0 else { return }
        case .button(let down, let number, _, _):
            let bit: Int
            switch number { case 0: bit = 1; case 1: bit = 2; case 2: bit = 4; default: return }
            if down { heldButtons |= bit } else { heldButtons &= ~bit }
        }
        lastMouseActivity = now
        idleHidden = false
    }

    mutating func update(now: TimeInterval, enabled: Bool, delay: TimeInterval) {
        let safeDelay = delay.isFinite ? min(max(delay, 1), 30) : 3
        idleHidden = scopeOwned && enabled && heldButtons == 0 && now.isFinite
            && lastMouseActivity.map { now >= $0 && now - $0 >= safeDelay } == true
    }
}
