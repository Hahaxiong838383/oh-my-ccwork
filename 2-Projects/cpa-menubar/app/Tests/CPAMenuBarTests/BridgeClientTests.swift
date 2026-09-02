import Foundation
import XCTest
@testable import CPAMenuBar

final class BridgeClientTests: XCTestCase {
    override func tearDown() {
        URLProtocolStub.handler = nil
        super.tearDown()
    }

    func testRemoveInvalidAccountRequestContract() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [URLProtocolStub.self]
        let session = URLSession(configuration: configuration)
        let client = BridgeClient(
            baseURL: URL(string: "https://bridge.example/desktop/v1")!,
            token: "desktop-token",
            session: session
        )
        URLProtocolStub.handler = { request in
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.url?.absoluteString, "https://bridge.example/desktop/v1/accounts/abc123def456/remove")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer desktop-token")
            let body = try requestBody(request)
            let decoded = try JSONSerialization.jsonObject(with: body) as? [String: String]
            XCTAssertEqual(decoded, ["confirm": "REMOVE_INVALID_ACCOUNT"])
            let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            return (response, Data(#"{"account_id":"abc123def456","status":"removed"}"#.utf8))
        }

        let response = try await client.removeInvalidAccount(accountID: "abc123def456")
        XCTAssertEqual(response.accountID, "abc123def456")
        XCTAssertEqual(response.status, "removed")
    }
}

private func requestBody(_ request: URLRequest) throws -> Data {
    if let body = request.httpBody {
        return body
    }
    guard let stream = request.httpBodyStream else {
        throw URLError(.cannotDecodeContentData)
    }
    stream.open()
    defer { stream.close() }
    var data = Data()
    let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: 4096)
    defer { buffer.deallocate() }
    while stream.hasBytesAvailable {
        let count = stream.read(buffer, maxLength: 4096)
        if count < 0 {
            throw stream.streamError ?? URLError(.cannotDecodeContentData)
        }
        if count == 0 { break }
        data.append(buffer, count: count)
    }
    return data
}

private final class URLProtocolStub: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: ((URLRequest) throws -> (HTTPURLResponse, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        do {
            guard let handler = Self.handler else {
                throw URLError(.badServerResponse)
            }
            let (response, data) = try handler(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}
