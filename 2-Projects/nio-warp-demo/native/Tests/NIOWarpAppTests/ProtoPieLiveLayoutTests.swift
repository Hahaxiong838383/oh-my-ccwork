import AppKit
import XCTest
@testable import NIOWarpApp

@MainActor private final class LiveLayoutProtoPieDriver: ProtoPiePreviewDriving {
    var preparations = [ProtoPieConfiguration]()
    var layouts = [ProtoPieSession]()
    var layoutWrites = [Double]()
    var presentationWrites = [Double]()
    var presentationChecks = 0
    var userOpens = 0
    var layoutError: Error?
    var layoutHandler: ((ProtoPieSession) async throws -> Void)?
    var presentationHandler: ((ProtoPieSession) async -> Bool)?
    var preparedSource: ProtoPieConfiguration.Source?

    func prepare(configuration: ProtoPieConfiguration, displayID: CGDirectDisplayID,
                 progress: @escaping (String) -> Void) async throws -> ProtoPieSession {
        preparations.append(configuration)
        var result = configuration
        if let preparedSource { result.source = preparedSource }
        return ProtoPieSession(windowID: 100, processID: 42, configuration: result,
            cloudTargetID: result.source == .cloud ? "owned-player" : nil, title: "Preview")
    }
    func isAlive(_ session: ProtoPieSession) async -> Bool { true }
    func isPresentationReady(_ session: ProtoPieSession, displayID: CGDirectDisplayID) async -> Bool {
        presentationChecks += 1
        let ready = await presentationHandler?(session) ?? true
        // Model ensureCloudContentLayout completing even if cancellation happened during CDP.
        presentationWrites.append(session.configuration.widthFitVerticalPosition)
        return ready
    }
    func updatePresentationLayout(_ session: ProtoPieSession) async throws {
        layouts.append(session)
        if let layoutHandler { try await layoutHandler(session) }
        if let layoutError { throw layoutError }
        layoutWrites.append(session.configuration.widthFitVerticalPosition)
    }
    func release(_ session: ProtoPieSession) async { }
    func openForUser(configuration: ProtoPieConfiguration) async throws { userOpens += 1 }
}

@MainActor final class ProtoPieLiveLayoutTests: XCTestCase {
    private var domains = [String]()
    private var coordinators = [ProtoPieCoordinator]()

    override func tearDown() async throws {
        for coordinator in coordinators { coordinator.shutdown() }
        coordinators = []
        for domain in domains { UserDefaults.standard.removePersistentDomain(forName: domain) }
        domains = []
        try await super.tearDown()
    }

    private func make(driver: LiveLayoutProtoPieDriver, fastMonitor: Bool = false) -> (ProtoPieCoordinator, UserDefaults) {
        let domain = "NIOWarp.ProtoPie.LiveLayout.\(UUID().uuidString)"
        domains.append(domain)
        let defaults = UserDefaults(suiteName: domain)!
        let coordinator = ProtoPieCoordinator(defaults: defaults, driver: driver,
            monitoringInterval: fastMonitor ? 1_000_000 : 60_000_000_000, recoveryDelay: 1_000_000)
        coordinators.append(coordinator)
        coordinator.draft.cloudURL = "https://cloud.protopie.io/p/active"
        coordinator.draft.fillWidth = true
        coordinator.draft.widthFitVerticalPosition = -0.536
        coordinator.onCapture = { _, _ in }
        XCTAssertTrue(coordinator.saveConfiguration())
        return (coordinator, defaults)
    }

    private func settle(_ condition: () -> Bool) async {
        for _ in 0..<1_000 {
            if condition() { return }
            try? await Task.sleep(nanoseconds: 1_000_000)
        }
        XCTFail("实时布局异步状态未在期限内完成")
    }

    private func start(_ coordinator: ProtoPieCoordinator) async {
        coordinator.setTargetDisplay(2); coordinator.start()
        await settle { coordinator.state == .running }
    }

    func testPositionUpdatesExistingPlayerAndLastSuccessfulWithoutSavingOrRecapturing() async throws {
        let driver = LiveLayoutProtoPieDriver(); let (coordinator, defaults) = make(driver: driver)
        var captures = 0
        coordinator.onCapture = { _, _ in captures += 1 }
        await start(coordinator)
        let original = try XCTUnwrap(coordinator.activeSession)
        coordinator.setVerticalPosition(0.905)
        XCTAssertEqual(coordinator.draft.widthFitVerticalPosition, 0.905)
        await settle { coordinator.activeSession?.configuration.widthFitVerticalPosition == 0.905 }
        XCTAssertEqual(driver.layouts.count, 1)
        XCTAssertEqual(driver.layouts.first?.cloudTargetID, original.cloudTargetID)
        XCTAssertEqual(coordinator.activeSession?.id, original.id)
        XCTAssertEqual(coordinator.activeSession?.windowID, original.windowID)
        XCTAssertEqual(driver.preparations.count, 1)
        XCTAssertEqual(captures, 1)
        XCTAssertEqual(coordinator.lastSuccessful?.widthFitVerticalPosition, 0.905)
        XCTAssertEqual(coordinator.saved.widthFitVerticalPosition, -0.536)
        let persisted = try JSONDecoder().decode(ProtoPieConfiguration.self,
            from: XCTUnwrap(defaults.data(forKey: ProtoPieCoordinator.lastSuccessfulKey)))
        XCTAssertEqual(persisted.widthFitVerticalPosition, 0.905)
        let saved = try JSONDecoder().decode(ProtoPieConfiguration.self,
            from: XCTUnwrap(defaults.data(forKey: ProtoPieCoordinator.savedKey)))
        XCTAssertEqual(saved.widthFitVerticalPosition, -0.536)
    }

    func testDebouncedSliderBurstAppliesOnlyLatestPosition() async {
        let driver = LiveLayoutProtoPieDriver(); let (coordinator, _) = make(driver: driver)
        await start(coordinator)
        coordinator.setVerticalPosition(0.1)
        coordinator.setVerticalPosition(-0.2)
        coordinator.setVerticalPosition(0.8)
        await settle { coordinator.activeSession?.configuration.widthFitVerticalPosition == 0.8 }
        XCTAssertEqual(driver.layoutWrites, [0.8])
        XCTAssertEqual(coordinator.lastSuccessful?.widthFitVerticalPosition, 0.8)
    }

    func testInFlightUpdateIsSerializedAndPendingValuesCollapseToLatest() async {
        let driver = LiveLayoutProtoPieDriver(); let (coordinator, _) = make(driver: driver)
        var releaseFirst: CheckedContinuation<Void, Never>?
        driver.layoutHandler = { _ in
            if driver.layouts.count == 1 { await withCheckedContinuation { releaseFirst = $0 } }
        }
        await start(coordinator)
        coordinator.setVerticalPosition(0.1)
        await settle { releaseFirst != nil }
        coordinator.setVerticalPosition(0.7); coordinator.setVerticalPosition(-0.3)
        try? await Task.sleep(nanoseconds: 120_000_000)
        XCTAssertEqual(driver.layouts.count, 1)
        releaseFirst?.resume(); releaseFirst = nil
        await settle { coordinator.activeSession?.configuration.widthFitVerticalPosition == -0.3 }
        XCTAssertEqual(driver.layoutWrites, [0.1, -0.3])
        XCTAssertEqual(coordinator.lastSuccessful?.widthFitVerticalPosition, -0.3)
        XCTAssertEqual(driver.preparations.count, 1)
    }

    func testOldMonitorWriteFinishesBeforeNewLayoutAndNewMonitorUsesNewPosition() async {
        let driver = LiveLayoutProtoPieDriver(); let (coordinator, _) = make(driver: driver, fastMonitor: true)
        var releaseMonitor: CheckedContinuation<Bool, Never>?
        driver.presentationHandler = { _ in
            if driver.presentationChecks == 1 { return await withCheckedContinuation { releaseMonitor = $0 } }
            return true
        }
        await start(coordinator)
        await settle { releaseMonitor != nil }
        coordinator.setVerticalPosition(0.905)
        try? await Task.sleep(nanoseconds: 120_000_000)
        XCTAssertTrue(driver.layouts.isEmpty, "旧 CDP 检查尚未返回时不能写入新 position")
        releaseMonitor?.resume(returning: true); releaseMonitor = nil
        await settle { coordinator.activeSession?.configuration.widthFitVerticalPosition == 0.905 }
        await settle { driver.presentationWrites.contains(0.905) }
        XCTAssertEqual(driver.presentationWrites.first, -0.536)
        XCTAssertTrue(driver.presentationWrites.dropFirst().allSatisfy { $0 == 0.905 })
        XCTAssertEqual(driver.layoutWrites, [0.905])
        XCTAssertEqual(driver.preparations.count, 1)
    }

    func testLivePositionDoesNotApplyOtherUnsavedDraftFields() async throws {
        let driver = LiveLayoutProtoPieDriver(); let (coordinator, _) = make(driver: driver)
        await start(coordinator)
        var expected = try XCTUnwrap(coordinator.activeSession?.configuration)
        coordinator.draft.autoStart = true
        coordinator.draft.autoRecover = false
        coordinator.draft.filePath = "/unapplied/draft.pie"
        coordinator.setVerticalPosition(0.4)
        expected.widthFitVerticalPosition = 0.4
        await settle { coordinator.activeSession?.configuration.widthFitVerticalPosition == 0.4 }
        XCTAssertEqual(driver.layouts.last?.configuration, expected)
        XCTAssertEqual(coordinator.activeSession?.configuration, expected)
        XCTAssertEqual(coordinator.lastSuccessful, expected)
        XCTAssertTrue(coordinator.draft.autoStart)
        XCTAssertFalse(coordinator.draft.autoRecover)
        XCTAssertEqual(coordinator.saved.widthFitVerticalPosition, -0.536)
    }

    func testDifferentDraftPlaybackURLDoesNotModifyActivePlayer() async {
        let driver = LiveLayoutProtoPieDriver(); let (coordinator, _) = make(driver: driver)
        await start(coordinator)
        let original = coordinator.activeSession
        coordinator.draft.cloudURL = "https://cloud.protopie.io/p/another"
        coordinator.setVerticalPosition(0.7)
        try? await Task.sleep(nanoseconds: 120_000_000)
        XCTAssertTrue(driver.layouts.isEmpty)
        XCTAssertEqual(coordinator.activeSession, original)
        XCTAssertEqual(coordinator.draft.widthFitVerticalPosition, 0.7)
    }

    func testStopBeforeDebounceCancelsLayoutWithoutChangingSuccessfulConfiguration() async {
        let driver = LiveLayoutProtoPieDriver(); let (coordinator, _) = make(driver: driver)
        await start(coordinator)
        let successful = coordinator.lastSuccessful
        coordinator.setVerticalPosition(0.5); coordinator.stop()
        try? await Task.sleep(nanoseconds: 120_000_000)
        XCTAssertTrue(driver.layouts.isEmpty)
        XCTAssertNil(coordinator.activeSession)
        XCTAssertEqual(coordinator.state, .stopped)
        XCTAssertEqual(coordinator.lastSuccessful, successful)
        XCTAssertEqual(coordinator.draft.widthFitVerticalPosition, 0.5)
    }

    func testStoppedInFlightUpdateCannotPublishLateSuccessOrRestartMonitoring() async {
        let driver = LiveLayoutProtoPieDriver(); let (coordinator, _) = make(driver: driver, fastMonitor: true)
        var releaseLayout: CheckedContinuation<Void, Never>?
        driver.layoutHandler = { _ in await withCheckedContinuation { releaseLayout = $0 } }
        await start(coordinator)
        let successful = coordinator.lastSuccessful
        coordinator.setVerticalPosition(0.5)
        await settle { releaseLayout != nil }
        coordinator.stop()
        let checksAtStop = driver.presentationChecks
        releaseLayout?.resume(); releaseLayout = nil
        try? await Task.sleep(nanoseconds: 120_000_000)
        XCTAssertNil(coordinator.activeSession)
        XCTAssertEqual(coordinator.state, .stopped)
        XCTAssertEqual(coordinator.lastSuccessful, successful)
        XCTAssertEqual(driver.presentationChecks, checksAtStop)
        XCTAssertEqual(driver.preparations.count, 1)
    }

    func testDisplayDisconnectCancelsPendingLayout() async {
        let driver = LiveLayoutProtoPieDriver(); let (coordinator, _) = make(driver: driver)
        await start(coordinator)
        let original = coordinator.activeSession
        coordinator.setVerticalPosition(0.5); coordinator.suspendForDisplayChange()
        try? await Task.sleep(nanoseconds: 120_000_000)
        XCTAssertTrue(driver.layouts.isEmpty)
        XCTAssertEqual(coordinator.state, .waitingForDisplay)
        XCTAssertEqual(coordinator.activeSession, original)
    }

    func testFailedLayoutPreservesActiveAndSuccessfulConfigurationAndReportsError() async {
        let driver = LiveLayoutProtoPieDriver(); let (coordinator, _) = make(driver: driver, fastMonitor: true)
        await start(coordinator)
        let original = coordinator.activeSession, successful = coordinator.lastSuccessful
        driver.layoutError = ProtoPieError.unavailable("测试布局失败")
        coordinator.setVerticalPosition(0.5)
        await settle { coordinator.notice.contains("测试布局失败") }
        XCTAssertEqual(coordinator.activeSession, original)
        XCTAssertEqual(coordinator.lastSuccessful, successful)
        XCTAssertEqual(coordinator.draft.widthFitVerticalPosition, 0.5)
        XCTAssertEqual(coordinator.saved.widthFitVerticalPosition, -0.536)
        XCTAssertEqual(driver.preparations.count, 1)
        XCTAssertTrue(driver.layoutWrites.isEmpty)
        let checks = driver.presentationChecks
        await settle { driver.presentationChecks > checks }
        XCTAssertEqual(driver.presentationWrites.last, -0.536)
    }

    func testPausedOrManuallyOpenedPlayerOnlyUpdatesDraft() async {
        for manualOpen in [false, true] {
            let driver = LiveLayoutProtoPieDriver(); let (coordinator, _) = make(driver: driver)
            await start(coordinator)
            let original = coordinator.activeSession
            if manualOpen {
                coordinator.openPlayer()
                await settle { driver.userOpens == 1 && coordinator.state == .running }
            } else { coordinator.setOutputPaused(true) }
            coordinator.setVerticalPosition(0.5)
            try? await Task.sleep(nanoseconds: 120_000_000)
            XCTAssertTrue(driver.layouts.isEmpty)
            XCTAssertEqual(coordinator.activeSession, original)
            XCTAssertEqual(coordinator.draft.widthFitVerticalPosition, 0.5)
        }
    }

    func testLocalSessionOrNoSessionDoesNotReceiveCloudLayoutCommands() async {
        let idleDriver = LiveLayoutProtoPieDriver(); let (idle, _) = make(driver: idleDriver)
        idle.setVerticalPosition(0.4)
        let localDriver = LiveLayoutProtoPieDriver(); localDriver.preparedSource = .localFile
        let (local, _) = make(driver: localDriver)
        await start(local)
        local.setVerticalPosition(0.6)
        try? await Task.sleep(nanoseconds: 120_000_000)
        XCTAssertTrue(idleDriver.layouts.isEmpty)
        XCTAssertTrue(localDriver.layouts.isEmpty)
        XCTAssertEqual(local.activeSession?.configuration.source, .localFile)
        XCTAssertEqual(local.activeSession?.configuration.widthFitVerticalPosition, -0.536)
        XCTAssertEqual(local.draft.widthFitVerticalPosition, 0.6)
    }
}
