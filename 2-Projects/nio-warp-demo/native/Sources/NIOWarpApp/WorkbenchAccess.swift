import Foundation
import CryptoKit

/// A local accidental-editing gate, deliberately separate from saved calibration.
enum WorkbenchPasswordVerifier {
    private static let digest = "4705211a3898ee604307651f325021cd98c8254bd0b895a1dc762c7722196bab"

    static func verify(_ password: String) -> Bool {
        let actual = SHA256.hash(data: Data(("nio-warp-debug-v1:" + password).utf8))
            .map { String(format: "%02x", $0) }.joined()
        return zip(actual.utf8, digest.utf8).reduce(UInt8(0)) { $0 | ($1.0 ^ $1.1) } == 0
    }
}

/// Owned by AppDelegate and shared by replacement workbenches. Never persisted.
@MainActor final class WorkbenchAccessSession {
    private(set) var isDebugMode = false
    private(set) var isAuthenticating = false
    private(set) var generation: UInt64 = 0
    private let passwordVerifier: (String) -> Bool

    init(passwordVerifier: @escaping (String) -> Bool = WorkbenchPasswordVerifier.verify) {
        self.passwordVerifier = passwordVerifier
    }

    var allowsDebugEditing: Bool { isDebugMode && !isAuthenticating }

    func allowsModule(_ identifier: String) -> Bool {
        guard !isAuthenticating, ["canvas", "global", "local", "quality", "history", "mouse", "protopie"].contains(identifier) else { return false }
        return isDebugMode || identifier == "history" || identifier == "protopie"
    }

    @discardableResult
    func unlock(password: String) -> Bool {
        guard passwordVerifier(password) else {
            NSLog("[workbench-access] authentication rejected")
            return false
        }
        if !isDebugMode { generation &+= 1 }
        isDebugMode = true
        NSLog("[workbench-access] debug mode unlocked")
        return true
    }

    func lock() {
        if isDebugMode { generation &+= 1 }
        isDebugMode = false
        NSLog("[workbench-access] usage mode locked")
    }

    @discardableResult
    func beginAuthentication() -> Bool {
        guard !isAuthenticating else { return false }
        isAuthenticating = true
        return true
    }

    func endAuthentication() { isAuthenticating = false }

    /// Hide debug-only overlays in a rendering copy, preserving exported/saved values.
    func renderConfiguration(_ configuration: WarpConfiguration) -> WarpConfiguration {
        guard !isDebugMode else { return configuration }
        var rendered = configuration
        rendered.render.testPattern = .off
        rendered.render.showAABoundary = false
        rendered.render.showWarpBoundary = false
        return rendered
    }
}
