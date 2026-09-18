import AppKit
import Foundation
import XCTest
@testable import NIOWarpApp

final class MouseCursorIdleSettingsTests: XCTestCase {
    private func descendants(_ view: NSView) -> [NSView] {
        [view] + view.subviews.flatMap(descendants)
    }

    func testLegacyPreferencesAddThreeSecondAutoHideWithoutChangingExistingChoicesOrWriting() throws {
        let suite = "NIOWarp.CursorIdle.Legacy.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        for reverse in [nil, false, true] as [Bool?] {
            var object: [String: Any] = ["mode": "physical", "previewOnly": false, "speed": 1.75, "pointerSize": 42]
            if let reverse { object["reverseHorizontal"] = reverse }
            let data = try JSONSerialization.data(withJSONObject: object)
            defaults.set(data, forKey: MouseMappingSettings.key)
            let loaded = MouseMappingSettings.load(defaults: defaults)
            XCTAssertEqual(loaded.mode, .physical)
            XCTAssertFalse(loaded.previewOnly)
            XCTAssertEqual(loaded.speed, 1.75)
            XCTAssertEqual(loaded.pointerSize, 42)
            XCTAssertEqual(loaded.reverseHorizontal, reverse ?? false)
            XCTAssertTrue(loaded.cursorAutoHideEnabled)
            XCTAssertEqual(loaded.cursorAutoHideDelay, 3)
            XCTAssertEqual(defaults.data(forKey: MouseMappingSettings.key), data)
        }
    }

    func testPartiallyPresentNewPreferencesDefaultIndependently() throws {
        let disabled = Data(#"{"mode":"glass","previewOnly":true,"speed":1,"pointerSize":28,"cursorAutoHideEnabled":false}"#.utf8)
        let loadedDisabled = try JSONDecoder().decode(MouseMappingSettings.self, from: disabled)
        XCTAssertFalse(loadedDisabled.cursorAutoHideEnabled)
        XCTAssertEqual(loadedDisabled.cursorAutoHideDelay, 3)
        let delayed = Data(#"{"mode":"glass","previewOnly":true,"speed":1,"pointerSize":28,"cursorAutoHideDelay":12}"#.utf8)
        let loadedDelayed = try JSONDecoder().decode(MouseMappingSettings.self, from: delayed)
        XCTAssertTrue(loadedDelayed.cursorAutoHideEnabled)
        XCTAssertEqual(loadedDelayed.cursorAutoHideDelay, 12)
    }

    func testDelaySanitizesLimitsAndNonfiniteValuesWithoutChangingOtherSettings() {
        for (input, expected) in [(-100.0, 1.0), (0, 1), (1, 1), (2.5, 2.5), (30, 30), (100, 30),
                                  (-Double.infinity, 3), (Double.infinity, 3), (Double.nan, 3)] {
            let original = MouseMappingSettings(mode: .physical, previewOnly: false, speed: 1.75,
                pointerSize: 42, reverseHorizontal: true, cursorAutoHideEnabled: false, cursorAutoHideDelay: input)
            var expectedSettings = original
            expectedSettings.cursorAutoHideDelay = expected
            XCTAssertEqual(original.sanitized(), expectedSettings)
        }
    }

    func testSavedAutoHidePreferencesRoundTripAndLeaveCalibrationAndSourceUntouched() throws {
        let suite = "NIOWarp.CursorIdle.Save.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        defaults.set(Data([4, 8, 15]), forKey: "nioWarpConfiguration.v2.test-display")
        defaults.set("test-source", forKey: "nioWarpProtoPie.test")
        let before = defaults.persistentDomain(forName: suite) ?? [:]
        for enabled in [false, true] {
            for delay in [1.0, 3, 12.5, 30, 100, .nan] {
                let original = MouseMappingSettings(mode: .physical, previewOnly: false, speed: 1.75,
                    pointerSize: 42, reverseHorizontal: true, cursorAutoHideEnabled: enabled, cursorAutoHideDelay: delay)
                original.save(defaults: defaults)
                XCTAssertEqual(MouseMappingSettings.load(defaults: defaults), original.sanitized())
                let others = (defaults.persistentDomain(forName: suite) ?? [:]).filter { $0.key != MouseMappingSettings.key }
                XCTAssertEqual(others as NSDictionary, before as NSDictionary)
            }
        }
    }

    func testPanelLoadsAutoHideAndSavesToggleAndSecondsWithoutChangingOtherChoices() throws {
        try MainActor.assumeIsolated {
            _ = NSApplication.shared
            let original = MouseMappingSettings(mode: .physical, previewOnly: false, speed: 1.75,
                pointerSize: 42, reverseHorizontal: true, cursorAutoHideEnabled: true, cursorAutoHideDelay: 3)
            let panel = MouseMappingPanel(settings: original)
            let views = descendants(panel.inspectorView)
            let toggle = try XCTUnwrap(views.first { $0.accessibilityIdentifier() == "nio-mouse-auto-hide" } as? NSButton)
            let field = try XCTUnwrap(views.first { $0.accessibilityIdentifier() == "nio-mouse-auto-hide-delay" } as? NSTextField)
            var changes: [MouseMappingSettings] = []
            panel.onSettingsChange = { changes.append($0) }
            XCTAssertEqual(toggle.state, .on)
            XCTAssertEqual(field.doubleValue, 3)
            XCTAssertTrue(field.isEnabled)
            field.stringValue = "7.5"
            field.sendAction(try XCTUnwrap(field.action), to: field.target)
            var expected = original; expected.cursorAutoHideDelay = 7.5
            XCTAssertEqual(changes, [expected])
            toggle.performClick(nil)
            expected.cursorAutoHideEnabled = false
            XCTAssertEqual(changes.last, expected)
            XCTAssertFalse(field.isEnabled)
            XCTAssertEqual(field.doubleValue, 7.5)
            toggle.performClick(nil)
            expected.cursorAutoHideEnabled = true
            XCTAssertEqual(changes.last, expected)
            XCTAssertTrue(field.isEnabled)
            let copy = views.compactMap { ($0 as? NSTextField)?.stringValue }.joined(separator: "\n")
            XCTAssertTrue(copy.contains("长按和拖动时不隐藏"))
            XCTAssertTrue(copy.contains("仅用键盘演示不会唤醒圆圈"))
            XCTAssertTrue(copy.contains("首次操作仍然生效"))
        }
    }

    func testPanelClampsNumericDelayAndRejectsInvalidTextWithoutSaving() throws {
        try MainActor.assumeIsolated {
            _ = NSApplication.shared
            let panel = MouseMappingPanel(settings: MouseMappingSettings())
            let field = try XCTUnwrap(descendants(panel.inspectorView).first {
                $0.accessibilityIdentifier() == "nio-mouse-auto-hide-delay"
            } as? NSTextField)
            var changes: [MouseMappingSettings] = []
            panel.onSettingsChange = { changes.append($0) }
            for (text, expected) in [("0", 1.0), ("100", 30.0), (" 5 ", 5.0)] {
                field.stringValue = text
                field.sendAction(try XCTUnwrap(field.action), to: field.target)
                XCTAssertEqual(field.doubleValue, expected)
                XCTAssertEqual(changes.last?.cursorAutoHideDelay, expected)
            }
            let count = changes.count
            for text in ["", "三秒", "--"] {
                field.stringValue = text
                field.sendAction(try XCTUnwrap(field.action), to: field.target)
                XCTAssertEqual(field.doubleValue, 5)
                XCTAssertEqual(changes.count, count)
            }
        }
    }

    func testPanelDisablesIdleSettingsWhileStartingOrActiveAndRestoresAfterStop() throws {
        try MainActor.assumeIsolated {
            _ = NSApplication.shared
            let original = MouseMappingSettings(cursorAutoHideEnabled: true, cursorAutoHideDelay: 4)
            let panel = MouseMappingPanel(settings: original)
            let views = descendants(panel.inspectorView)
            let toggle = try XCTUnwrap(views.first { $0.accessibilityIdentifier() == "nio-mouse-auto-hide" } as? NSButton)
            let field = try XCTUnwrap(views.first { $0.accessibilityIdentifier() == "nio-mouse-auto-hide-delay" } as? NSTextField)
            var changes: [MouseMappingSettings] = []
            panel.onSettingsChange = { changes.append($0) }
            for (active, busy) in [(false, true), (true, false), (true, true)] {
                panel.update(active: active, busy: busy, message: "测试")
                XCTAssertFalse(toggle.isEnabled)
                XCTAssertFalse(field.isEnabled)
                toggle.performClick(nil)
                field.stringValue = "12"
                field.sendAction(try XCTUnwrap(field.action), to: field.target)
                XCTAssertTrue(changes.isEmpty)
                XCTAssertEqual(field.doubleValue, 4)
                panel.load(original)
                XCTAssertFalse(field.isEnabled, "刷新设置不能在演示中重新启用输入框")
            }
            panel.update(active: false, busy: false, message: "测试")
            XCTAssertTrue(toggle.isEnabled)
            XCTAssertTrue(field.isEnabled)
            toggle.performClick(nil)
            XCTAssertFalse(field.isEnabled)
            XCTAssertEqual(changes.count, 1)
        }
    }
}
