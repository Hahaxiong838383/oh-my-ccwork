import AppKit
import XCTest
@testable import NIOWarpApp

/// These tests never start capture, connect to Chrome, or move the real pointer.
@MainActor final class MouseMappingTestPatternGuardTests: XCTestCase {
    private func make(_ body: (MouseMappingController, UserDefaults) throws -> Void) throws {
        let name = "nio-warp-pattern-guard-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        let controller = MouseMappingController(defaults: defaults)
        defer { controller.stop() }
        try body(controller, defaults)
    }

    private func runtime(_ defaults: UserDefaults) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(defaults.data(forKey: "nioWarpMouseMapping.runtime.v1"))) as? [String: Any])
    }

    func testGridBlocksManualStartBeforeCaptureIsReadyWithoutPausingOrChangingSettings() throws {
        try make { controller, defaults in
            let saved = Data("user-calibration-and-history".utf8)
            defaults.set(saved, forKey: "nioWarpConfiguration.v1")
            controller.settings.save(defaults: defaults)
            let settings = controller.settings
            var prompts: [TestPatternMode] = [], activity = 0, returned = 0
            controller.testPatternProvider = { .calibrationGrid }
            controller.onStartBlockedByTestPattern = { prompts.append($0) }
            controller.onAutomationUserActivity = { activity += 1 }
            controller.onReturnToWorkbench = { returned += 1 }
            controller.start()
            XCTAssertEqual(prompts, [.calibrationGrid])
            XCTAssertEqual(activity, 0, "被网格拦截的启动不能重复暂停轮播")
            XCTAssertEqual(returned, 0, "内屏提醒负责焦点，不先拆掉承接 mouse-up 的外屏表面")
            XCTAssertFalse(controller.isActive)
            XCTAssertFalse(controller.automationOwnsInput)
            let state = try runtime(defaults)
            XCTAssertEqual(state["busy"] as? Bool, false)
            XCTAssertEqual(state["nativeEngaged"] as? Bool, false)
            XCTAssertNil(state["transport"])
            XCTAssertEqual(state["message"] as? String, MouseMappingController.testPatternStartMessage(.calibrationGrid))
            XCTAssertEqual(controller.settings, settings)
            XCTAssertEqual(defaults.data(forKey: "nioWarpConfiguration.v1"), saved)
            XCTAssertNil(defaults.data(forKey: "nioWarpMouseMapping.stops.v1"))
        }
    }

    func testAntiAliasingPatternUsesItsOwnClearMessage() throws {
        try make { controller, defaults in
            var prompts: [TestPatternMode] = []
            controller.testPatternProvider = { .antiAliasingComparison }
            controller.onStartBlockedByTestPattern = { prompts.append($0) }
            controller.start()
            XCTAssertEqual(prompts, [.antiAliasingComparison])
            let message = try XCTUnwrap(try runtime(defaults)["message"] as? String)
            XCTAssertTrue(message.contains("抗锯齿 A/B"))
            XCTAssertTrue(message.contains("标定与画质"))
            XCTAssertFalse(controller.isActive)
        }
    }

    func testDirectAutomaticStartNeverOpensReminderOrLeavesInputOwnership() throws {
        try make { controller, defaults in
            var prompts = 0, activity = 0, failures = 0
            controller.testPatternProvider = { .calibrationGrid }
            controller.onStartBlockedByTestPattern = { _ in prompts += 1 }
            controller.onAutomationUserActivity = { activity += 1 }
            controller.onAutomationFailure = { _ in failures += 1 }
            controller.start(automatic: true)
            XCTAssertEqual(prompts, 0)
            XCTAssertEqual(activity, 0)
            XCTAssertEqual(failures, 0, "准备失败的统一记录由 scheduler 负责")
            XCTAssertFalse(controller.isActive)
            XCTAssertFalse(controller.automationOwnsInput)
            XCTAssertEqual(try runtime(defaults)["busy"] as? Bool, false)
        }
    }

    func testBeginAutomationFailsImmediatelyInsteadOfWaitingForConnectionDeadline() async throws {
        let name = "nio-warp-pattern-automation-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        let controller = MouseMappingController(defaults: defaults)
        defer { controller.stop() }
        var prompts = 0, failures = 0
        controller.testPatternProvider = { .calibrationGrid }
        controller.onStartBlockedByTestPattern = { _ in prompts += 1 }
        controller.onAutomationFailure = { _ in failures += 1 }
        let began = ProcessInfo.processInfo.systemUptime
        do { try await controller.beginAutomation(); XCTFail("网格显示期间不得开启自动输入") }
        catch { XCTAssertEqual(error.localizedDescription, MouseMappingController.testPatternStartMessage(.calibrationGrid)) }
        XCTAssertLessThan(ProcessInfo.processInfo.systemUptime - began, 1)
        XCTAssertEqual(prompts, 0)
        XCTAssertEqual(failures, 0)
        XCTAssertFalse(controller.automationOwnsInput)
        XCTAssertFalse(controller.isActive)
        XCTAssertEqual(try runtime(defaults)["busy"] as? Bool, false)
    }

    func testScriptPointPickIsCancelledWhenGridBlocksManualEntry() async throws {
        let name = "nio-warp-pattern-pick-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        let controller = MouseMappingController(defaults: defaults)
        defer { controller.stop() }
        var prompts = 0, picked = 0, activity = 0
        controller.testPatternProvider = { .calibrationGrid }
        controller.onStartBlockedByTestPattern = { _ in prompts += 1 }
        controller.onAutomationUserActivity = { activity += 1 }
        await controller.pickAutomationPoint { _, _ in picked += 1 }
        XCTAssertEqual(prompts, 1)
        XCTAssertEqual(picked, 0)
        XCTAssertEqual(activity, 0)
        XCTAssertNil(controller.onPickedPoint, "失败取点不能遗留到下一次正常点击")
        XCTAssertFalse(controller.isActive)
    }

    func testOffPreservesNormalStartAndDuplicateRequestGuard() throws {
        try make { controller, defaults in
            var prompts = 0, activity = 0
            controller.testPatternProvider = { .off }
            controller.onStartBlockedByTestPattern = { _ in prompts += 1 }
            controller.onAutomationUserActivity = { activity += 1 }
            controller.start()
            controller.start()
            XCTAssertEqual(activity, 1)
            XCTAssertEqual(prompts, 0)
            XCTAssertEqual(try runtime(defaults)["busy"] as? Bool, true)
            // Cancel synchronously before the task may attempt native capture.
            controller.stop()
            XCTAssertEqual(try runtime(defaults)["busy"] as? Bool, false)
        }
    }

    func testRenderedGridIsFallbackWhenCurrentConfigurationProviderIsAbsent() throws {
        _ = NSApplication.shared
        try make { controller, defaults in
            let output = fixture(.calibrationGrid)
            controller.outputProvider = { output }
            controller.testPatternProvider = { nil }
            var prompts: [TestPatternMode] = []
            controller.onStartBlockedByTestPattern = { prompts.append($0) }
            controller.start()
            XCTAssertEqual(prompts, [.calibrationGrid])
            XCTAssertEqual(try runtime(defaults)["busy"] as? Bool, false)
            XCTAssertFalse(output.cursor.receivesInput)
        }
    }

    func testCurrentRendererPatternTakesPriorityOverOlderCompletedFrame() throws {
        _ = NSApplication.shared
        try make { controller, defaults in
            let output = fixture(.off)
            controller.outputProvider = { output }
            controller.testPatternProvider = { .calibrationGrid }
            var prompts: [TestPatternMode] = []
            controller.onStartBlockedByTestPattern = { prompts.append($0) }
            controller.start()
            XCTAssertEqual(prompts, [.calibrationGrid])
            XCTAssertEqual(try runtime(defaults)["busy"] as? Bool, false)
            XCTAssertFalse(controller.isActive)
        }
    }

    func testPresentationMonitorDoesNotShowUnattendedGridReminder() async throws {
        let name = "nio-warp-pattern-monitor-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        let controller = MouseMappingController(defaults: defaults)
        var prompts = 0
        controller.testPatternProvider = { .calibrationGrid }
        controller.onStartBlockedByTestPattern = { _ in prompts += 1 }
        controller.monitorPresentation()
        try await Task.sleep(nanoseconds: 350_000_000)
        XCTAssertEqual(prompts, 0)
        XCTAssertFalse(controller.isActive)
        XCTAssertFalse(controller.automationOwnsInput)
        controller.stop()
    }

    private func fixture(_ pattern: TestPatternMode) -> MouseMappingOutput {
        let window = NSWindow(contentRect: CGRect(x: 0, y: 0, width: 32, height: 16),
                              styleMask: [], backing: .buffered, defer: true)
        let cursor = MouseCursorOverlay(frame: .zero)
        var configuration = WarpConfiguration.defaultConfiguration(displayWidth: 32, displayHeight: 16)
        configuration.render.testPattern = pattern
        let frame = MouseMappingRenderFrame(mesh: GeneratedMesh(vertices: [], indices: [],
            validation: MeshValidation(foldedCellCount: 0, outOfAASampleCount: 0, totalSampleCount: 0)),
            revision: 1, configuration: configuration, sourceWidth: 32, sourceHeight: 16,
            source: MouseCaptureSource(generation: UUID(), windowID: 1, processID: 1,
                windowSize: CGSize(width: 32, height: 16), pointPixelScale: 1),
            metadata: MouseCaptureMetadata(contentRect: CGRect(x: 0, y: 0, width: 32, height: 16), contentScale: 1, scaleFactor: 1))
        return MouseMappingOutput(window: window, cursor: cursor, displayID: 0, frame: frame,
                                  setInputEnabled: { cursor.receivesInput = $0 })
    }
}
