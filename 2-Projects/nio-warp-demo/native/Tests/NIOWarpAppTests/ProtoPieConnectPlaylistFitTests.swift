import AppKit
import XCTest
@testable import NIOWarpApp

final class ProtoPieConnectPlaylistFitTests: XCTestCase {
    private func item(scaleToFit: Bool? = nil) throws -> ProtoPiePlaylistItem {
        var item = ProtoPiePlaylistItem()
        item.source = .connect
        item.cloudURL = "http://localhost:9981/pie?pieid=42&scaleToFit=true"
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(item)) as? [String: Any])
        // Construct on-disk fixtures without depending on the new Swift property.
        object.removeValue(forKey: "connectScaleToFit")
        if let scaleToFit { object["connectScaleToFit"] = scaleToFit }
        return try JSONDecoder().decode(ProtoPiePlaylistItem.self, from: JSONSerialization.data(withJSONObject: object))
    }

    private func encodedFit(_ item: ProtoPiePlaylistItem) throws -> Bool? {
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(item)) as? [String: Any])
        return object["connectScaleToFit"] as? Bool
    }

    func testNewAndMissingFieldItemsDefaultToNativeFitEvenWhenPreviousFitIsOff() throws {
        XCTAssertEqual(try encodedFit(ProtoPiePlaylistItem()), true)
        let old = try item()
        XCTAssertEqual(try encodedFit(old), true)
        var previous = ProtoPieConfiguration(); previous.scaleToFit = false
        let configuration = try old.configuration(inheriting: previous)
        XCTAssertTrue(configuration.scaleToFit)
        let query = URLComponents(url: try configuration.playbackURL(), resolvingAgainstBaseURL: false)?.queryItems
        XCTAssertEqual(query?.filter { $0.name == "scaleToFit" }.map(\.value), ["true"])
    }

    func testExplicitNativeFitOffSurvivesRoundTripAndOverridesURLQuery() throws {
        let original = try item(scaleToFit: false)
        let decoded = try JSONDecoder().decode(ProtoPiePlaylistItem.self, from: JSONEncoder().encode(original))
        XCTAssertEqual(try encodedFit(decoded), false)
        let configuration = try decoded.configuration(inheriting: ProtoPieConfiguration())
        XCTAssertFalse(configuration.scaleToFit)
        let query = URLComponents(url: try configuration.playbackURL(), resolvingAgainstBaseURL: false)?.queryItems
        XCTAssertEqual(query?.filter { $0.name == "scaleToFit" }.map(\.value), ["false"])
    }

    func testConnectKeepsInheritedCloudGeometryAndCloudStillAppliesItsOverrides() throws {
        var previous = ProtoPieConfiguration()
        previous.cloudURL = "https://cloud.protopie.io/p/kept"
        previous.fillWidth = true; previous.widthFitVerticalPosition = -0.65
        var connect = try item(scaleToFit: false)
        connect.fillWidth = false; connect.verticalPosition = 0.4
        let configuration = try connect.configuration(inheriting: previous)
        XCTAssertEqual(configuration.cloudURL, previous.cloudURL)
        XCTAssertEqual(configuration.fillWidth, previous.fillWidth)
        XCTAssertEqual(configuration.widthFitVerticalPosition, previous.widthFitVerticalPosition)
        XCTAssertFalse(configuration.scaleToFit)
        XCTAssertEqual(connect.fillWidth, false)
        XCTAssertEqual(connect.verticalPosition, 0.4)

        var cloud = connect; cloud.source = .cloud
        cloud.cloudURL = "https://cloud.protopie.io/p/fixture"
        let cloudConfiguration = try cloud.configuration(inheriting: previous)
        XCTAssertEqual(cloudConfiguration.fillWidth, false)
        XCTAssertEqual(cloudConfiguration.widthFitVerticalPosition, 0.4)
        XCTAssertEqual(cloudConfiguration.scaleToFit, previous.scaleToFit)
    }
}

/// Real AppKit target/action events, backed by isolated production stores and
/// controllers. No preview, input binding or production defaults are used.
@MainActor final class ProtoPieConnectPlaylistFitUITests: XCTestCase {
    private var domains: [String] = []
    private var directories: [URL] = []
    private var panels: [ProtoPiePlaybackPanel] = []
    private var controllers: [ProtoPiePlaybackController] = []

    override func tearDown() async throws {
        for panel in panels { panel.disconnect() }
        for controller in controllers { controller.shutdown() }
        panels = []; controllers = []
        for domain in domains { UserDefaults.standard.removePersistentDomain(forName: domain) }
        for directory in directories { try? FileManager.default.removeItem(at: directory) }
        domains = []; directories = []
        try await super.tearDown()
    }

    private func defaults() throws -> UserDefaults {
        let domain = "NIOWarp.ConnectPlaylistFit.\(UUID().uuidString)"
        domains.append(domain)
        return try XCTUnwrap(UserDefaults(suiteName: domain))
    }

    private func bytes(_ item: ProtoPiePlaylistItem, fit: Bool? = nil) throws -> Data {
        var library = ProtoPiePlaybackLibrary(); library.items = [item]; library.selectedItemID = item.id
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(library)) as? [String: Any])
        var items = try XCTUnwrap(object["items"] as? [[String: Any]])
        items[0].removeValue(forKey: "connectScaleToFit")
        if let fit { items[0]["connectScaleToFit"] = fit }
        object["items"] = items
        return try JSONSerialization.data(withJSONObject: object)
    }

    private func make(_ defaults: UserDefaults) -> (ProtoPiePlaybackPanel, ProtoPiePlaybackController) {
        _ = NSApplication.shared
        let store = ProtoPiePlaybackStore(defaults: defaults, legacy: ProtoPieConfiguration())
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("NIOWarp.ConnectPlaylistFit.\(UUID().uuidString)")
        directories.append(directory)
        let controller = ProtoPiePlaybackController(store: store, log: ProtoPiePlaybackLog(directory: directory))
        controllers.append(controller)
        let panel = ProtoPiePlaybackPanel(controller: controller); panels.append(panel)
        return (panel, controller)
    }

    private func descendants(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(descendants) }
    private func find<T: NSControl>(_ type: T.Type, _ id: String, _ panel: ProtoPiePlaybackPanel) -> T? {
        descendants(panel.view).first { $0.accessibilityIdentifier() == "nio-playback-\(id)" } as? T
    }
    private func activate(_ control: NSControl) { _ = control.sendAction(control.action, to: control.target) }

    func testOldV1LibraryMigrationDefaultsFitAndPreservesLegacyBytes() throws {
        let defaults = try defaults()
        var item = ProtoPiePlaylistItem(); item.source = .connect
        item.cloudURL = "http://localhost:9981/pie?pieid=42"
        let original = try bytes(item)
        defaults.set(original, forKey: ProtoPiePlaybackStore.legacyStorageKey)
        let store = ProtoPiePlaybackStore(defaults: defaults, legacy: ProtoPieConfiguration())
        XCTAssertNil(store.warning)
        XCTAssertEqual(defaults.data(forKey: ProtoPiePlaybackStore.legacyStorageKey), original)
        let saved = try XCTUnwrap(defaults.data(forKey: ProtoPiePlaybackStore.storageKey))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: saved) as? [String: Any])
        XCTAssertEqual((object["items"] as? [[String: Any]])?.first?["connectScaleToFit"] as? Bool, true)
        var previous = ProtoPieConfiguration(); previous.scaleToFit = false
        XCTAssertTrue(try XCTUnwrap(store.library.items.first).configuration(inheriting: previous).scaleToFit)
    }

    func testConnectShowsNativeFitOnlyAndRealCheckboxPersistsWithoutLaunching() throws {
        let defaults = try defaults()
        var item = ProtoPiePlaylistItem(); item.source = .connect
        item.cloudURL = "http://localhost:9981/pie?pieid=42"
        item.fillWidth = true; item.verticalPosition = 0.6
        defaults.set(try bytes(item), forKey: ProtoPiePlaybackStore.storageKey)
        let originalPreferences = Data("preserved-calibration".utf8)
        defaults.set(originalPreferences, forKey: "nioWarpConfiguration.v1")
        let (panel, controller) = make(defaults)
        var preparations = 0
        controller.prepare = { _, _ in preparations += 1 }
        let fit = try XCTUnwrap(find(NSButton.self, "source-connect-scale-to-fit", panel))
        XCTAssertTrue(fit.isEnabled); XCTAssertEqual(fit.state, .on)
        XCTAssertNil(find(NSPopUpButton.self, "source-fill-width", panel))
        XCTAssertNil(find(NSButton.self, "source-position-override", panel))
        XCTAssertNil(find(NSTextField.self, "source-position", panel))
        let labels = descendants(panel.view).compactMap { ($0 as? NSTextField)?.stringValue }
        XCTAssertTrue(labels.contains { $0.contains("横向铺满") && $0.contains("内部上下取景") && $0.contains("不可用") })
        fit.state = .off; activate(fit)
        let saved = try XCTUnwrap(controller.library.items.first)
        XCTAssertFalse(try saved.configuration(inheriting: ProtoPieConfiguration()).scaleToFit)
        XCTAssertEqual(saved.fillWidth, true); XCTAssertEqual(saved.verticalPosition, 0.6)
        let (reopened, reopenedController) = make(defaults)
        XCTAssertEqual(try XCTUnwrap(find(NSButton.self, "source-connect-scale-to-fit", reopened)).state, .off)
        XCTAssertEqual(reopenedController.library.items.first, saved)
        XCTAssertEqual(preparations, 0); XCTAssertEqual(controller.runtime.state, .idle)
        XCTAssertEqual(defaults.data(forKey: "nioWarpConfiguration.v1"), originalPreferences)
    }

    func testSourceSwitchKeepsCloudFramingAndConnectFitThroughRealEvents() throws {
        let defaults = try defaults()
        var item = ProtoPiePlaylistItem(); item.enabled = false
        item.fillWidth = true; item.verticalPosition = 0.6
        defaults.set(try bytes(item, fit: false), forKey: ProtoPiePlaybackStore.storageKey)
        let (panel, controller) = make(defaults)
        XCTAssertNil(find(NSButton.self, "source-connect-scale-to-fit", panel))
        let source = try XCTUnwrap(find(NSPopUpButton.self, "source-kind", panel))
        source.selectItem(at: 1); activate(source)
        let fit = try XCTUnwrap(find(NSButton.self, "source-connect-scale-to-fit", panel))
        XCTAssertEqual(fit.state, .off)
        fit.state = .on; activate(fit)
        let connectSource = try XCTUnwrap(find(NSPopUpButton.self, "source-kind", panel))
        connectSource.selectItem(at: 0); activate(connectSource)
        XCTAssertEqual(try XCTUnwrap(find(NSPopUpButton.self, "source-fill-width", panel)).indexOfSelectedItem, 1)
        let position = try XCTUnwrap(find(NSTextField.self, "source-position", panel))
        XCTAssertEqual(position.doubleValue, 0.6, accuracy: 0.0001)
        let fill = try XCTUnwrap(find(NSPopUpButton.self, "source-fill-width", panel))
        fill.selectItem(at: 2); activate(fill)
        position.stringValue = "-0.4"; activate(position)
        let cloudSource = try XCTUnwrap(find(NSPopUpButton.self, "source-kind", panel))
        cloudSource.selectItem(at: 1); activate(cloudSource)
        XCTAssertEqual(try XCTUnwrap(find(NSButton.self, "source-connect-scale-to-fit", panel)).state, .on)
        let saved = try XCTUnwrap(controller.library.items.first)
        XCTAssertEqual(saved.source, .connect)
        XCTAssertEqual(saved.fillWidth, false); XCTAssertEqual(saved.verticalPosition, -0.4)
        XCTAssertEqual(controller.runtime.state, .idle)
    }
}
