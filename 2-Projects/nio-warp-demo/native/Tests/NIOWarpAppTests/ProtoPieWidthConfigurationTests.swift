import AppKit
import XCTest
@testable import NIOWarpApp

@MainActor private final class WidthFitNoLaunchDriver: ProtoPiePreviewDriving {
    func prepare(configuration: ProtoPieConfiguration, displayID: CGDirectDisplayID,
                 progress: @escaping (String) -> Void) async throws -> ProtoPieSession {
        XCTFail("修改播放比例配置不得打开播放器")
        throw ProtoPieError.unavailable("测试禁止启动播放器")
    }
    func isAlive(_ session: ProtoPieSession) async -> Bool { false }
    func release(_ session: ProtoPieSession) async {}
    func openForUser(configuration: ProtoPieConfiguration) async throws { XCTFail("配置测试不得打开播放器") }
}

final class ProtoPieWidthConfigurationTests: XCTestCase {
    func testLegacyConfigurationKeepsLinksBookmarksAndEveryExistingChoice() throws {
        for source in ProtoPieConfiguration.Source.allCases {
            var original = ProtoPieConfiguration()
            original.source = source
            original.cloudURL = "https://cloud.protopie.io/p/synthetic?shareKey=synthetic-private#scene"
            original.fileBookmark = Data([3, 1, 4, 1, 5])
            original.filePath = "/tmp/original-prototype.pie"
            original.autoStart = true; original.autoRecover = false
            original.scaleToFit = false; original.hidePlayerUI = false
            var json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(original)) as? [String: Any])
            json.removeValue(forKey: "fillWidth")
            json.removeValue(forKey: "widthFitVerticalPosition")
            let decoded = try JSONDecoder().decode(ProtoPieConfiguration.self,
                from: JSONSerialization.data(withJSONObject: json))
            XCTAssertEqual(decoded, original)
            XCTAssertFalse(decoded.fillWidth)
        }
    }

    func testWidthFillRoundTripsAndForcesNativeFitWithoutRewritingOrdinaryFitPreference() throws {
        for fill in [false, true] {
            for ordinaryFit in [false, true] {
                var configuration = ProtoPieConfiguration()
                configuration.cloudURL = "https://cloud.protopie.io/p/synthetic?scaleToFit=false&scaleToFit=false&shareKey=synthetic#scene"
                configuration.fillWidth = fill; configuration.scaleToFit = ordinaryFit
                let decoded = try JSONDecoder().decode(ProtoPieConfiguration.self, from: JSONEncoder().encode(configuration))
                XCTAssertEqual(decoded, configuration)
                let url = try XCTUnwrap(URLComponents(url: decoded.playbackURL(), resolvingAgainstBaseURL: false))
                XCTAssertEqual(url.queryItems?.filter { $0.name == "scaleToFit" },
                    [URLQueryItem(name: "scaleToFit", value: fill || ordinaryFit ? "true" : "false")])
                XCTAssertEqual(url.queryItems?.first { $0.name == "shareKey" }?.value, "synthetic")
                XCTAssertEqual(url.fragment, "scene")
                XCTAssertEqual(configuration.scaleToFit, ordinaryFit)
            }
        }
    }

    func testVerticalPositionMigratesClampsAndRoundTripsWithoutChangingWidthOrURL() throws {
        var configuration = ProtoPieConfiguration()
        configuration.cloudURL = "https://cloud.protopie.io/p/synthetic?shareKey=synthetic"
        configuration.fillWidth = true
        let originalURL = try configuration.playbackURL()
        for value in [-3.0, -1, -0.375, 0, 0.625, 1, 3, -.infinity, .infinity, .nan] {
            configuration.widthFitVerticalPosition = value
            let expected = value.isFinite ? min(max(value, -1), 1) : 0
            XCTAssertEqual(configuration.widthFitVerticalPosition, expected)
            XCTAssertEqual(try JSONDecoder().decode(ProtoPieConfiguration.self, from: JSONEncoder().encode(configuration)), configuration)
            XCTAssertEqual(try configuration.playbackURL(), originalURL)
            XCTAssertTrue(configuration.fillWidth)
        }
        for raw in [-100.0, -0.375, 0, 0.625, 100] {
            var json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(configuration)) as? [String: Any])
            json["widthFitVerticalPosition"] = raw
            let decoded = try JSONDecoder().decode(ProtoPieConfiguration.self, from: JSONSerialization.data(withJSONObject: json))
            XCTAssertEqual(decoded.widthFitVerticalPosition, min(max(raw, -1), 1))
            XCTAssertTrue(decoded.fillWidth)
            XCTAssertEqual(decoded.cloudURL, configuration.cloudURL)
        }
        var json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(configuration)) as? [String: Any])
        json.removeValue(forKey: "widthFitVerticalPosition")
        let legacy = try JSONDecoder().decode(ProtoPieConfiguration.self, from: JSONSerialization.data(withJSONObject: json))
        XCTAssertEqual(legacy.widthFitVerticalPosition, 0)
        XCTAssertTrue(legacy.fillWidth)
        json["widthFitVerticalPosition"] = "NaN"
        let decoder = JSONDecoder()
        decoder.nonConformingFloatDecodingStrategy = .convertFromString(positiveInfinity: "Infinity", negativeInfinity: "-Infinity", nan: "NaN")
        XCTAssertEqual(try decoder.decode(ProtoPieConfiguration.self, from: JSONSerialization.data(withJSONObject: json)).widthFitVerticalPosition, 0)
    }
}

@MainActor final class ProtoPieWidthPanelTests: XCTestCase {
    private func descendants(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(descendants) }

    func testLegacySavedDraftAndLastSuccessfulConfigurationsLoadWithoutRewriting() throws {
        let suite = "NIOWarp.WidthFit.Legacy.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        var expected = [ProtoPieConfiguration]()
        for (index, key) in [ProtoPieCoordinator.savedKey, ProtoPieCoordinator.draftKey, ProtoPieCoordinator.lastSuccessfulKey].enumerated() {
            var configuration = ProtoPieConfiguration()
            configuration.cloudURL = "https://cloud.protopie.io/p/source-\(index)?shareKey=synthetic"
            configuration.autoStart = true; configuration.autoRecover = false; configuration.scaleToFit = false
            var json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(configuration)) as? [String: Any])
            json.removeValue(forKey: "fillWidth")
            json.removeValue(forKey: "widthFitVerticalPosition")
            defaults.set(try JSONSerialization.data(withJSONObject: json), forKey: key)
            expected.append(configuration)
        }
        let before = defaults.persistentDomain(forName: suite) as NSDictionary?
        let coordinator = ProtoPieCoordinator(defaults: defaults, driver: WidthFitNoLaunchDriver())
        defer { coordinator.shutdown() }
        XCTAssertEqual(coordinator.saved, expected[0])
        XCTAssertEqual(coordinator.draft, expected[1])
        XCTAssertEqual(coordinator.lastSuccessful, expected[2])
        XCTAssertEqual(defaults.persistentDomain(forName: suite) as NSDictionary?, before)
        XCTAssertEqual(coordinator.state, .idle)
    }

    func testWidthCheckboxPersistsAndRestoresOrdinaryFitWithoutTouchingCalibration() throws {
        _ = NSApplication.shared
        let suite = "NIOWarp.WidthFit.Panel.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        defaults.set(Data([9, 8, 7]), forKey: "nioWarpConfiguration.v2.synthetic-display")
        let coordinator = ProtoPieCoordinator(defaults: defaults, driver: WidthFitNoLaunchDriver())
        defer { coordinator.shutdown() }
        coordinator.draft.cloudURL = "https://cloud.protopie.io/p/synthetic?shareKey=synthetic"
        coordinator.draft.scaleToFit = false
        let originalURL = coordinator.draft.cloudURL
        let panel = ProtoPiePanel(coordinator: coordinator)
        defer { panel.disconnect() }
        let views = descendants(panel.inspectorView)
        let width = try XCTUnwrap(views.first { $0.accessibilityIdentifier() == "nio-protopie-fill-width" } as? NSButton)
        let fit = try XCTUnwrap(views.first { $0.accessibilityIdentifier() == "nio-protopie-scale-to-fit" } as? NSButton)
        XCTAssertEqual(width.state, .off); XCTAssertEqual(fit.state, .off)
        XCTAssertTrue(width.isEnabled); XCTAssertTrue(fit.isEnabled)
        width.performClick(nil)
        XCTAssertTrue(coordinator.draft.fillWidth)
        XCTAssertFalse(coordinator.draft.scaleToFit)
        XCTAssertEqual(width.state, .on); XCTAssertEqual(fit.state, .on)
        XCTAssertFalse(fit.isEnabled)
        XCTAssertTrue(coordinator.saveConfiguration())
        let restored = ProtoPieCoordinator(defaults: defaults, driver: WidthFitNoLaunchDriver())
        defer { restored.shutdown() }
        XCTAssertEqual(restored.saved, coordinator.draft)
        XCTAssertEqual(restored.draft, coordinator.draft)
        let restoredPanel = ProtoPiePanel(coordinator: restored)
        defer { restoredPanel.disconnect() }
        let restoredWidth = try XCTUnwrap(descendants(restoredPanel.inspectorView).first {
            $0.accessibilityIdentifier() == "nio-protopie-fill-width"
        } as? NSButton)
        XCTAssertEqual(restoredWidth.state, .on)
        width.performClick(nil)
        XCTAssertFalse(coordinator.draft.fillWidth)
        XCTAssertFalse(coordinator.draft.scaleToFit)
        XCTAssertEqual(fit.state, .off); XCTAssertTrue(fit.isEnabled)
        XCTAssertEqual(coordinator.draft.cloudURL, originalURL)
        XCTAssertEqual(defaults.data(forKey: "nioWarpConfiguration.v2.synthetic-display"), Data([9, 8, 7]))
        XCTAssertEqual(coordinator.state, .idle)
    }

    func testWidthFillControlIsDisabledForLocalFileWithoutDiscardingCloudChoice() throws {
        _ = NSApplication.shared
        let suite = "NIOWarp.WidthFit.Local.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let coordinator = ProtoPieCoordinator(defaults: defaults, driver: WidthFitNoLaunchDriver())
        defer { coordinator.shutdown() }
        coordinator.draft.source = .localFile; coordinator.draft.fillWidth = true
        let panel = ProtoPiePanel(coordinator: coordinator)
        defer { panel.disconnect() }
        let width = try XCTUnwrap(descendants(panel.inspectorView).first {
            $0.accessibilityIdentifier() == "nio-protopie-fill-width"
        } as? NSButton)
        XCTAssertFalse(width.isEnabled)
        width.performClick(nil)
        XCTAssertTrue(coordinator.draft.fillWidth)
        coordinator.draft.source = .cloud
        XCTAssertTrue(width.isEnabled)
        XCTAssertEqual(width.state, .on)
    }

    func testVerticalControlsUpdateOnlyDraftAndPreservePositionWhenDisabled() throws {
        _ = NSApplication.shared
        let suite = "NIOWarp.WidthFit.Position.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let coordinator = ProtoPieCoordinator(defaults: defaults, driver: WidthFitNoLaunchDriver())
        defer { coordinator.shutdown() }
        coordinator.draft.cloudURL = "https://cloud.protopie.io/p/synthetic?shareKey=synthetic"
        coordinator.draft.fillWidth = true; coordinator.draft.widthFitVerticalPosition = -0.5
        XCTAssertTrue(coordinator.saveConfiguration())
        let saved = defaults.data(forKey: ProtoPieCoordinator.savedKey)
        let panel = ProtoPiePanel(coordinator: coordinator)
        defer { panel.disconnect() }
        let views = descendants(panel.inspectorView)
        let slider = try XCTUnwrap(views.first { $0.accessibilityIdentifier() == "nio-protopie-vertical-position" } as? NSSlider)
        let input = try XCTUnwrap(views.first { $0.accessibilityIdentifier() == "nio-protopie-vertical-position-input" } as? NSTextField)
        XCTAssertEqual(slider.minValue, -1); XCTAssertEqual(slider.maxValue, 1)
        XCTAssertEqual(slider.doubleValue, -0.5); XCTAssertEqual(input.stringValue, "-0.500")
        XCTAssertTrue(slider.isEnabled); XCTAssertTrue(input.isEnabled)
        slider.doubleValue = 0.375
        slider.sendAction(try XCTUnwrap(slider.action), to: slider.target)
        XCTAssertEqual(coordinator.draft.widthFitVerticalPosition, 0.375)
        XCTAssertEqual(coordinator.saved.widthFitVerticalPosition, -0.5)
        XCTAssertEqual(defaults.data(forKey: ProtoPieCoordinator.savedKey), saved)
        input.stringValue = "-0.625"
        input.sendAction(try XCTUnwrap(input.action), to: input.target)
        XCTAssertEqual(coordinator.draft.widthFitVerticalPosition, -0.625)
        XCTAssertEqual(slider.doubleValue, -0.625)
        for invalid in ["invalid", "NaN", "inf"] {
            input.stringValue = invalid; input.sendAction(try XCTUnwrap(input.action), to: input.target)
            XCTAssertEqual(coordinator.draft.widthFitVerticalPosition, -0.625)
            XCTAssertEqual(input.stringValue, "-0.625")
        }
        input.stringValue = "5"; input.sendAction(try XCTUnwrap(input.action), to: input.target)
        XCTAssertEqual(coordinator.draft.widthFitVerticalPosition, 1)
        XCTAssertEqual(input.stringValue, "1.000")
        coordinator.draft.fillWidth = false
        XCTAssertFalse(slider.isEnabled); XCTAssertFalse(input.isEnabled)
        slider.doubleValue = 0; slider.sendAction(try XCTUnwrap(slider.action), to: slider.target)
        XCTAssertEqual(coordinator.draft.widthFitVerticalPosition, 1)
        coordinator.draft.fillWidth = true; coordinator.draft.source = .localFile
        XCTAssertFalse(slider.isEnabled); XCTAssertFalse(input.isEnabled)
        coordinator.draft.source = .cloud
        XCTAssertTrue(slider.isEnabled); XCTAssertTrue(input.isEnabled)
        XCTAssertEqual(slider.doubleValue, 1)
        XCTAssertTrue(coordinator.saveConfiguration())
        let persisted = try JSONDecoder().decode(ProtoPieConfiguration.self, from: XCTUnwrap(defaults.data(forKey: ProtoPieCoordinator.savedKey)))
        XCTAssertEqual(persisted.widthFitVerticalPosition, 1)
        XCTAssertEqual(persisted.cloudURL, "https://cloud.protopie.io/p/synthetic?shareKey=synthetic")
        XCTAssertEqual(coordinator.state, .idle)
    }
}
