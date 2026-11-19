import AppKit
import MetalKit
import XCTest
@testable import NIOWarpApp

@MainActor private final class ModeUINoLaunchDriver: ProtoPiePreviewDriving {
    func prepare(configuration: ProtoPieConfiguration, displayID: CGDirectDisplayID,
                 progress: @escaping (String) -> Void) async throws -> ProtoPieSession {
        XCTFail("模式切换不得启动播放器")
        throw ProtoPieError.unavailable("isolated mode fixture")
    }
    func isAlive(_ session: ProtoPieSession) async -> Bool { false }
    func release(_ session: ProtoPieSession) async { }
    func openForUser(configuration: ProtoPieConfiguration) async throws { XCTFail("模式测试不得打开应用") }
}

/// Real workbench actions and AppKit sheets, isolated from installed preferences,
/// player processes, capture sources, and physical mouse/keyboard event taps.
@MainActor final class WorkbenchModeUITests: XCTestCase {
    @MainActor private final class Fixture {
        let domain = "NIOWarp.ModeUI.\(UUID().uuidString)"
        let defaults: UserDefaults
        let access: WorkbenchAccessSession
        let store: ConfigurationStore
        let history: ConfigurationHistoryStore
        let presets: PresetStore
        let proto: ProtoPieCoordinator
        let mouse: MouseMappingController
        let renderer: WarpRenderer?
        let panel: ControlPanelController
        let original: WarpConfiguration
        let selectedPreset: WarpPreset
        var authTransitions: [Bool] = []

        init(active: Bool = false, debug: Bool = false, access shared: WorkbenchAccessSession? = nil) throws {
            _ = NSApplication.shared
            defaults = try XCTUnwrap(UserDefaults(suiteName: domain))
            access = shared ?? WorkbenchAccessSession(passwordVerifier: { $0 == "fixture-debug-access" })
            if debug { XCTAssertTrue(access.unlock(password: "fixture-debug-access")) }
            store = ConfigurationStore(defaults: defaults)
            history = ConfigurationHistoryStore(defaults: defaults)
            presets = PresetStore(defaults: defaults)
            var config = WarpConfiguration.defaultConfiguration(displayWidth: 5120, displayHeight: 2880)
            config.bezierWarp.enabled = true
            config.manual.arch = 0.15
            original = config
            store.save(config)
            var previous = config; previous.manual.arch = 0.12
            history.record(previous, reason: "fixture previous", force: true)
            var preset = config; preset.manual.arch = 0.22
            selectedPreset = try presets.save(name: "已验收预设", configuration: preset)
            MouseMappingSettings(mode: .glass, previewOnly: false, speed: 1, pointerSize: 28,
                reverseHorizontal: false).save(defaults: defaults)
            proto = ProtoPieCoordinator(defaults: defaults, driver: ModeUINoLaunchDriver())
            mouse = MouseMappingController(defaults: defaults)
            mouse.settingsEditingAllowed = { [access] in access.allowsDebugEditing }
            if active {
                guard MTLCreateSystemDefaultDevice() != nil else { throw XCTSkip("需要 Metal 设备") }
                renderer = try XCTUnwrap(WarpRenderer(view: MTKView(frame: .zero), frameStore: LatestFrameStore(), configuration: config))
            } else { renderer = nil }
            // Capture notifications separately from geometry boundary refreshes;
            // mode locking may hide debug overlays but must never rebuild capture.
            panel = ControlPanelController(renderer: renderer, store: store, configuration: config,
                sourceScreen: nil, outputScreen: nil,
                setWarpVisible: { _ in XCTFail("模式切换不得显隐输出") }, isWarpVisible: { false },
                applyCaptureConfiguration: { _ in XCTFail("模式切换不得重启捕获") },
                updateAABoundary: { _, _ in }, updateWarpBoundary: { _, _ in }, presentWindow: false,
                historyStore: history, presetStore: presets, protoPie: proto, mouseMapping: mouse,
                terminateApplication: { XCTFail("模式操作不能退出应用") }, accessSession: access)
        }

        func finish() {
            if let window = panel.window, let sheet = window.attachedSheet {
                window.endSheet(sheet, returnCode: .cancel)
            }
            panel.close(); proto.shutdown(); mouse.stop()
            defaults.removePersistentDomain(forName: domain)
        }

        var protectedState: NSDictionary {
            let values = defaults.persistentDomain(forName: domain) ?? [:]
            return values.filter { !$0.key.contains("runtime") } as NSDictionary
        }
    }

    private func descendants(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(descendants) }
    private func views(_ fixture: Fixture) throws -> [NSView] {
        let root = try XCTUnwrap(fixture.panel.window?.contentView)
        let pages = descendants(root).compactMap { $0 as? NSTabView }.flatMap(\.tabViewItems).compactMap(\.view)
        return ([root] + pages).flatMap(descendants)
    }
    private func control<T: NSControl>(_ type: T.Type, _ id: String, _ fixture: Fixture) throws -> T {
        try XCTUnwrap(views(fixture).first { $0.accessibilityIdentifier() == id } as? T, id)
    }
    private func action(_ selector: String, _ fixture: Fixture) throws -> NSControl {
        try XCTUnwrap(views(fixture).compactMap { $0 as? NSControl }.first {
            $0.action.map(NSStringFromSelector) == selector
        }, selector)
    }
    private func invoke(_ selector: String, _ fixture: Fixture) throws {
        let sender = try action(selector, fixture)
        XCTAssertTrue(sender.sendAction(sender.action, to: sender.target), selector)
    }
    private func wait(_ condition: () -> Bool) {
        let deadline = Date().addingTimeInterval(3)
        while !condition(), Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.01)) }
        XCTAssertTrue(condition(), "sheet 或异步状态未按期更新")
    }
    private func sheet(_ fixture: Fixture) throws -> NSWindow {
        wait { fixture.panel.window?.attachedSheet != nil }
        return try XCTUnwrap(fixture.panel.window?.attachedSheet)
    }
    private func passwordField(_ window: NSWindow) throws -> NSSecureTextField {
        try XCTUnwrap(descendants(try XCTUnwrap(window.contentView)).first {
            $0.accessibilityIdentifier() == "nio-debug-password"
        } as? NSSecureTextField)
    }
    private func end(_ sheet: NSWindow, in fixture: Fixture, response: NSApplication.ModalResponse) {
        fixture.panel.window?.endSheet(sheet, returnCode: response)
        wait { fixture.panel.window?.attachedSheet !== sheet }
    }

    func testDefaultUseModeBlocksAllFiveTabsAndTheirCommandShortcuts() throws {
        let f = try Fixture(); defer { f.finish() }
        let before = f.protectedState
        XCTAssertEqual(f.panel.selectedModuleIdentifier, "protopie")
        let picker = try control(NSSegmentedControl.self, "nio-workbench-modules", f)
        XCTAssertEqual(picker.segmentCount, 7)
        let modules = ["canvas", "global", "local", "quality", "history", "mouse", "protopie"]
        let window = try XCTUnwrap(f.panel.window)
        for (index, module) in modules.enumerated() {
            let allowed = ["history", "protopie"].contains(module)
            XCTAssertEqual(picker.isEnabled(forSegment: index), allowed, module)
            f.panel.selectModule("protopie")
            f.panel.selectModule(module)
            XCTAssertEqual(f.panel.selectedModuleIdentifier, allowed ? module : "protopie")
            f.panel.selectModule("protopie")
            let key = String(index + 1)
            let event = try XCTUnwrap(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: .command,
                timestamp: 0, windowNumber: window.windowNumber, context: nil, characters: key,
                charactersIgnoringModifiers: key, isARepeat: false, keyCode: 0))
            XCTAssertTrue(window.performKeyEquivalent(with: event))
            XCTAssertEqual(f.panel.selectedModuleIdentifier, allowed ? module : "protopie")
        }
        XCTAssertEqual(f.protectedState, before)
    }

    func testLockedDirectActionsCannotChangeGeometryPresetsHistoryOrOpenDebugModals() throws {
        let f = try Fixture(active: true); defer { f.finish() }
        let before = f.protectedState
        let configuration = f.panel.configurationForOfflinePreview
        for selector in ["applyAAFields", "centerAA", "fullAA", "applyCanvasFields", "rebaseCanvas",
                         "restoreReferenceCanvas", "refillCanvasContent", "resetVerticalScale", "resetOutputVerticalOffset",
                         "savePreset", "deletePreset", "rollbackConfiguration", "importConfiguration", "resetConfiguration"] {
            try invoke(selector, f)
            XCTAssertNil(f.panel.window?.attachedSheet, selector)
            XCTAssertEqual(f.panel.configurationForOfflinePreview, configuration, selector)
            XCTAssertEqual(f.protectedState, before, selector)
        }
        for selector in ["updateStrength:", "updateArch:", "updateVerticalScale:", "updateTilt:", "updateHorizontalBend:"] {
            let slider = try XCTUnwrap(action(selector, f) as? NSSlider)
            XCTAssertFalse(slider.isEnabled)
            slider.doubleValue = slider.maxValue
            XCTAssertTrue(slider.sendAction(slider.action, to: slider.target))
            XCTAssertEqual(f.panel.configurationForOfflinePreview, configuration, selector)
            XCTAssertEqual(f.protectedState, before, selector)
        }
    }

    func testAllowedTabsRetainReadAndPlaybackControlsWhilePhysicalPositionIsLocked() throws {
        let f = try Fixture(active: true); defer { f.finish() }
        f.panel.selectModule("history")
        XCTAssertTrue(try action("applyPreset", f).isEnabled)
        XCTAssertTrue(try action("exportConfiguration", f).isEnabled)
        for selector in ["savePreset", "deletePreset", "importConfiguration", "resetConfiguration", "rollbackConfiguration"] {
            XCTAssertFalse(try action(selector, f).isEnabled, selector)
        }
        f.panel.selectModule("protopie")
        let position = try control(NSSlider.self, "nio-protopie-output-vertical-offset", f)
        XCTAssertFalse(position.isEnabled)
        let original = f.panel.configurationForOfflinePreview
        let before = f.protectedState
        position.doubleValue = 600
        XCTAssertTrue(position.sendAction(position.action, to: position.target))
        f.proto.draft.cloudURL = "https://cloud.protopie.io/p/mode-fixture"
        XCTAssertFalse(position.isEnabled, "来源刷新不能重新启用校正滑块")
        XCTAssertEqual(f.panel.configurationForOfflinePreview, original)
        // Source editing is intentionally allowed; compare protected stores only.
        for key in ["nioWarpPresets.v1", "nioWarpConfigurationHistory.v1", MouseMappingSettings.key] {
            XCTAssertEqual(f.protectedState[key] as? Data, before[key] as? Data, key)
        }
        let sourceControls = try views(f).compactMap { $0 as? NSButton }
        XCTAssertTrue(sourceControls.contains { $0.title.hasPrefix("保存配置") && $0.isEnabled })
    }

    func testWrongPasswordClearsSecureFieldAndCancelPreservesAllProtectedState() throws {
        let f = try Fixture(active: true); defer { f.finish() }
        let before = f.protectedState
        try invoke("toggleDebugMode", f)
        let first = try sheet(f)
        let input = try passwordField(first)
        XCTAssertTrue(f.access.isAuthenticating)
        XCTAssertFalse(f.access.isDebugMode)
        input.stringValue = "incorrect"
        try invoke("toggleDebugMode", f)
        XCTAssertTrue(f.panel.window?.attachedSheet === first, "重复按钮不得叠加sheet")
        end(first, in: f, response: .alertSecondButtonReturn)
        let retry = try sheet(f)
        XCTAssertEqual(input.stringValue, "")
        XCTAssertEqual(try passwordField(retry).stringValue, "")
        XCTAssertTrue(f.access.isAuthenticating, "重试时应持续保留密码输入独占")
        XCTAssertFalse(f.access.isDebugMode)
        XCTAssertNotNil(descendants(try XCTUnwrap(retry.contentView)).first { $0.accessibilityIdentifier() == "nio-debug-password-error" })
        end(retry, in: f, response: .alertFirstButtonReturn)
        wait { !f.access.isAuthenticating }
        XCTAssertFalse(f.access.isDebugMode)
        XCTAssertEqual(f.panel.selectedModuleIdentifier, "protopie")
        XCTAssertEqual(f.protectedState, before)
    }

    func testCorrectPasswordUnlocksAllTabsAndRelockPreservesConfiguration() throws {
        let f = try Fixture(active: true); defer { f.finish() }
        let before = f.protectedState
        try invoke("toggleDebugMode", f)
        let confirmation = try sheet(f)
        let input = try passwordField(confirmation)
        input.stringValue = "fixture-debug-access"
        end(confirmation, in: f, response: .alertSecondButtonReturn)
        wait { !f.access.isAuthenticating }
        XCTAssertTrue(f.access.isDebugMode)
        XCTAssertEqual(input.stringValue, "")
        let picker = try control(NSSegmentedControl.self, "nio-workbench-modules", f)
        for index in 0..<7 { XCTAssertTrue(picker.isEnabled(forSegment: index)) }
        f.panel.selectModule("global")
        XCTAssertEqual(f.panel.selectedModuleIdentifier, "global")
        XCTAssertTrue(try action("updateArch:", f).isEnabled)
        f.panel.selectModule("mouse")
        XCTAssertTrue(try control(NSSlider.self, "nio-mouse-speed", f).isEnabled,
            "初始使用模式的灰锁状态不能残留到已解锁的原鼠标设置")
        XCTAssertTrue(try control(NSButton.self, "nio-mouse-reverse-horizontal", f).isEnabled)
        try invoke("toggleDebugMode", f)
        XCTAssertFalse(f.access.isDebugMode)
        XCTAssertEqual(f.panel.selectedModuleIdentifier, "protopie")
        XCTAssertFalse(try action("updateArch:", f).isEnabled)
        XCTAssertFalse(try control(NSSlider.self, "nio-mouse-speed", f).isEnabled)
        XCTAssertTrue(try control(NSButton.self, "nio-workbench-quit", f).isEnabled)
        XCTAssertEqual(f.protectedState, before)
        XCTAssertEqual(f.panel.configurationForOfflinePreview, f.original)
    }

    func testRelockCancelsPendingBezierValidationWithoutHistoryOrParameterWrites() throws {
        let f = try Fixture(active: true, debug: true); defer { f.finish() }
        let before = f.protectedState
        let editor = f.panel.showBezierEditor(presentWindow: false)
        editor.selectNode(6)
        editor.nudge(dx: 2, dy: -1)
        try invoke("toggleDebugMode", f)
        let deadline = Date().addingTimeInterval(0.6)
        while Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.01)) }
        XCTAssertFalse(f.access.isDebugMode)
        XCTAssertEqual(f.panel.configurationForOfflinePreview, f.original)
        XCTAssertEqual(f.store.offlineConfiguration(), f.original)
        XCTAssertEqual(f.protectedState, before)
    }

    func testSharedSessionSurvivesWorkbenchRecreationButNewSessionStartsLocked() throws {
        let shared = authorizedWorkbenchAccessSession()
        let first = try Fixture(access: shared); defer { first.finish() }
        first.panel.selectModule("global")
        let replacement = try Fixture(access: shared); defer { replacement.finish() }
        replacement.panel.restoreWorkspace(from: first.panel, sameDisplay: true)
        XCTAssertEqual(replacement.panel.selectedModuleIdentifier, "global")
        XCTAssertTrue(shared.isDebugMode)
        let restarted = try Fixture(); defer { restarted.finish() }
        restarted.panel.restoreWorkspace(from: first.panel, sameDisplay: true)
        XCTAssertEqual(restarted.panel.selectedModuleIdentifier, "protopie")
        XCTAssertFalse(restarted.access.isDebugMode)
        XCTAssertFalse(try control(NSSegmentedControl.self, "nio-workbench-modules", restarted).isEnabled(forSegment: 1))
    }

    func testExistingPresetNeedsConfirmationAndCanApplyWithoutUnlocking() throws {
        let f = try Fixture(active: true); defer { f.finish() }
        f.panel.selectModule("history")
        let before = f.protectedState
        try invoke("applyPreset", f)
        let cancel = try sheet(f)
        XCTAssertEqual(f.panel.configurationForOfflinePreview, f.original)
        end(cancel, in: f, response: .alertFirstButtonReturn)
        XCTAssertEqual(f.protectedState, before)
        try invoke("applyPreset", f)
        let confirm = try sheet(f)
        end(confirm, in: f, response: .alertSecondButtonReturn)
        wait { f.panel.configurationForOfflinePreview.manual.arch == f.selectedPreset.configuration.manual.arch }
        XCTAssertFalse(f.access.isDebugMode)
        XCTAssertEqual(f.store.offlineConfiguration(), f.selectedPreset.configuration)
        XCTAssertEqual(f.presets.all(), [f.selectedPreset], "应用已有预设不能覆盖预设备份")
        XCTAssertFalse(try action("updateArch:", f).isEnabled)
    }
}
