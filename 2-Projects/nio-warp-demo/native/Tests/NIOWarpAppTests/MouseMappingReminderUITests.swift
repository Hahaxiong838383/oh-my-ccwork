import AppKit
import MetalKit
import XCTest
@testable import NIOWarpApp

/// Exercise the actual workbench reminder sheet without starting a player,
/// capturing hardware input, or changing production preferences.
@MainActor final class MouseMappingReminderUITests: XCTestCase {
    private struct Fixture {
        let panel: ControlPanelController
        let mouse: MouseMappingController
        let defaults: UserDefaults
        let domain: String
        let history: ConfigurationHistoryStore
        let renderer: WarpRenderer
    }

    private func make(pattern: TestPatternMode = .calibrationGrid, allowsPreviewSetup: Bool = false) throws -> Fixture {
        _ = NSApplication.shared
        let domain = "NIOWarp.MouseReminder.UI.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: domain))
        MouseMappingSettings().save(defaults: defaults)
        var configuration = WarpConfiguration.defaultConfiguration(displayWidth: 5120, displayHeight: 2880)
        configuration.manual.enabled = false
        configuration.render.testPattern = pattern
        configuration.enableCanvasGrowth()
        let store = ConfigurationStore(defaults: defaults)
        store.save(configuration)
        let history = ConfigurationHistoryStore(defaults: defaults)
        var previous = configuration
        previous.canvas.width = 9000
        history.record(previous, reason: "已有标定记录", force: true)
        guard MTLCreateSystemDefaultDevice() != nil else { throw XCTSkip("需要 Metal 设备") }
        let renderer = try XCTUnwrap(WarpRenderer(view: MTKView(frame: .zero), frameStore: LatestFrameStore(), configuration: configuration))
        let mouse = MouseMappingController(defaults: defaults)
        let panel = ControlPanelController(renderer: renderer, store: store, configuration: configuration,
            sourceScreen: NSScreen.screens.first, outputScreen: nil,
            setWarpVisible: { _ in XCTFail("提示不应改变输出显隐") }, isWarpVisible: { false },
            applyCaptureConfiguration: { _ in XCTFail("提示不应重启捕获") },
            updateAABoundary: { _, _ in XCTFail("提示不应改变 AA") },
            updateWarpBoundary: { _, _ in if !allowsPreviewSetup { XCTFail("提示不应改变曲面") } }, presentWindow: false,
            historyStore: history, presetStore: PresetStore(defaults: defaults), mouseMapping: mouse,
            terminateApplication: { XCTFail("提示不应退出程序") }, accessSession: authorizedWorkbenchAccessSession())
        panel.selectModule("mouse")
        return Fixture(panel: panel, mouse: mouse, defaults: defaults, domain: domain, history: history, renderer: renderer)
    }

    private func descendants(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(descendants) }

    private func wait(_ condition: () -> Bool) {
        let deadline = Date().addingTimeInterval(3)
        while !condition(), Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.01)) }
        XCTAssertTrue(condition(), "鼠标提示 sheet 未在预期时间内更新")
    }

    private func sheet(_ fixture: Fixture) throws -> NSWindow {
        wait { fixture.panel.window?.attachedSheet != nil }
        return try XCTUnwrap(fixture.panel.window?.attachedSheet)
    }

    private func button(_ title: String, in sheet: NSWindow) throws -> NSButton {
        try XCTUnwrap(descendants(try XCTUnwrap(sheet.contentView)).compactMap { $0 as? NSButton }.first { $0.title == title })
    }

    private func labels(in sheet: NSWindow) throws -> [String] {
        descendants(try XCTUnwrap(sheet.contentView)).compactMap { ($0 as? NSTextField)?.stringValue }
    }

    private func invoke(_ action: String, in fixture: Fixture) throws {
        let root = try XCTUnwrap(fixture.panel.window?.contentView)
        // AppKit detaches inactive tabs' documents from the window hierarchy.
        let tabPages = descendants(root).compactMap { $0 as? NSTabView }
            .flatMap(\.tabViewItems).compactMap(\.view)
        let candidates = ([root] + tabPages).flatMap(descendants)
        let control = try XCTUnwrap(candidates.compactMap { $0 as? NSControl }.first {
            $0.action.map(NSStringFromSelector) == action
        })
        XCTAssertTrue(control.sendAction(control.action, to: control.target))
    }

    private func persistedSettings(_ fixture: Fixture) -> NSDictionary {
        var value = fixture.defaults.persistentDomain(forName: fixture.domain) ?? [:]
        // Switching away from the mouse module can commit an unchanged field
        // and refresh diagnostic timestamps. Neither is a calibration change.
        value.removeValue(forKey: "nioWarpMouseMapping.runtime.v1")
        if let data = value[MouseMappingSettings.key] as? Data,
           let settings = try? JSONSerialization.jsonObject(with: data) {
            value[MouseMappingSettings.key] = settings
        }
        return value as NSDictionary
    }

    private func finish(_ fixture: Fixture) {
        if let window = fixture.panel.window, let sheet = window.attachedSheet {
            window.endSheet(sheet, returnCode: .cancel)
            wait { window.attachedSheet == nil }
        }
        fixture.panel.close()
        fixture.defaults.removePersistentDomain(forName: fixture.domain)
    }

    func testGridReminderUsesVisibleWorkbenchSheetAndDoesNotStartInput() throws {
        let fixture = try make(); defer { finish(fixture) }
        let window = try XCTUnwrap(fixture.panel.window)
        let geometry = fixture.panel.configurationForOfflinePreview
        let persisted = persistedSettings(fixture)
        fixture.panel.showMouseMappingTestPatternReminder(.calibrationGrid)
        let reminder = try sheet(fixture)
        XCTAssertTrue(try labels(in: reminder).contains("请先关闭标定网格"))
        XCTAssertTrue(reminder.sheetParent === window)
        XCTAssertTrue(window.isVisible)
        XCTAssertTrue(reminder.isVisible)
        XCTAssertNil(NSApp.modalWindow, "提示不能使用独立 runModal 阻塞工作台")
        let screen = try XCTUnwrap(window.screen)
        XCTAssertTrue(screen.visibleFrame.intersects(reminder.frame))
        XCTAssertEqual(reminder.screen, screen)
        let displayID = try XCTUnwrap((screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value)
        XCTAssertFalse(OwnedPresentationDisplay.isOwnedDisplay(displayID))
        let acknowledge = try button("知道了", in: reminder)
        let navigate = try button("前往标定与画质", in: reminder)
        XCTAssertTrue(reminder.defaultButtonCell === acknowledge.cell)
        XCTAssertEqual(acknowledge.keyEquivalent, "\r")
        XCTAssertTrue(navigate.keyEquivalent.isEmpty)
        XCTAssertFalse(fixture.mouse.isActive)
        acknowledge.performClick(nil)
        wait { window.attachedSheet == nil }
        XCTAssertEqual(fixture.panel.selectedModuleIdentifier, "mouse")
        XCTAssertEqual(fixture.panel.configurationForOfflinePreview, geometry)
        XCTAssertEqual(fixture.panel.configurationForOfflinePreview.render.testPattern, .calibrationGrid)
        XCTAssertEqual(persistedSettings(fixture), persisted)
        XCTAssertFalse(fixture.mouse.isActive)
    }

    func testReturnAcknowledgesWithoutChangingCalibrationHistoryOrModule() throws {
        let fixture = try make(); defer { finish(fixture) }
        let geometry = fixture.panel.configurationForOfflinePreview
        let history = fixture.history.all()
        let persisted = persistedSettings(fixture)
        fixture.panel.showMouseMappingTestPatternReminder(.calibrationGrid)
        let reminder = try sheet(fixture)
        let event = try XCTUnwrap(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0,
            windowNumber: reminder.windowNumber, context: nil, characters: "\r", charactersIgnoringModifiers: "\r", isARepeat: false, keyCode: 36))
        XCTAssertTrue(reminder.performKeyEquivalent(with: event))
        wait { fixture.panel.window?.attachedSheet == nil }
        XCTAssertEqual(fixture.panel.configurationForOfflinePreview, geometry)
        XCTAssertEqual(fixture.history.all(), history)
        XCTAssertEqual(fixture.panel.selectedModuleIdentifier, "mouse")
        XCTAssertEqual(persistedSettings(fixture), persisted)
        XCTAssertFalse(fixture.mouse.isActive)
    }

    func testNavigateOnlySelectsQualityAndKeepsGridAndParameters() throws {
        let fixture = try make(); defer { finish(fixture) }
        let geometry = fixture.panel.configurationForOfflinePreview
        let history = fixture.history.all()
        let persisted = persistedSettings(fixture)
        fixture.panel.showMouseMappingTestPatternReminder(.calibrationGrid)
        let reminder = try sheet(fixture)
        try button("前往标定与画质", in: reminder).performClick(nil)
        wait { fixture.panel.window?.attachedSheet == nil && fixture.panel.selectedModuleIdentifier == "quality" }
        XCTAssertEqual(fixture.panel.configurationForOfflinePreview, geometry)
        XCTAssertEqual(fixture.panel.configurationForOfflinePreview.render.testPattern, .calibrationGrid)
        XCTAssertEqual(fixture.history.all(), history)
        XCTAssertEqual(persistedSettings(fixture), persisted)
        XCTAssertFalse(fixture.mouse.isActive)
    }

    func testComparisonPatternHasSpecificTitleAndOffDoesNotPresentReminder() throws {
        let fixture = try make(pattern: .antiAliasingComparison); defer { finish(fixture) }
        let geometry = fixture.panel.configurationForOfflinePreview
        let persisted = persistedSettings(fixture)
        fixture.panel.showMouseMappingTestPatternReminder(.off)
        XCTAssertNil(fixture.panel.window?.attachedSheet)
        fixture.panel.showMouseMappingTestPatternReminder(.antiAliasingComparison)
        let reminder = try sheet(fixture)
        XCTAssertTrue(try labels(in: reminder).contains("请先结束测试画面"))
        try button("知道了", in: reminder).performClick(nil)
        wait { fixture.panel.window?.attachedSheet == nil }
        XCTAssertEqual(fixture.panel.configurationForOfflinePreview, geometry)
        XCTAssertEqual(persistedSettings(fixture), persisted)
        XCTAssertFalse(fixture.mouse.isActive)
    }

    func testRepeatedRequestsAndOtherActionsCannotStackOnReminder() throws {
        let fixture = try make(); defer { finish(fixture) }
        let geometry = fixture.panel.configurationForOfflinePreview
        let persisted = persistedSettings(fixture)
        fixture.panel.showMouseMappingTestPatternReminder(.calibrationGrid)
        let reminder = try sheet(fixture)
        fixture.panel.showMouseMappingTestPatternReminder(.calibrationGrid)
        fixture.panel.showMouseMappingTestPatternReminder(.antiAliasingComparison)
        try invoke("requestQuit", in: fixture)
        try invoke("rebaseCanvas", in: fixture)
        XCTAssertTrue(fixture.panel.window?.attachedSheet === reminder)
        XCTAssertEqual(fixture.panel.window?.sheets.count, 1)
        XCTAssertTrue(try labels(in: reminder).contains("请先关闭标定网格"))
        try button("知道了", in: reminder).performClick(nil)
        wait { fixture.panel.window?.attachedSheet == nil }
        fixture.panel.showMouseMappingTestPatternReminder(.calibrationGrid)
        let next = try sheet(fixture)
        XCTAssertFalse(next === reminder, "确认关闭后允许下一次主动操作重新提醒")
        try button("知道了", in: next).performClick(nil)
        wait { fixture.panel.window?.attachedSheet == nil }
        XCTAssertEqual(fixture.panel.configurationForOfflinePreview, geometry)
        XCTAssertEqual(persistedSettings(fixture), persisted)
    }

    func testTemporaryUncorrectedGridReminderDoesNotExitPreviewOrChangeSavedParameters() throws {
        let fixture = try make(pattern: .off, allowsPreviewSetup: true); defer { finish(fixture) }
        let geometry = fixture.panel.configurationForOfflinePreview
        try invoke("toggleRawCalibration", in: fixture)
        let preview = fixture.renderer.activeConfiguration
        XCTAssertEqual(preview.render.testPattern, .calibrationGrid)
        XCTAssertEqual(fixture.panel.configurationForOfflinePreview.render.testPattern, .off)
        let persisted = persistedSettings(fixture)
        fixture.panel.showMouseMappingTestPatternReminder(preview.render.testPattern)
        let reminder = try sheet(fixture)
        XCTAssertTrue(try labels(in: reminder).contains("请先结束临时标定预览"))
        try button("前往标定与画质", in: reminder).performClick(nil)
        wait { fixture.panel.window?.attachedSheet == nil && fixture.panel.selectedModuleIdentifier == "quality" }
        XCTAssertEqual(fixture.renderer.activeConfiguration, preview, "提示只导航，不替用户结束临时预览")
        XCTAssertEqual(fixture.panel.configurationForOfflinePreview, geometry)
        XCTAssertEqual(persistedSettings(fixture), persisted)
        XCTAssertFalse(fixture.mouse.isActive)
    }

    func testReminderDoesNotReplaceExistingQuitOrCanvasConfirmation() throws {
        let fixture = try make(); defer { finish(fixture) }
        let geometry = fixture.panel.configurationForOfflinePreview
        let persisted = persistedSettings(fixture)
        for (action, title, cancelTitle) in [("requestQuit", "退出 NIO Warp？", "取消"),
                                            ("rebaseCanvas", "把当前画面作为新的外扩起点？", "取消，不改动")] {
            try invoke(action, in: fixture)
            let original = try sheet(fixture)
            XCTAssertTrue(try labels(in: original).contains(title))
            fixture.panel.showMouseMappingTestPatternReminder(.calibrationGrid)
            XCTAssertTrue(fixture.panel.window?.attachedSheet === original)
            XCTAssertEqual(fixture.panel.window?.sheets.count, 1)
            try button(cancelTitle, in: original).performClick(nil)
            wait { fixture.panel.window?.attachedSheet == nil }
        }
        fixture.panel.showMouseMappingTestPatternReminder(.calibrationGrid)
        let reminder = try sheet(fixture)
        XCTAssertTrue(try labels(in: reminder).contains("请先关闭标定网格"))
        try button("知道了", in: reminder).performClick(nil)
        wait { fixture.panel.window?.attachedSheet == nil }
        XCTAssertEqual(fixture.panel.configurationForOfflinePreview, geometry)
        XCTAssertEqual(persistedSettings(fixture), persisted)
        XCTAssertFalse(fixture.mouse.isActive)
    }
}
