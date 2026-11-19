import Foundation
import XCTest
@testable import NIOWarpApp

@MainActor private final class CDPFixtureWire: ProtoPieCDPWire {
    var sent = [[String: Any]]()
    var closed = false
    var onSend: (([String: Any], CDPFixtureWire) -> Void)?
    private var incoming = [Result<Data, Error>]()
    private var waiting: CheckedContinuation<Data, Error>?

    func send(_ text: String) async throws {
        guard !closed else { throw ProtoPieCDPTransport.Failure.disconnected }
        let value = try JSONSerialization.jsonObject(with: Data(text.utf8)) as! [String: Any]
        sent.append(value); onSend?(value, self)
    }
    func receive() async throws -> Data {
        if !incoming.isEmpty { return try incoming.removeFirst().get() }
        if closed { throw ProtoPieCDPTransport.Failure.disconnected }
        return try await withCheckedThrowingContinuation { waiting = $0 }
    }
    func close() { closed = true; let old = waiting; waiting = nil; old?.resume(throwing: ProtoPieCDPTransport.Failure.disconnected) }
    func push(_ value: [String: Any]) {
        let result = Result { try JSONSerialization.data(withJSONObject: value) }
        if let old = waiting { waiting = nil; old.resume(with: result) }
        else { incoming.append(result) }
    }
    func reply(_ request: [String: Any], result: [String: Any] = [:]) {
        var response: [String: Any] = ["id": request["id"]!, "result": result]
        if let session = request["sessionId"] { response["sessionId"] = session }
        push(response)
    }
    func automatic() {
        onSend = { request, wire in
            if request["method"] as? String == "Target.attachToTarget" {
                let id = (request["params"] as! [String: Any])["targetId"] as! String
                wire.reply(request, result: ["sessionId": "session-" + id])
            } else { wire.reply(request, result: ["echo": request["method"]!]) }
        }
    }
}

@MainActor final class ProtoPieCDPTransportTests: XCTestCase {
    private let endpoint = URL(string: "ws://127.0.0.1:9222/devtools/browser/fixture")!
    private func waitUntil(_ condition: () -> Bool) async {
        for _ in 0..<2000 { if condition() { return }; await Task.yield() }
        XCTFail("Condition did not settle")
    }
    private func outcome(_ task: Task<[String: Any], Error>) async -> Error? {
        do { _ = try await task.value; return nil } catch { return error }
    }

    func testHundredsOfTargetLifecyclesUseOneBrowserSocket() async throws {
        let wire = CDPFixtureWire(); wire.automatic()
        var connections = 0
        let transport = ProtoPieCDPTransport(wireFactory: { _ in connections += 1; return wire })
        defer { transport.shutdown() }
        for index in 0..<200 {
            let target = "page-\(index)"
            _ = try await transport.call(browserSocket: endpoint, targetID: target, method: "Runtime.evaluate")
            _ = try await transport.call(browserSocket: endpoint, targetID: target, method: "Page.getLayoutMetrics")
            _ = try await transport.call(browserSocket: endpoint, method: "Target.closeTarget", parameters: ["targetId": target])
            await transport.releaseTarget(target)
        }
        XCTAssertEqual(connections, 1)
        XCTAssertEqual(wire.sent.filter { $0["method"] as? String == "Target.attachToTarget" }.count, 200)
        XCTAssertEqual(wire.sent.filter { $0["method"] as? String == "Target.detachFromTarget" }.count, 0)
        XCTAssertEqual(transport.snapshot()["pending"] as? Int, 0)
        XCTAssertEqual(transport.snapshot()["attachedTargets"] as? Int, 0)
    }

    func testConcurrentSameTargetAttachesOnceAndRoutesOutOfOrderReplies() async throws {
        let wire = CDPFixtureWire()
        let transport = ProtoPieCDPTransport(wireFactory: { _ in wire })
        defer { transport.shutdown() }
        let first = Task { try await transport.call(browserSocket: endpoint, targetID: "page", method: "Runtime.first") }
        let second = Task { try await transport.call(browserSocket: endpoint, targetID: "page", method: "Runtime.second") }
        await waitUntil { wire.sent.count == 1 }
        XCTAssertEqual(wire.sent[0]["method"] as? String, "Target.attachToTarget")
        XCTAssertEqual((wire.sent[0]["params"] as? [String: Any])?["flatten"] as? Bool, true)
        wire.reply(wire.sent[0], result: ["sessionId": "session-a"])
        await waitUntil { wire.sent.count == 3 }
        let requests = Array(wire.sent.suffix(2))
        for request in requests.reversed() {
            XCTAssertEqual(request["sessionId"] as? String, "session-a")
            wire.reply(request, result: ["value": request["method"]!])
        }
        let a = try await first.value, b = try await second.value
        XCTAssertEqual(a["value"] as? String, "Runtime.first")
        XCTAssertEqual(b["value"] as? String, "Runtime.second")
    }

    func testWrongResponseSessionFailsClosedWithoutReturningForeignResult() async {
        let wire = CDPFixtureWire(); wire.automatic()
        let transport = ProtoPieCDPTransport(wireFactory: { _ in wire })
        wire.onSend = { request, wire in
            if request["method"] as? String == "Target.attachToTarget" { wire.reply(request, result: ["sessionId": "session-a"]) }
            else { wire.push(["id": request["id"]!, "sessionId": "wrong-session", "result": ["secret": "foreign"]]) }
        }
        let task = Task { try await transport.call(browserSocket: endpoint, targetID: "page", method: "Runtime.evaluate") }
        let error = await outcome(task)
        XCTAssertEqual(error as? ProtoPieCDPTransport.Failure, .invalidResponse)
        XCTAssertTrue(wire.closed)
        XCTAssertEqual(transport.snapshot()["pending"] as? Int, 0)
        transport.shutdown()
    }

    func testTimeoutNeverReplaysMutationAndLaterRequestCanUseSameWire() async throws {
        let wire = CDPFixtureWire()
        let transport = ProtoPieCDPTransport(timeout: 0.02, wireFactory: { _ in wire })
        defer { transport.shutdown() }
        let task = Task { try await transport.call(browserSocket: endpoint, method: "Browser.setWindowBounds") }
        let error = await outcome(task)
        XCTAssertEqual(error as? ProtoPieCDPTransport.Failure, .timeout)
        XCTAssertEqual(wire.sent.count, 1)
        XCTAssertFalse(wire.closed)
        wire.automatic()
        _ = try await transport.call(browserSocket: endpoint, method: "Browser.getVersion")
        XCTAssertEqual(wire.sent.count, 2)
        XCTAssertEqual(transport.snapshot()["connections"] as? Int, 1)
        XCTAssertEqual(transport.snapshot()["timeouts"] as? Int, 1)
    }

    func testCancelledRequestDropsLateReplyWithoutCancelingSibling() async throws {
        let wire = CDPFixtureWire()
        let transport = ProtoPieCDPTransport(wireFactory: { _ in wire })
        defer { transport.shutdown() }
        let a = Task { try await transport.call(browserSocket: endpoint, method: "Browser.first") }
        let b = Task { try await transport.call(browserSocket: endpoint, method: "Browser.second") }
        await waitUntil { wire.sent.count == 2 }
        a.cancel()
        let error = await outcome(a)
        XCTAssertTrue(error is CancellationError)
        for request in wire.sent { wire.reply(request, result: ["value": request["method"]!]) }
        let result = try await b.value
        XCTAssertEqual(result["value"] as? String, "Browser.second")
        XCTAssertEqual(wire.sent.count, 2)
        XCTAssertFalse(wire.closed)
    }

    func testCanceledAttachWaiterDoesNotCancelAnotherWaiterOrSendItsMutation() async throws {
        let wire = CDPFixtureWire()
        let transport = ProtoPieCDPTransport(wireFactory: { _ in wire })
        defer { transport.shutdown() }
        let a = Task { try await transport.call(browserSocket: endpoint, targetID: "page", method: "Runtime.cancelled") }
        let b = Task { try await transport.call(browserSocket: endpoint, targetID: "page", method: "Runtime.kept") }
        await waitUntil { wire.sent.count == 1 }
        a.cancel()
        wire.automatic()
        wire.reply(wire.sent[0], result: ["sessionId": "session-page"])
        let error = await outcome(a)
        XCTAssertTrue(error is CancellationError)
        _ = try await b.value
        XCTAssertEqual(wire.sent.filter { $0["method"] as? String == "Runtime.cancelled" }.count, 0)
        XCTAssertEqual(wire.sent.filter { $0["method"] as? String == "Runtime.kept" }.count, 1)
    }

    func testDisconnectRejectsInflightAndReconnectBudgetIsFinite() async throws {
        var wires = [CDPFixtureWire]()
        let transport = ProtoPieCDPTransport(maximumConnections: 2, wireFactory: { _ in
            let wire = CDPFixtureWire(); wires.append(wire); return wire
        })
        defer { transport.shutdown() }
        let first = Task { try await transport.call(browserSocket: endpoint, method: "Browser.setWindowBounds") }
        await waitUntil { wires.first?.sent.count == 1 }
        wires[0].close()
        let outcome1 = await outcome(first)
        XCTAssertEqual(outcome1 as? ProtoPieCDPTransport.Failure, .disconnected)
        let second = Task { try await transport.call(browserSocket: endpoint, method: "Browser.getVersion") }
        await waitUntil { wires.count == 2 && wires[1].sent.count == 1 }
        wires[1].reply(wires[1].sent[0]); _ = try await second.value
        XCTAssertEqual(wires[0].sent.count, 1)
        wires[1].close()
        await waitUntil { transport.snapshot()["connected"] as? Bool == false }
        let third = Task { try await transport.call(browserSocket: endpoint, method: "Browser.getVersion") }
        let outcome2 = await outcome(third)
        XCTAssertEqual(outcome2 as? ProtoPieCDPTransport.Failure, .connectionBudget)
        XCTAssertEqual(wires.count, 2)
    }

    func testBrowserEndpointReplacementRejectsOldWorkAndNeverUsesOldSessions() async throws {
        var wires = [CDPFixtureWire]()
        let transport = ProtoPieCDPTransport(wireFactory: { _ in
            let wire = CDPFixtureWire(); wires.append(wire); return wire
        })
        defer { transport.shutdown() }
        let old = Task { try await transport.call(browserSocket: endpoint, targetID: "page", method: "Runtime.old") }
        await waitUntil { wires.first?.sent.count == 1 }
        let newer = Task { try await transport.call(browserSocket: URL(string: "ws://127.0.0.1:9223/devtools/browser/new")!, targetID: "page", method: "Runtime.new") }
        await waitUntil { wires.count == 2 && wires[1].sent.count == 1 }
        wires[0].reply(wires[0].sent[0], result: ["sessionId": "obsolete"])
        wires[1].automatic(); wires[1].reply(wires[1].sent[0], result: ["sessionId": "new-session"])
        let outcome3 = await outcome(old)
        XCTAssertNotNil(outcome3)
        _ = try await newer.value
        XCTAssertEqual(wires[1].sent.last?["sessionId"] as? String, "new-session")
        XCTAssertEqual(transport.snapshot()["attachedTargets"] as? Int, 1)
    }

    func testDetachedTargetFailsOnlyItsInflightRequestsAndReattaches() async throws {
        let wire = CDPFixtureWire(); wire.automatic()
        let transport = ProtoPieCDPTransport(wireFactory: { _ in wire })
        defer { transport.shutdown() }
        _ = try await transport.call(browserSocket: endpoint, targetID: "page", method: "Runtime.initial")
        wire.onSend = nil
        let page = Task { try await transport.call(browserSocket: endpoint, targetID: "page", method: "Runtime.pending") }
        let browser = Task { try await transport.call(browserSocket: endpoint, method: "Browser.getVersion") }
        await waitUntil { wire.sent.count == 4 }
        wire.push(["method": "Target.detachedFromTarget", "params": ["sessionId": "session-page", "targetId": "page"]])
        let outcome4 = await outcome(page)
        XCTAssertEqual(outcome4 as? ProtoPieCDPTransport.Failure, .targetDetached)
        let browserRequest = wire.sent.first { $0["method"] as? String == "Browser.getVersion" }!
        wire.reply(browserRequest); _ = try await browser.value
        wire.automatic()
        _ = try await transport.call(browserSocket: endpoint, targetID: "page", method: "Runtime.after")
        XCTAssertEqual(wire.sent.filter { $0["method"] as? String == "Target.attachToTarget" }.count, 2)
        XCTAssertFalse(wire.closed)
    }

    func testConfirmedCloseBeforeDetachedEventOnlyClearsLocalSession() async throws {
        let wire = CDPFixtureWire(); wire.automatic()
        let transport = ProtoPieCDPTransport(wireFactory: { _ in wire })
        defer { transport.shutdown() }
        _ = try await transport.call(browserSocket: endpoint, targetID: "old", method: "Runtime.evaluate")
        _ = try await transport.call(browserSocket: endpoint, targetID: "new", method: "Runtime.evaluate")
        let before = wire.sent.count
        await transport.releaseTarget("old")
        XCTAssertEqual(wire.sent.count, before)
        wire.push(["method": "Target.detachedFromTarget", "params": ["sessionId": "session-old", "targetId": "old"]])
        _ = try await transport.call(browserSocket: endpoint, targetID: "new", method: "Runtime.evaluate")
        XCTAssertFalse(wire.closed)
        XCTAssertEqual(transport.snapshot()["connections"] as? Int, 1)
        XCTAssertEqual(transport.snapshot()["attachedTargets"] as? Int, 1)
    }

    func testConfirmedTargetDestroyedWhileAttachingDoesNotInstallLateSession() async {
        let wire = CDPFixtureWire()
        let transport = ProtoPieCDPTransport(wireFactory: { _ in wire })
        defer { transport.shutdown() }
        let task = Task { try await transport.call(browserSocket: endpoint, targetID: "page", method: "Runtime.evaluate") }
        await waitUntil { wire.sent.count == 1 }
        await transport.releaseTarget("page")
        wire.reply(wire.sent[0], result: ["sessionId": "late-session"])
        let outcome5 = await outcome(task)
        XCTAssertEqual(outcome5 as? ProtoPieCDPTransport.Failure, .targetDetached)
        XCTAssertEqual(transport.snapshot()["attachedTargets"] as? Int, 0)
        XCTAssertFalse(wire.closed)
        XCTAssertEqual(wire.sent.count, 1)
    }

    func testAttachTimeoutClosesUnknownRemoteAttachmentWithoutRetry() async {
        let wire = CDPFixtureWire()
        let transport = ProtoPieCDPTransport(timeout: 0.02, wireFactory: { _ in wire })
        defer { transport.shutdown() }
        let task = Task { try await transport.call(browserSocket: endpoint, targetID: "page", method: "Runtime.evaluate") }
        let outcome6 = await outcome(task)
        XCTAssertEqual(outcome6 as? ProtoPieCDPTransport.Failure, .timeout)
        XCTAssertTrue(wire.closed)
        XCTAssertEqual(wire.sent.count, 1)
        XCTAssertEqual(transport.snapshot()["attachingTargets"] as? Int, 0)
    }

    func testPendingAndTargetLimitsRejectWithoutEvictingLiveOwner() async throws {
        let wire = CDPFixtureWire(); wire.automatic()
        let transport = ProtoPieCDPTransport(maximumPending: 1, maximumTargets: 1, wireFactory: { _ in wire })
        defer { transport.shutdown() }
        _ = try await transport.call(browserSocket: endpoint, targetID: "kept", method: "Runtime.evaluate")
        let excess = Task { try await transport.call(browserSocket: endpoint, targetID: "extra", method: "Runtime.evaluate") }
        let outcome7 = await outcome(excess)
        XCTAssertEqual(outcome7 as? ProtoPieCDPTransport.Failure, .capacity)
        wire.onSend = nil
        let first = Task { try await transport.call(browserSocket: endpoint, method: "Browser.pending") }
        await waitUntil { wire.sent.count == 3 }
        let second = Task { try await transport.call(browserSocket: endpoint, method: "Browser.extra") }
        let outcome8 = await outcome(second)
        XCTAssertEqual(outcome8 as? ProtoPieCDPTransport.Failure, .capacity)
        transport.shutdown()
        let outcome9 = await outcome(first)
        XCTAssertEqual(outcome9 as? ProtoPieCDPTransport.Failure, .closed)
    }

    func testRejectedResponseDoesNotExposePageErrorAndShutdownCannotReconnect() async {
        let wire = CDPFixtureWire()
        wire.onSend = { request, wire in wire.push(["id": request["id"]!, "error": ["code": -32000, "message": "https://private.example/secret"]]) }
        let transport = ProtoPieCDPTransport(wireFactory: { _ in wire })
        let task = Task { try await transport.call(browserSocket: endpoint, method: "Browser.getVersion") }
        let error = await outcome(task)
        XCTAssertEqual(error as? ProtoPieCDPTransport.Failure, .rejected(-32000))
        XCTAssertFalse(error?.localizedDescription.contains("private") ?? true)
        transport.shutdown()
        let stopped = Task { try await transport.call(browserSocket: endpoint, method: "Browser.getVersion") }
        let outcome10 = await outcome(stopped)
        XCTAssertEqual(outcome10 as? ProtoPieCDPTransport.Failure, .closed)
        XCTAssertEqual(wire.sent.count, 1)
    }

    func testRetiredEndpointCleanupCannotDisconnectReplacementBrowser() async throws {
        var wires = [CDPFixtureWire]()
        let transport = ProtoPieCDPTransport(wireFactory: { _ in
            let wire = CDPFixtureWire(); wire.automatic(); wires.append(wire); return wire
        })
        defer { transport.shutdown() }
        _ = try await transport.call(browserSocket: endpoint, targetID: "old", method: "Runtime.evaluate")
        let replacement = URL(string: "ws://127.0.0.1:9222/devtools/browser/replacement")!
        _ = try await transport.call(browserSocket: replacement, targetID: "new", method: "Runtime.evaluate")
        let late = Task { try await transport.call(browserSocket: endpoint, method: "Target.closeTarget", parameters: ["targetId": "old"]) }
        let error = await outcome(late)
        XCTAssertEqual(error as? ProtoPieCDPTransport.Failure, .disconnected)
        XCTAssertEqual(wires.count, 2)
        XCTAssertFalse(wires[1].closed)
        XCTAssertEqual(transport.snapshot()["attachedTargets"] as? Int, 1)
        _ = try await transport.call(browserSocket: replacement, targetID: "new", method: "Runtime.stillWorks")
        XCTAssertEqual(wires[1].sent.filter { $0["method"] as? String == "Target.attachToTarget" }.count, 1)
    }

    func testDetachedEventBeforeAttachReplyNeverSendsBusinessMutation() async {
        let wire = CDPFixtureWire()
        let transport = ProtoPieCDPTransport(wireFactory: { _ in wire })
        defer { transport.shutdown() }
        let task = Task { try await transport.call(browserSocket: endpoint, targetID: "page", method: "Runtime.mutation") }
        await waitUntil { wire.sent.count == 1 }
        wire.push(["method": "Target.detachedFromTarget", "params": ["sessionId": "gone-session"]])
        wire.reply(wire.sent[0], result: ["sessionId": "gone-session"])
        let error = await outcome(task)
        XCTAssertEqual(error as? ProtoPieCDPTransport.Failure, .targetDetached)
        XCTAssertEqual(wire.sent.count, 1)
        XCTAssertEqual(transport.snapshot()["attachedTargets"] as? Int, 0)
        XCTAssertFalse(wire.closed)
    }

    func testTargetDestroyedEventBeforeAttachReplyInvalidatesAttachment() async {
        let wire = CDPFixtureWire()
        let transport = ProtoPieCDPTransport(wireFactory: { _ in wire })
        defer { transport.shutdown() }
        let task = Task { try await transport.call(browserSocket: endpoint, targetID: "page", method: "Runtime.mutation") }
        await waitUntil { wire.sent.count == 1 }
        wire.push(["method": "Target.targetDestroyed", "params": ["targetId": "page"]])
        wire.reply(wire.sent[0], result: ["sessionId": "gone-session"])
        let error = await outcome(task)
        XCTAssertEqual(error as? ProtoPieCDPTransport.Failure, .targetDetached)
        XCTAssertEqual(wire.sent.count, 1)
        XCTAssertEqual(transport.snapshot()["attachedTargets"] as? Int, 0)
        XCTAssertEqual(transport.snapshot()["attachingTargets"] as? Int, 0)
        XCTAssertFalse(wire.closed)
    }
}
