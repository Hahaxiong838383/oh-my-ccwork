import AppKit
import XCTest
@testable import NIOWarpApp

@MainActor private final class ConnectOptionNoLaunchDriver: ProtoPiePreviewDriving {
    func prepare(configuration: ProtoPieConfiguration, displayID: CGDirectDisplayID,
                 progress: @escaping (String) -> Void) async throws -> ProtoPieSession {
        XCTFail("来源及比例选项编辑不得启动播放器")
        throw ProtoPieError.unavailable("配置测试禁止启动播放器")
    }
    func isAlive(_ session: ProtoPieSession) async -> Bool { false }
    func release(_ session: ProtoPieSession) async {}
    func openForUser(configuration: ProtoPieConfiguration) async throws {
        XCTFail("配置测试不得打开播放器")
    }
}

/// Real AppKit targets with isolated preferences; no Chrome, network, or output window.
@MainActor final class ProtoPieConnectOptionUITests: XCTestCase {
    private var domains = [String]()
    private var coordinators = [ProtoPieCoordinator]()
    private var panels = [ProtoPiePanel]()
    private let cloudURL = "https://cloud.protopie.io/p/retained-cloud?shareKey=fixture"
    private let connectURL = "http://localhost:9981/pie?pieid=23&name=retained&touchHint=true"
    private let retainedPosition = -0.536480686695279

    override func tearDown() async throws {
        for panel in panels { panel.disconnect() }
        for coordinator in coordinators { coordinator.shutdown() }
        panels.removeAll(); coordinators.removeAll()
        for domain in domains { UserDefaults.standard.removePersistentDomain(forName: domain) }
        domains.removeAll()
        try await super.tearDown()
    }

    private func make(hideUI: Bool = false) throws -> (ProtoPiePanel, ProtoPieCoordinator, UserDefaults) {
        _ = NSApplication.shared
        let domain = "NIOWarp.Connect.Options.UI.\(UUID().uuidString)"
        domains.append(domain)
        let defaults = try XCTUnwrap(UserDefaults(suiteName: domain))
        let coordinator = ProtoPieCoordinator(defaults: defaults, driver: ConnectOptionNoLaunchDriver())
        coordinators.append(coordinator)
        var configuration = ProtoPieConfiguration()
        configuration.cloudURL = cloudURL; configuration.connectURL = connectURL
        configuration.fillWidth = true; configuration.scaleToFit = false
        configuration.hidePlayerUI = hideUI
        configuration.widthFitVerticalPosition = retainedPosition
        coordinator.draft = configuration
        let panel = ProtoPiePanel(coordinator: coordinator)
        panels.append(panel)
        return (panel, coordinator, defaults)
    }

    private func descendants(_ view: NSView) -> [NSView] {
        [view] + view.subviews.flatMap(descendants)
    }

    private func control<T: NSControl>(_ type: T.Type, _ suffix: String, in panel: ProtoPiePanel,
                                       file: StaticString = #filePath, line: UInt = #line) throws -> T {
        try XCTUnwrap(descendants(panel.inspectorView).first {
            $0.accessibilityIdentifier() == "nio-protopie-\(suffix)"
        } as? T, "Missing control: \(suffix)", file: file, line: line)
    }

    private func button(title: String, in panel: ProtoPiePanel) throws -> NSButton {
        try XCTUnwrap(descendants(panel.inspectorView).compactMap { $0 as? NSButton }.first {
            $0.title == title
        })
    }

    private func switchSource(_ segment: Int, panel: ProtoPiePanel) throws {
        let source = try control(NSSegmentedControl.self, "source-kind", in: panel)
        source.selectedSegment = segment
        XCTAssertTrue(source.sendAction(source.action, to: source.target))
    }

    private func assertRetainedCloudOptions(_ coordinator: ProtoPieCoordinator, hideUI: Bool,
                                           file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(coordinator.draft.fillWidth, file: file, line: line)
        XCTAssertEqual(coordinator.draft.hidePlayerUI, hideUI, file: file, line: line)
        XCTAssertEqual(coordinator.draft.widthFitVerticalPosition, retainedPosition, file: file, line: line)
        XCTAssertEqual(coordinator.draft.cloudURL, cloudURL, file: file, line: line)
        XCTAssertEqual(coordinator.draft.connectURL, connectURL, file: file, line: line)
        XCTAssertEqual(coordinator.state, .idle, file: file, line: line)
    }

    func testConnectFitAndAutomaticOptionsPreserveEveryCloudOnlyChoice() throws {
        for hideUI in [false, true] {
            let (panel, coordinator, defaults) = try make(hideUI: hideUI)
            try switchSource(2, panel: panel)
            XCTAssertEqual(coordinator.draft.source, .connect)
            let fit = try control(NSButton.self, "scale-to-fit", in: panel)
            XCTAssertTrue(fit.isEnabled)
            XCTAssertEqual(fit.state, .off, "保留的 Cloud fillWidth 不能把 Connect 原生适配显示为开启")
            assertRetainedCloudOptions(coordinator, hideUI: hideUI)

            fit.performClick(nil)
            XCTAssertTrue(coordinator.draft.scaleToFit)
            assertRetainedCloudOptions(coordinator, hideUI: hideUI)
            fit.performClick(nil)
            XCTAssertFalse(coordinator.draft.scaleToFit)
            try button(title: "打开 NIO Warp 时自动联动", in: panel).performClick(nil)
            XCTAssertTrue(coordinator.draft.autoStart)
            try button(title: "意外中断后自动恢复（最多 3 次）", in: panel).performClick(nil)
            XCTAssertFalse(coordinator.draft.autoRecover)
            assertRetainedCloudOptions(coordinator, hideUI: hideUI)

            let persisted = try JSONDecoder().decode(ProtoPieConfiguration.self,
                from: XCTUnwrap(defaults.data(forKey: ProtoPieCoordinator.draftKey)))
            XCTAssertEqual(persisted, coordinator.draft, "实际 optionsChanged 的自动保存也应保留 Cloud 选项")
        }
    }

    func testConnectDisablesWidthAndInternalCropWhileReturningCloudRestoresControls() throws {
        let (panel, coordinator, _) = try make(hideUI: true)
        let width = try control(NSButton.self, "fill-width", in: panel)
        let fit = try control(NSButton.self, "scale-to-fit", in: panel)
        let cropToggle = try control(NSButton.self, "internal-crop-toggle", in: panel)
        let cropSlider = try control(NSSlider.self, "vertical-position", in: panel)
        let cropInput = try control(NSTextField.self, "vertical-position-input", in: panel)
        let hideUI = try button(title: "隐藏 Cloud 播放工具栏", in: panel)
        XCTAssertTrue(width.isEnabled); XCTAssertEqual(width.state, .on)
        XCTAssertFalse(fit.isEnabled); XCTAssertEqual(fit.state, .on)
        XCTAssertTrue(cropToggle.isEnabled); XCTAssertTrue(cropSlider.isEnabled); XCTAssertTrue(cropInput.isEnabled)

        try switchSource(2, panel: panel)
        XCTAssertFalse(width.isEnabled); XCTAssertEqual(width.state, .off)
        XCTAssertFalse(cropToggle.isEnabled)
        XCTAssertFalse(cropSlider.isEnabled); XCTAssertFalse(cropInput.isEnabled)
        XCTAssertFalse(hideUI.isEnabled)
        XCTAssertTrue(fit.isEnabled); XCTAssertEqual(fit.state, .off)
        width.performClick(nil); cropSlider.doubleValue = 0.75
        _ = cropSlider.sendAction(cropSlider.action, to: cropSlider.target)
        cropInput.stringValue = "0.75"
        _ = cropInput.sendAction(cropInput.action, to: cropInput.target)
        assertRetainedCloudOptions(coordinator, hideUI: true)

        try switchSource(0, panel: panel)
        XCTAssertEqual(coordinator.draft.source, .cloud)
        XCTAssertTrue(width.isEnabled); XCTAssertEqual(width.state, .on)
        XCTAssertFalse(fit.isEnabled); XCTAssertEqual(fit.state, .on)
        XCTAssertTrue(cropToggle.isEnabled); XCTAssertTrue(cropSlider.isEnabled); XCTAssertTrue(cropInput.isEnabled)
        XCTAssertTrue(hideUI.isEnabled); XCTAssertEqual(hideUI.state, .on)
        XCTAssertEqual(cropSlider.doubleValue, retainedPosition)
        XCTAssertEqual(cropInput.stringValue, String(format: "%.3f", retainedPosition))
        assertRetainedCloudOptions(coordinator, hideUI: true)
    }

    func testNativeFitRemainsSelectableWhenReturningToConnectWithCloudWidthChoiceRetained() throws {
        let (panel, coordinator, _) = try make()
        try switchSource(2, panel: panel)
        let fit = try control(NSButton.self, "scale-to-fit", in: panel)
        fit.performClick(nil)
        XCTAssertTrue(coordinator.draft.scaleToFit)
        try switchSource(0, panel: panel)
        XCTAssertFalse(fit.isEnabled); XCTAssertEqual(fit.state, .on)
        try switchSource(2, panel: panel)
        XCTAssertTrue(fit.isEnabled); XCTAssertEqual(fit.state, .on)
        fit.performClick(nil)
        XCTAssertFalse(coordinator.draft.scaleToFit)
        assertRetainedCloudOptions(coordinator, hideUI: false)
    }

    func testLocalAutomaticOptionEditAlsoPreservesCloudWidthChoiceOnReturn() throws {
        let (panel, coordinator, _) = try make(hideUI: true)
        try switchSource(1, panel: panel)
        XCTAssertEqual(coordinator.draft.source, .localFile)
        let width = try control(NSButton.self, "fill-width", in: panel)
        XCTAssertFalse(width.isEnabled)
        try button(title: "打开 NIO Warp 时自动联动", in: panel).performClick(nil)
        XCTAssertTrue(coordinator.draft.autoStart)
        assertRetainedCloudOptions(coordinator, hideUI: true)
        try switchSource(0, panel: panel)
        XCTAssertTrue(width.isEnabled); XCTAssertEqual(width.state, .on)
        assertRetainedCloudOptions(coordinator, hideUI: true)
    }

    func testConnectPlaybackURLFitIgnoresRetainedCloudWidthFill() throws {
        var configuration = ProtoPieConfiguration()
        configuration.source = .connect; configuration.connectURL = connectURL
        for nativeFit in [false, true] {
            configuration.scaleToFit = nativeFit
            configuration.fillWidth = false
            let withoutCloudFill = try configuration.playbackURL()
            configuration.fillWidth = true
            let withCloudFill = try configuration.playbackURL()
            XCTAssertEqual(withCloudFill, withoutCloudFill)
            let items = try XCTUnwrap(URLComponents(url: withCloudFill, resolvingAgainstBaseURL: false)?.queryItems)
            XCTAssertEqual(items.filter { $0.name == "scaleToFit" },
                           [URLQueryItem(name: "scaleToFit", value: nativeFit ? "true" : "false")])
            XCTAssertEqual(items.first { $0.name == "touchHint" }?.value, "true")
        }
    }
}
