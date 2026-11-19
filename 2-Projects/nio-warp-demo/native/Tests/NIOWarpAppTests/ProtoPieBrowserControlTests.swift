import Foundation
import XCTest
@testable import NIOWarpApp

@MainActor private final class BrowserControlFixtureWire: ProtoPieCDPWire {
    var sent = [[String: Any]]()
    var closeCount = 0
    var unansweredMethod: String?
    private var incoming = [Data]()
    private var waiting: CheckedContinuation<Data, Error>?

    func send(_ text: String) async throws {
        guard closeCount == 0 else { throw ProtoPieCDPTransport.Failure.disconnected }
        let request = try JSONSerialization.jsonObject(with: Data(text.utf8)) as! [String: Any]
        sent.append(request)
        if request["method"] as? String == unansweredMethod { return }
        var result: [String: Any] = ["echo": request["method"]!]
        if request["method"] as? String == "Target.attachToTarget" {
            let target = (request["params"] as! [String: Any])["targetId"] as! String
            result = ["sessionId": "session-" + target]
        }
        var response: [String: Any] = ["id": request["id"]!, "result": result]
        if let sessionID = request["sessionId"] { response["sessionId"] = sessionID }
        let data = try JSONSerialization.data(withJSONObject: response)
        if let previous = waiting { waiting = nil; previous.resume(returning: data) }
        else { incoming.append(data) }
    }

    func receive() async throws -> Data {
        if !incoming.isEmpty { return incoming.removeFirst() }
        if closeCount > 0 { throw ProtoPieCDPTransport.Failure.disconnected }
        return try await withCheckedThrowingContinuation { waiting = $0 }
    }

    func close() {
        closeCount += 1
        let previous = waiting; waiting = nil
        previous?.resume(throwing: ProtoPieCDPTransport.Failure.disconnected)
    }
}

@MainActor final class ProtoPieBrowserControlTests: XCTestCase {
    private var suites = [String]()
    private let browser = URL(string: "ws://127.0.0.1:9222/devtools/browser/control-fixture")!

    override func tearDown() async throws {
        for suite in suites { UserDefaults(suiteName: suite)?.removePersistentDomain(forName: suite) }
        suites.removeAll()
    }

    private func preferences(_ mode: ProtoPieControlMode? = nil) -> UserDefaults {
        let name = "NIOWarp.BrowserControlTests." + UUID().uuidString
        suites.append(name)
        let defaults = UserDefaults(suiteName: name)!
        if let mode { defaults.set(mode.rawValue, forKey: ProtoPieControlMode.preferenceKey) }
        return defaults
    }

    private func page(_ target: String) -> ProtoPiePageEndpoint {
        ProtoPiePageEndpoint(browserSocket: browser, targetID: target,
            legacySocket: URL(string: "ws://127.0.0.1:1/devtools/page/legacy-must-not-be-used")!)
    }

    private func diagnostics(_ defaults: UserDefaults) throws -> [String: Any] {
        try XCTUnwrap(defaults.dictionary(forKey: ProtoPieBrowserControl.runtimeKey))
    }

    private func legacyBrowser() throws -> URL {
        guard let value = ProcessInfo.processInfo.environment["NIO_WARP_CONTROL_TEST_SOCKET"],
              let socket = URL(string: value), socket.host == "127.0.0.1" else {
            throw XCTSkip("Run the isolated browser-control runner to start its loopback-only WebSocket fixture.")
        }
        return socket
    }

    func testModeIsCapturedForLifetimeAndPreferenceOnlyAffectsNextWrapper() async throws {
        let defaults = preferences()
        let wire = BrowserControlFixtureWire()
        var connections = 0
        let transport = ProtoPieCDPTransport(wireFactory: { _ in connections += 1; return wire })
        let control = ProtoPieBrowserControl(defaults: defaults, transport: transport)
        defer { control.shutdown() }
        XCTAssertEqual(control.mode, .persistent)
        defaults.set(ProtoPieControlMode.legacy.rawValue, forKey: ProtoPieControlMode.preferenceKey)
        XCTAssertEqual(ProtoPieControlMode.selected(in: defaults), .legacy)
        XCTAssertEqual(control.mode, .persistent)
        let response = try await control.call(browser, method: "Browser.getVersion")
        XCTAssertEqual(response["echo"] as? String, "Browser.getVersion")
        XCTAssertEqual(connections, 1)
        let next = ProtoPieBrowserControl(defaults: defaults)
        XCTAssertEqual(next.mode, .legacy)
        next.shutdown()
        // An unknown saved value is safe for the next launch, without changing this instance.
        defaults.set("unknown-future-mode", forKey: ProtoPieControlMode.preferenceKey)
        XCTAssertEqual(ProtoPieControlMode.selected(in: defaults), .persistent)
        XCTAssertEqual(next.mode, .legacy)
    }

    func testBrowserAndPageCallsReuseOneWireAndRouteOnlyOwnedTargetSession() async throws {
        let defaults = preferences(.persistent)
        let wire = BrowserControlFixtureWire()
        var endpoints = [URL]()
        let transport = ProtoPieCDPTransport(wireFactory: { endpoints.append($0); return wire })
        let control = ProtoPieBrowserControl(defaults: defaults, transport: transport)
        defer { control.shutdown() }
        let target = page("owned-page")
        for _ in 0..<40 {
            _ = try await control.call(browser, method: "Browser.getWindowBounds", parameters: ["windowId": 11])
            _ = try await control.call(target, method: "Runtime.evaluate", parameters: ["expression": "({width:123})"])
        }
        XCTAssertEqual(endpoints, [browser])
        XCTAssertEqual(wire.sent.filter { $0["method"] as? String == "Target.attachToTarget" }.count, 1)
        for request in wire.sent where request["method"] as? String == "Runtime.evaluate" {
            XCTAssertEqual(request["sessionId"] as? String, "session-owned-page")
        }
        for request in wire.sent where request["method"] as? String == "Browser.getWindowBounds" {
            XCTAssertNil(request["sessionId"])
        }
        XCTAssertEqual(transport.snapshot()["requests"] as? Int, 81)
        XCTAssertEqual(transport.snapshot()["completed"] as? Int, 81)
        XCTAssertEqual(transport.snapshot()["attachedTargets"] as? Int, 1)
        XCTAssertEqual(transport.snapshot()["pending"] as? Int, 0)
    }

    func testConfirmedTargetReleaseDoesNotCloseOtherPageOrSendAnotherMutation() async throws {
        let wire = BrowserControlFixtureWire()
        let transport = ProtoPieCDPTransport(wireFactory: { _ in wire })
        let control = ProtoPieBrowserControl(defaults: preferences(), transport: transport)
        defer { control.shutdown() }
        _ = try await control.call(page("old"), method: "Runtime.evaluate")
        _ = try await control.call(page("committed"), method: "Runtime.evaluate")
        let before = wire.sent.count
        await control.releaseTarget("old")
        await control.releaseTarget("unknown")
        XCTAssertEqual(wire.sent.count, before)
        XCTAssertEqual(wire.closeCount, 0)
        XCTAssertEqual(transport.snapshot()["attachedTargets"] as? Int, 1)
        _ = try await control.call(page("committed"), method: "Runtime.evaluate")
        XCTAssertEqual(wire.sent.last?["sessionId"] as? String, "session-committed")
        XCTAssertEqual(wire.sent.filter { $0["method"] as? String == "Target.closeTarget" }.count, 0)
        XCTAssertEqual(transport.snapshot()["connections"] as? Int, 1)
    }

    func testMutationTimeoutIsReturnedWithoutLegacyFallbackOrReplay() async throws {
        let defaults = preferences()
        let wire = BrowserControlFixtureWire(); wire.unansweredMethod = "Browser.setWindowBounds"
        let transport = ProtoPieCDPTransport(timeout: 0.02, wireFactory: { _ in wire })
        let control = ProtoPieBrowserControl(defaults: defaults, transport: transport)
        do {
            _ = try await control.call(browser, method: "Browser.setWindowBounds", parameters: ["windowId": 4])
            XCTFail("A lost mutation response must be returned as an uncertain failure")
        } catch { XCTAssertEqual(error as? ProtoPieCDPTransport.Failure, .timeout) }
        control.shutdown()
        XCTAssertEqual(wire.sent.count, 1)
        XCTAssertEqual(try diagnostics(defaults)["legacyRequests"] as? Int, 0)
        XCTAssertEqual(try diagnostics(defaults)["timeouts"] as? Int, 1)
        XCTAssertEqual(try diagnostics(defaults)["pending"] as? Int, 0)
    }

    func testShutdownIsTerminalAndPublishesBoundedPayloadFreeDiagnostics() async throws {
        let defaults = preferences()
        let wire = BrowserControlFixtureWire()
        let transport = ProtoPieCDPTransport(wireFactory: { _ in wire })
        let control = ProtoPieBrowserControl(defaults: defaults, transport: transport)
        _ = try await control.call(page("private-target-canary"), method: "Runtime.evaluate",
                                   parameters: ["expression": "private-script-canary", "url": "https://example.invalid/private-link-canary"])
        control.shutdown(); control.shutdown()
        XCTAssertEqual(wire.closeCount, 1)
        let diagnostic = try diagnostics(defaults)
        XCTAssertEqual(diagnostic["shutdown"] as? Bool, true)
        XCTAssertEqual(diagnostic["connected"] as? Bool, false)
        XCTAssertEqual(diagnostic["mode"] as? String, "persistent")
        XCTAssertEqual(diagnostic["requests"] as? Int, 2)
        XCTAssertEqual(diagnostic["completed"] as? Int, 2)
        XCTAssertEqual(diagnostic["attachedTargets"] as? Int, 0)
        let text = String(data: try JSONSerialization.data(withJSONObject: diagnostic), encoding: .utf8)!
        for secret in ["private-target-canary", "private-script-canary", "private-link-canary", browser.absoluteString, "Runtime.evaluate"] {
            XCTAssertFalse(text.contains(secret))
        }
        XCTAssertTrue(diagnostic.values.allSatisfy { $0 is String || $0 is NSNumber })
        let before = wire.sent.count
        do { _ = try await control.call(browser, method: "Browser.getVersion"); XCTFail("Shutdown cannot reconnect") }
        catch { XCTAssertEqual(error as? ProtoPieCDPTransport.Failure, .closed) }
        do { _ = try await control.call(page("page"), method: "Runtime.evaluate"); XCTFail("Shutdown cannot attach a new page") }
        catch { XCTAssertEqual(error as? ProtoPieCDPTransport.Failure, .closed) }
        XCTAssertEqual(wire.sent.count, before)
        XCTAssertEqual(transport.snapshot()["connections"] as? Int, 1)
    }

    func testLegacyUsesOriginalBrowserAndPageSocketsAndRemainsFixedAfterPreferenceChange() async throws {
        let socket = try legacyBrowser()
        let defaults = preferences(.legacy)
        var persistentConnections = 0
        let transport = ProtoPieCDPTransport(wireFactory: { _ in
            persistentConnections += 1
            return BrowserControlFixtureWire()
        })
        let control = ProtoPieBrowserControl(defaults: defaults, transport: transport)
        defer { control.shutdown() }
        let browserResult = try await control.call(socket, method: "Browser.getVersion")
        defaults.set(ProtoPieControlMode.persistent.rawValue, forKey: ProtoPieControlMode.preferenceKey)
        let pageSocket = socket.deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("page").appendingPathComponent("legacy-owned-page")
        let endpoint = ProtoPiePageEndpoint(browserSocket: browser, targetID: "unused-flattened-target", legacySocket: pageSocket)
        let pageResult = try await control.call(endpoint, method: "Runtime.evaluate", parameters: ["expression": "1 + 1"])
        XCTAssertEqual(browserResult["requestPath"] as? String, socket.path)
        XCTAssertEqual(pageResult["requestPath"] as? String, pageSocket.path)
        XCTAssertEqual(browserResult["echoMethod"] as? String, "Browser.getVersion")
        XCTAssertEqual(pageResult["echoMethod"] as? String, "Runtime.evaluate")
        XCTAssertEqual(browserResult["requestId"] as? Int, 1)
        XCTAssertEqual(pageResult["requestId"] as? Int, 1)
        XCTAssertNotEqual(browserResult["connectionOrdinal"] as? Int, pageResult["connectionOrdinal"] as? Int)
        XCTAssertEqual(pageResult["hasSessionID"] as? Bool, false)
        XCTAssertEqual(control.mode, .legacy)
        XCTAssertEqual(persistentConnections, 0)
        await control.releaseTarget("unused-flattened-target")
        XCTAssertEqual(persistentConnections, 0)
        control.shutdown()
        let diagnostic = try diagnostics(defaults)
        XCTAssertEqual(diagnostic["legacyRequests"] as? Int, 2)
        XCTAssertEqual(diagnostic["requests"] as? Int, 0)
        XCTAssertEqual(diagnostic["connections"] as? Int, 0)
        XCTAssertEqual(diagnostic["mode"] as? String, "legacy")
    }

    func testLegacyShutdownRejectsBothEntryPointsWithoutCreatingAnySocket() async throws {
        let defaults = preferences(.legacy)
        var persistentConnections = 0
        let transport = ProtoPieCDPTransport(wireFactory: { _ in persistentConnections += 1; return BrowserControlFixtureWire() })
        let control = ProtoPieBrowserControl(defaults: defaults, transport: transport)
        control.shutdown()
        do { _ = try await control.call(browser, method: "Browser.getVersion"); XCTFail("Legacy browser call must stop at shutdown") }
        catch { XCTAssertEqual(error as? ProtoPieCDPTransport.Failure, .closed) }
        do { _ = try await control.call(page("page"), method: "Runtime.evaluate"); XCTFail("Legacy page call must stop at shutdown") }
        catch { XCTAssertEqual(error as? ProtoPieCDPTransport.Failure, .closed) }
        XCTAssertEqual(persistentConnections, 0)
        XCTAssertEqual(try diagnostics(defaults)["legacyRequests"] as? Int, 0)
        XCTAssertEqual(try diagnostics(defaults)["shutdown"] as? Bool, true)
    }

    func testLegacyCancellationDoesNotCreatePersistentFallbackConnection() async throws {
        let socket = try legacyBrowser()
        guard let seenPath = ProcessInfo.processInfo.environment["NIO_WARP_CONTROL_TEST_CANCEL_SEEN"] else {
            throw XCTSkip("The loopback runner supplies its request-arrival marker.")
        }
        let defaults = preferences(.legacy)
        var persistentConnections = 0
        let transport = ProtoPieCDPTransport(wireFactory: { _ in persistentConnections += 1; return BrowserControlFixtureWire() })
        let control = ProtoPieBrowserControl(defaults: defaults, transport: transport)
        let task = Task { @MainActor in
            try await control.call(socket, method: "Fixture.awaitCancellation")
        }
        for _ in 0..<200 {
            if FileManager.default.fileExists(atPath: seenPath) { break }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTAssertTrue(FileManager.default.fileExists(atPath: seenPath), "Cancel only after the fixture receives the real legacy request")
        task.cancel()
        do { _ = try await task.value; XCTFail("Cancelled call must fail") }
        catch { XCTAssertTrue(task.isCancelled) }
        control.shutdown()
        XCTAssertEqual(persistentConnections, 0)
        XCTAssertEqual(try diagnostics(defaults)["legacyRequests"] as? Int, 1)
    }
}
