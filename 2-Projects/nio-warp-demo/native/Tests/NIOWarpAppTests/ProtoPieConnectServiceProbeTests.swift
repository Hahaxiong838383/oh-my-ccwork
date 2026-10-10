import Foundation
import XCTest
@testable import NIOWarpApp

final class ProtoPieConnectServiceProbeTests: XCTestCase {
    private let playerURL = URL(string: "http://localhost:9981/pie?pieid=23")!

    private func response(_ status: Int = 200, url: URL? = nil, body: String,
                          contentType: String = "text/html") throws -> ProtoPieConnectServiceProbe.Status {
        let http = try XCTUnwrap(HTTPURLResponse(url: url ?? playerURL, statusCode: status,
                                                httpVersion: "HTTP/1.1", headerFields: ["Content-Type": contentType]))
        return ProtoPieConnectServiceProbe.classify(data: Data(body.utf8), response: http, expectedURL: playerURL)
    }

    func testHTTPPlayerPageDoesNotClaimRenderedOrMessageReadiness() throws {
        XCTAssertEqual(try response(body: "<html><body><div id='root'></div><script src='/player.js'></script></body></html>"), .playerPageAvailable)
        let result = ProtoPieConnectServiceProbe.Result(status: .playerPageAvailable, attempts: 1)
        XCTAssertFalse(result.messageConnectionVerified)
        XCTAssertTrue(result.summary.contains("未验证"))
    }

    func testClassifiesLoginHomeMissingPrototypeAndUnsupportedResponsesSeparately() throws {
        XCTAssertEqual(try response(401, body: ""), .loginRequired)
        XCTAssertEqual(try response(body: "<html><input type='password'></html>"), .loginRequired)
        XCTAssertEqual(try response(url: URL(string: "http://localhost:9981/login")!, body: "<html>Login</html>"), .loginRequired)
        XCTAssertEqual(try response(url: URL(string: "http://localhost:9981/")!, body: "<html>ProtoPie Connect</html>"), .serviceHome)
        XCTAssertEqual(try response(404, body: ""), .prototypeUnavailable)
        XCTAssertEqual(try response(body: "<html>Prototype not found</html>"), .prototypeUnavailable)
        XCTAssertEqual(try response(url: URL(string: "http://localhost:9981/pie?pieid=24")!, body: "<html>Player</html>"), .unsupportedPage)
        XCTAssertEqual(try response(url: URL(string: "http://other.example/pie?pieid=23")!, body: "<html>Player</html>"), .unsupportedPage)
        XCTAssertEqual(try response(body: "{}", contentType: "application/json"), .unsupportedPage)
        XCTAssertEqual(try response(body: ""), .unsupportedPage)
    }

    func testTransientHTTPFailureRetriesWithinLimitAndReturnsPageAvailability() async throws {
        let transport = ProbeHTTPFixture(responses: [503, 503, 200])
        let session = transport.session()
        defer { session.invalidateAndCancel(); transport.remove() }
        let probe = ProtoPieConnectServiceProbe(timeout: 0.2, retryLimit: 2, retryDelay: 0, session: session)
        let result = try await probe.probe(transport.url)
        XCTAssertEqual(result.status, .playerPageAvailable)
        XCTAssertEqual(result.attempts, 3)
        XCTAssertFalse(result.messageConnectionVerified)
    }

    func testTimeoutReturnsActionableUnavailableWithinBoundedAttempts() async throws {
        let transport = ProbeHTTPFixture(responses: [], neverResponds: true)
        let session = transport.session()
        defer { session.invalidateAndCancel(); transport.remove() }
        let probe = ProtoPieConnectServiceProbe(timeout: 0.05, retryLimit: 1, retryDelay: 0, session: session)
        let start = Date()
        let result = try await probe.probe(transport.url)
        guard case .unavailable = result.status else { return XCTFail("超时不能报告播放器可用") }
        XCTAssertEqual(result.attempts, 2)
        XCTAssertLessThan(Date().timeIntervalSince(start), 1)
        XCTAssertTrue(result.summary.contains("Connect"))
    }

    func testCancellationStopsRetryAndIsNotReportedAsConnectionFailure() async throws {
        let transport = ProbeHTTPFixture(responses: [], neverResponds: true)
        let session = transport.session()
        defer { session.invalidateAndCancel(); transport.remove() }
        let probe = ProtoPieConnectServiceProbe(timeout: 2, retryLimit: 2, retryDelay: 0, session: session)
        let task = Task { try await probe.probe(transport.url) }
        try await Task.sleep(nanoseconds: 20_000_000)
        task.cancel()
        do { _ = try await task.value; XCTFail("取消应抛出 CancellationError") }
        catch is CancellationError { }
        catch { XCTFail("取消被误报：\(error)") }
    }

    func testOversizedResponseStopsWithoutRetryAndDoesNotExposeURLOrBody() async throws {
        let body = Data(("<html>secret-input-marker" + String(repeating: "x", count: 600_000) + "</html>").utf8)
        let transport = ProbeHTTPFixture(responses: [200], body: body)
        let session = transport.session()
        defer { session.invalidateAndCancel(); transport.remove() }
        let probe = ProtoPieConnectServiceProbe(timeout: 2, retryLimit: 2, retryDelay: 0, session: session)
        let result = try await probe.probe(transport.url)
        XCTAssertEqual(result.status, .unavailable("检测响应超过 512 KiB 限制"))
        XCTAssertEqual(result.attempts, 1)
        XCTAssertFalse(result.summary.contains("probe-"))
        XCTAssertFalse(result.summary.contains("secret-input-marker"))
    }
}

/// Only the external HTTP transport is substituted; retries, time bounds,
/// cancellation, response classification and summaries execute production code.
private final class ProbeHTTPFixture {
    let url = URL(string: "http://probe-\(UUID().uuidString.lowercased()).test/pie?pieid=23")!
    var responses: [Int]
    let neverResponds: Bool
    let body: Data
    private let lock = NSLock()
    init(responses: [Int], neverResponds: Bool = false, body: Data = Data("<html><div id='root'></div></html>".utf8)) {
        self.responses = responses; self.neverResponds = neverResponds; self.body = body
        ProbeHTTPProtocol.register(self)
    }
    func nextStatus() -> Int { lock.lock(); defer { lock.unlock() }; return responses.isEmpty ? 503 : responses.removeFirst() }
    func session() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ProbeHTTPProtocol.self]
        return URLSession(configuration: configuration)
    }
    func remove() { ProbeHTTPProtocol.unregister(self) }
}

private final class ProbeHTTPProtocol: URLProtocol {
    private static let lock = NSLock()
    private static var fixtures: [String: ProbeHTTPFixture] = [:]
    static func register(_ fixture: ProbeHTTPFixture) { lock.lock(); defer { lock.unlock() }; fixtures[fixture.url.host!] = fixture }
    static func unregister(_ fixture: ProbeHTTPFixture) { lock.lock(); defer { lock.unlock() }; fixtures.removeValue(forKey: fixture.url.host!) }
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host?.hasPrefix("probe-") == true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.lock.lock(); let fixture = Self.fixtures[request.url?.host ?? ""]; Self.lock.unlock()
        guard let fixture else { client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost)); return }
        guard !fixture.neverResponds else { return }
        let response = HTTPURLResponse(url: request.url!, statusCode: fixture.nextStatus(), httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": "text/html"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: fixture.body)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() { }
}
