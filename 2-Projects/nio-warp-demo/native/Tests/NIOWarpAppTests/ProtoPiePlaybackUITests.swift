import AppKit
import XCTest
@testable import NIOWarpApp

@MainActor private final class PlaybackUINoLaunchDriver: ProtoPiePreviewDriving {
    func prepare(configuration: ProtoPieConfiguration, displayID: CGDirectDisplayID,
                 progress: @escaping (String) -> Void) async throws -> ProtoPieSession {
        throw ProtoPieError.unavailable("UI 测试禁止打开播放器")
    }
    func isAlive(_ session: ProtoPieSession) async -> Bool { false }
    func release(_ session: ProtoPieSession) async { }
    func openForUser(configuration: ProtoPieConfiguration) async throws { XCTFail("UI 测试不应启动播放器") }
}

/// Exercise the real AppKit targets against an isolated store. No Chrome, system
/// pointer, production defaults or remote device is touched by these tests.
@MainActor final class ProtoPiePlaybackUITests: XCTestCase {
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

    private func make() -> (ProtoPiePlaybackPanel, ProtoPiePlaybackController, UserDefaults) {
        _ = NSApplication.shared
        let domain = "NIOWarp.Playback.UI.\(UUID().uuidString)"
        domains.append(domain)
        let defaults = UserDefaults(suiteName: domain)!
        var legacy = ProtoPieConfiguration(); legacy.cloudURL = "https://cloud.protopie.io/p/ui-fixture"
        let store = ProtoPiePlaybackStore(defaults: defaults, legacy: legacy)
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(domain)
        directories.append(directory)
        let controller = ProtoPiePlaybackController(store: store, log: ProtoPiePlaybackLog(directory: directory))
        controllers.append(controller)
        let panel = ProtoPiePlaybackPanel(controller: controller)
        panels.append(panel)
        return (panel, controller, defaults)
    }

    private func descendants(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(descendants) }

    private func control<T: NSControl>(_ type: T.Type, _ id: String, in panel: ProtoPiePlaybackPanel,
                                       file: StaticString = #filePath, line: UInt = #line) throws -> T {
        try XCTUnwrap(descendants(panel.view).first { $0.accessibilityIdentifier() == "nio-playback-\(id)" } as? T,
                      "Missing \(id)", file: file, line: line)
    }

    private func activate(_ control: NSControl) {
        _ = control.sendAction(control.action, to: control.target)
    }

    private func click(_ id: String, _ panel: ProtoPiePlaybackPanel) throws {
        let button = try control(NSButton.self, id, in: panel)
        XCTAssertTrue(button.isEnabled)
        button.performClick(nil)
    }

    private func edit(_ id: String, value: String, panel: ProtoPiePlaybackPanel) throws {
        let field = try control(NSTextField.self, id, in: panel)
        field.stringValue = value; activate(field)
    }

    private func section(_ index: Int, _ panel: ProtoPiePlaybackPanel) throws {
        let selector = try control(NSSegmentedControl.self, "sections", in: panel)
        selector.selectedSegment = index; activate(selector)
    }

    func testInlineRenamePersistsWithoutStartingPreviewOrChangingLegacyDefaults() throws {
        let (panel, controller, defaults) = make()
        let legacyBytes = Data("unchanged-old-calibration".utf8)
        defaults.set(legacyBytes, forKey: "nioWarpConfiguration.v1")
        var preparationCount = 0
        controller.prepare = { _, _ in preparationCount += 1 }
        let first = try XCTUnwrap(controller.library.items.first)
        try edit("item-name-\(first.id)", value: "道路演示 · 日间", panel: panel)
        XCTAssertEqual(controller.library.items.first?.name, "道路演示 · 日间")
        XCTAssertEqual(preparationCount, 0)
        XCTAssertEqual(controller.runtime.state, .idle)
        XCTAssertEqual(defaults.data(forKey: "nioWarpConfiguration.v1"), legacyBytes)
        try section(1, panel)
        try edit("script-name", value: "开场与导航", panel: panel)
        XCTAssertEqual(controller.library.items.first?.script.name, "开场与导航")
        XCTAssertEqual(controller.library.items.first?.name, "道路演示 · 日间")
    }

    func testEmptyNewItemIsDisabledAndSourceCRUDKeepsUniqueIdentities() throws {
        let (panel, controller, _) = make()
        let original = try XCTUnwrap(controller.library.items.first)
        try click("add-item", panel)
        let added = try XCTUnwrap(controller.library.items.last)
        XCTAssertFalse(added.enabled)
        XCTAssertEqual(added.cloudURL, "")
        XCTAssertEqual(controller.library.selectedItemID, added.id)
        try edit("source-url", value: "https://cloud.protopie.io/p/second", panel: panel)
        try click("source-enabled", panel)
        XCTAssertTrue(controller.library.items.last?.enabled == true)
        try click("item-up", panel)
        XCTAssertEqual(controller.library.items.map(\.id), [added.id, original.id])
        try click("duplicate-item", panel)
        let duplicate = try XCTUnwrap(controller.library.items.last)
        XCTAssertNotEqual(duplicate.id, added.id)
        XCTAssertEqual(duplicate.cloudURL, "https://cloud.protopie.io/p/second")
        try click("delete-item", panel)
        XCTAssertEqual(controller.library.items.count, 2)
        try click("undo-delete", panel)
        XCTAssertEqual(controller.library.items.count, 3)
        XCTAssertEqual(controller.library.selectedItemID, duplicate.id)
    }

    func testScriptStepsInitializationCoordinateEditingAndReorderAreRealEdits() throws {
        let (panel, controller, _) = make()
        try section(1, panel)
        try click("keypad-example", panel)
        var script = try XCTUnwrap(controller.library.items.first?.script)
        XCTAssertEqual(script.steps.map(\.key), ["Numpad2", "Numpad0", "Numpad1", "Numpad2", "Numpad3", "Numpad4"])
        let first = script.steps[0]
        let kind = try control(NSPopUpButton.self, "step-kind-\(first.id)", in: panel)
        kind.selectItem(at: 7); activate(kind) // Drag.
        try edit("step-x-\(first.id)", value: "25", panel: panel)
        try edit("step-y-\(first.id)", value: "40", panel: panel)
        try edit("step-end-x-\(first.id)", value: "90", panel: panel)
        try edit("step-duration-\(first.id)", value: "1.5", panel: panel)
        try edit("step-repeat-\(first.id)", value: "3", panel: panel)
        script = try XCTUnwrap(controller.library.items.first?.script)
        XCTAssertEqual(script.steps[0].kind, .mouseDrag)
        XCTAssertEqual(script.steps[0].x, 0.25)
        XCTAssertEqual(script.steps[0].y, 0.4)
        XCTAssertEqual(script.steps[0].endX, 0.9)
        XCTAssertEqual(script.steps[0].duration, 1.5)
        XCTAssertEqual(script.steps[0].repeatCount, 3)
        try click("step-down-\(first.id)", panel)
        XCTAssertEqual(controller.library.items.first?.script.steps[1].id, first.id)
        let stage = try control(NSSegmentedControl.self, "script-stage", in: panel)
        stage.selectedSegment = 0; activate(stage)
        try click("add-step", panel)
        XCTAssertEqual(controller.library.items.first?.script.initialization.count, 1)
        XCTAssertEqual(controller.library.items.first?.script.steps.count, 6)
        XCTAssertFalse(try control(NSButton.self, "try-step", in: panel).isEnabled)
    }

    func testPlanHoursMinutesSecondsAndInvalidNumberAreHandledWithoutStarting() throws {
        let (panel, controller, _) = make()
        try section(2, panel)
        try edit("total-duration-hours", value: "3", panel: panel)
        try edit("total-duration-minutes", value: "12", panel: panel)
        try edit("total-duration-seconds", value: "30", panel: panel)
        XCTAssertEqual(controller.library.plan.totalDurationSeconds, 11_550)
        try edit("total-duration-minutes", value: "NaN", panel: panel)
        XCTAssertEqual(controller.library.plan.totalDurationSeconds, 11_550)
        XCTAssertEqual(try control(NSTextField.self, "total-duration-minutes", in: panel).stringValue, "12")
        try click("plan-unlimited", panel)
        XCTAssertNil(controller.library.plan.totalDurationSeconds)
        let end = try control(NSPopUpButton.self, "plan-end-action", in: panel)
        end.selectItem(at: 1); activate(end)
        XCTAssertEqual(controller.library.plan.endAction, .workbench)
        XCTAssertEqual(controller.runtime.state, .idle)
    }

    func testEveryActionKindExposesAndPersistsItsRelevantFields() throws {
        let (panel, controller, _) = make()
        try section(1, panel); try click("add-step", panel)
        let id = try XCTUnwrap(controller.library.items.first?.script.steps.first?.id)
        let kinds: [ProtoPieScriptStep.Kind] = [.wait, .keyPress, .keyHold, .mouseMove, .mouseClick, .mouseDoubleClick, .mouseHold, .mouseDrag, .scroll]
        for (index, expected) in kinds.enumerated() {
            let kind = try control(NSPopUpButton.self, "step-kind-\(id)", in: panel)
            kind.selectItem(at: index); activate(kind)
            XCTAssertEqual(controller.library.items.first?.script.steps.first?.kind, expected)
            try edit("step-wait-\(id)", value: "1.75", panel: panel)
            if [.wait, .keyPress, .keyHold, .mouseMove, .mouseHold, .mouseDrag].contains(expected) {
                try edit("step-duration-\(id)", value: "0.75", panel: panel)
                XCTAssertEqual(controller.library.items.first?.script.steps.first?.duration, 0.75)
            }
            if [.keyPress, .keyHold].contains(expected) { try edit("step-key-\(id)", value: "Digit7", panel: panel) }
            if [.mouseMove, .mouseClick, .mouseDoubleClick, .mouseHold, .mouseDrag, .scroll].contains(expected) {
                try edit("step-x-\(id)", value: "60", panel: panel)
                XCTAssertEqual(controller.library.items.first?.script.steps.first?.x, 0.6)
            }
            if [.mouseClick, .mouseDoubleClick, .mouseHold, .mouseDrag].contains(expected) {
                let mouseButton = try control(NSPopUpButton.self, "step-button-\(id)", in: panel)
                mouseButton.selectItem(at: 1); activate(mouseButton)
                XCTAssertEqual(controller.library.items.first?.script.steps.first?.button, .right)
            }
            if expected == .scroll {
                try edit("step-delta-x-\(id)", value: "-100", panel: panel)
                try edit("step-delta-y-\(id)", value: "320", panel: panel)
                XCTAssertEqual(controller.library.items.first?.script.steps.first?.deltaX, -100)
                XCTAssertEqual(controller.library.items.first?.script.steps.first?.deltaY, 320)
            }
        }
        try edit("script-repeat", value: "5", panel: panel)
        try edit("script-gap", value: "2.5", panel: panel)
        try click("script-reload", panel)
        XCTAssertEqual(controller.library.items.first?.script.repeatCount, 5)
        XCTAssertEqual(controller.library.items.first?.script.loopInterval, 2.5)
        XCTAssertTrue(controller.library.items.first?.script.reloadEachLoop == true)
        XCTAssertEqual(controller.runtime.state, .idle)
    }

    func testPickingPositionWritesTheOriginalStepWithoutTouchingOtherItems() throws {
        let (panel, controller, _) = make()
        try section(1, panel); try click("add-step", panel)
        let first = try XCTUnwrap(controller.library.items.first?.script.steps.first)
        let kind = try control(NSPopUpButton.self, "step-kind-\(first.id)", in: panel)
        kind.selectItem(at: 4); activate(kind)
        panel.onPickPosition = { completed in completed(0.8, 0.2) }
        try click("pick-start-\(first.id)", panel)
        XCTAssertEqual(controller.library.items.first?.script.steps.first?.x, 0.8)
        XCTAssertEqual(controller.library.items.first?.script.steps.first?.y, 0.2)
        XCTAssertEqual(controller.runtime.state, .idle)
    }

    func testFormattingAndEmbeddedControlsDoNotCreateFeatureWindows() throws {
        let (panel, _, _) = make()
        XCTAssertNil(panel.view.window)
        XCTAssertEqual(ProtoPiePlaybackPanel.durationText(3601), "01:00:01")
        XCTAssertEqual(ProtoPiePlaybackPanel.durationText(-5), "00:00")
        XCTAssertEqual(ProtoPiePlaybackPanel.durationText(.nan), "—")
        XCTAssertNotNil(try control(NSButton.self, "stop", in: panel))
        try section(3, panel)
        XCTAssertNotNil(try control(NSButton.self, "export-logs", in: panel))
    }

    func testPanelFitsAirWidthWithScrollableEditorsAndVisibleRuntimeControls() throws {
        let (panel, _, _) = make()
        let host = NSView(frame: NSRect(x: 0, y: 0, width: 860, height: 600))
        let window = NSWindow(contentRect: host.frame, styleMask: [.titled], backing: .buffered, defer: false)
        window.contentView = host; host.addSubview(panel.view)
        NSLayoutConstraint.activate([
            panel.view.leadingAnchor.constraint(equalTo: host.leadingAnchor), panel.view.trailingAnchor.constraint(equalTo: host.trailingAnchor),
            panel.view.topAnchor.constraint(equalTo: host.topAnchor), panel.view.bottomAnchor.constraint(equalTo: host.bottomAnchor)
        ])
        defer { window.contentView = nil; window.close() }
        for selectedSection in 0...3 {
            try section(selectedSection, panel)
            if selectedSection == 1 { try click("keypad-example", panel) }
            host.layoutSubtreeIfNeeded()
            let stop = try control(NSButton.self, "stop", in: panel)
            let stopFrame = stop.convert(stop.bounds, to: panel.view)
            XCTAssertTrue(panel.view.bounds.contains(stopFrame), "运行栏在 860pt 宽度应完整可见")
            XCTAssertTrue(stopFrame.width > 20)
            let sections = try control(NSSegmentedControl.self, "sections", in: panel)
            XCTAssertTrue(sections.frame.width >= 500)
            XCTAssertTrue(descendants(panel.view).compactMap { $0 as? NSScrollView }.count >= 2)
            if selectedSection == 0 {
                for unit in ["hours", "minutes", "seconds"] {
                    let input = try control(NSTextField.self, "item-duration-\(unit)", in: panel)
                    XCTAssertTrue(input.frame.width >= 64, "时分秒数字输入不能被压缩到看不清")
                }
            }
            if let directory = ProcessInfo.processInfo.environment["NIO_PLAYBACK_UI_ARTIFACT_DIR"] {
                let path = URL(fileURLWithPath: directory)
                try FileManager.default.createDirectory(at: path, withIntermediateDirectories: true)
                let bitmap = try XCTUnwrap(panel.view.bitmapImageRepForCachingDisplay(in: panel.view.bounds))
                panel.view.cacheDisplay(in: panel.view.bounds, to: bitmap)
                let image = try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
                try image.write(to: path.appendingPathComponent("panel-\(selectedSection)-860.png"))
            }
        }
    }

    func testWorkbenchEmbeddingPreservesSevenTabsAndLegacyControlsAtAirSize() throws {
        let (_, playback, defaults) = make()
        let config = WarpConfiguration.defaultConfiguration(displayWidth: 3840, displayHeight: 2400)
        let proto = ProtoPieCoordinator(defaults: defaults, driver: PlaybackUINoLaunchDriver())
        let workbench = ControlPanelController(renderer: nil, store: ConfigurationStore(defaults: defaults), configuration: config,
            sourceScreen: nil, outputScreen: nil,
            setWarpVisible: { _ in XCTFail("导航不得改变输出") }, isWarpVisible: { false },
            applyCaptureConfiguration: { _ in XCTFail("导航不得重新捕获") },
            updateAABoundary: { _, _ in XCTFail("导航不得修改 AA") },
            updateWarpBoundary: { _, _ in XCTFail("导航不得修改 Warp") }, presentWindow: false,
            historyStore: ConfigurationHistoryStore(defaults: defaults), presetStore: PresetStore(defaults: defaults),
            protoPie: proto, mouseMapping: MouseMappingController(defaults: defaults), playback: playback,
            terminateApplication: { XCTFail("测试不得退出 App") })
        defer { workbench.close(); proto.shutdown() }
        let window = try XCTUnwrap(workbench.window)
        window.setContentSize(NSSize(width: 860, height: 650))
        workbench.selectModule("protopie")
        let content = try XCTUnwrap(window.contentView)
        // cacheDisplay excludes NSWindow's backing color; supply that backdrop
        // in this offscreen fixture without changing the production workbench.
        content.wantsLayer = true; content.layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
        content.layoutSubtreeIfNeeded()
        let all = descendants(content)
        let tabs = try XCTUnwrap(all.first { $0.accessibilityIdentifier() == "nio-protopie-full-workspace" } as? NSTabView)
        XCTAssertEqual(tabs.tabViewItems.map(\.label), ["云端播放与自动演示", "画面设置与本地 .pie"])
        XCTAssertEqual(tabs.tabViewType, .noTabsNoBorder)
        XCTAssertFalse(tabs.isHiddenOrHasHiddenAncestor)
        let workspaceSections = try XCTUnwrap(all.first { $0.accessibilityIdentifier() == "nio-protopie-workspace-sections" } as? NSSegmentedControl)
        XCTAssertEqual(workspaceSections.segmentCount, 2)
        XCTAssertEqual(workspaceSections.selectedSegment, 0)
        XCTAssertFalse(workspaceSections.isHiddenOrHasHiddenAncestor)
        let picker = try XCTUnwrap(all.first { $0.accessibilityIdentifier() == "nio-workbench-modules" } as? NSSegmentedControl)
        XCTAssertEqual(picker.segmentCount, 7)
        XCTAssertEqual(picker.label(forSegment: 6), "ProtoPie 联动")
        let stop = try XCTUnwrap(all.first { $0.accessibilityIdentifier() == "nio-playback-stop" })
        XCTAssertFalse(stop.isHiddenOrHasHiddenAncestor)
        XCTAssertTrue(content.bounds.contains(stop.convert(stop.bounds, to: content)), "最小宽度下自动演示停止按钮应可达")
        if let directory = ProcessInfo.processInfo.environment["NIO_PLAYBACK_UI_ARTIFACT_DIR"] {
            let bitmap = try XCTUnwrap(content.bitmapImageRepForCachingDisplay(in: content.bounds))
            content.cacheDisplay(in: content.bounds, to: bitmap)
            let image = try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
            try image.write(to: URL(fileURLWithPath: directory).appendingPathComponent("workbench-860.png"))
        }
        workspaceSections.selectedSegment = 1; activate(workspaceSections); content.layoutSubtreeIfNeeded()
        XCTAssertEqual(tabs.selectedTabViewItem?.identifier as? String, "legacy")
        let originalPosition = try XCTUnwrap(descendants(content).first { $0.accessibilityIdentifier() == "nio-protopie-output-vertical-offset" })
        XCTAssertFalse(originalPosition.isHiddenOrHasHiddenAncestor)
        workbench.selectModule("global")
        XCTAssertTrue(tabs.isHiddenOrHasHiddenAncestor)
        XCTAssertTrue(workspaceSections.isHiddenOrHasHiddenAncestor)
        XCTAssertEqual(workbench.configurationForOfflinePreview, config)
    }
}
