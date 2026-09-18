import AppKit
import Foundation
import XCTest
@testable import NIOWarpApp

final class MouseMappingSettingsTests: XCTestCase {
    func testMissingCorruptAndUnknownModeSettingsDefaultToPreviewWithoutWriting() throws {
        let suite = "NIOWarp.MouseSettings.SafeDefault.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        for data in [nil, Data("invalid".utf8), Data(#"{"mode":"unknown","previewOnly":false,"speed":1,"pointerSize":28}"#.utf8)] as [Data?] {
            defaults.set(data, forKey: MouseMappingSettings.key)
            let before = defaults.persistentDomain(forName: suite) as NSDictionary?
            let loaded = MouseMappingSettings.load(defaults: defaults)
            XCTAssertEqual(loaded.mode, .glass)
            XCTAssertTrue(loaded.previewOnly)
            XCTAssertEqual(loaded.speed, 1)
            XCTAssertEqual(loaded.pointerSize, 28)
            XCTAssertFalse(loaded.reverseHorizontal)
            XCTAssertEqual(defaults.persistentDomain(forName: suite) as NSDictionary?, before)
        }
    }

    func testLegacyPreferencesKeepEveryChoiceAndDefaultOnlyNewDirectionField() throws {
        let suite = "NIOWarp.MouseSettings.Legacy.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        for mode in MouseMappingMode.allCases {
            let data = try JSONSerialization.data(withJSONObject: ["mode": mode.rawValue,
                "previewOnly": false, "speed": 1.75, "pointerSize": 42])
            defaults.set(data, forKey: MouseMappingSettings.key)
            let loaded = MouseMappingSettings.load(defaults: defaults)
            XCTAssertEqual(loaded.mode, mode)
            XCTAssertFalse(loaded.previewOnly)
            XCTAssertEqual(loaded.speed, 1.75)
            XCTAssertEqual(loaded.pointerSize, 42)
            XCTAssertFalse(loaded.reverseHorizontal)
            XCTAssertEqual(defaults.data(forKey: MouseMappingSettings.key), data, "读取旧配置不得隐式改写偏好")
        }
    }

    func testExplicitDirectionRoundTripsForBothModesWithoutResettingOtherChoices() throws {
        for mode in MouseMappingMode.allCases {
            for reverse in [false, true] {
                let original = MouseMappingSettings(mode: mode, previewOnly: false, speed: 1.6,
                    pointerSize: 36, reverseHorizontal: reverse)
                let loaded = try JSONDecoder().decode(MouseMappingSettings.self, from: JSONEncoder().encode(original))
                XCTAssertEqual(loaded, original)
                XCTAssertEqual(loaded.sanitized().reverseHorizontal, reverse)
            }
        }
    }

    func testFiniteLimitsAndNonfiniteValuesAreSanitizedWithoutChangingModeOrPreviewChoice() {
        for value in [-Double.infinity, Double.infinity, Double.nan] {
            let settings = MouseMappingSettings(mode: .physical, previewOnly: false, speed: value, pointerSize: value, reverseHorizontal: true).sanitized()
            XCTAssertEqual(settings.speed, 1)
            XCTAssertEqual(settings.pointerSize, 28)
            XCTAssertEqual(settings.mode, .physical)
            XCTAssertFalse(settings.previewOnly)
            XCTAssertTrue(settings.reverseHorizontal)
        }
        let low = MouseMappingSettings(speed: -100, pointerSize: -100).sanitized()
        XCTAssertEqual(low.speed, 0.25)
        XCTAssertEqual(low.pointerSize, 12)
        let high = MouseMappingSettings(speed: 100, pointerSize: 100).sanitized()
        XCTAssertEqual(high.speed, 4)
        XCTAssertEqual(high.pointerSize, 64)
    }

    func testSavingSanitizedPreferencesPreservesCalibrationAndProtoPieKeys() throws {
        let suite = "NIOWarp.MouseSettings.Save.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        defaults.set(Data([1, 2, 3]), forKey: "nioWarpConfiguration.v2.test-display")
        defaults.set("private-test-source", forKey: "nioWarpProtoPie.test")
        let before = defaults.persistentDomain(forName: suite) ?? [:]
        let input = MouseMappingSettings(mode: .physical, previewOnly: false, speed: 10, pointerSize: 2, reverseHorizontal: true)
        input.save(defaults: defaults)
        let saved = MouseMappingSettings.load(defaults: defaults)
        XCTAssertEqual(saved, input.sanitized())
        let others = (defaults.persistentDomain(forName: suite) ?? [:]).filter { $0.key != MouseMappingSettings.key }
        XCTAssertEqual(others as NSDictionary, before as NSDictionary)
    }

    func testControllerConstructionAndPreferencesNeverStartInputOrOpenWindows() throws {
        let suite = "NIOWarp.MouseSettings.Controller.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let settings = MouseMappingSettings(mode: .physical, previewOnly: false, speed: 1.8, pointerSize: 24, reverseHorizontal: true)
        settings.save(defaults: defaults)
        MainActor.assumeIsolated {
            _ = NSApplication.shared
            let windows = Set(NSApplication.shared.windows.map(ObjectIdentifier.init))
            let controller = MouseMappingController(defaults: defaults)
            controller.outputProvider = { XCTFail("配置鼠标偏好不得接管显示输出"); return nil }
            controller.sessionProvider = { XCTFail("配置鼠标偏好不得连接浏览器"); return nil }
            let panel = controller.makePanel()
            XCTAssertEqual(controller.settings, settings)
            XCTAssertFalse(controller.isActive, "持久化允许点击不代表启动时自动接管鼠标")
            XCTAssertNil(panel.inspectorView.window)
            XCTAssertEqual(Set(NSApplication.shared.windows.map(ObjectIdentifier.init)), windows)
            XCTAssertNotNil(defaults.data(forKey: "nioWarpMouseMapping.runtime.v1"))
        }
    }
}
