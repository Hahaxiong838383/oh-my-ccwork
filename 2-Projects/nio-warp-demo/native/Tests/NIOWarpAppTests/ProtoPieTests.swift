import AppKit
import XCTest
import JavaScriptCore
@testable import NIOWarpApp

final class ProtoPieConfigurationTests: XCTestCase {
    func testCloudOptionsPreservePrivateShareParametersAndReplaceDuplicates() throws {
        var config = ProtoPieConfiguration()
        config.cloudURL = " https://cloud.protopie.io/p/example?token=private&ui=true&ui=true&scaleToFit=false#scene "
        let components = try XCTUnwrap(URLComponents(url: config.playbackURL(), resolvingAgainstBaseURL: false))
        XCTAssertEqual(components.queryItems?.filter { $0.name == "ui" }, [URLQueryItem(name: "ui", value: "false")])
        XCTAssertEqual(components.queryItems?.first { $0.name == "token" }?.value, "private")
        XCTAssertEqual(components.fragment, "scene")
        XCTAssertEqual(components.queryItems?.first { $0.name == "bgColor" }?.value, "#000000")
        XCTAssertTrue(try config.playbackURL().absoluteString.contains("bgColor=%23000000"))
    }

    func testManualPreviewWindowUsesControlScreenVisibleBoundsAndNegativeCoordinates() {
        let visible = CGRect(x: -1440, y: 25, width: 1440, height: 850)
        let result = ProtoPieSystemDriver.manualPreviewBounds(visibleFrame: visible, primaryTop: 900)
        let topLeftVisible = CGRect(x: visible.minX, y: 900 - visible.maxY, width: visible.width, height: visible.height)
        XCTAssertTrue(topLeftVisible.contains(result))
        XCTAssertEqual(result.width, 1200)
        XCTAssertEqual(result.height, 800)
        XCTAssertEqual(result.minX, -1320)
        XCTAssertEqual(result.minY, 50)
    }

    func testRejectsUnrelatedOriginsCredentialsAndNonTLS() {
        for text in ["http://cloud.protopie.io/p/a", "https://evil.example/p/a", "https://cloud.protopie.io.evil.example/p/a",
                     "https://user:pass@cloud.protopie.io/p/a", "https://cloud.protopie.io:9222/p/a", "https://cloud.protopie.io/p/", "file:///tmp/test"] {
            var config = ProtoPieConfiguration(); config.cloudURL = text
            XCTAssertThrowsError(try config.playbackURL(), text)
        }
    }

    func testConfigurationRoundTripDoesNotContainGeometryOrDisplay() throws {
        var config = ProtoPieConfiguration(); config.cloudURL = "https://cloud.protopie.io/p/example"
        config.autoStart = true; config.autoRecover = false; config.hidePlayerUI = false
        let data = try JSONEncoder().encode(config)
        XCTAssertEqual(try JSONDecoder().decode(ProtoPieConfiguration.self, from: data), config)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertNil(json["warpStrength"]); XCTAssertNil(json["displayID"]); XCTAssertNil(json["bezierWarp"])
    }

    func testLocalFileRequiresValidBookmarkAndPieExtension() throws {
        var config = ProtoPieConfiguration(); config.source = .localFile
        config.filePath = "/tmp/nonexistent.pie"
        XCTAssertThrowsError(try config.validate())
        XCTAssertThrowsError(try config.selectFile(URL(fileURLWithPath: "/tmp/document.txt")))
        config.fileBookmark = Data("bad bookmark".utf8)
        XCTAssertThrowsError(try config.resolvedFile())
    }

    func testCloudJavaScriptEscapesUntrustedURLPathAndMarker() throws {
        let url = URL(string: "https://cloud.protopie.io/p/a%22test")!
        let expression = ProtoPieSystemDriver.cloudReadinessExpression(expectedURL: url, marker: "x\"; throw Error('bad');//")
        XCTAssertTrue(expression.contains("const [expectedPath, marker] = ["))
        let declaration = try XCTUnwrap(expression.split(separator: "\n").first { $0.contains("const [expectedPath, marker] = ") })
        let value = try XCTUnwrap(declaration.components(separatedBy: " = ").last).dropLast()
        let arguments = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(value.utf8)) as? [String])
        XCTAssertEqual(arguments[1], "x\"; throw Error('bad');//")
        XCTAssertTrue(expression.contains("location.pathname===expectedPath"))
    }

    func testSingleWidePrototypeImageIsReadyButLogoAndLoginAreNot() throws {
        let context = try XCTUnwrap(JSContext())
        let setup = """
        var innerWidth=1900, innerHeight=1030;
        var location={hostname:'cloud.protopie.io',pathname:'/p/example'};
        var getComputedStyle=()=>({visibility:'visible'});
        var contentImage={complete:true,naturalWidth:6016,naturalHeight:400,alt:'',className:'layer',src:'asset.png',
          getBoundingClientRect:()=>({width:1900,height:126})};
        var password=false;
        var document={readyState:'complete',title:'ProtoPie',body:{innerText:''},querySelector:()=>null,
          querySelectorAll:s=>s==='img'?[contentImage]:(s==='input[type=password]'&&password?[contentImage]:[])};
        """
        context.evaluateScript(setup)
        let script = ProtoPieSystemDriver.cloudReadinessExpression(expectedURL: URL(string: "https://cloud.protopie.io/p/example")!, marker: "owned-preview")
        XCTAssertEqual(context.evaluateScript(script)?.toDictionary()?["ready"] as? Bool, true)
        XCTAssertEqual(context.evaluateScript("document.title")?.toString(), "owned-preview")
        context.evaluateScript("contentImage.getBoundingClientRect=()=>({width:50,height:50});")
        XCTAssertEqual(context.evaluateScript(script)?.toDictionary()?["ready"] as? Bool, false)
        context.evaluateScript("contentImage.getBoundingClientRect=()=>({width:1900,height:126});password=true;")
        XCTAssertNotNil(context.evaluateScript(script)?.toDictionary()?["problem"])
        XCTAssertNil(context.exception)
    }

    func testCloudTargetBindsOnlyNewIsolatedTargetAndHandlesLoginRedirect() {
        let expected = URL(string: "https://cloud.protopie.io/p/example")!
        let existing: [String: Any] = ["targetId": "user-old", "type": "page", "url": expected.absoluteString]
        let login: [String: Any] = ["targetId": "new-login", "type": "page", "url": "https://cloud.protopie.io/login"]
        XCTAssertEqual(ProtoPieSystemDriver.newCloudTarget([existing, login], excluding: ["user-old"], expectedURL: expected)?["targetId"] as? String, "new-login")
        XCTAssertNil(ProtoPieSystemDriver.newCloudTarget([existing], excluding: ["user-old"], expectedURL: expected))
        let ambiguous: [String: Any] = ["targetId": "another", "type": "page", "url": "https://cloud.protopie.io/login"]
        XCTAssertNil(ProtoPieSystemDriver.newCloudTarget([login, ambiguous], excluding: [], expectedURL: expected))
    }

    func testPreviewWindowRecognitionDoesNotAcceptEditorOrWelcome() {
        XCTAssertFalse(ProtoPieSystemDriver.isPreviewTitle("ProtoPie Studio – Dashboard"))
        XCTAssertFalse(ProtoPieSystemDriver.isPreviewTitle("test1.pie"))
        XCTAssertTrue(ProtoPieSystemDriver.isPreviewTitle("test1 – Preview"))
        XCTAssertTrue(ProtoPieSystemDriver.isPreviewTitle("预览"))
    }
}

@MainActor private final class FakeProtoPieDriver: ProtoPiePreviewDriving {
    var preparations = [ProtoPieConfiguration]()
    var preparedDisplayIDs = [CGDirectDisplayID]()
    var userOpens = 0
    var releases = [ProtoPieSession]()
    var alive = true
    var presentationReady = true
    var presentationChecks = 0
    var presentationResponses = [Bool]()
    var presentationCheck: (() async -> Bool)?
    var failForURL: String?
    var delay: UInt64 = 0
    var nextID: CGWindowID = 100
    var error: Error?
    func prepare(configuration: ProtoPieConfiguration, displayID: CGDirectDisplayID, progress: @escaping (String) -> Void) async throws -> ProtoPieSession {
        preparations.append(configuration)
        preparedDisplayIDs.append(displayID)
        if delay > 0 { try await Task.sleep(nanoseconds: delay) }
        if configuration.cloudURL == failForURL { throw ProtoPieError.waitingForUser("链接需要登录") }
        if let error { throw error }
        presentationReady = true
        nextID += 1
        return ProtoPieSession(windowID: nextID, processID: 42, configuration: configuration, title: "Preview")
    }
    func isAlive(_ session: ProtoPieSession) async -> Bool { alive }
    func isPresentationReady(_ session: ProtoPieSession, displayID: CGDirectDisplayID) async -> Bool {
        presentationChecks += 1
        if let presentationCheck { return await presentationCheck() }
        if !presentationResponses.isEmpty { return presentationResponses.removeFirst() }
        return presentationReady
    }
    func release(_ session: ProtoPieSession) async { releases.append(session) }
    func openForUser(configuration: ProtoPieConfiguration) async throws {
        userOpens += 1
        if delay > 0 { try await Task.sleep(nanoseconds: delay) }
    }
}

@MainActor final class ProtoPieCoordinatorTests: XCTestCase {
    private var domains = [String]()
    private var coordinators = [ProtoPieCoordinator]()
    override func tearDown() async throws {
        for coordinator in coordinators { coordinator.shutdown() }
        coordinators = []
        for domain in domains { UserDefaults.standard.removePersistentDomain(forName: domain) }
        domains = []
        try await super.tearDown()
    }
    private func make(driver: FakeProtoPieDriver? = nil, fastMonitor: Bool = false) -> (ProtoPieCoordinator, UserDefaults) {
        let domain = "NIOWarp.ProtoPie.Tests.\(UUID().uuidString)"
        domains.append(domain)
        let defaults = UserDefaults(suiteName: domain)!
        let coordinator = ProtoPieCoordinator(defaults: defaults, driver: driver ?? FakeProtoPieDriver(),
            monitoringInterval: fastMonitor ? 1_000_000 : 60_000_000_000, recoveryDelay: 1_000_000)
        coordinators.append(coordinator)
        coordinator.draft.cloudURL = "https://cloud.protopie.io/p/first"
        coordinator.onCapture = { _, _ in }
        return (coordinator, defaults)
    }
    private func settle(_ condition: () -> Bool) async {
        for _ in 0..<200 {
            if condition() { return }
            try? await Task.sleep(nanoseconds: 1_000_000)
        }
        XCTFail("异步状态未在期限内完成")
    }

    func testSaveDraftNeverStartsOrChangesActiveSource() {
        let driver = FakeProtoPieDriver(); let (coordinator, defaults) = make(driver: driver)
        coordinator.setTargetDisplay(2)
        XCTAssertTrue(coordinator.saveConfiguration())
        XCTAssertEqual(driver.preparations.count, 0)
        XCTAssertEqual(coordinator.state, .idle)
        XCTAssertNotNil(defaults.data(forKey: ProtoPieCoordinator.savedKey))
    }

    func testStartWaitsForDisplayAndReconnectUsesRequestedSource() async {
        let driver = FakeProtoPieDriver(); let (coordinator, _) = make(driver: driver)
        coordinator.start()
        XCTAssertEqual(coordinator.state, .waitingForDisplay)
        XCTAssertTrue(driver.preparations.isEmpty)
        coordinator.setTargetDisplay(2)
        await settle { coordinator.state == .running }
        XCTAssertEqual(driver.preparations.count, 1)
    }

    func testManualStopCancelsPendingStartupAndReconnectDoesNotRestart() async {
        let driver = FakeProtoPieDriver(); driver.delay = 30_000_000
        let (coordinator, _) = make(driver: driver)
        coordinator.setTargetDisplay(2); coordinator.start()
        await settle { !driver.preparations.isEmpty }
        coordinator.stop()
        coordinator.setTargetDisplay(nil); coordinator.setTargetDisplay(3)
        try? await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertEqual(coordinator.state, .stopped)
        XCTAssertNil(coordinator.activeSession)
        XCTAssertEqual(driver.preparations.count, 1)
    }

    func testRepeatedOpenPlayerDoesNotLaunchDuplicatesAndStopCancelsResult() async {
        let driver = FakeProtoPieDriver(); driver.delay = 20_000_000
        let (coordinator, _) = make(driver: driver)
        coordinator.openPlayer(); coordinator.openPlayer()
        await settle { driver.userOpens == 1 }
        coordinator.stop()
        try? await Task.sleep(nanoseconds: 30_000_000)
        XCTAssertEqual(driver.userOpens, 1)
        XCTAssertEqual(coordinator.state, .stopped)
        XCTAssertTrue(driver.preparations.isEmpty)
    }

    func testRunningWaitsUntilCaptureFirstFrameCallbackCompletes() async {
        let (coordinator, _) = make()
        var releaseCapture: CheckedContinuation<Void, Never>?
        coordinator.onCapture = { _, _ in await withCheckedContinuation { releaseCapture = $0 } }
        coordinator.setTargetDisplay(2); coordinator.start()
        await settle { releaseCapture != nil }
        XCTAssertEqual(coordinator.state, .capturing)
        XCTAssertNil(coordinator.lastSuccessful)
        releaseCapture?.resume()
        await settle { coordinator.state == .running }
        XCTAssertEqual(coordinator.lastSuccessful, coordinator.draft)
    }

    func testDuplicateStartDoesNotSpawnMultiplePlayers() async {
        let driver = FakeProtoPieDriver(); driver.delay = 20_000_000
        let (coordinator, _) = make(driver: driver)
        coordinator.setTargetDisplay(2); coordinator.start(); coordinator.start(); coordinator.start()
        await settle { coordinator.state == .running }
        XCTAssertEqual(driver.preparations.count, 1)
    }

    func testReplacementFailureKeepsOldCaptureAndDoesNotStopOutput() async {
        let driver = FakeProtoPieDriver(); let (coordinator, _) = make(driver: driver)
        var stops = 0; var captures = [CGWindowID]()
        coordinator.onStop = { stops += 1 }; coordinator.onCapture = { id, _ in captures.append(id) }
        coordinator.setTargetDisplay(2); coordinator.start()
        await settle { coordinator.state == .running }
        let old = coordinator.activeSession
        coordinator.draft.cloudURL = "https://cloud.protopie.io/p/broken"; driver.failForURL = coordinator.draft.cloudURL
        coordinator.start()
        await settle { if case .failed = coordinator.state { return true }; return false }
        XCTAssertEqual(coordinator.activeSession, old)
        XCTAssertEqual(stops, 0)
        XCTAssertEqual(captures.last, old?.windowID)
        XCTAssertTrue(coordinator.notice.contains("已保留上一预览"))
    }

    func testCaptureFailureIsNotRecordedAsSuccessfulAndKeepsOldWindow() async {
        let driver = FakeProtoPieDriver(); let (coordinator, _) = make(driver: driver)
        coordinator.setTargetDisplay(2); coordinator.start()
        await settle { coordinator.state == .running }
        let old = coordinator.activeSession!
        coordinator.draft.cloudURL = "https://cloud.protopie.io/p/second"
        coordinator.onCapture = { id, _ in if id != old.windowID { throw ProtoPieError.unavailable("首帧超时") } }
        coordinator.start()
        await settle { if case .failed = coordinator.state { return true }; return false }
        XCTAssertEqual(coordinator.lastSuccessful, old.configuration)
        XCTAssertEqual(coordinator.activeSession, old)
        XCTAssertEqual(driver.releases.count, 1)
    }

    func testDisplayDisconnectKeepsIntentAndManualStopClearsIt() async {
        let driver = FakeProtoPieDriver(); let (coordinator, _) = make(driver: driver)
        coordinator.setTargetDisplay(2); coordinator.start()
        await settle { coordinator.state == .running }
        coordinator.suspendForDisplayChange()
        XCTAssertEqual(coordinator.state, .waitingForDisplay)
        coordinator.setTargetDisplay(3)
        await settle { coordinator.state == .running }
        XCTAssertEqual(driver.preparations.count, 2)
        coordinator.stop(); coordinator.setTargetDisplay(nil); coordinator.setTargetDisplay(2)
        XCTAssertEqual(driver.preparations.count, 2)
    }

    func testDisplayReconfigurationRebindsEvenWhenDisplayIDIsUnchanged() async {
        let driver = FakeProtoPieDriver(); let (coordinator, _) = make(driver: driver)
        var captured = [CGWindowID]()
        coordinator.onCapture = { id, _ in captured.append(id) }
        coordinator.setTargetDisplay(2); coordinator.start()
        await settle { coordinator.state == .running }
        coordinator.suspendForDisplayChange()
        XCTAssertEqual(coordinator.state, .waitingForDisplay)
        coordinator.setTargetDisplay(2)
        await settle { coordinator.state == .running }
        XCTAssertEqual(driver.preparedDisplayIDs, [2, 2])
        XCTAssertEqual(captured.count, 2)
        XCTAssertEqual(captured.last, coordinator.activeSession?.windowID)
        XCTAssertFalse(captured.first == captured.last)
    }

    func testUserPauseSurvivesDisplayReconfigurationAndCanBeResumed() async {
        let driver = FakeProtoPieDriver(); let (coordinator, _) = make(driver: driver)
        coordinator.setTargetDisplay(2); coordinator.start()
        await settle { coordinator.state == .running }
        coordinator.setOutputPaused(true)
        coordinator.suspendForDisplayChange()
        XCTAssertEqual(coordinator.state, .waitingForDisplay)
        coordinator.setTargetDisplay(2)
        await settle { coordinator.state == .paused }
        XCTAssertEqual(driver.preparedDisplayIDs, [2, 2])
        XCTAssertNotNil(coordinator.activeSession)
        coordinator.setOutputPaused(false)
        XCTAssertEqual(coordinator.state, .running)
        XCTAssertEqual(driver.preparations.count, 2)
    }

    func testAliveWindowLosingFullscreenIsPreparedAndRecapturedAfterTwoFailedChecks() async {
        let driver = FakeProtoPieDriver(); let (coordinator, _) = make(driver: driver, fastMonitor: true)
        var captured = [CGWindowID]()
        coordinator.onCapture = { id, _ in captured.append(id) }
        coordinator.setTargetDisplay(2); coordinator.start()
        await settle { coordinator.state == .running }
        let originalWindow = coordinator.activeSession?.windowID
        let originalChecks = driver.presentationChecks
        driver.presentationReady = false
        await settle { driver.preparations.count == 2 && coordinator.state == .running }
        XCTAssertTrue(driver.presentationChecks >= originalChecks + 2)
        XCTAssertTrue(driver.alive)
        XCTAssertEqual(driver.preparedDisplayIDs, [2, 2])
        XCTAssertEqual(captured.count, 2)
        XCTAssertFalse(coordinator.activeSession?.windowID == originalWindow)
        XCTAssertEqual(captured.last, coordinator.activeSession?.windowID)
        XCTAssertTrue(driver.presentationReady)
    }

    func testOneTransientPresentationFailureDoesNotRestartOrRecapture() async {
        let driver = FakeProtoPieDriver(); let (coordinator, _) = make(driver: driver, fastMonitor: true)
        var captures = 0
        coordinator.onCapture = { _, _ in captures += 1 }
        coordinator.setTargetDisplay(2); coordinator.start()
        await settle { coordinator.state == .running }
        let checked = driver.presentationChecks
        driver.presentationResponses = [false, true, false, true]
        await settle { driver.presentationChecks >= checked + 6 }
        XCTAssertEqual(driver.preparations.count, 1)
        XCTAssertEqual(captures, 1)
        XCTAssertEqual(coordinator.state, .running)
    }

    func testRepeatedFullscreenLossHasBoundedRecoveryAndExplicitStartResetsBudget() async {
        let driver = FakeProtoPieDriver(); let (coordinator, _) = make(driver: driver, fastMonitor: true)
        driver.presentationCheck = { false }
        coordinator.setTargetDisplay(2); coordinator.start()
        await settle { driver.preparations.count == 4 }
        try? await Task.sleep(nanoseconds: 20_000_000)
        XCTAssertEqual(driver.preparations.count, 4)
        XCTAssertNotNil(coordinator.activeSession)
        coordinator.start()
        await settle { driver.preparations.count == 8 }
        try? await Task.sleep(nanoseconds: 20_000_000)
        XCTAssertEqual(driver.preparations.count, 8)
        XCTAssertNotNil(coordinator.activeSession)
    }

    func testManualPlayerWindowIsNotForcedBackToFullscreenUntilExplicitStart() async {
        let driver = FakeProtoPieDriver(); let (coordinator, _) = make(driver: driver, fastMonitor: true)
        coordinator.setTargetDisplay(2); coordinator.start()
        await settle { coordinator.state == .running }
        coordinator.openPlayer()
        await settle { driver.userOpens == 1 && coordinator.state == .running }
        driver.presentationReady = false
        try? await Task.sleep(nanoseconds: 20_000_000)
        XCTAssertEqual(driver.preparations.count, 1)
        XCTAssertFalse(driver.presentationReady)
        coordinator.start()
        await settle { driver.preparations.count == 2 && coordinator.state == .running }
        XCTAssertTrue(driver.presentationReady)
        driver.presentationReady = false
        await settle { driver.preparations.count == 3 && coordinator.state == .running }
        XCTAssertTrue(driver.presentationReady)
    }

    func testReloadLeavesManualPlayerModeAndRestoresPresentationMonitoring() async {
        let driver = FakeProtoPieDriver(); let (coordinator, _) = make(driver: driver, fastMonitor: true)
        coordinator.setTargetDisplay(2); coordinator.start()
        await settle { coordinator.state == .running }
        coordinator.openPlayer()
        await settle { driver.userOpens == 1 && coordinator.state == .running }
        coordinator.reload()
        await settle { driver.preparations.count == 2 && coordinator.state == .running }
        driver.presentationReady = false
        await settle { driver.preparations.count == 3 && coordinator.state == .running }
        XCTAssertTrue(driver.presentationReady)
    }

    func testManualPlayerModeSurvivesDisplayChangeUntilExplicitStart() async {
        let driver = FakeProtoPieDriver(); let (coordinator, _) = make(driver: driver, fastMonitor: true)
        var captured = [CGWindowID]()
        coordinator.onCapture = { id, _ in captured.append(id) }
        coordinator.setTargetDisplay(2); coordinator.start()
        await settle { coordinator.state == .running }
        coordinator.openPlayer()
        await settle { driver.userOpens == 1 && coordinator.state == .running }
        driver.presentationReady = false
        coordinator.suspendForDisplayChange(); coordinator.setTargetDisplay(3)
        try? await Task.sleep(nanoseconds: 20_000_000)
        XCTAssertEqual(driver.preparedDisplayIDs, [2])
        XCTAssertEqual(captured.count, 1)
        XCTAssertFalse(driver.presentationReady)
        XCTAssertEqual(coordinator.targetDisplayID, 3)
        coordinator.start()
        await settle { driver.preparations.count == 2 && coordinator.state == .running }
        XCTAssertEqual(driver.preparedDisplayIDs, [2, 3])
        XCTAssertEqual(captured.count, 2)
        XCTAssertTrue(driver.presentationReady)
    }

    func testManualPlayerModeSurvivesCaptureInterruptionUntilExplicitReload() async {
        let driver = FakeProtoPieDriver(); let (coordinator, _) = make(driver: driver, fastMonitor: true)
        XCTAssertTrue(coordinator.saveConfiguration())
        coordinator.setTargetDisplay(2); coordinator.start()
        await settle { coordinator.state == .running }
        coordinator.openPlayer()
        await settle { driver.userOpens == 1 && coordinator.state == .running }
        driver.presentationReady = false
        coordinator.reportCaptureInterrupted("人工操作时捕获中断")
        try? await Task.sleep(nanoseconds: 20_000_000)
        XCTAssertEqual(driver.preparations.count, 1)
        XCTAssertFalse(driver.presentationReady)
        coordinator.reload()
        await settle { driver.preparations.count == 2 && coordinator.state == .running }
        XCTAssertTrue(driver.presentationReady)
        driver.presentationReady = false
        await settle { driver.preparations.count == 3 && coordinator.state == .running }
        XCTAssertTrue(driver.presentationReady)
    }

    func testClosedManualPlayerDoesNotAutoRestartUntilExplicitStart() async {
        let driver = FakeProtoPieDriver(); let (coordinator, _) = make(driver: driver, fastMonitor: true)
        coordinator.setTargetDisplay(2); coordinator.start()
        await settle { coordinator.state == .running }
        coordinator.openPlayer()
        await settle { driver.userOpens == 1 && coordinator.state == .running }
        driver.alive = false
        try? await Task.sleep(nanoseconds: 20_000_000)
        XCTAssertEqual(driver.preparations.count, 1)
        driver.alive = true
        coordinator.start()
        await settle { driver.preparations.count == 2 && coordinator.state == .running }
        XCTAssertTrue(driver.presentationReady)
    }

    func testDisabledAutoRecoveryDoesNotForceAliveWindowBackToFullscreen() async {
        let driver = FakeProtoPieDriver(); let (coordinator, _) = make(driver: driver, fastMonitor: true)
        coordinator.draft.autoRecover = false
        XCTAssertTrue(coordinator.saveConfiguration())
        coordinator.setTargetDisplay(2); coordinator.start()
        await settle { coordinator.state == .running }
        driver.presentationReady = false
        try? await Task.sleep(nanoseconds: 20_000_000)
        XCTAssertEqual(driver.preparations.count, 1)
        XCTAssertFalse(driver.presentationReady)
        XCTAssertEqual(coordinator.state, .running)
    }

    func testPausedOutputDoesNotForceFullscreenButResumingCanRecover() async {
        let driver = FakeProtoPieDriver(); let (coordinator, _) = make(driver: driver, fastMonitor: true)
        coordinator.setTargetDisplay(2); coordinator.start()
        await settle { coordinator.state == .running }
        coordinator.setOutputPaused(true)
        driver.presentationReady = false
        try? await Task.sleep(nanoseconds: 20_000_000)
        XCTAssertEqual(driver.preparations.count, 1)
        XCTAssertEqual(coordinator.state, .paused)
        coordinator.setOutputPaused(false)
        await settle { driver.preparations.count == 2 && coordinator.state == .running }
        XCTAssertTrue(driver.presentationReady)
    }

    func testStopDisablesFullscreenRecoveryAndDisplayReconnect() async {
        let driver = FakeProtoPieDriver(); let (coordinator, _) = make(driver: driver, fastMonitor: true)
        coordinator.setTargetDisplay(2); coordinator.start()
        await settle { coordinator.state == .running }
        driver.presentationReady = false
        coordinator.stop()
        coordinator.suspendForDisplayChange(); coordinator.setTargetDisplay(2)
        try? await Task.sleep(nanoseconds: 20_000_000)
        XCTAssertEqual(driver.preparations.count, 1)
        XCTAssertNil(coordinator.activeSession)
        XCTAssertEqual(coordinator.state, .stopped)
    }

    func testSlowPresentationCheckCannotRecoverAfterStop() async {
        let driver = FakeProtoPieDriver(); let (coordinator, _) = make(driver: driver, fastMonitor: true)
        var pendingCheck: CheckedContinuation<Bool, Never>?
        var healthCalls = 0
        driver.presentationCheck = {
            healthCalls += 1
            if healthCalls == 1 { return false }
            return await withCheckedContinuation { pendingCheck = $0 }
        }
        coordinator.setTargetDisplay(2); coordinator.start()
        await settle { pendingCheck != nil }
        coordinator.stop()
        driver.presentationCheck = nil
        driver.presentationReady = false
        pendingCheck?.resume(returning: false); pendingCheck = nil
        try? await Task.sleep(nanoseconds: 20_000_000)
        XCTAssertEqual(driver.preparations.count, 1)
        XCTAssertNil(coordinator.activeSession)
        XCTAssertEqual(coordinator.state, .stopped)
    }

    func testSlowPresentationCheckCannotRecoverAfterUserOpensPlayer() async {
        let driver = FakeProtoPieDriver(); let (coordinator, _) = make(driver: driver, fastMonitor: true)
        var pendingCheck: CheckedContinuation<Bool, Never>?
        var healthCalls = 0
        driver.presentationCheck = {
            healthCalls += 1
            if healthCalls == 1 { return false }
            return await withCheckedContinuation { pendingCheck = $0 }
        }
        coordinator.setTargetDisplay(2); coordinator.start()
        await settle { pendingCheck != nil }
        coordinator.openPlayer()
        await settle { driver.userOpens == 1 && coordinator.state == .running }
        driver.presentationCheck = nil
        driver.presentationReady = false
        pendingCheck?.resume(returning: false); pendingCheck = nil
        try? await Task.sleep(nanoseconds: 20_000_000)
        XCTAssertEqual(driver.preparations.count, 1)
        XCTAssertNotNil(coordinator.activeSession)
        XCTAssertEqual(coordinator.state, .running)
    }

    func testSlowPresentationCheckHonorsAutoRecoveryDisabledWhileChecking() async {
        let driver = FakeProtoPieDriver(); let (coordinator, _) = make(driver: driver, fastMonitor: true)
        var pendingCheck: CheckedContinuation<Bool, Never>?
        var healthCalls = 0
        driver.presentationCheck = {
            healthCalls += 1
            if healthCalls == 1 { return false }
            return await withCheckedContinuation { pendingCheck = $0 }
        }
        coordinator.setTargetDisplay(2); coordinator.start()
        await settle { pendingCheck != nil }
        coordinator.draft.autoRecover = false
        XCTAssertTrue(coordinator.saveConfiguration())
        driver.presentationCheck = nil
        driver.presentationReady = false
        pendingCheck?.resume(returning: false); pendingCheck = nil
        try? await Task.sleep(nanoseconds: 20_000_000)
        XCTAssertEqual(driver.preparations.count, 1)
        XCTAssertNotNil(coordinator.activeSession)
        XCTAssertEqual(coordinator.state, .running)
    }

    func testOldPresentationCheckCannotAffectDisplayReplacementSession() async {
        let driver = FakeProtoPieDriver(); let (coordinator, _) = make(driver: driver, fastMonitor: true)
        var pendingCheck: CheckedContinuation<Bool, Never>?
        var healthCalls = 0
        driver.presentationCheck = {
            healthCalls += 1
            if healthCalls == 1 { return false }
            return await withCheckedContinuation { pendingCheck = $0 }
        }
        coordinator.setTargetDisplay(2); coordinator.start()
        await settle { pendingCheck != nil }
        driver.presentationCheck = nil
        coordinator.suspendForDisplayChange(); coordinator.setTargetDisplay(3)
        await settle { driver.preparations.count == 2 && coordinator.state == .running }
        let replacement = coordinator.activeSession
        pendingCheck?.resume(returning: false); pendingCheck = nil
        try? await Task.sleep(nanoseconds: 20_000_000)
        XCTAssertEqual(driver.preparedDisplayIDs, [2, 3])
        XCTAssertEqual(coordinator.activeSession, replacement)
        XCTAssertEqual(coordinator.state, .running)
    }

    func testDisplayChangesDuringStartupCancelOldCandidate() async {
        let driver = FakeProtoPieDriver(); driver.delay = 15_000_000
        let (coordinator, _) = make(driver: driver)
        var captured = [CGWindowID]()
        coordinator.onCapture = { id, _ in captured.append(id) }
        coordinator.setTargetDisplay(2); coordinator.start()
        await settle { driver.preparations.count == 1 }
        coordinator.setTargetDisplay(3)
        await settle { coordinator.state == .running }
        XCTAssertEqual(driver.preparations.count, 2)
        XCTAssertEqual(captured.count, 1)
        XCTAssertEqual(coordinator.targetDisplayID, 3)
    }

    func testSavedAutostartIgnoresUnappliedDraftSource() async {
        let (coordinator, _) = make()
        coordinator.draft.autoStart = true; XCTAssertTrue(coordinator.saveConfiguration())
        coordinator.draft.cloudURL = "https://cloud.protopie.io/p/unapplied"
        coordinator.setTargetDisplay(2); coordinator.startIfConfigured()
        await settle { coordinator.state == .running }
        XCTAssertEqual(coordinator.activeSession?.configuration.cloudURL, coordinator.saved.cloudURL)
    }

    func testAutomaticRecoveryIsBoundedAndPermissionFailureDoesNotLoop() async {
        let driver = FakeProtoPieDriver(); driver.error = ProtoPieError.unavailable("网络中断")
        let (coordinator, _) = make(driver: driver)
        coordinator.setTargetDisplay(2); coordinator.start()
        await settle { driver.preparations.count == 4 }
        try? await Task.sleep(nanoseconds: 15_000_000)
        XCTAssertEqual(driver.preparations.count, 4)
        driver.error = ProtoPieError.permission("等待授权")
        coordinator.stop(); coordinator.start()
        await settle { driver.preparations.count == 5 }
        try? await Task.sleep(nanoseconds: 15_000_000)
        XCTAssertEqual(driver.preparations.count, 5)
    }

    func testPauseDoesNotRestartPlayerOrMutateSavedConfiguration() async {
        let driver = FakeProtoPieDriver(); let (coordinator, defaults) = make(driver: driver)
        XCTAssertTrue(coordinator.saveConfiguration())
        let saved = defaults.data(forKey: ProtoPieCoordinator.savedKey)
        coordinator.setTargetDisplay(2); coordinator.start()
        await settle { coordinator.state == .running }
        coordinator.setOutputPaused(true); XCTAssertEqual(coordinator.state, .paused)
        coordinator.setOutputPaused(false); XCTAssertEqual(coordinator.state, .running)
        XCTAssertEqual(driver.preparations.count, 1)
        XCTAssertEqual(defaults.data(forKey: ProtoPieCoordinator.savedKey), saved)
    }

    func testInspectorUsesScrollableDocumentAtAirMinimumHeight() {
        _ = NSApplication.shared
        let (coordinator, _) = make()
        let panel = ProtoPiePanel(coordinator: coordinator)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 288, height: 440), styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        defer { window.close() }
        window.contentView = panel.inspectorView
        window.contentView?.layoutSubtreeIfNeeded()
        XCTAssertTrue(panel.inspectorView.hasVerticalScroller)
        XCTAssertFalse(panel.inspectorView.hasHorizontalScroller)
        XCTAssertTrue((panel.inspectorView.documentView?.frame.height ?? 0) > panel.inspectorView.contentView.bounds.height)
        XCTAssertEqual(panel.inspectorView.documentView?.frame.width ?? -1, panel.inspectorView.contentView.bounds.width)
    }

    func testIndependentObserversBothReceiveStateAndDraftChanges() {
        let (coordinator, _) = make()
        var first = 0, second = 0
        let token = coordinator.observe { first += 1 }
        _ = coordinator.observe { second += 1 }
        coordinator.draft.hidePlayerUI.toggle()
        XCTAssertEqual(first, 2); XCTAssertEqual(second, 2)
        coordinator.removeObserver(token); coordinator.stop()
        XCTAssertEqual(first, 2); XCTAssertEqual(second, 3)
    }
}
