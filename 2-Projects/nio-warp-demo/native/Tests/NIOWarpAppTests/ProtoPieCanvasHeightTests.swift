import AppKit
import XCTest
@testable import NIOWarpApp

@MainActor private final class CanvasHeightProtoPieDriver: ProtoPiePreviewDriving {
    struct Preparation {
        var canvas: CanvasConfiguration?
        var configuration: ProtoPieConfiguration
        var outputDisplayID: CGDirectDisplayID
    }

    var canvas: CanvasConfiguration?
    var canvasUpdates = [CanvasConfiguration?]()
    var preparations = [Preparation]()
    var releases = [ProtoPieSession]()
    var capturedPresentations = [ProtoPieSession]()
    var userOpens = 0
    var presentationShutdowns = 0
    var presentationReady = true
    var presentationChecks = 0
    var prepareHandler: ((Int) async throws -> Void)?

    func setPresentationCanvas(_ canvas: CanvasConfiguration?) {
        self.canvas = canvas
        canvasUpdates.append(canvas)
    }
    func shutdownPresentation() { presentationShutdowns += 1 }
    func presentationCaptured(_ session: ProtoPieSession) { capturedPresentations.append(session) }
    func prepare(configuration: ProtoPieConfiguration, displayID: CGDirectDisplayID,
                 progress: @escaping (String) -> Void) async throws -> ProtoPieSession {
        preparations.append(Preparation(canvas: canvas, configuration: configuration, outputDisplayID: displayID))
        let index = preparations.count
        if let prepareHandler { try await prepareHandler(index) }
        // Each completed preparation identifies a distinct capture source. A
        // suspended old preparation deliberately need not honor cancellation:
        // the coordinator must reject its late result before publishing it.
        return ProtoPieSession(windowID: CGWindowID(100 + index), processID: 42,
            configuration: configuration, cloudTargetID: "canvas-player-\(index)", title: "Canvas preview")
    }
    func isAlive(_ session: ProtoPieSession) async -> Bool { true }
    func isPresentationReady(_ session: ProtoPieSession, displayID: CGDirectDisplayID) async -> Bool {
        presentationChecks += 1
        return presentationReady
    }
    func release(_ session: ProtoPieSession) async { releases.append(session) }
    func openForUser(configuration: ProtoPieConfiguration) async throws { userOpens += 1 }
}

@MainActor final class ProtoPieCanvasHeightTests: XCTestCase {
    private var domains = [String]()
    private var coordinators = [ProtoPieCoordinator]()

    override func tearDown() async throws {
        for coordinator in coordinators { coordinator.shutdown() }
        coordinators = []
        for domain in domains { UserDefaults.standard.removePersistentDomain(forName: domain) }
        domains = []
        try await super.tearDown()
    }

    private func make(_ driver: CanvasHeightProtoPieDriver) -> (ProtoPieCoordinator, UserDefaults) {
        let domain = "NIOWarp.ProtoPie.CanvasHeight.\(UUID().uuidString)"
        domains.append(domain)
        let defaults = UserDefaults(suiteName: domain)!
        let coordinator = ProtoPieCoordinator(defaults: defaults, driver: driver,
            monitoringInterval: 60_000_000_000, recoveryDelay: 1_000_000)
        coordinators.append(coordinator)
        coordinator.draft.cloudURL = "https://cloud.protopie.io/p/canvas-height"
        coordinator.draft.fillWidth = true
        coordinator.draft.widthFitVerticalPosition = -0.88
        coordinator.onCapture = { _, _ in }
        XCTAssertTrue(coordinator.saveConfiguration())
        return (coordinator, defaults)
    }

    private func settle(_ condition: () -> Bool) async {
        for _ in 0..<1_000 {
            if condition() { return }
            try? await Task.sleep(nanoseconds: 1_000_000)
        }
        XCTFail("播放器画布高度异步状态未在期限内完成")
    }

    private func start(_ coordinator: ProtoPieCoordinator, height: Int = 2800) async {
        coordinator.setPresentationCanvas(CanvasConfiguration(width: 12500, height: height))
        coordinator.setTargetDisplay(4)
        coordinator.start()
        await settle { coordinator.state == .running }
    }

    func testCanvasHeightReachesDriverBeforeFirstPreparationWithoutChangingPhysicalOutput() async {
        let driver = CanvasHeightProtoPieDriver(); let (coordinator, _) = make(driver)
        await start(coordinator)
        XCTAssertEqual(driver.preparations.count, 1)
        XCTAssertEqual(driver.preparations.first?.canvas, CanvasConfiguration(width: 12500, height: 2800))
        XCTAssertEqual(driver.preparations.first?.outputDisplayID, 4)
        XCTAssertEqual(coordinator.targetDisplayID, 4)
        XCTAssertEqual(coordinator.presentationCanvas?.height, 2800)
    }

    func testPreparedDisplayIsNotCommittedUntilCaptureCompletesThenNotifiedExactlyOnce() async {
        let driver = CanvasHeightProtoPieDriver(); let (coordinator, _) = make(driver)
        var releaseCapture: CheckedContinuation<Void, Never>?
        coordinator.onCapture = { _, _ in await withCheckedContinuation { releaseCapture = $0 } }
        coordinator.setPresentationCanvas(CanvasConfiguration(width: 12500, height: 2800))
        coordinator.setTargetDisplay(4); coordinator.start()
        await settle { releaseCapture != nil }
        XCTAssertEqual(driver.preparations.count, 1)
        XCTAssertEqual(coordinator.state, .capturing)
        XCTAssertTrue(driver.capturedPresentations.isEmpty,
            "只有模式准备完成还不能释放正在使用的旧显示器，必须先验收捕获首帧")
        XCTAssertNil(coordinator.activeSession)
        releaseCapture?.resume(); releaseCapture = nil
        await settle { coordinator.state == .running }
        XCTAssertEqual(driver.capturedPresentations.count, 1)
        XCTAssertEqual(driver.capturedPresentations.first, coordinator.activeSession)
        try? await Task.sleep(nanoseconds: 20_000_000)
        XCTAssertEqual(driver.capturedPresentations.count, 1)
    }

    func testRunningHeightChangeRecapturesAndKeepsUnappliedDraftOutOfActiveConfiguration() async throws {
        let driver = CanvasHeightProtoPieDriver(); let (coordinator, defaults) = make(driver)
        var captures = [CGWindowID]()
        coordinator.onCapture = { id, _ in captures.append(id) }
        await start(coordinator)
        let activeConfiguration = try XCTUnwrap(coordinator.activeSession?.configuration)
        let savedBytes = defaults.data(forKey: ProtoPieCoordinator.savedKey)
        coordinator.draft.cloudURL = "https://cloud.protopie.io/p/unapplied-draft"
        coordinator.draft.widthFitVerticalPosition = 0.7
        coordinator.setPresentationCanvas(CanvasConfiguration(width: 12500, height: 3200))
        await settle { driver.preparations.count == 2 && coordinator.state == .running }
        XCTAssertEqual(driver.preparations.last?.canvas?.height, 3200)
        XCTAssertEqual(driver.preparations.last?.configuration, activeConfiguration)
        XCTAssertEqual(coordinator.activeSession?.configuration, activeConfiguration)
        XCTAssertEqual(coordinator.lastSuccessful, activeConfiguration)
        XCTAssertEqual(captures, [101, 102])
        XCTAssertEqual(coordinator.saved, activeConfiguration)
        XCTAssertEqual(defaults.data(forKey: ProtoPieCoordinator.savedKey), savedBytes)
        XCTAssertEqual(coordinator.draft.widthFitVerticalPosition, 0.7)
        XCTAssertTrue(coordinator.hasUnsavedDraft)
    }

    func testWidthOnlyOrIdenticalCanvasChangeDoesNotRebuildRunningSource() async {
        let driver = CanvasHeightProtoPieDriver(); let (coordinator, _) = make(driver)
        var captures = 0
        coordinator.onCapture = { _, _ in captures += 1 }
        await start(coordinator)
        let original = coordinator.activeSession
        coordinator.setPresentationCanvas(CanvasConfiguration(width: 12500, height: 2800))
        coordinator.setPresentationCanvas(CanvasConfiguration(width: 14000, height: 2800))
        try? await Task.sleep(nanoseconds: 30_000_000)
        XCTAssertEqual(driver.preparations.count, 1)
        XCTAssertEqual(captures, 1)
        XCTAssertEqual(coordinator.activeSession, original)
        XCTAssertEqual(coordinator.presentationCanvas, CanvasConfiguration(width: 14000, height: 2800))
        XCTAssertEqual(driver.canvas, coordinator.presentationCanvas)
    }

    func testHeightChangesDuringPreparationDrainOldWorkAndCaptureOnlyLatestHeight() async {
        let driver = CanvasHeightProtoPieDriver(); let (coordinator, _) = make(driver)
        var releaseOld: CheckedContinuation<Void, Never>?
        driver.prepareHandler = { index in
            if index == 1 { await withCheckedContinuation { releaseOld = $0 } }
        }
        var captures = [CGWindowID]()
        coordinator.onCapture = { id, _ in captures.append(id) }
        coordinator.setPresentationCanvas(CanvasConfiguration(width: 12500, height: 2800))
        coordinator.setTargetDisplay(4); coordinator.start()
        await settle { releaseOld != nil }
        coordinator.setPresentationCanvas(CanvasConfiguration(width: 12500, height: 3000))
        coordinator.setPresentationCanvas(CanvasConfiguration(width: 12500, height: 3200))
        try? await Task.sleep(nanoseconds: 20_000_000)
        XCTAssertEqual(driver.preparations.count, 1, "旧准备仍在写窗口时不能同时重建另一个源")
        XCTAssertEqual(driver.canvas?.height, 2800, "旧准备退出前不能切换其源显示尺寸")
        XCTAssertTrue(captures.isEmpty)
        releaseOld?.resume(); releaseOld = nil
        await settle { coordinator.state == .running && driver.preparations.count == 2 }
        XCTAssertEqual(driver.preparations.map { $0.canvas?.height }, [2800, 3200])
        XCTAssertEqual(captures, [102])
        XCTAssertEqual(coordinator.activeSession?.windowID, 102)
    }

    func testHeightChangesWhileFirstCaptureIsBusyRejectOldSuccess() async {
        let driver = CanvasHeightProtoPieDriver(); let (coordinator, _) = make(driver)
        var releaseCapture: CheckedContinuation<Void, Never>?
        var captures = [CGWindowID]()
        coordinator.onCapture = { id, _ in
            captures.append(id)
            if captures.count == 1 { await withCheckedContinuation { releaseCapture = $0 } }
        }
        coordinator.setPresentationCanvas(CanvasConfiguration(width: 12500, height: 2800))
        coordinator.setTargetDisplay(4); coordinator.start()
        await settle { releaseCapture != nil }
        coordinator.setPresentationCanvas(CanvasConfiguration(width: 12500, height: 3100))
        coordinator.setPresentationCanvas(CanvasConfiguration(width: 12500, height: 3400))
        XCTAssertNil(coordinator.lastSuccessful)
        XCTAssertTrue(driver.capturedPresentations.isEmpty)
        releaseCapture?.resume(); releaseCapture = nil
        await settle { coordinator.state == .running && captures.count == 2 }
        XCTAssertEqual(driver.preparations.map { $0.canvas?.height }, [2800, 3400])
        XCTAssertEqual(coordinator.activeSession?.windowID, 102)
        XCTAssertEqual(captures, [101, 102])
        XCTAssertEqual(driver.capturedPresentations.map(\.windowID), [102],
            "已取消的旧首帧即使随后返回，也不能通知驱动释放当前使用的显示器")
    }

    func testStopWhileCaptureIsPendingNeverCommitsLateSourceDisplay() async {
        let driver = CanvasHeightProtoPieDriver(); let (coordinator, _) = make(driver)
        var releaseCapture: CheckedContinuation<Void, Never>?
        coordinator.onCapture = { _, _ in await withCheckedContinuation { releaseCapture = $0 } }
        coordinator.setPresentationCanvas(CanvasConfiguration(width: 12500, height: 2800))
        coordinator.setTargetDisplay(4); coordinator.start()
        await settle { releaseCapture != nil }
        XCTAssertTrue(driver.capturedPresentations.isEmpty)
        coordinator.stop()
        releaseCapture?.resume(); releaseCapture = nil
        try? await Task.sleep(nanoseconds: 30_000_000)
        XCTAssertEqual(coordinator.state, .stopped)
        XCTAssertNil(coordinator.activeSession)
        XCTAssertTrue(driver.capturedPresentations.isEmpty)
    }

    func testWidthChangeDuringPendingHeightRebuildCannotBypassOldOperationDrain() async {
        let driver = CanvasHeightProtoPieDriver(); let (coordinator, _) = make(driver)
        var releaseOld: CheckedContinuation<Void, Never>?
        driver.prepareHandler = { index in
            if index == 1 { await withCheckedContinuation { releaseOld = $0 } }
        }
        coordinator.setPresentationCanvas(CanvasConfiguration(width: 12500, height: 2800))
        coordinator.setTargetDisplay(4); coordinator.start()
        await settle { releaseOld != nil }
        coordinator.setPresentationCanvas(CanvasConfiguration(width: 12500, height: 3000))
        coordinator.setPresentationCanvas(CanvasConfiguration(width: 14000, height: 3000))
        try? await Task.sleep(nanoseconds: 20_000_000)
        XCTAssertEqual(driver.canvas, CanvasConfiguration(width: 12500, height: 2800),
            "排队重建期间的宽度编辑不能提前将新高度传入仍工作的旧驱动")
        XCTAssertEqual(driver.preparations.count, 1)
        releaseOld?.resume(); releaseOld = nil
        await settle { coordinator.state == .running && driver.preparations.count == 2 }
        XCTAssertEqual(driver.preparations.last?.canvas, CanvasConfiguration(width: 14000, height: 3000))
    }

    func testFailedHeightRebuildRejectsOldWindowWhenCompleteHeightCannotBeVerified() async {
        let driver = CanvasHeightProtoPieDriver(); let (coordinator, _) = make(driver)
        var captures = [CGWindowID]()
        var resumes = 0, suspensions = 0, stops = 0
        coordinator.onCapture = { id, _ in captures.append(id) }
        coordinator.onResumeOutput = { resumes += 1 }
        coordinator.onSuspendOutput = { suspensions += 1 }
        coordinator.onStop = { stops += 1 }
        await start(coordinator)
        let successful = coordinator.lastSuccessful
        driver.presentationReady = false
        driver.prepareHandler = { _ in throw ProtoPieError.permission("测试完整高度验证失败") }
        coordinator.setPresentationCanvas(CanvasConfiguration(width: 12500, height: 3200))
        await settle { if case .failed = coordinator.state { return true }; return false }
        XCTAssertNil(coordinator.activeSession)
        XCTAssertEqual(captures, [101], "旧窗口缺失完整高度时不能重新捕获并冒充成功")
        XCTAssertEqual(driver.presentationChecks, 1)
        XCTAssertEqual(suspensions, 1)
        XCTAssertEqual(resumes, 0)
        XCTAssertEqual(stops, 1)
        XCTAssertEqual(coordinator.lastSuccessful, successful)
        XCTAssertTrue(coordinator.notice.contains("完整高度尚未确认"))
    }

    func testFailedHeightRebuildCanRestoreOldSourceOnlyAfterCompletePresentationCheck() async {
        let driver = CanvasHeightProtoPieDriver(); let (coordinator, _) = make(driver)
        var captures = [CGWindowID]()
        var resumes = 0, stops = 0
        coordinator.onCapture = { id, _ in captures.append(id) }
        coordinator.onResumeOutput = { resumes += 1 }
        coordinator.onStop = { stops += 1 }
        await start(coordinator)
        let original = coordinator.activeSession
        driver.presentationReady = true
        driver.prepareHandler = { _ in throw ProtoPieError.permission("测试重建失败但原源已完整") }
        coordinator.setPresentationCanvas(CanvasConfiguration(width: 12500, height: 3200))
        await settle { if case .failed = coordinator.state { return true }; return false }
        XCTAssertEqual(driver.presentationChecks, 1)
        XCTAssertEqual(coordinator.activeSession, original)
        XCTAssertEqual(captures, [101, 101])
        XCTAssertEqual(resumes, 1)
        XCTAssertEqual(stops, 0)
        XCTAssertTrue(coordinator.notice.contains("已保留上一预览来源"))
    }

    func testStopDuringHeightRebuildPreventsLatePreparationFromRestartingOrCapturing() async {
        let driver = CanvasHeightProtoPieDriver(); let (coordinator, _) = make(driver)
        var captures = [CGWindowID]()
        coordinator.onCapture = { id, _ in captures.append(id) }
        await start(coordinator)
        let successful = coordinator.lastSuccessful
        var releaseResize: CheckedContinuation<Void, Never>?
        driver.prepareHandler = { _ in await withCheckedContinuation { releaseResize = $0 } }
        coordinator.setPresentationCanvas(CanvasConfiguration(width: 12500, height: 3200))
        await settle { releaseResize != nil }
        coordinator.stop()
        releaseResize?.resume(); releaseResize = nil
        try? await Task.sleep(nanoseconds: 30_000_000)
        XCTAssertEqual(coordinator.state, .stopped)
        XCTAssertNil(coordinator.activeSession)
        XCTAssertEqual(captures, [101])
        XCTAssertEqual(coordinator.lastSuccessful, successful)
    }

    func testStoppedCanvasChangeDoesNotStartAndNextExplicitStartUsesLatestHeight() async {
        let driver = CanvasHeightProtoPieDriver(); let (coordinator, _) = make(driver)
        await start(coordinator)
        coordinator.stop()
        coordinator.setPresentationCanvas(CanvasConfiguration(width: 12500, height: 3500))
        try? await Task.sleep(nanoseconds: 30_000_000)
        XCTAssertEqual(coordinator.state, .stopped)
        XCTAssertEqual(driver.preparations.count, 1)
        XCTAssertNil(coordinator.activeSession)
        coordinator.start()
        await settle { coordinator.state == .running }
        XCTAssertEqual(driver.preparations.count, 2)
        XCTAssertEqual(driver.preparations.last?.canvas?.height, 3500)
    }

    func testManualPlayerIsNotTakenBackByCanvasChangeUntilExplicitStart() async {
        let driver = CanvasHeightProtoPieDriver(); let (coordinator, _) = make(driver)
        await start(coordinator)
        coordinator.openPlayer()
        await settle { driver.userOpens == 1 && coordinator.state == .running }
        let original = coordinator.activeSession
        coordinator.setPresentationCanvas(CanvasConfiguration(width: 12500, height: 3000))
        try? await Task.sleep(nanoseconds: 30_000_000)
        XCTAssertEqual(driver.preparations.count, 1)
        XCTAssertEqual(coordinator.activeSession, original)
        XCTAssertEqual(driver.userOpens, 1)
        coordinator.start()
        await settle { driver.preparations.count == 2 && coordinator.state == .running }
        XCTAssertEqual(driver.preparations.last?.canvas?.height, 3000)
    }

    func testPausedOutputStaysPausedAcrossCanvasHeightChange() async {
        let driver = CanvasHeightProtoPieDriver(); let (coordinator, _) = make(driver)
        await start(coordinator)
        coordinator.setOutputPaused(true)
        var states = [ProtoPieRuntimeState]()
        var resumes = 0
        coordinator.onStateChange = { states.append($0) }
        coordinator.onResumeOutput = { resumes += 1 }
        coordinator.setPresentationCanvas(CanvasConfiguration(width: 12500, height: 3300))
        await settle { coordinator.state == .paused }
        try? await Task.sleep(nanoseconds: 30_000_000)
        XCTAssertEqual(coordinator.state, .paused)
        XCTAssertFalse(states.contains(.running))
        XCTAssertEqual(resumes, 0)
        coordinator.setOutputPaused(false)
        await settle { coordinator.state == .running && driver.preparations.last?.canvas?.height == 3300 }
        XCTAssertEqual(coordinator.presentationCanvas?.height, 3300)
    }

    func testDisconnectedCanvasChangeIsAppliedOnReconnectWithoutStartingEarly() async {
        let driver = CanvasHeightProtoPieDriver(); let (coordinator, _) = make(driver)
        await start(coordinator)
        coordinator.suspendForDisplayChange()
        coordinator.setPresentationCanvas(CanvasConfiguration(width: 12500, height: 3600))
        try? await Task.sleep(nanoseconds: 30_000_000)
        XCTAssertEqual(coordinator.state, .waitingForDisplay)
        XCTAssertEqual(driver.preparations.count, 1)
        coordinator.setTargetDisplay(5)
        await settle { driver.preparations.count == 2 && coordinator.state == .running }
        XCTAssertEqual(driver.preparations.last?.canvas?.height, 3600)
        XCTAssertEqual(driver.preparations.last?.outputDisplayID, 5)
    }

    func testInvalidCanvasDimensionsCannotReplaceAcceptedHeight() async {
        let driver = CanvasHeightProtoPieDriver(); let (coordinator, _) = make(driver)
        await start(coordinator)
        let accepted = coordinator.presentationCanvas
        let updates = driver.canvasUpdates.count
        for invalid in [CanvasConfiguration(width: 12500, height: 0),
                        CanvasConfiguration(width: 12500, height: 32769),
                        CanvasConfiguration(width: 0, height: 2800)] {
            coordinator.setPresentationCanvas(invalid)
        }
        try? await Task.sleep(nanoseconds: 20_000_000)
        XCTAssertEqual(coordinator.presentationCanvas, accepted)
        XCTAssertEqual(driver.canvasUpdates.count, updates)
        XCTAssertEqual(driver.preparations.count, 1)
    }

    func testOwnedPresentationIsReleasedOnlyAfterCaptureShutdownIsExplicitlyFinished() async {
        let driver = CanvasHeightProtoPieDriver(); let (coordinator, _) = make(driver)
        await start(coordinator)
        coordinator.shutdown()
        XCTAssertEqual(driver.presentationShutdowns, 0, "捕获退出前不能移除虚拟源显示器")
        coordinator.finishShutdownPresentation()
        XCTAssertEqual(driver.presentationShutdowns, 1)
        XCTAssertNil(coordinator.activeSession)
    }
}
