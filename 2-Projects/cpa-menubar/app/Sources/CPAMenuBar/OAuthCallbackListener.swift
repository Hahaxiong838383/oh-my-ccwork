import Foundation
import Network

final class OAuthCallbackListener: @unchecked Sendable {
    private var listener: NWListener?
    private let queue = DispatchQueue(label: "com.hahaxiong.cpa-menubar.oauth")
    private let lock = NSLock()
    private var completion: ((Result<URL, Error>) -> Void)?
    private var generation = UUID()
    private let port: NWEndpoint.Port

    init(port: UInt16 = 1455) {
        self.port = NWEndpoint.Port(rawValue: port) ?? .any
    }

    var listeningPort: UInt16? {
        lock.lock()
        defer { lock.unlock() }
        return listener?.port?.rawValue
    }

    func start(expectedState: String, completion: @escaping (Result<URL, Error>) -> Void) throws {
        stop()
        let listener = try NWListener(using: .tcp, on: port)
        let generation = UUID()
        lock.lock()
        self.listener = listener
        self.completion = completion
        self.generation = generation
        lock.unlock()

        listener.stateUpdateHandler = { [weak self] state in
            if case let .failed(error) = state {
                self?.finish(.failure(error), generation: generation)
            }
        }
        listener.newConnectionHandler = { [weak self] connection in
            self?.handle(connection, expectedState: expectedState, generation: generation)
        }
        listener.start(queue: queue)
    }

    func stop() {
        lock.lock()
        listener?.cancel()
        listener = nil
        completion = nil
        generation = UUID()
        lock.unlock()
    }

    private func handle(_ connection: NWConnection, expectedState: String, generation: UUID) {
        connection.start(queue: queue)
        connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, _, error in
            guard let self else { return }
            if error != nil {
                connection.cancel()
                return
            }
            guard let data,
                  let request = String(data: data, encoding: .utf8),
                  let firstLine = request.components(separatedBy: "\r\n").first,
                  let target = firstLine.split(separator: " ").dropFirst().first,
                  let url = URL(string: "http://localhost:1455\(target)")
            else {
                sendResponse(connection, success: false)
                return
            }
            guard OAuthCallbackValidation.matches(url, expectedState: expectedState) else {
                sendResponse(connection, success: false)
                return
            }
            sendResponse(connection, success: true)
            finish(.success(url), generation: generation)
        }
    }

    private func sendResponse(_ connection: NWConnection, success: Bool) {
        let message = success ? "授权已收到，可以关闭此页面。" : "授权回调无效，请返回应用重试。"
        let body = "<html><meta charset=\"utf-8\"><body style=\"font-family:-apple-system;padding:48px\"><h2>CPA Menu</h2><p>\(message)</p></body></html>"
        let response = "HTTP/1.1 \(success ? "200 OK" : "400 Bad Request")\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: \(body.utf8.count)\r\nConnection: close\r\n\r\n\(body)"
        connection.send(content: Data(response.utf8), completion: .contentProcessed { _ in connection.cancel() })
    }

    private func finish(_ result: Result<URL, Error>, generation: UUID) {
        lock.lock()
        guard self.generation == generation else {
            lock.unlock()
            return
        }
        let completion = completion
        self.completion = nil
        listener?.cancel()
        listener = nil
        lock.unlock()
        completion?(result)
    }
}

enum OAuthListenerError: LocalizedError {
    case invalidRequest

    var errorDescription: String? { "无法读取 OAuth 回调" }
}
