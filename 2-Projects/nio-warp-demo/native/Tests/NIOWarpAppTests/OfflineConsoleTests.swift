import AppKit
import XCTest
@testable import NIOWarpApp

final class OfflineConsoleTests: XCTestCase {
    private let builtIn = WarpScreenCandidate(id: 1, isBuiltIn: true, area: 1400 * 900)
    private let external = WarpScreenCandidate(id: 2, isBuiltIn: false, area: 2560 * 1440)

    func testNoExternalNeverSelectsInternalScreenForOutput() {
        XCTAssertNil(DisplaySessionPolicy.selection(screens: [], preferredControlID: nil))
        XCTAssertNil(DisplaySessionPolicy.selection(screens: [builtIn], preferredControlID: 1))
        XCTAssertNil(DisplaySessionPolicy.selection(screens: [builtIn, WarpScreenCandidate(id: 3, isBuiltIn: true, area: 900)], preferredControlID: 1))
    }

    func testOnlyExternalKeepsTheSoleControlScreenSafe() {
        XCTAssertNil(DisplaySessionPolicy.selection(screens: [external], preferredControlID: 2))
        XCTAssertTrue(DisplaySessionPolicy.waitingMessage(hasExternalScreen: true).contains("唯一"))
    }

    func testConnectDisconnectSequenceDoesNotDependOnScreenOrder() {
        let states = [[builtIn], [external, builtIn], [builtIn]]
        let selections = states.map { DisplaySessionPolicy.selection(screens: $0, preferredControlID: 2) }
        XCTAssertNil(selections[0])
        XCTAssertEqual(selections[1], WarpScreenSelection(controlID: 1, outputID: 2))
        XCTAssertNil(selections[2])
    }

    func testLargestExternalIsOutputAndBuiltInAlwaysControls() {
        let smaller = WarpScreenCandidate(id: 3, isBuiltIn: false, area: 800 * 600)
        XCTAssertEqual(DisplaySessionPolicy.selection(screens: [smaller, external, builtIn], preferredControlID: 3), WarpScreenSelection(controlID: 1, outputID: 2))
    }

    func testTwoExternalScreensCanUseSeparateControlAndOutput() {
        let second = WarpScreenCandidate(id: 3, isBuiltIn: false, area: 800 * 600)
        XCTAssertEqual(DisplaySessionPolicy.selection(screens: [external, second], preferredControlID: 3), WarpScreenSelection(controlID: 3, outputID: 2))
    }

    func testFirstOfflineLaunchDoesNotPersistDefaultOrInternalProfile() throws {
        let suite = "NIOWarp.Offline.Empty.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let before = defaults.persistentDomain(forName: suite)
        let store = ConfigurationStore(defaults: defaults)
        let preview = store.offlineConfiguration()
        XCTAssertTrue(preview.validationErrors().isEmpty)
        XCTAssertEqual(preview.displayPixelWidth, 5120)
        XCTAssertEqual(defaults.persistentDomain(forName: suite) as NSDictionary?, before as NSDictionary?)
    }

    func testOfflinePreviewUsesLastActualDisplayWithoutChangingProfiles() throws {
        let suite = "NIOWarp.Offline.Last.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = ConfigurationStore(defaults: defaults)
        _ = store.load(displayIdentifier: "a-monitor", displayWidth: 3840, displayHeight: 2400)
        var last = store.load(displayIdentifier: "z-monitor", displayWidth: 5120, displayHeight: 2880)
        last.canvas = CanvasConfiguration(width: 6016, height: 1000)
        store.save(last)
        let before = try XCTUnwrap(defaults.persistentDomain(forName: suite))
        XCTAssertEqual(store.offlineConfiguration(), last)
        XCTAssertEqual(defaults.persistentDomain(forName: suite) as NSDictionary?, before as NSDictionary)
        _ = store.load(displayIdentifier: "a-monitor", displayWidth: 3840, displayHeight: 2400)
        XCTAssertEqual(store.offlineConfiguration().displayPixelWidth, 3840)
    }

    func testLegacyOfflinePreviewMigratesOnlyInMemory() throws {
        let suite = "NIOWarp.Offline.Legacy.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        var legacy = WarpConfiguration.defaultConfiguration(displayWidth: 3840, displayHeight: 2400)
        legacy.schemaVersion = 3
        legacy.contentMode = .stretch
        let data = try JSONEncoder().encode(legacy)
        defaults.set(data, forKey: "nioWarpConfiguration.v1")
        let preview = ConfigurationStore(defaults: defaults).offlineConfiguration()
        XCTAssertEqual(preview.schemaVersion, WarpConfiguration.currentSchemaVersion)
        XCTAssertEqual(preview.displayPixelWidth, 3840)
        XCTAssertEqual(preview.contentMode, .fill)
        XCTAssertEqual(defaults.data(forKey: "nioWarpConfiguration.v1"), data)
        XCTAssertNil(defaults.string(forKey: "nioWarpLastDisplayProfile"))
    }

    func testCorruptOrFoldedOfflineProfileFallsBackWithoutOverwritingIt() throws {
        let suite = "NIOWarp.Offline.Invalid.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        defaults.set(Data("invalid".utf8), forKey: "nioWarpConfiguration.v2.broken")
        var folded = WarpConfiguration.defaultConfiguration(displayWidth: 5120, displayHeight: 2880)
        folded.warpTrend = .inverse
        folded.polynomial.enabled = true
        folded.polynomial.coefficientsX[1] = 5
        defaults.set(try JSONEncoder().encode(folded), forKey: "nioWarpConfiguration.v2.folded")
        let before = defaults.persistentDomain(forName: suite)
        let preview = ConfigurationStore(defaults: defaults).offlineConfiguration()
        XCTAssertFalse(preview.polynomial.enabled)
        XCTAssertEqual(defaults.persistentDomain(forName: suite) as NSDictionary?, before as NSDictionary?)
    }

    func testConsoleCanBeConstructedWithoutRendererOrScreens() throws {
        _ = NSApplication.shared
        let suite = "NIOWarp.Offline.UI.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = ConfigurationStore(defaults: defaults)
        let config = store.offlineConfiguration()
        let controller = ControlPanelController(
            renderer: nil, store: store, configuration: config, sourceScreen: nil, outputScreen: nil,
            setWarpVisible: { _ in XCTFail("待机不应操作输出窗口") }, isWarpVisible: { false },
            applyCaptureConfiguration: { _ in XCTFail("待机不应启动捕获") },
            updateAABoundary: { _, _ in XCTFail("待机不应操作输出边界") },
            updateWarpBoundary: { _, _ in XCTFail("待机不应操作曲面输出") }, presentWindow: false
        )
        defer { controller.close() }
        XCTAssertTrue(controller.isWaitingForDisplay)
        XCTAssertEqual(controller.configurationForOfflinePreview, config)
        XCTAssertTrue(try XCTUnwrap(controller.window?.title).contains("等待外屏"))
        let content = try XCTUnwrap(controller.window?.contentView)
        func controls(_ view: NSView) -> [NSControl] {
            view.subviews.flatMap { child in (child as? NSControl).map { [$0] } ?? [] } + view.subviews.flatMap(controls)
        }
        func descendants(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(descendants) }
        let tabView = try XCTUnwrap(descendants(content).compactMap { $0 as? NSTabView }.first)
        let allControls = tabView.tabViewItems.filter { $0.identifier as? String != "protopie" }.compactMap(\.view).flatMap(controls)
        let mutationActions = Set(["applyAAFields", "centerAA", "fullAA", "applyCanvasFields", "rebaseCanvas", "restoreReferenceCanvas", "refillCanvasContent", "applyPolynomialCoefficients", "clearPolynomial", "resetConfiguration", "applyPreset"])
        for button in allControls.compactMap({ $0 as? NSButton }) {
            if let action = button.action, mutationActions.contains(NSStringFromSelector(action)) { XCTAssertFalse(button.isEnabled, button.title) }
        }
        let editable = allControls.compactMap { $0 as? NSTextField }.filter(\.isEditable)
        XCTAssertFalse(editable.isEmpty)
        XCTAssertTrue(editable.allSatisfy { !$0.isEnabled })
        let allViews = descendants(content) + tabView.tabViewItems.compactMap(\.view).flatMap(descendants)
        let export = try XCTUnwrap(allViews.compactMap { $0 as? NSButton }.first { $0.title == "导出参数备份" })
        XCTAssertTrue(export.isEnabled)
        let navigation = try XCTUnwrap(allViews.compactMap { $0 as? NSSegmentedControl }.first { $0.accessibilityIdentifier() == "nio-workbench-modules" })
        XCTAssertTrue(navigation.isEnabled)
        XCTAssertEqual(navigation.segmentCount, 6)
        XCTAssertNil(defaults.persistentDomain(forName: suite))
    }
}
