import Foundation

struct ProtoPieCloudTargetLease {
    let socket: URL
    let targetID: String
    let createdForRequest: Bool
}

/// Owns individual pages in NIO Warp's dedicated Chrome profile. Cleanup never
/// terminates a browser and never guesses ownership from a URL alone.
@MainActor final class ProtoPieCloudTargetLifecycle {
    struct Entry {
        let socket: URL
        let configuration: ProtoPieConfiguration?
        var failed: Bool
    }
    private(set) var entries = [String: Entry]()
    private(set) var committedTargetID: String?
    private(set) var committedSessionID: UUID?
    private var closings = [String: Task<Bool, Never>]()
    private let closeTarget: (URL, String) async throws -> Bool
    private let targetExists: (URL, String) async throws -> Bool

    init(closeTarget: @escaping (URL, String) async throws -> Bool,
         targetExists: @escaping (URL, String) async throws -> Bool) {
        self.closeTarget = closeTarget; self.targetExists = targetExists
    }

    func register(_ targetID: String, socket: URL, configuration: ProtoPieConfiguration,
                  createdForRequest: Bool) -> ProtoPieCloudTargetLease {
        entries[targetID] = Entry(socket: socket, configuration: configuration, failed: false)
        return ProtoPieCloudTargetLease(socket: socket, targetID: targetID, createdForRequest: createdForRequest)
    }

    func reusable(configuration: ProtoPieConfiguration, available: Set<String>) -> String? {
        let candidates = entries.filter { available.contains($0.key) && $0.value.configuration == configuration && !$0.value.failed }
        if let committedTargetID, candidates[committedTargetID] != nil { return committedTargetID }
        return candidates.keys.sorted().first
    }

    func commit(_ targetID: String?, sessionID: UUID) {
        committedTargetID = targetID
        committedSessionID = targetID == nil ? nil : sessionID
    }

    /// The coordinator explicitly releases only superseded or rejected sessions.
    /// A canceled finalize may have committed locally before its caller resumes.
    func releaseSessionTarget(_ targetID: String, sessionID: UUID) async {
        if committedTargetID == targetID {
            // A rejected newer session may have reused the old page but changed
            // its native window. Prepared identity is not committed ownership.
            guard committedSessionID == sessionID else { return }
            committedTargetID = nil; committedSessionID = nil
        }
        _ = await closeOwned(targetID)
    }

    func registerMarkedOrphan(_ targetID: String, socket: URL, preserving: Set<String>) {
        guard !preserving.contains(targetID), targetID != committedTargetID else { return }
        if entries[targetID] == nil { entries[targetID] = Entry(socket: socket, configuration: nil, failed: true) }
        else { entries[targetID]?.failed = true }
    }

    func preparationFailed(_ lease: ProtoPieCloudTargetLease) async {
        guard lease.createdForRequest, lease.targetID != committedTargetID else { return }
        entries[lease.targetID]?.failed = true
        _ = await closeOwned(lease.targetID)
    }

    /// A canceled preparation still has to close its new page. An unstructured
    /// task is deliberately used so the caller's cancellation cannot suppress
    /// the CDP close command. Transport operations retain their own deadlines.
    @discardableResult func closeOwned(_ targetID: String) async -> Bool {
        guard targetID != committedTargetID else { return false }
        if let existing = closings[targetID] { return await existing.value }
        guard let entry = entries[targetID] else { return false }
        let cleanup = Task { @MainActor [self] in
            var confirmed = false
            do { confirmed = try await closeTarget(entry.socket, targetID) }
            catch { /* Keep ownership until absence is independently confirmed. */ }
            if !confirmed {
                do { confirmed = !(try await targetExists(entry.socket, targetID)) }
                catch { }
            }
            if confirmed { entries.removeValue(forKey: targetID) }
            else {
                entries[targetID]?.failed = true
                NSLog("NIO ProtoPie target cleanup pending: %@", targetID)
            }
            return confirmed
        }
        closings[targetID] = cleanup
        let result = await cleanup.value
        closings.removeValue(forKey: targetID)
        return result
    }

    func cleanupFailures(preserving: Set<String>) async {
        let candidates = entries.filter { $0.value.failed && !preserving.contains($0.key) && $0.key != committedTargetID }.map(\.key)
        await withTaskGroup(of: Void.self) { group in
            for id in candidates { group.addTask { [self] in _ = await closeOwned(id) } }
            await group.waitForAll()
        }
    }

    nonisolated static func markedOrphans(_ targets: [[String: Any]], preserving: Set<String>) -> [String] {
        targets.compactMap { target in
            guard target["type"] as? String == "page", let id = target["targetId"] as? String,
                  !preserving.contains(id), let title = target["title"] as? String,
                  let text = target["url"] as? String, let url = URL(string: text) else { return nil }
            if title.hasPrefix("NIO Warp Preview · "), url.host == "cloud.protopie.io" { return id }
            if title.hasPrefix("NIO Warp Connect Preview · "), (try? ProtoPieConnectSource.pageIdentity(for: url)) != nil { return id }
            return nil
        }
    }

    nonisolated static func confirmedTargetInfos(_ result: [String: Any]) throws -> [[String: Any]] {
        guard let infos = result["targetInfos"] as? [[String: Any]],
              infos.allSatisfy({ ($0["targetId"] as? String)?.isEmpty == false }) else {
            throw ProtoPieError.unavailable("专用播放器页面列表未确认，请稍后重试。")
        }
        return infos
    }

    nonisolated static func unboundLaunchedTarget(_ targets: [[String: Any]], excluding known: Set<String>,
                                                expectedURL: URL) -> String? {
        let added = targets.filter { target in
            guard target["type"] as? String == "page", let id = target["targetId"] as? String else { return false }
            return !known.contains(id)
        }
        let exact = added.filter { $0["url"] as? String == expectedURL.absoluteString }
        if exact.count == 1 { return exact[0]["targetId"] as? String }
        // Connect must never claim another pieid or an unrelated service page.
        if (try? ProtoPieConnectSource.pageIdentity(for: expectedURL)) != nil {
            let bound = added.filter { target in
                guard let text = target["url"] as? String, let actual = URL(string: text) else { return false }
                return ProtoPieConnectSource.matchesPage(actual, expected: expectedURL)
            }
            return bound.count == 1 ? bound[0]["targetId"] as? String : nil
        }
        guard added.count == 1, let text = added[0]["url"] as? String,
              let url = URL(string: text), url.host == "cloud.protopie.io" || url.host == "accounts.protopie.io" else { return nil }
        return added[0]["targetId"] as? String
    }
}
