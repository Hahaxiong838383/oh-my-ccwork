import Foundation
import XCTest
@testable import NIOWarpApp

@MainActor final class ProtoPieCloudTargetLifecycleTests: XCTestCase {
    private let socket = URL(string: "ws://127.0.0.1:9222/devtools/browser/fixture")!
    private var configuration: ProtoPieConfiguration {
        var value = ProtoPieConfiguration(); value.cloudURL = "https://cloud.protopie.io/p/fixture"; return value
    }

    func testFailedReusedSourceNeverClosesItsTarget() async {
        var closed = [String]()
        let owner = ProtoPieCloudTargetLifecycle(closeTarget: { _, id in closed.append(id); return true }, targetExists: { _, _ in true })
        let lease = owner.register("old-source", socket: socket, configuration: configuration, createdForRequest: false)
        await owner.preparationFailed(lease)
        XCTAssertTrue(closed.isEmpty)
        XCTAssertNotNil(owner.entries["old-source"])
        XCTAssertEqual(owner.entries["old-source"]?.failed, false)
    }

    func testFailedNewSourceClosesOnlyItsPreciselyOwnedTarget() async {
        var closed = [String](), sockets = [URL]()
        let owner = ProtoPieCloudTargetLifecycle(closeTarget: { socket, id in sockets.append(socket); closed.append(id); return true }, targetExists: { _, _ in true })
        _ = owner.register("old-source", socket: socket, configuration: configuration, createdForRequest: false)
        owner.commit("old-source", sessionID: UUID())
        let lease = owner.register("failed-new", socket: socket, configuration: configuration, createdForRequest: true)
        await owner.preparationFailed(lease)
        XCTAssertEqual(closed, ["failed-new"])
        XCTAssertEqual(sockets, [socket])
        XCTAssertNil(owner.entries["failed-new"])
        XCTAssertNotNil(owner.entries["old-source"])
        XCTAssertEqual(owner.committedTargetID, "old-source")
    }

    func testCanceledPreparationStillSendsCloseFromUncancelledCleanupTask() async {
        var closed = [String](), cancellationFlags = [Bool]()
        let owner = ProtoPieCloudTargetLifecycle(closeTarget: { _, id in
            cancellationFlags.append(Task.isCancelled)
            try Task.checkCancellation()
            closed.append(id); return true
        }, targetExists: { _, _ in true })
        let lease = owner.register("cancelled-new", socket: socket, configuration: configuration, createdForRequest: true)
        var gate: CheckedContinuation<Void, Never>?
        let request = Task { @MainActor in
            await withCheckedContinuation { gate = $0 }
            XCTAssertTrue(Task.isCancelled)
            await owner.preparationFailed(lease)
        }
        while gate == nil { await Task.yield() }
        request.cancel(); gate?.resume(); await request.value
        XCTAssertEqual(closed, ["cancelled-new"])
        XCTAssertEqual(cancellationFlags, [false])
        XCTAssertNil(owner.entries["cancelled-new"])
    }

    func testCanceledCoordinatorReleaseAlsoClosesLateLocallyCommittedCandidate() async {
        var closed = [String]()
        let owner = ProtoPieCloudTargetLifecycle(closeTarget: { _, id in
            try Task.checkCancellation(); closed.append(id); return true
        }, targetExists: { _, _ in true })
        _ = owner.register("late-candidate", socket: socket, configuration: configuration, createdForRequest: true)
        let sessionID = UUID()
        owner.commit("late-candidate", sessionID: sessionID)
        var gate: CheckedContinuation<Void, Never>?
        let request = Task { @MainActor in
            await withCheckedContinuation { gate = $0 }
            await owner.releaseSessionTarget("late-candidate", sessionID: sessionID)
        }
        while gate == nil { await Task.yield() }
        request.cancel(); gate?.resume(); await request.value
        XCTAssertEqual(closed, ["late-candidate"])
        XCTAssertNil(owner.committedTargetID)
        XCTAssertTrue(owner.entries.isEmpty)
    }

    func testRejectedReusedPageCannotCloseThePreviouslyCommittedSession() async {
        var closed = [String]()
        let owner = ProtoPieCloudTargetLifecycle(closeTarget: { _, id in closed.append(id); return true }, targetExists: { _, _ in true })
        let oldSession = UUID(), rejectedCandidate = UUID()
        _ = owner.register("same-page", socket: socket, configuration: configuration, createdForRequest: false)
        owner.commit("same-page", sessionID: oldSession)
        let reused = owner.register("same-page", socket: socket, configuration: configuration, createdForRequest: false)
        // A new native window ID can cause coordinator cleanup even though the
        // page still belongs to the last accepted capture session.
        await owner.preparationFailed(reused)
        await owner.releaseSessionTarget("same-page", sessionID: rejectedCandidate)
        XCTAssertTrue(closed.isEmpty)
        XCTAssertEqual(owner.committedTargetID, "same-page")
        XCTAssertEqual(owner.committedSessionID, oldSession)
        XCTAssertNotNil(owner.entries["same-page"])
    }

    func testOldSessionReleaseCannotCloseSamePageAfterNewSessionCommits() async {
        var closed = [String]()
        let owner = ProtoPieCloudTargetLifecycle(closeTarget: { _, id in closed.append(id); return true }, targetExists: { _, _ in true })
        let oldSession = UUID(), newSession = UUID()
        _ = owner.register("same-page", socket: socket, configuration: configuration, createdForRequest: false)
        owner.commit("same-page", sessionID: oldSession)
        owner.commit("same-page", sessionID: newSession)
        await owner.releaseSessionTarget("same-page", sessionID: oldSession)
        XCTAssertTrue(closed.isEmpty)
        XCTAssertEqual(owner.committedSessionID, newSession)
        await owner.releaseSessionTarget("same-page", sessionID: newSession)
        XCTAssertEqual(closed, ["same-page"])
        XCTAssertNil(owner.committedSessionID)
    }

    func testCloseFailureRetainsOwnershipUntilRetryIsAcknowledged() async {
        var shouldClose = false, calls = 0
        let owner = ProtoPieCloudTargetLifecycle(closeTarget: { _, _ in
            calls += 1
            if !shouldClose { throw ProtoPieError.unavailable("close failed") }
            return true
        }, targetExists: { _, _ in true })
        let lease = owner.register("pending-close", socket: socket, configuration: configuration, createdForRequest: true)
        await owner.preparationFailed(lease)
        XCTAssertEqual(owner.entries["pending-close"]?.failed, true)
        XCTAssertNil(owner.reusable(configuration: configuration, available: ["pending-close"]))
        shouldClose = true
        await owner.cleanupFailures(preserving: [])
        XCTAssertEqual(calls, 2)
        XCTAssertNil(owner.entries["pending-close"])
    }

    func testFailedCloseCanForgetOnlyAfterIndependentAbsenceConfirmation() async {
        var queries = [String]()
        let owner = ProtoPieCloudTargetLifecycle(closeTarget: { _, _ in false }, targetExists: { _, id in queries.append(id); return false })
        let lease = owner.register("already-gone", socket: socket, configuration: configuration, createdForRequest: true)
        await owner.preparationFailed(lease)
        XCTAssertEqual(queries, ["already-gone"])
        XCTAssertNil(owner.entries["already-gone"])
    }

    func testUnknownCloseAndProtectedCommittedSourceNeverSendCommands() async {
        var closed = [String]()
        let owner = ProtoPieCloudTargetLifecycle(closeTarget: { _, id in closed.append(id); return true }, targetExists: { _, _ in false })
        _ = owner.register("current", socket: socket, configuration: configuration, createdForRequest: true)
        owner.commit("current", sessionID: UUID())
        let unknown = await owner.closeOwned("ordinary-user-page")
        let protected = await owner.closeOwned("current")
        XCTAssertFalse(unknown); XCTAssertFalse(protected)
        XCTAssertTrue(closed.isEmpty)
        XCTAssertNotNil(owner.entries["current"])
    }

    func testSuccessfulHandoffCleansKnownOrphansWhileKeepingBothValidSourcesUntilExplicitRelease() async {
        var closed = [String]()
        let owner = ProtoPieCloudTargetLifecycle(closeTarget: { _, id in closed.append(id); return true }, targetExists: { _, _ in true })
        for id in ["old", "candidate"] { _ = owner.register(id, socket: socket, configuration: configuration, createdForRequest: false) }
        owner.commit("candidate", sessionID: UUID())
        owner.registerMarkedOrphan("orphan", socket: socket, preserving: ["old", "candidate"])
        owner.registerMarkedOrphan("old", socket: socket, preserving: ["old", "candidate"])
        owner.registerMarkedOrphan("candidate", socket: socket, preserving: ["old", "candidate"])
        await owner.cleanupFailures(preserving: ["old", "candidate"])
        XCTAssertEqual(closed, ["orphan"])
        XCTAssertNotNil(owner.entries["old"]); XCTAssertNotNil(owner.entries["candidate"])
        await owner.releaseSessionTarget("old", sessionID: UUID())
        XCTAssertEqual(closed, ["orphan", "old"])
        XCTAssertEqual(owner.committedTargetID, "candidate")
    }

    func testConcurrentCleanupRequestsShareOneCloseAcknowledgement() async {
        var gate: CheckedContinuation<Void, Never>?, calls = 0
        let owner = ProtoPieCloudTargetLifecycle(closeTarget: { _, _ in
            calls += 1; await withCheckedContinuation { gate = $0 }; return true
        }, targetExists: { _, _ in true })
        _ = owner.register("orphan", socket: socket, configuration: configuration, createdForRequest: true)
        let first = Task { await owner.closeOwned("orphan") }
        while gate == nil { await Task.yield() }
        let second = Task { await owner.closeOwned("orphan") }
        await Task.yield()
        gate?.resume()
        let a = await first.value, b = await second.value
        XCTAssertTrue(a); XCTAssertTrue(b); XCTAssertEqual(calls, 1)
        XCTAssertTrue(owner.entries.isEmpty)
    }

    func testRestartOrphanDiscoveryRequiresNIOMarkerAndCloudHostAndExcludesCurrentTarget() {
        func page(_ id: String, title: String = "NIO Warp Preview · marker", url: String = "https://cloud.protopie.io/p/fixture", type: String = "page") -> [String: Any] {
            ["targetId": id, "type": type, "title": title, "url": url]
        }
        let targets = [page("orphan"), page("current"), page("user", title: "ProtoPie Cloud"),
            page("foreign", url: "https://example.com"), page("worker", type: "worker")]
        XCTAssertEqual(ProtoPieCloudTargetLifecycle.markedOrphans(targets, preserving: ["current"]), ["orphan"])
    }

    func testUnboundLaunchCleanupNeverSelectsAnExistingOrAmbiguousPage() throws {
        let url = try XCTUnwrap(URL(string: configuration.cloudURL))
        func page(_ id: String, _ text: String? = nil) -> [String: Any] { ["targetId": id, "type": "page", "url": text ?? url.absoluteString] }
        XCTAssertEqual(ProtoPieCloudTargetLifecycle.unboundLaunchedTarget([page("old"), page("new")], excluding: ["old"], expectedURL: url), "new")
        XCTAssertNil(ProtoPieCloudTargetLifecycle.unboundLaunchedTarget([page("old")], excluding: ["old"], expectedURL: url))
        XCTAssertNil(ProtoPieCloudTargetLifecycle.unboundLaunchedTarget([page("new1"), page("new2")], excluding: [], expectedURL: url))
        XCTAssertNil(ProtoPieCloudTargetLifecycle.unboundLaunchedTarget([page("user", "https://example.com")], excluding: [], expectedURL: url))
        XCTAssertEqual(ProtoPieCloudTargetLifecycle.unboundLaunchedTarget([page("login", "https://accounts.protopie.io/login")], excluding: [], expectedURL: url), "login")
    }

    func testMalformedTargetListCannotBecomeAnEmptyOwnershipBaseline() throws {
        let empty = try ProtoPieCloudTargetLifecycle.confirmedTargetInfos(["targetInfos": [[String: Any]]()])
        XCTAssertTrue(empty.isEmpty)
        for invalid: [String: Any] in [[:], ["targetInfos": "missing"], ["targetInfos": [["type": "page"]]]] {
            do { _ = try ProtoPieCloudTargetLifecycle.confirmedTargetInfos(invalid); XCTFail("未确认的页面列表不能当作零页面") }
            catch { XCTAssertTrue(error.localizedDescription.contains("页面列表未确认")) }
        }
    }

    func testDriverLaunchSelectionRejectsMultipleExactNewPages() throws {
        let url = try XCTUnwrap(URL(string: configuration.cloudURL))
        let first: [String: Any] = ["targetId": "first", "type": "page", "url": url.absoluteString]
        let second: [String: Any] = ["targetId": "second", "type": "page", "url": url.absoluteString]
        XCTAssertNil(ProtoPieSystemDriver.newCloudTarget([first, second], excluding: [], expectedURL: url))
        XCTAssertEqual(ProtoPieSystemDriver.newCloudTarget([first, second], excluding: ["first"], expectedURL: url)?["targetId"] as? String, "second")
    }

    func testSourceReusePrefersCommittedTargetAndNeverSelectsFailedCleanup() async {
        let owner = ProtoPieCloudTargetLifecycle(closeTarget: { _, _ in false }, targetExists: { _, _ in true })
        _ = owner.register("a-uncommitted", socket: socket, configuration: configuration, createdForRequest: false)
        _ = owner.register("z-current", socket: socket, configuration: configuration, createdForRequest: false)
        owner.commit("z-current", sessionID: UUID())
        let failed = owner.register("failed", socket: socket, configuration: configuration, createdForRequest: true)
        await owner.preparationFailed(failed)
        XCTAssertEqual(owner.reusable(configuration: configuration, available: ["a-uncommitted", "z-current", "failed"]), "z-current")
        XCTAssertNil(owner.reusable(configuration: configuration, available: ["failed"]))
    }
}
