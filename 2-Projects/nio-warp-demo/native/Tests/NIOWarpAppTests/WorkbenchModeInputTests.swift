import AppKit
import XCTest
@testable import NIOWarpApp

@MainActor final class WorkbenchModeInputTests: XCTestCase {
    private func descendants(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(descendants) }

    func testPasswordInputSuspensionIsIdempotentAndDoesNotStartHardwareCapture() {
        let capture = NativeMouseInputCapture()
        var leaves = 0, exits = 0, keyboardEvents = 0
        capture.onLeave = { leaves += 1 }
        capture.onExit = { _, _ in exits += 1 }
        capture.onKeyboardEvent = { _ in keyboardEvents += 1 }
        XCTAssertFalse(capture.physicalInputSuspended)
        capture.setPhysicalInputSuspended(true)
        capture.setPhysicalInputSuspended(true)
        XCTAssertTrue(capture.physicalInputSuspended)
        XCTAssertFalse(capture.isActive)
        XCTAssertFalse(capture.engaged)
        capture.setPhysicalInputSuspended(false)
        capture.setPhysicalInputSuspended(false)
        XCTAssertFalse(capture.physicalInputSuspended)
        XCTAssertFalse(capture.isActive)
        XCTAssertEqual(leaves, 0)
        XCTAssertEqual(exits, 0)
        XCTAssertEqual(keyboardEvents, 0)
    }

    func testAuthenticationBlocksHumanAcquisitionAndDoesNotDeclareManualTakeover() throws {
        let domain = "NIOWarp.ModeInput.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: domain))
        defer { defaults.removePersistentDomain(forName: domain) }
        let original = MouseMappingSettings(mode: .glass, previewOnly: false, speed: 1.3,
            pointerSize: 28, reverseHorizontal: false)
        original.save(defaults: defaults)
        let controller = MouseMappingController(defaults: defaults)
        var manualActivity = 0
        controller.onAutomationUserActivity = { manualActivity += 1 }
        controller.setWorkbenchInputExclusive(true)
        controller.start()
        controller.start()
        XCTAssertTrue(controller.workbenchInputExclusive)
        XCTAssertFalse(controller.isActive)
        XCTAssertFalse(controller.automationOwnsInput)
        XCTAssertEqual(manualActivity, 0, "密码输入不能暂停轮播或当成人工接管")
        XCTAssertEqual(controller.settings, original)
        controller.setWorkbenchInputExclusive(false)
        XCTAssertFalse(controller.isActive, "关密码框不能自动抢回演示焦点")
        controller.start()
        XCTAssertEqual(manualActivity, 1, "关框后仍能由本机点击进入原交互链路")
        controller.stop()
        XCTAssertEqual(MouseMappingSettings.load(defaults: defaults), original)
    }

    func testMousePanelDirectActionAndControllerCallbackCannotBypassModeLock() throws {
        _ = NSApplication.shared
        let domain = "NIOWarp.ModeInput.Settings.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: domain))
        defer { defaults.removePersistentDomain(forName: domain) }
        let original = MouseMappingSettings(mode: .glass, previewOnly: false, speed: 1,
            pointerSize: 28, reverseHorizontal: false)
        original.save(defaults: defaults)
        let access = WorkbenchAccessSession(passwordVerifier: { $0 == "fixture-debug-access" })
        let controller = MouseMappingController(defaults: defaults)
        controller.settingsEditingAllowed = { access.allowsDebugEditing }
        let panel = controller.makePanel()
        let speed = try XCTUnwrap(descendants(panel.inspectorView).first {
            $0.accessibilityIdentifier() == "nio-mouse-speed"
        } as? NSSlider)
        let reverse = try XCTUnwrap(descendants(panel.inspectorView).first {
            $0.accessibilityIdentifier() == "nio-mouse-reverse-horizontal"
        } as? NSButton)
        panel.update(active: false, busy: false, message: "fixture refresh")
        XCTAssertFalse(speed.isEnabled)
        XCTAssertFalse(reverse.isEnabled)
        speed.doubleValue = 2.7
        XCTAssertTrue(speed.sendAction(speed.action, to: speed.target))
        var changed = original; changed.speed = 2.7; changed.reverseHorizontal = true
        panel.onSettingsChange?(changed)
        XCTAssertEqual(controller.settings, original)
        XCTAssertEqual(MouseMappingSettings.load(defaults: defaults), original)
        XCTAssertTrue(access.unlock(password: "fixture-debug-access"))
        panel.update(active: false, busy: false, message: "debug refresh")
        XCTAssertTrue(speed.isEnabled)
        speed.doubleValue = 1.7
        XCTAssertTrue(speed.sendAction(speed.action, to: speed.target))
        XCTAssertEqual(controller.settings.speed, 1.7)
        XCTAssertFalse(controller.settings.reverseHorizontal)
        let accepted = controller.settings
        access.lock()
        panel.update(active: false, busy: false, message: "relocked refresh")
        XCTAssertFalse(speed.isEnabled)
        panel.onSettingsChange?(changed)
        XCTAssertEqual(controller.settings, accepted)
        XCTAssertEqual(MouseMappingSettings.load(defaults: defaults), accepted)
    }
}
