import AppKit
import Foundation
import XCTest
@testable import NIOWarpApp

@MainActor private final class PlaybackCoordinatorDriver: ProtoPiePreviewDriving {
    var preparations = [ProtoPieConfiguration]()
    var displays = [CGDirectDisplayID]()
    var released = [CGWindowID]()
    var alive = true
    var ready = true
    var prepareBarrier: ((Int) async -> Void)?
    var readinessBarrier: (() async -> Bool)?
    var failURL: String?
    var refreshes = 0
    var nextWindow: CGWindowID = 300
    var canvases = [CanvasConfiguration?]()
    func setPresentationCanvas(_ canvas: CanvasConfiguration?) { canvases.append(canvas) }
    func requestFreshPreview() { refreshes += 1 }
    func prepare(configuration: ProtoPieConfiguration, displayID: CGDirectDisplayID,
                 progress: @escaping (String) -> Void) async throws -> ProtoPieSession {
        preparations.append(configuration); displays.append(displayID)
        await prepareBarrier?(preparations.count)
        if configuration.cloudURL == failURL { throw ProtoPieError.unavailable("模拟切源失败") }
        let window = nextWindow; nextWindow += 1
        return ProtoPieSession(windowID: window, processID: 42, configuration: configuration, title: "Test")
    }
    func isAlive(_ session: ProtoPieSession) async -> Bool { alive }
    func isPresentationReady(_ session: ProtoPieSession, displayID: CGDirectDisplayID) async -> Bool {
        if let readinessBarrier { return await readinessBarrier() }
        return ready
    }
    func release(_ session: ProtoPieSession) async { released.append(session.windowID) }
    func openForUser(configuration: ProtoPieConfiguration) async throws { }
}

@MainActor final class ProtoPiePlaybackCoordinatorTests: XCTestCase {
    private var domains = [String]()
    private var coordinators = [ProtoPieCoordinator]()
    override func tearDown() async throws {
        for coordinator in coordinators { coordinator.shutdown() }
        for domain in domains { UserDefaults.standard.removePersistentDomain(forName: domain) }
        coordinators = []; domains = []
        try await super.tearDown()
    }
    private func configuration(_ name: String) -> ProtoPieConfiguration {
        var value = ProtoPieConfiguration(); value.cloudURL = "https://cloud.protopie.io/p/\(name)"; return value
    }
    private func make(fast: Bool = false) -> (ProtoPieCoordinator, PlaybackCoordinatorDriver, UserDefaults) {
        let domain = "NIOWarp.Playback.Coordinator.\(UUID())"; domains.append(domain)
        let defaults = UserDefaults(suiteName: domain)!
        let driver = PlaybackCoordinatorDriver()
        let coordinator = ProtoPieCoordinator(defaults: defaults, driver: driver,
            monitoringInterval: fast ? 1_000_000 : 60_000_000_000, recoveryDelay: 1_000_000)
        coordinator.draft = configuration("legacy"); _ = coordinator.saveConfiguration()
        coordinator.setTargetDisplay(2); coordinator.onCapture = { _, _ in }
        coordinators.append(coordinator); return (coordinator, driver, defaults)
    }
    private func settle(_ condition: () -> Bool) async {
        for _ in 0..<200 {
            if condition() { return }
            try? await Task.sleep(nanoseconds: 1_000_000)
        }
        XCTFail("异步状态未完成")
    }
    private func quiet() async { try? await Task.sleep(nanoseconds: 20_000_000) }

    func testManagedPreparationNeverMutatesLegacySavedDraftOrLastSuccess() async throws {
        let (coordinator, _, defaults) = make()
        coordinator.start(); await settle { coordinator.state == .running }
        let draft = coordinator.draft, saved = coordinator.saved, last = coordinator.lastSuccessful
        let keys = [ProtoPieCoordinator.savedKey, ProtoPieCoordinator.draftKey, ProtoPieCoordinator.lastSuccessfulKey]
        let before = keys.map { defaults.data(forKey: $0) }
        let requested = configuration("playlist")
        let session = try await coordinator.prepareForPlayback(configuration: requested, reload: false)
        XCTAssertEqual(session.configuration, requested)
        XCTAssertEqual(coordinator.draft, draft); XCTAssertEqual(coordinator.saved, saved)
        XCTAssertEqual(coordinator.lastSuccessful, last)
        XCTAssertEqual(keys.map { defaults.data(forKey: $0) }, before)
    }

    func testManagedFullscreenFailureNotifiesWithoutInternalRestartEvenLegacyRecoveryDisabled() async throws {
        let (coordinator, driver, _) = make(fast: true)
        coordinator.draft.autoRecover = false; XCTAssertTrue(coordinator.saveConfiguration())
        _ = try await coordinator.prepareForPlayback(configuration: configuration("playlist"), reload: false)
        var failed = 0
        coordinator.onStateChange = { if case .failed = $0 { failed += 1 } }
        driver.ready = false
        await settle { failed == 1 }; await quiet()
        XCTAssertEqual(driver.preparations.count, 1)
        XCTAssertEqual(failed, 1); XCTAssertNil(coordinator.activeSession)
    }

    func testManagedDisplayReconnectDoesNotLaunchLegacyOrCurrentWithoutScheduler() async throws {
        let (coordinator, driver, _) = make()
        _ = try await coordinator.prepareForPlayback(configuration: configuration("playlist"), reload: false)
        coordinator.suspendForDisplayChange(); coordinator.setTargetDisplay(3); await quiet()
        XCTAssertEqual(driver.preparations.count, 1)
        XCTAssertNil(coordinator.activeSession)
        let resumed = try await coordinator.prepareForPlayback(configuration: configuration("playlist"), reload: true)
        XCTAssertEqual(resumed.configuration.cloudURL, configuration("playlist").cloudURL)
        XCTAssertEqual(driver.displays, [2, 3]); XCTAssertEqual(driver.refreshes, 1)
    }

    func testManagedCanvasHeightChangeNotifiesInsteadOfSelfRebuilding() async throws {
        let (coordinator, driver, _) = make()
        coordinator.setPresentationCanvas(CanvasConfiguration(width: 1920, height: 600))
        _ = try await coordinator.prepareForPlayback(configuration: configuration("playlist"), reload: false)
        coordinator.setPresentationCanvas(CanvasConfiguration(width: 1920, height: 800)); await quiet()
        XCTAssertEqual(driver.preparations.count, 1)
        if case .failed = coordinator.state {} else { XCTFail("画布变化应交给调度器处理") }
        _ = try await coordinator.prepareForPlayback(configuration: configuration("playlist"), reload: false)
        XCTAssertEqual(driver.canvases.last!, CanvasConfiguration(width: 1920, height: 800))
    }

    func testCanceledLateCandidateIsReleasedBeforeReplacementStarts() async throws {
        let (coordinator, driver, _) = make()
        var gate: CheckedContinuation<Void, Never>?
        driver.prepareBarrier = { count in if count == 1 { await withCheckedContinuation { gate = $0 } } }
        var captures = [CGWindowID](); coordinator.onCapture = { id, _ in captures.append(id) }
        let first = Task { try? await coordinator.prepareForPlayback(configuration: self.configuration("first"), reload: false) }
        await settle { gate != nil }
        coordinator.cancelPlaybackPreparation()
        let second = Task { try? await coordinator.prepareForPlayback(configuration: self.configuration("second"), reload: false) }
        await quiet(); XCTAssertEqual(driver.preparations.count, 1)
        gate?.resume()
        _ = await first.value
        let session = await second.value
        XCTAssertEqual(driver.preparations.count, 2)
        XCTAssertEqual(driver.released, [300]); XCTAssertEqual(captures, [301])
        XCTAssertEqual(session?.configuration.cloudURL, configuration("second").cloudURL)
    }

    func testParentTaskCancellationAlsoCancelsUnstructuredPreparation() async throws {
        let (coordinator, driver, _) = make()
        var gate: CheckedContinuation<Void, Never>?
        driver.prepareBarrier = { _ in await withCheckedContinuation { gate = $0 } }
        var captures = 0; coordinator.onCapture = { _, _ in captures += 1 }
        let request = Task { try? await coordinator.prepareForPlayback(configuration: self.configuration("first"), reload: false) }
        await settle { gate != nil }; request.cancel(); await quiet()
        gate?.resume(); _ = await request.value
        XCTAssertEqual(captures, 0); XCTAssertNil(coordinator.activeSession)
        XCTAssertEqual(driver.released, [300])
    }

    func testCancelPreservesLastValidPreviewAndDisplayChangeCannotResurrectPlan() async throws {
        let (coordinator, driver, _) = make()
        let original = try await coordinator.prepareForPlayback(configuration: configuration("first"), reload: false)
        var gate: CheckedContinuation<Void, Never>?
        driver.prepareBarrier = { count in if count == 2 { await withCheckedContinuation { gate = $0 } } }
        let candidate = Task { try? await coordinator.prepareForPlayback(configuration: self.configuration("second"), reload: false) }
        await settle { gate != nil }; coordinator.cancelPlaybackPreparation()
        XCTAssertEqual(coordinator.activeSession, original)
        gate?.resume(); _ = await candidate.value
        XCTAssertEqual(coordinator.activeSession, original); XCTAssertEqual(driver.released, [301])
        coordinator.setTargetDisplay(3); await quiet()
        XCTAssertEqual(driver.preparations.count, 2)
    }

    func testExplicitManualStartCancelsAutomationAndWaitsForItsLateDriver() async throws {
        let (coordinator, driver, _) = make()
        var gate: CheckedContinuation<Void, Never>?
        driver.prepareBarrier = { count in if count == 1 { await withCheckedContinuation { gate = $0 } } }
        let automatic = Task { try? await coordinator.prepareForPlayback(configuration: self.configuration("automatic"), reload: false) }
        await settle { gate != nil }
        var manualCalls = 0
        coordinator.onManualControl = { manualCalls += 1; coordinator.cancelPlaybackPreparation() }
        coordinator.start(); await quiet()
        XCTAssertEqual(manualCalls, 1); XCTAssertEqual(driver.preparations.count, 1)
        gate?.resume(); _ = await automatic.value
        await settle { coordinator.state == .running && driver.preparations.count == 2 }
        XCTAssertFalse(coordinator.playbackManaged)
        XCTAssertEqual(coordinator.activeSession?.configuration, coordinator.saved)
        XCTAssertEqual(driver.released, [300])
    }

    func testTopologyChangeWhilePreparingThrowsRecoverableErrorInsteadOfSilentCancellation() async throws {
        let (coordinator, driver, _) = make()
        var gate: CheckedContinuation<Void, Never>?
        driver.prepareBarrier = { _ in await withCheckedContinuation { gate = $0 } }
        var recoverable = false
        let request = Task {
            do { _ = try await coordinator.prepareForPlayback(configuration: self.configuration("first"), reload: false) }
            catch { recoverable = error is ProtoPieError }
        }
        await settle { gate != nil }; coordinator.suspendForDisplayChange(); gate?.resume(); await request.value
        XCTAssertTrue(recoverable); XCTAssertEqual(driver.preparations.count, 1)
        XCTAssertEqual(driver.released, [300])
    }

    func testCandidateFailurePreservesOldCaptureAndDoesNotWriteLegacyStateOrSelfRetry() async throws {
        let (coordinator, driver, defaults) = make()
        let old = try await coordinator.prepareForPlayback(configuration: configuration("first"), reload: false)
        let savedBefore = defaults.data(forKey: ProtoPieCoordinator.savedKey)
        driver.failURL = configuration("broken").cloudURL
        do { _ = try await coordinator.prepareForPlayback(configuration: configuration("broken"), reload: false); XCTFail("应失败") }
        catch { }
        await quiet()
        XCTAssertEqual(coordinator.activeSession, old)
        XCTAssertEqual(driver.preparations.count, 2)
        XCTAssertEqual(defaults.data(forKey: ProtoPieCoordinator.savedKey), savedBefore)
        XCTAssertNil(coordinator.lastSuccessful)
    }
    func testManualStartWithoutIntegrationCallbackStillCancelsManagedCandidate() async throws {
        let (coordinator, driver, _) = make()
        var gate: CheckedContinuation<Void, Never>?
        driver.prepareBarrier = { count in if count == 1 { await withCheckedContinuation { gate = $0 } } }
        let automatic = Task { try? await coordinator.prepareForPlayback(configuration: self.configuration("automatic"), reload: false) }
        await settle { gate != nil }; coordinator.start(); await quiet()
        XCTAssertEqual(driver.preparations.count, 1)
        gate?.resume(); _ = await automatic.value
        await settle { coordinator.state == .running && driver.preparations.count == 2 }
        XCTAssertFalse(coordinator.playbackManaged)
        XCTAssertEqual(coordinator.lastSuccessful, coordinator.saved)
        XCTAssertEqual(coordinator.activeSession?.configuration, coordinator.saved)
        XCTAssertEqual(driver.released, [300])
    }

}
