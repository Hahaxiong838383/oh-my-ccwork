import Foundation

/// Keeps the verified browser identity next to its page endpoint. Persistent
/// control never guesses a page's browser from the current global port.
struct ProtoPiePageEndpoint {
    let browserSocket: URL
    let targetID: String
    let legacySocket: URL
}

enum ProtoPieControlMode: String {
    case persistent
    case legacy

    static let preferenceKey = "nioWarpProtoPie.controlMode.v1"
    static func selected(in defaults: UserDefaults = .standard) -> Self {
        Self(rawValue: defaults.string(forKey: preferenceKey) ?? "") ?? .persistent
    }
    var title: String { self == .persistent ? "持久连接" : "兼容控制（原机制）" }
}

/// Mode is captured once per application/driver lifetime. Changing the saved
/// preference cannot replay an in-flight mutation through a second transport.
@MainActor final class ProtoPieBrowserControl {
    static let runtimeKey = "nioWarpProtoPie.controlRuntime.v1"
    let mode: ProtoPieControlMode
    private let transport: ProtoPieCDPTransport
    private let defaults: UserDefaults
    private var legacyRequests = 0
    private var isShutdown = false
    private var lastPublishedAt = -Double.infinity

    init(defaults: UserDefaults = .standard, transport: ProtoPieCDPTransport? = nil) {
        self.defaults = defaults
        self.transport = transport ?? ProtoPieCDPTransport()
        mode = ProtoPieControlMode.selected(in: defaults)
        publish(force: true)
    }

    func call(_ browser: URL, method: String, parameters: [String: Any] = [:]) async throws -> [String: Any] {
        guard !isShutdown else { throw ProtoPieCDPTransport.Failure.closed }
        defer { publish() }
        if mode == .legacy {
            legacyRequests += 1
            return try await ProtoPieLegacyCDP.call(browser, method: method, parameters: parameters)
        }
        return try await transport.call(browserSocket: browser, method: method, parameters: parameters)
    }

    func call(_ page: ProtoPiePageEndpoint, method: String, parameters: [String: Any] = [:]) async throws -> [String: Any] {
        guard !isShutdown else { throw ProtoPieCDPTransport.Failure.closed }
        defer { publish() }
        if mode == .legacy {
            legacyRequests += 1
            return try await ProtoPieLegacyCDP.call(page.legacySocket, method: method, parameters: parameters)
        }
        return try await transport.call(browserSocket: page.browserSocket, targetID: page.targetID,
                                        method: method, parameters: parameters)
    }

    func releaseTarget(_ targetID: String) async {
        if mode == .persistent { await transport.releaseTarget(targetID) }
        publish()
    }

    func shutdown() {
        isShutdown = true
        transport.shutdown()
        publish(force: true)
    }

    private func publish(force: Bool = false) {
        let now = ProcessInfo.processInfo.systemUptime
        guard force || now - lastPublishedAt >= 2 else { return }
        lastPublishedAt = now
        // Counts only: never persist socket URLs, target IDs, commands or payloads.
        var diagnostic = transport.snapshot()
        diagnostic["mode"] = mode.rawValue
        diagnostic["legacyRequests"] = legacyRequests
        diagnostic["updatedAt"] = Date().timeIntervalSince1970
        defaults.set(diagnostic, forKey: Self.runtimeKey)
    }
}
