import AppKit
import MetalKit
import XCTest
@testable import NIOWarpApp

/// Real AppKit sheet regressions, using private defaults and a renderer with no
/// capture source. They never launch a player or modify the installed app.
@MainActor final class CanvasGrowthConfirmationTests: XCTestCase {
    private struct Fixture {
        let panel: ControlPanelController
        let defaults: UserDefaults
        let domain: String
        let history: ConfigurationHistoryStore
    }

    private func make() throws -> Fixture {
        _ = NSApplication.shared
        let domain = "NIOWarp.CanvasConfirmation.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: domain))
        var configuration = WarpConfiguration.defaultConfiguration(displayWidth: 5120, displayHeight: 2880)
        configuration.manual.enabled = false
        configuration.enableCanvasGrowth()
        configuration.canvas.width = 9000
        let store = ConfigurationStore(defaults: defaults)
        store.save(configuration)
        let history = ConfigurationHistoryStore(defaults: defaults)
        guard MTLCreateSystemDefaultDevice() != nil else { throw XCTSkip("需要 Metal 设备") }
        let renderer = try XCTUnwrap(WarpRenderer(view: MTKView(frame: .zero), frameStore: LatestFrameStore(), configuration: configuration))
        let panel = ControlPanelController(renderer: renderer, store: store, configuration: configuration,
            sourceScreen: NSScreen.screens.first, outputScreen: nil,
            setWarpVisible: { _ in }, isWarpVisible: { false },
            applyCaptureConfiguration: { _ in XCTFail("记住外扩起点不应重启捕获") },
            updateAABoundary: { _, _ in }, updateWarpBoundary: { _, _ in }, presentWindow: false,
            historyStore: history, presetStore: PresetStore(defaults: defaults), accessSession: authorizedWorkbenchAccessSession())
        return Fixture(panel: panel, defaults: defaults, domain: domain, history: history)
    }

    private func descendants(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(descendants) }

    private func control(_ action: String, in fixture: Fixture) throws -> NSControl {
        let root = try XCTUnwrap(fixture.panel.window?.contentView)
        return try XCTUnwrap(descendants(root).compactMap { $0 as? NSControl }.first {
            $0.action.map(NSStringFromSelector) == action
        })
    }

    private func request(_ fixture: Fixture) throws {
        let control = try control("rebaseCanvas", in: fixture)
        XCTAssertTrue(control.sendAction(control.action, to: control.target))
    }

    private func wait(_ condition: () -> Bool) {
        let deadline = Date().addingTimeInterval(3)
        while !condition(), Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.01)) }
        XCTAssertTrue(condition(), "工作台确认 sheet 未在预期时间内更新")
    }

    private func sheet(_ fixture: Fixture) throws -> NSWindow {
        wait { fixture.panel.window?.attachedSheet != nil }
        return try XCTUnwrap(fixture.panel.window?.attachedSheet)
    }

    private func button(_ title: String, in sheet: NSWindow) throws -> NSButton {
        try XCTUnwrap(descendants(try XCTUnwrap(sheet.contentView)).compactMap { $0 as? NSButton }.first { $0.title == title })
    }

    private func finish(_ fixture: Fixture) {
        if let window = fixture.panel.window, let sheet = window.attachedSheet {
            window.endSheet(sheet, returnCode: .cancel)
            wait { window.attachedSheet == nil }
        }
        fixture.panel.close()
        fixture.defaults.removePersistentDomain(forName: fixture.domain)
    }

    func testConfirmationBelongsToVisibleControlWindowAndReturnsWithoutModalLoop() throws {
        let fixture = try make(); defer { finish(fixture) }
        let window = try XCTUnwrap(fixture.panel.window)
        try request(fixture) // Would never return with the old runModal implementation.
        let confirmation = try sheet(fixture)
        XCTAssertTrue(confirmation.sheetParent === window)
        XCTAssertTrue(window.isVisible)
        XCTAssertTrue(confirmation.isVisible)
        XCTAssertTrue(NSApp.modalWindow == nil, "不能阻塞应用级事件循环")
        let screen = try XCTUnwrap(window.screen)
        XCTAssertTrue(screen.visibleFrame.intersects(confirmation.frame))
        XCTAssertEqual(confirmation.screen, screen)
        if let builtIn = NSScreen.screens.first(where: {
            guard let id = ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value else { return false }
            return CGDisplayIsBuiltin(id) != 0 && CGDisplayIsActive(id) != 0 && CGDisplayIsAsleep(id) == 0
        }) { XCTAssertEqual(screen, builtIn, "有可用内屏时，确认框应跟随内屏工作台") }
        let screenID = try XCTUnwrap((screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value)
        XCTAssertFalse(OwnedPresentationDisplay.isOwnedDisplay(screenID), "不能在不可见内容屏确认")
    }

    func testCancelAndReturnKeepCalibrationAndHistoryUnchanged() throws {
        let fixture = try make(); defer { finish(fixture) }
        let before = fixture.panel.configurationForOfflinePreview
        let persisted = fixture.defaults.persistentDomain(forName: fixture.domain) as NSDictionary?
        let count = fixture.history.count
        for useReturn in [false, true] {
            try request(fixture)
            let confirmation = try sheet(fixture)
            let cancel = try button("取消，不改动", in: confirmation)
            let confirm = try button("记住当前画面", in: confirmation)
            XCTAssertTrue(confirmation.defaultButtonCell === cancel.cell)
            XCTAssertEqual(cancel.keyEquivalent, "\r")
            XCTAssertTrue(confirm.keyEquivalent.isEmpty)
            if useReturn {
                let event = try XCTUnwrap(NSEvent.keyEvent(with: .keyDown, location: .zero,
                    modifierFlags: [], timestamp: 0, windowNumber: confirmation.windowNumber, context: nil,
                    characters: "\r", charactersIgnoringModifiers: "\r", isARepeat: false, keyCode: 36))
                XCTAssertTrue(confirmation.performKeyEquivalent(with: event))
            } else { cancel.performClick(nil) }
            wait { fixture.panel.window?.attachedSheet == nil }
            XCTAssertEqual(fixture.panel.configurationForOfflinePreview, before)
            XCTAssertEqual(fixture.history.count, count)
            XCTAssertEqual(fixture.defaults.persistentDomain(forName: fixture.domain) as NSDictionary?, persisted)
        }
    }

    func testConfirmRebasesExactlyOnceAndRepeatedRequestsDoNotStackSheets() throws {
        let fixture = try make(); defer { finish(fixture) }
        let before = fixture.panel.configurationForOfflinePreview
        var expected = before; expected.rebaseCanvasGrowth()
        let count = fixture.history.count
        try request(fixture)
        let confirmation = try sheet(fixture)
        try request(fixture)
        try request(fixture)
        XCTAssertTrue(fixture.panel.window?.attachedSheet === confirmation)
        XCTAssertEqual(fixture.panel.window?.sheets.count, 1)
        XCTAssertEqual(fixture.panel.configurationForOfflinePreview, before)
        try button("记住当前画面", in: confirmation).performClick(nil)
        wait { fixture.panel.window?.attachedSheet == nil && fixture.panel.configurationForOfflinePreview == expected }
        XCTAssertEqual(fixture.panel.configurationForOfflinePreview, expected)
        XCTAssertEqual(fixture.history.count, count + 1)
        XCTAssertEqual(fixture.history.all().last?.configuration, before)
        try request(fixture)
        let second = try sheet(fixture)
        try button("取消，不改动", in: second).performClick(nil)
        wait { fixture.panel.window?.attachedSheet == nil }
        XCTAssertEqual(fixture.history.count, count + 1)
    }

    func testChangedConfigurationCannotBeRebasedByStaleConfirmation() throws {
        let fixture = try make(); defer { finish(fixture) }
        try request(fixture)
        let confirmation = try sheet(fixture)
        let offset = try XCTUnwrap(control("updateOutputVerticalOffset", in: fixture) as? NSSlider)
        offset.doubleValue = 100
        XCTAssertTrue(offset.sendAction(offset.action, to: offset.target))
        let changed = fixture.panel.configurationForOfflinePreview
        XCTAssertEqual(changed.outputVerticalOffsetPixels, 100)
        let persisted = fixture.defaults.persistentDomain(forName: fixture.domain) as NSDictionary?
        let count = fixture.history.count
        try button("记住当前画面", in: confirmation).performClick(nil)
        wait { fixture.panel.window?.attachedSheet == nil }
        XCTAssertEqual(fixture.panel.configurationForOfflinePreview, changed)
        XCTAssertEqual(fixture.history.count, count)
        XCTAssertEqual(fixture.defaults.persistentDomain(forName: fixture.domain) as NSDictionary?, persisted)
        XCTAssertEqual(changed.canvasReference?.canvas.width, 7680)
    }

    func testUnappliedCanvasDraftCannotBeRebasedByStaleConfirmation() throws {
        let fixture = try make(); defer { finish(fixture) }
        let before = fixture.panel.configurationForOfflinePreview
        try request(fixture)
        let confirmation = try sheet(fixture)
        let root = try XCTUnwrap(fixture.panel.window?.contentView)
        let width = try XCTUnwrap(descendants(root).compactMap { $0 as? NSTextField }.first { $0.isEditable && $0.stringValue == "9000" })
        width.stringValue = "9100"
        let persisted = fixture.defaults.persistentDomain(forName: fixture.domain) as NSDictionary?
        try button("记住当前画面", in: confirmation).performClick(nil)
        wait { fixture.panel.window?.attachedSheet == nil }
        XCTAssertEqual(fixture.panel.configurationForOfflinePreview, before)
        XCTAssertEqual(width.stringValue, "9100")
        XCTAssertEqual(fixture.defaults.persistentDomain(forName: fixture.domain) as NSDictionary?, persisted)
        XCTAssertEqual(fixture.history.count, 0)
    }
}
