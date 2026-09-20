import Foundation

/// Dedicated control transport. It never shares the mouse-input connection and
/// never retries a command: a disconnected mutation may already have happened.
@MainActor protocol ProtoPieCDPWire: AnyObject {
    func send(_ text: String) async throws
    func receive() async throws -> Data
    func close()
}

@MainActor private final class ProtoPieCDPURLSessionWire: ProtoPieCDPWire {
    private let session: URLSession
    private let socket: URLSessionWebSocketTask

    init(url: URL) {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.connectionProxyDictionary = [:]
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        configuration.urlCredentialStorage = nil
        session = URLSession(configuration: configuration)
        socket = session.webSocketTask(with: url)
        socket.maximumMessageSize = 4 * 1_024 * 1_024
        socket.resume()
    }

    func send(_ text: String) async throws { try await socket.send(.string(text)) }
    func receive() async throws -> Data {
        switch try await socket.receive() {
        case .data(let data): return data
        case .string(let string): return Data(string.utf8)
        @unknown default: throw ProtoPieCDPTransport.Failure.disconnected
        }
    }
    func close() { socket.cancel(); session.invalidateAndCancel() }
}

@MainActor final class ProtoPieCDPTransport {
    enum Failure: LocalizedError, Equatable {
        case invalidEndpoint, invalidTarget, closed, disconnected, timeout, capacity, connectionBudget
        case targetDetached, invalidResponse, rejected(Int?)

        var errorDescription: String? {
            switch self {
            case .invalidEndpoint: return "专用播放器控制地址无效。"
            case .invalidTarget: return "专用播放器页面标识无效。"
            case .closed: return "播放器控制连接已关闭。"
            case .disconnected: return "播放器控制连接已断开，本次命令不会自动重放。"
            case .timeout: return "播放器控制请求超时，本次命令不会自动重放。"
            case .capacity: return "播放器控制请求或页面会话过多，请等待当前操作完成。"
            case .connectionBudget: return "播放器控制连接多次中断，已停止自动重连，请重启应用或手动切换备用模式。"
            case .targetDetached: return "播放器页面会话已结束，请重新准备预览。"
            case .invalidResponse: return "播放器控制响应与请求会话不匹配，已断开连接。"
            case .rejected: return "专用播放器拒绝了控制请求。"
            }
        }
    }

    typealias WireFactory = (URL) throws -> ProtoPieCDPWire
    private struct Pending {
        let generation: UUID
        let sessionID: String?
        let targetID: String?
        let attaching: Bool
        let continuation: CheckedContinuation<[String: Any], Error>
        let deadline: Task<Void, Never>
        var sender: Task<Void, Never>?
    }
    private struct Attachment {
        let token: UUID
        let task: Task<String, Error>
    }

    private let factory: WireFactory
    private let timeoutNanoseconds: UInt64
    private let maximumPending: Int
    private let maximumTargets: Int
    private let maximumConnections: Int
    private var wire: ProtoPieCDPWire?
    private var endpoint: URL?
    // At most maximumConnections entries. Late cleanup for a replaced Chrome
    // process must not tear down the replacement browser's healthy connection.
    private var retiredEndpoints = Set<URL>()
    private var receiver: Task<Void, Never>?
    private var generation = UUID()
    private var nextID = 1
    private var pending: [Int: Pending] = [:]
    private var sessions: [String: String] = [:]
    private var attachments: [String: Attachment] = [:]
    private var detachedDuringAttach = Set<String>()
    private var isShutdown = false
    private var connectionCount = 0
    private var disconnectCount = 0
    private var requestCount = 0
    private var completedCount = 0
    private var cancelledCount = 0
    private var timeoutCount = 0

    init(timeout: TimeInterval = 6, maximumPending: Int = 64, maximumTargets: Int = 8,
         maximumConnections: Int = 16, wireFactory: WireFactory? = nil) {
        timeoutNanoseconds = UInt64(max(0.01, min(timeout.isFinite ? timeout : 6, 60)) * 1_000_000_000)
        self.maximumPending = max(1, min(maximumPending, 64))
        self.maximumTargets = max(1, min(maximumTargets, 8))
        self.maximumConnections = max(1, min(maximumConnections, 16))
        factory = wireFactory ?? { ProtoPieCDPURLSessionWire(url: $0) }
    }

    deinit {
        receiver?.cancel()
        for entry in pending.values {
            entry.deadline.cancel(); entry.sender?.cancel()
            entry.continuation.resume(throwing: Failure.closed)
        }
        for entry in attachments.values { entry.task.cancel() }
        let oldWire = wire
        Task { @MainActor in oldWire?.close() }
    }

    /// targetID must be supplied by the driver's owned-page lease, never guessed
    /// from an arbitrary page URL. Browser commands do not attach to a target.
    func call(browserSocket: URL, targetID: String? = nil, method: String,
              parameters: [String: Any] = [:]) async throws -> [String: Any] {
        try Task.checkCancellation()
        guard method != "Target.attachToTarget", method != "Target.detachFromTarget" else { throw Failure.invalidTarget }
        if let targetID, !Self.validTarget(targetID) { throw Failure.invalidTarget }
        try connect(to: browserSocket)
        let token = generation
        let sessionID: String?
        if let targetID { sessionID = try await attachedSession(for: targetID, token: token) }
        else { sessionID = nil }
        try Task.checkCancellation()
        guard generation == token, wire != nil else { throw Failure.disconnected }
        if let targetID, sessions[targetID] != sessionID { throw Failure.targetDetached }
        return try await request(method, parameters: parameters, sessionID: sessionID, targetID: targetID, token: token)
    }

    /// Call only after the lifecycle owner has confirmed page close/absence.
    /// Chrome has already destroyed its sessions; sending detach here can race
    /// the detached event and mistake "session not found" for a broken wire.
    func releaseTarget(_ targetID: String) async {
        guard !isShutdown else { return }
        targetGone(targetID)
    }

    func shutdown() {
        guard !isShutdown else { return }
        isShutdown = true
        disconnect(Failure.closed)
    }

    /// Bounded counters only; no URLs, titles, identifiers, or response payloads.
    func snapshot() -> [String: Any] {
        ["connected": wire != nil, "shutdown": isShutdown, "connections": connectionCount,
         "maximumConnections": maximumConnections, "disconnects": disconnectCount,
         "requests": requestCount, "completed": completedCount, "cancelled": cancelledCount,
         "timeouts": timeoutCount, "pending": pending.count, "attachedTargets": sessions.count,
         "attachingTargets": attachments.count]
    }

    private static func validTarget(_ value: String) -> Bool {
        value.range(of: "^[A-Za-z0-9_-]{1,128}$", options: .regularExpression) != nil
    }

    private func connect(to url: URL) throws {
        guard !isShutdown else { throw Failure.closed }
        guard url.scheme == "ws", ["127.0.0.1", "localhost", "[::1]", "::1"].contains(url.host ?? ""),
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
              url.path.hasPrefix("/devtools/browser/"), url.path.count > "/devtools/browser/".count else {
            throw Failure.invalidEndpoint
        }
        guard !retiredEndpoints.contains(url) else { throw Failure.disconnected }
        if endpoint == url, wire != nil { return }
        guard connectionCount < maximumConnections else { throw Failure.connectionBudget }
        if wire != nil { disconnect(Failure.disconnected) }
        connectionCount += 1
        let nextWire: ProtoPieCDPWire
        do { nextWire = try factory(url) } catch { throw Failure.disconnected }
        if let old = endpoint, old != url { retiredEndpoints.insert(old) }
        endpoint = url; wire = nextWire; generation = UUID()
        let token = generation
        // Do not retain the transport across a receive suspension. shutdown or
        // deinit can cancel the wire even when no more replies arrive.
        receiver = Task { @MainActor [weak self, nextWire] in
            while !Task.isCancelled {
                do {
                    let data = try await nextWire.receive()
                    guard !Task.isCancelled, self?.generation == token else { return }
                    self?.receive(data, token: token)
                } catch {
                    guard !Task.isCancelled, self?.generation == token else { return }
                    self?.disconnect(Failure.disconnected)
                    return
                }
            }
        }
    }

    private func attachedSession(for targetID: String, token: UUID) async throws -> String {
        if let sessionID = sessions[targetID] { return sessionID }
        if let existing = attachments[targetID] { return try await existing.task.value }
        guard sessions.count + attachments.count < maximumTargets else { throw Failure.capacity }
        let attempt = UUID()
        let task = Task { @MainActor [weak self] () throws -> String in
            guard let self else { throw Failure.closed }
            do {
                let result = try await self.request("Target.attachToTarget", parameters: ["targetId": targetID, "flatten": true],
                                                    sessionID: nil, targetID: targetID, attaching: true, token: token)
                guard self.generation == token else { throw Failure.disconnected }
                guard self.attachments[targetID]?.token == attempt else { throw Failure.targetDetached }
                guard let sessionID = result["sessionId"] as? String, Self.validTarget(sessionID),
                      !self.sessions.values.contains(sessionID) else {
                    if self.generation == token { self.disconnect(Failure.invalidResponse) }
                    throw Failure.invalidResponse
                }
                guard !self.detachedDuringAttach.contains(sessionID) else { throw Failure.targetDetached }
                self.attachments.removeValue(forKey: targetID)
                if self.attachments.isEmpty { self.detachedDuringAttach.removeAll() }
                self.sessions[targetID] = sessionID
                return sessionID
            } catch {
                if self.attachments[targetID]?.token == attempt { self.attachments.removeValue(forKey: targetID) }
                if self.attachments.isEmpty { self.detachedDuringAttach.removeAll() }
                throw error
            }
        }
        attachments[targetID] = Attachment(token: attempt, task: task)
        return try await task.value
    }

    private func request(_ method: String, parameters: [String: Any], sessionID: String?, targetID: String?,
                         attaching: Bool = false, token: UUID) async throws -> [String: Any] {
        try Task.checkCancellation()
        guard generation == token, let wire, !isShutdown else { throw Failure.disconnected }
        guard pending.count < maximumPending else { throw Failure.capacity }
        let id = nextID; nextID += 1
        var payload: [String: Any] = ["id": id, "method": method, "params": parameters]
        if let sessionID { payload["sessionId"] = sessionID }
        let data: Data
        do { data = try JSONSerialization.data(withJSONObject: payload) }
        catch { throw Failure.invalidResponse }
        let text = String(decoding: data, as: UTF8.self)
        requestCount += 1
        return try await withTaskCancellationHandler(operation: {
            try await withCheckedThrowingContinuation { continuation in
                let timeout = timeoutNanoseconds
                let timer = Task { @MainActor [weak self] in
                    do { try await Task.sleep(nanoseconds: timeout) } catch { return }
                    guard let self, self.generation == token, let entry = self.pending[id] else { return }
                    self.timeoutCount += 1
                    if entry.attaching { self.disconnect(Failure.timeout) }
                    else { self.finish(id, result: .failure(Failure.timeout)) }
                }
                pending[id] = Pending(generation: token, sessionID: sessionID, targetID: targetID,
                    attaching: attaching, continuation: continuation, deadline: timer, sender: nil)
                pending[id]?.sender = Task { @MainActor [weak self, wire] in
                    guard let self, self.generation == token, self.pending[id] != nil else { return }
                    do { try await wire.send(text) }
                    catch {
                        guard self.generation == token, self.pending[id] != nil else { return }
                        self.disconnect(Failure.disconnected)
                    }
                }
            }
        }, onCancel: { Task { @MainActor [weak self] in
            guard let self, self.generation == token, let entry = self.pending[id] else { return }
            self.cancelledCount += 1
            if entry.attaching { self.disconnect(CancellationError()) }
            else { self.finish(id, result: .failure(CancellationError())) }
        } })
    }

    private func receive(_ data: Data, token: UUID) {
        guard generation == token else { return }
        guard data.count <= 4 * 1_024 * 1_024,
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            disconnect(Failure.invalidResponse); return
        }
        if let id = object["id"] as? Int {
            guard let entry = pending[id], entry.generation == token else { return }
            let actualSession = object["sessionId"] as? String
            guard actualSession == entry.sessionID else { disconnect(Failure.invalidResponse); return }
            if let error = object["error"] as? [String: Any] {
                finish(id, result: .failure(Failure.rejected(error["code"] as? Int)))
            } else if let result = object["result"] as? [String: Any] {
                completedCount += 1; finish(id, result: .success(result))
            } else { disconnect(Failure.invalidResponse) }
            return
        }
        guard let method = object["method"] as? String, let parameters = object["params"] as? [String: Any] else { return }
        if method == "Target.detachedFromTarget", let sessionID = parameters["sessionId"] as? String {
            if let targetID = sessions.first(where: { $0.value == sessionID })?.key { targetGone(targetID) }
            else if !attachments.isEmpty {
                // An event can precede the attach response or its continuation.
                // Keep only a bounded, short-lived set while attaches are pending.
                guard detachedDuringAttach.count < maximumPending else { disconnect(Failure.invalidResponse); return }
                detachedDuringAttach.insert(sessionID)
            }
        } else if method == "Target.targetDestroyed", let targetID = parameters["targetId"] as? String {
            targetGone(targetID)
        }
    }

    private func targetGone(_ targetID: String) {
        sessions.removeValue(forKey: targetID)
        let attachment = attachments.removeValue(forKey: targetID)
        failRequests(targetID: targetID, error: Failure.targetDetached)
        attachment?.task.cancel()
        if attachments.isEmpty { detachedDuringAttach.removeAll() }
    }

    private func failRequests(targetID: String, error: Error) {
        let ids = pending.filter { $0.value.targetID == targetID }.map(\.key)
        for id in ids { finish(id, result: .failure(error)) }
    }

    private func finish(_ id: Int, result: Result<[String: Any], Error>) {
        guard let entry = pending.removeValue(forKey: id) else { return }
        entry.deadline.cancel(); entry.sender?.cancel()
        entry.continuation.resume(with: result)
    }

    private func disconnect(_ error: Error) {
        generation = UUID()
        receiver?.cancel(); receiver = nil
        let oldWire = wire; wire = nil
        if oldWire != nil { disconnectCount += 1 }
        oldWire?.close()
        let oldAttachments = attachments; attachments.removeAll(); sessions.removeAll()
        detachedDuringAttach.removeAll()
        let ids = Array(pending.keys)
        for id in ids { finish(id, result: .failure(error)) }
        for entry in oldAttachments.values { entry.task.cancel() }
    }
}
