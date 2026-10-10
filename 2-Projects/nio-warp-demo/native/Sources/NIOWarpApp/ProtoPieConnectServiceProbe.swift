import Foundation

/// HTTP availability is separate from the browser's rendered-player check and
/// from Connect's message channel; neither is verified by an HTTP response.
final class ProtoPieConnectServiceProbe {
    enum Status: Equatable {
        case playerPageAvailable, loginRequired, serviceHome, prototypeUnavailable, unsupportedPage
        case unavailable(String)
    }

    struct Result: Equatable {
        let status: Status
        let attempts: Int
        var messageConnectionVerified: Bool { false }
        var summary: String {
            switch status {
            case .playerPageAvailable: return "Connect 浏览器页面可访问；等待画面验证，消息连接未验证。"
            case .loginRequired: return "请在 Connect 完成登录或授权，再重新测试。消息连接未验证。"
            case .serviceHome: return "Connect 服务首页可访问；请加载原型并复制 /pie?pieid=… 完整链接。消息连接未验证。"
            case .prototypeUnavailable: return "Connect 原型不存在或已移除；请重新加载原型并复制链接。消息连接未验证。"
            case .unsupportedPage: return "返回内容不是当前 Connect 原型页面；请确认完整链接。消息连接未验证。"
            case .unavailable(let reason): return "Connect 服务无法访问（\(reason)）；请打开 Connect、确认端口后重试。消息连接未验证。"
            }
        }
    }

    private let timeout: TimeInterval
    private let retryLimit: Int
    private let retryDelay: TimeInterval
    private let session: URLSession
    private let ownsSession: Bool
    private static let maximumResponseBytes = 512 * 1024
    private enum BodyLimitError: Error { case exceeded }

    init(timeout: TimeInterval = 3, retryLimit: Int = 2, retryDelay: TimeInterval = 0.25, session: URLSession? = nil) {
        self.timeout = timeout.isFinite ? min(max(timeout, 0.01), 30) : 3
        self.retryLimit = min(max(retryLimit, 0), 3)
        self.retryDelay = retryDelay.isFinite ? min(max(retryDelay, 0), 5) : 0.25
        if let session { self.session = session; ownsSession = false }
        else {
            let configuration = URLSessionConfiguration.ephemeral
            configuration.timeoutIntervalForRequest = self.timeout
            configuration.timeoutIntervalForResource = self.timeout
            self.session = URLSession(configuration: configuration); ownsSession = true
        }
    }

    deinit { if ownsSession { session.invalidateAndCancel() } }

    func probe(_ url: URL) async throws -> Result {
        let source = try ProtoPieConnectSource.parse(url.absoluteString)
        try Task.checkCancellation()
        for attempt in 1...(retryLimit + 1) {
            let status: Status
            var shouldRetry = true
            do {
                var request = URLRequest(url: source.url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
                request.setValue("text/html, application/xhtml+xml", forHTTPHeaderField: "Accept")
                let (data, response) = try await boundedLoad(request)
                try Task.checkCancellation()
                if let response = response as? HTTPURLResponse {
                    status = Self.classify(data: data, response: response, expectedURL: source.url)
                } else { status = .unsupportedPage }
            } catch {
                if Task.isCancelled || error is CancellationError || (error as? URLError)?.code == .cancelled {
                    throw CancellationError()
                }
                let reason: String
                if error is BodyLimitError {
                    reason = "检测响应超过 512 KiB 限制"
                    shouldRetry = false
                } else if let error = error as? URLError {
                    switch error.code {
                    case .timedOut: reason = "检测超时"
                    case .cannotConnectToHost, .cannotFindHost, .notConnectedToInternet: reason = "服务未启动或地址不可达"
                    default: reason = "网络错误 \(error.code.rawValue)"
                    }
                } else { reason = "检测失败" }
                status = .unavailable(reason)
            }
            if case .unavailable = status, shouldRetry, attempt <= retryLimit {
                if retryDelay > 0 { try await Task.sleep(nanoseconds: UInt64(retryDelay * 1_000_000_000)) }
                try Task.checkCancellation()
                continue
            }
            return Result(status: status, attempts: attempt)
        }
        // The finite attempt loop always returns or throws.
        throw ProtoPieError.unavailable("Connect 检测未完成，请重试。")
    }

    static func classify(data: Data, response: HTTPURLResponse, expectedURL: URL) -> Status {
        let code = response.statusCode
        guard let actualURL = response.url else { return .unsupportedPage }
        let path = actualURL.path.lowercased()
        if code == 401 || code == 403 || ["/login", "/signin", "/sign-in", "/auth"].contains(path) { return .loginRequired }
        if code == 404 || code == 410 { return .prototypeUnavailable }
        guard (200...299).contains(code) else { return .unavailable("HTTP \(code)") }
        let body = String(decoding: data.prefix(262_144), as: UTF8.self).lowercased()
        if body.range(of: #"<input\b[^>]*\btype\s*=\s*['"]?password\b"#, options: .regularExpression) != nil {
            return .loginRequired
        }
        if ["prototype not found", "pie not found", "invalid pieid", "原型不存在", "原型已移除"].contains(where: body.contains) {
            return .prototypeUnavailable
        }
        guard sameOrigin(actualURL, expectedURL) else { return .unsupportedPage }
        if path == "/" || path == "/index.html" { return .serviceHome }
        guard ProtoPieConnectSource.matchesPage(actualURL, expected: expectedURL),
              !body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return .unsupportedPage }
        let mimeType = response.mimeType?.lowercased()
        guard ["text/html", "application/xhtml+xml"].contains(mimeType ?? "") ||
                (mimeType == nil && (body.contains("<html") || body.contains("<!doctype html"))) else { return .unsupportedPage }
        return .playerPageAvailable
    }

    private func boundedLoad(_ request: URLRequest) async throws -> (Data, URLResponse) {
        let session = session, timeout = timeout
        return try await withThrowingTaskGroup(of: (Data, URLResponse).self) { group in
            group.addTask {
                let (bytes, response) = try await session.bytes(for: request)
                return try await withTaskCancellationHandler {
                    defer { bytes.task.cancel() }
                    guard response.expectedContentLength <= Int64(Self.maximumResponseBytes) else { throw BodyLimitError.exceeded }
                    var data = Data()
                    data.reserveCapacity(16_384)
                    for try await byte in bytes {
                        try Task.checkCancellation()
                        guard data.count < Self.maximumResponseBytes else { throw BodyLimitError.exceeded }
                        data.append(byte)
                    }
                    return (data, response)
                } onCancel: { bytes.task.cancel() }
            }
            group.addTask {
                try await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
                throw URLError(.timedOut)
            }
            defer { group.cancelAll() }
            guard let response = try await group.next() else { throw CancellationError() }
            return response
        }
    }

    private static func sameOrigin(_ actual: URL, _ expected: URL) -> Bool {
        guard let lhs = URLComponents(url: actual, resolvingAgainstBaseURL: false),
              let rhs = URLComponents(url: expected, resolvingAgainstBaseURL: false),
              lhs.scheme?.lowercased() == rhs.scheme?.lowercased(), lhs.host?.lowercased() == rhs.host?.lowercased() else { return false }
        let defaultPort = rhs.scheme?.lowercased() == "https" ? 443 : 80
        return (lhs.port ?? defaultPort) == (rhs.port ?? defaultPort)
    }
}
