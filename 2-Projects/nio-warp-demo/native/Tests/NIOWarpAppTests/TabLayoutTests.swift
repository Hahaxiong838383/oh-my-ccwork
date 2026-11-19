import AppKit
import MetalKit
import XCTest
@testable import NIOWarpApp

@MainActor private final class WorkbenchNoLaunchDriver: ProtoPiePreviewDriving {
    func prepare(configuration: ProtoPieConfiguration, displayID: CGDirectDisplayID, progress: @escaping (String) -> Void) async throws -> ProtoPieSession {
        XCTFail("导航与布局测试不得启动外部播放器")
        throw ProtoPieError.unavailable("测试禁止启动播放器")
    }
    func isAlive(_ session: ProtoPieSession) async -> Bool { false }
    func release(_ session: ProtoPieSession) async {}
    func openForUser(configuration: ProtoPieConfiguration) async throws { XCTFail("布局测试不得打开应用") }
}

final class TabLayoutTests: XCTestCase {
    private let modules = ["canvas", "global", "local", "quality", "history", "mouse", "protopie"]
    private let titles = ["画布与输入", "整体校正", "局部微调", "标定与画质", "预设与历史", "鼠标映射", "ProtoPie 联动"]

    private func descendants(_ view: NSView) -> [NSView] {
        [view] + view.subviews.flatMap(descendants)
    }

    private func controller(active: Bool = false, initialHistory: Bool = false, bezierEnabled: Bool = false, allowsGeometryCommit: Bool = false, protoPieConfiguration: ProtoPieConfiguration? = nil, terminateApplication: @escaping () -> Void = { XCTFail("测试不应终止宿主应用") }) throws -> (ControlPanelController, UserDefaults, String) {
        _ = NSApplication.shared
        let suite = "NIOWarp.TabLayout.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        var config = WarpConfiguration.defaultConfiguration(displayWidth: 5120, displayHeight: 2880)
        config.bezierWarp.enabled = bezierEnabled
        let store = ConfigurationStore(defaults: defaults)
        let history = ConfigurationHistoryStore(defaults: defaults)
        if bezierEnabled { store.save(config) }
        if initialHistory {
            var previous = config
            previous.manual.strength = 0.9
            history.record(previous, reason: "原有历史记录", force: true)
        }
        if let protoPieConfiguration {
            let data = try JSONEncoder().encode(protoPieConfiguration)
            for key in ["nioWarpProtoPie.configuration.v1", "nioWarpProtoPie.draft.v1", "nioWarpProtoPie.lastSuccessful.v1"] {
                defaults.set(data, forKey: key)
            }
        }
        let protoPie = MainActor.assumeIsolated { ProtoPieCoordinator(defaults: defaults, driver: WorkbenchNoLaunchDriver()) }
        let mouseMapping = MainActor.assumeIsolated { MouseMappingController(defaults: defaults) }
        var renderer: WarpRenderer?
        if active {
            guard MTLCreateSystemDefaultDevice() != nil else { throw XCTSkip("需要 Metal 设备") }
            renderer = try XCTUnwrap(WarpRenderer(view: MTKView(frame: .zero), frameStore: LatestFrameStore(), configuration: config))
        }
        let panel = ControlPanelController(
            renderer: renderer, store: store, configuration: config,
            sourceScreen: nil, outputScreen: nil,
            setWarpVisible: { _ in XCTFail("切换模块不能改变输出状态") }, isWarpVisible: { false },
            applyCaptureConfiguration: { _ in XCTFail("切换模块不能重启捕获") },
            updateAABoundary: { _, _ in if !allowsGeometryCommit { XCTFail("切换模块不能更新 AA") } },
            updateWarpBoundary: { _, _ in if !allowsGeometryCommit { XCTFail("切换模块不能更新 Warp") } }, presentWindow: false,
            historyStore: history, presetStore: PresetStore(defaults: defaults), protoPie: protoPie, mouseMapping: mouseMapping,
            terminateApplication: terminateApplication, accessSession: authorizedWorkbenchAccessSession()
        )
        return (panel, defaults, suite)
    }

    private func tabs(in panel: ControlPanelController) throws -> NSTabView {
        let content = try XCTUnwrap(panel.window?.contentView)
        return try XCTUnwrap(descendants(content).compactMap { $0 as? NSTabView }.first)
    }

    private func identifiedView(_ identifier: String, in panel: ControlPanelController) throws -> NSView {
        try XCTUnwrap(descendants(try XCTUnwrap(panel.window?.contentView)).first { $0.accessibilityIdentifier() == identifier })
    }

    private func item(_ identifier: String, in panel: ControlPanelController) throws -> NSTabViewItem {
        try XCTUnwrap(try tabs(in: panel).tabViewItems.first { $0.identifier as? String == identifier })
    }

    private func labels(in item: NSTabViewItem) throws -> [String] {
        descendants(try XCTUnwrap(item.view)).compactMap { ($0 as? NSTextField)?.stringValue }
    }

    private func protoPieConfigurations(in defaults: UserDefaults) throws -> [String: ProtoPieConfiguration] {
        var result: [String: ProtoPieConfiguration] = [:]
        for key in ["nioWarpProtoPie.configuration.v1", "nioWarpProtoPie.draft.v1", "nioWarpProtoPie.lastSuccessful.v1"] {
            if let data = defaults.data(forKey: key) {
                result[key] = try JSONDecoder().decode(ProtoPieConfiguration.self, from: data)
            }
        }
        return result
    }

    func testSevenModulesHaveRequestedOrderWithProtoPieLastAndCanvasDefault() throws {
        let (panel, defaults, suite) = try controller()
        defer { panel.close(); defaults.removePersistentDomain(forName: suite) }
        let navigation = try tabs(in: panel)
        XCTAssertEqual(navigation.tabViewItems.map(\.label), titles)
        XCTAssertEqual(navigation.tabViewItems.compactMap { $0.identifier as? String }, modules)
        XCTAssertEqual(navigation.tabViewType, .noTabsNoBorder)
        XCTAssertEqual(panel.selectedModuleIdentifier, "canvas")
        let segments = try XCTUnwrap(identifiedView("nio-workbench-modules", in: panel) as? NSSegmentedControl)
        XCTAssertEqual(segments.segmentCount, 7)
        XCTAssertEqual((0..<7).compactMap { segments.label(forSegment: $0) }, titles)
        XCTAssertEqual(segments.selectedSegment, 0)
        for (index, module) in modules.enumerated() {
            segments.selectedSegment = index
            segments.sendAction(try XCTUnwrap(segments.action), to: segments.target)
            XCTAssertEqual(panel.selectedModuleIdentifier, module)
            XCTAssertEqual(navigation.selectedTabViewItem?.identifier as? String, module)
        }
        XCTAssertEqual(panel.window?.level, .normal, "工作台默认不能遮挡普通编辑或播放器窗口")
    }

    func testCommandNumberShortcutsIncludeMouseAndKeepProtoPieSeventh() throws {
        let (panel, defaults, suite) = try controller()
        defer { panel.close(); defaults.removePersistentDomain(forName: suite) }
        let window = try XCTUnwrap(panel.window)
        let before = defaults.persistentDomain(forName: suite) as NSDictionary?
        for number in 1...7 {
            let event = try XCTUnwrap(NSEvent.keyEvent(with: .keyDown, location: .zero,
                modifierFlags: .command, timestamp: 0, windowNumber: window.windowNumber,
                context: nil, characters: String(number), charactersIgnoringModifiers: String(number),
                isARepeat: false, keyCode: 0))
            XCTAssertTrue(window.performKeyEquivalent(with: event))
            XCTAssertEqual(panel.selectedModuleIdentifier, modules[number - 1])
        }
        XCTAssertEqual(panel.selectedModuleIdentifier, "protopie")
        let unsupported = try XCTUnwrap(NSEvent.keyEvent(with: .keyDown, location: .zero,
            modifierFlags: .command, timestamp: 0, windowNumber: window.windowNumber,
            context: nil, characters: "8", charactersIgnoringModifiers: "8", isARepeat: false, keyCode: 28))
        XCTAssertFalse(window.performKeyEquivalent(with: unsupported))
        XCTAssertEqual(panel.selectedModuleIdentifier, "protopie")
        XCTAssertEqual(defaults.persistentDomain(forName: suite) as NSDictionary?, before)
    }

    func testMouseTabUsesRealPanelAndChangesOnlyInputPreferences() throws {
        let (panel, defaults, suite) = try controller()
        defer { panel.close(); defaults.removePersistentDomain(forName: suite) }
        let original = panel.configurationForOfflinePreview
        panel.selectModule("mouse")
        let mouse = try XCTUnwrap(item("mouse", in: panel).view)
        let views = descendants(mouse)
        let speed = try XCTUnwrap(views.first { $0.accessibilityIdentifier() == "nio-mouse-speed" } as? NSSlider)
        let preview = try XCTUnwrap(views.first { $0.accessibilityIdentifier() == "nio-mouse-preview-only" } as? NSButton)
        let mode = try XCTUnwrap(views.first { $0.accessibilityIdentifier() == "nio-mouse-mode" } as? NSPopUpButton)
        let reverse = try XCTUnwrap(views.first { $0.accessibilityIdentifier() == "nio-mouse-reverse-horizontal" } as? NSButton)
        XCTAssertEqual(preview.state, .on)
        XCTAssertEqual(reverse.state, .off)
        XCTAssertEqual(mode.indexOfSelectedItem, 0)
        XCTAssertTrue(speed.isEnabled, "离线允许预设鼠标偏好，不代表启动输入接管")
        let before = defaults.persistentDomain(forName: suite) ?? [:]
        speed.doubleValue = 1.75
        speed.sendAction(try XCTUnwrap(speed.action), to: speed.target)
        reverse.performClick(nil)
        let loaded = MouseMappingSettings.load(defaults: defaults)
        XCTAssertEqual(loaded.speed, 1.75)
        XCTAssertTrue(loaded.previewOnly)
        XCTAssertTrue(loaded.reverseHorizontal)
        XCTAssertEqual(panel.configurationForOfflinePreview, original)
        let after = defaults.persistentDomain(forName: suite) ?? [:]
        let mouseKeys = [MouseMappingSettings.key, "nioWarpMouseMapping.runtime.v1"]
        let otherBefore = before.filter { !mouseKeys.contains($0.key) } as NSDictionary
        let otherAfter = after.filter { !mouseKeys.contains($0.key) } as NSDictionary
        XCTAssertEqual(otherAfter, otherBefore, "鼠标偏好不得修改校正配置、预设、历史或 ProtoPie 来源")
        panel.selectModule("protopie"); panel.selectModule("mouse")
        XCTAssertEqual(speed.doubleValue, 1.75)
        XCTAssertEqual(reverse.state, .on)
        reverse.performClick(nil)
        XCTAssertFalse(MouseMappingSettings.load(defaults: defaults).reverseHorizontal)
        XCTAssertEqual(MouseMappingSettings.load(defaults: defaults).speed, 1.75)
    }

    func testMouseDirectionControlLoadsAndIsDisabledWhileStartingOrControlling() throws {
        try MainActor.assumeIsolated {
            let original = MouseMappingSettings(mode: .physical, previewOnly: false, speed: 1.8,
                pointerSize: 40, reverseHorizontal: true)
            let mouse = MouseMappingPanel(settings: original)
            let reverse = try XCTUnwrap(descendants(mouse.inspectorView).first {
                $0.accessibilityIdentifier() == "nio-mouse-reverse-horizontal"
            } as? NSButton)
            var updated: [MouseMappingSettings] = []
            mouse.onSettingsChange = { updated.append($0) }
            XCTAssertEqual(reverse.state, .on)
            for state in [(false, true), (true, false)] {
                mouse.update(active: state.0, busy: state.1, message: "测试")
                XCTAssertFalse(reverse.isEnabled)
                reverse.performClick(nil)
                XCTAssertTrue(updated.isEmpty, "接管中不能切换方向，避免拖动途中反转")
            }
            mouse.update(active: false, busy: false, message: "测试")
            XCTAssertTrue(reverse.isEnabled)
            reverse.performClick(nil)
            var expected = original; expected.reverseHorizontal = false
            XCTAssertEqual(updated, [expected])
        }
    }

    func testMousePanelUsesOriginalCursorWithoutPointerShapeControls() throws {
        try MainActor.assumeIsolated {
            let original = MouseMappingSettings(mode: .glass, previewOnly: true, speed: 1.8,
                pointerSize: 40, reverseHorizontal: false)
            let mouse = MouseMappingPanel(settings: original)
            let views = descendants(mouse.inspectorView)
            let start = try XCTUnwrap(views.first { $0.accessibilityIdentifier() == "nio-mouse-start" } as? NSButton)
            let stop = try XCTUnwrap(views.first { $0.accessibilityIdentifier() == "nio-mouse-stop" } as? NSButton)
            let preview = try XCTUnwrap(views.first { $0.accessibilityIdentifier() == "nio-mouse-preview-only" } as? NSButton)
            let speed = try XCTUnwrap(views.first { $0.accessibilityIdentifier() == "nio-mouse-speed" } as? NSSlider)
            XCTAssertEqual(start.title, "启用原有鼠标校正")
            XCTAssertEqual(stop.title, "暂停鼠标校正")
            XCTAssertEqual(preview.title, "仅检查移动，暂不发送点击")
            XCTAssertNil(views.first { $0.accessibilityIdentifier() == "nio-mouse-pointer-size" })
            XCTAssertEqual(views.compactMap { $0 as? NSSlider }.count, 1, "仅保留速度调节，不设置原有指针的形状或尺寸")
            let copy = views.compactMap { ($0 as? NSTextField)?.stringValue }.joined(separator: "\n")
            XCTAssertTrue(copy.contains("原生鼠标校正"))
            XCTAssertTrue(copy.contains("使用 ProtoPie 自带的圆形指针，不新增指针"))
            XCTAssertTrue(copy.contains("不改变画面镜像、上下方向或内屏鼠标"))
            XCTAssertFalse(copy.contains("指针直径"))
            XCTAssertFalse(copy.contains("圆圈十字"))
            var updated: MouseMappingSettings?
            mouse.onSettingsChange = { updated = $0 }
            speed.doubleValue = 2
            speed.sendAction(try XCTUnwrap(speed.action), to: speed.target)
            var expected = original; expected.speed = 2
            XCTAssertEqual(updated, expected, "移除尺寸控件后保存其他选项仍保留旧 pointerSize 字段")
        }
    }

    func testMouseDirectionControlRemainsReachableInMinimumWorkbench() throws {
        let (panel, defaults, suite) = try controller()
        defer { panel.close(); defaults.removePersistentDomain(forName: suite) }
        let window = try XCTUnwrap(panel.window)
        window.setContentSize(NSSize(width: 1040, height: 650))
        panel.selectModule("mouse")
        let content = try XCTUnwrap(window.contentView)
        content.layoutSubtreeIfNeeded()
        let scroll = try XCTUnwrap(item("mouse", in: panel).view as? NSScrollView)
        let document = try XCTUnwrap(scroll.documentView)
        let reverse = try identifiedView("nio-mouse-reverse-horizontal", in: panel)
        reverse.scrollToVisible(reverse.bounds)
        content.layoutSubtreeIfNeeded()
        let frame = reverse.convert(reverse.bounds, to: document)
        XCTAssertGreaterThanOrEqual(frame.minX, -1)
        XCTAssertLessThanOrEqual(frame.maxX, document.bounds.width + 1)
        XCTAssertFalse(reverse.isHiddenOrHasHiddenAncestor)
        XCTAssertTrue(scroll.contentView.bounds.intersects(reverse.convert(reverse.bounds, to: scroll.contentView)))
        XCTAssertFalse(scroll.hasHorizontalScroller)
    }

    func testMigratedControlWindowFitsVisibleFrameWithoutChangingCalibration() throws {
        let (panel, defaults, suite) = try controller()
        defer { panel.close(); defaults.removePersistentDomain(forName: suite) }
        let window = try XCTUnwrap(panel.window)
        let before = panel.configurationForOfflinePreview
        let visible = NSRect(x: 0, y: 90, width: 1512, height: 859)
        window.setFrame(NSRect(x: 1900, y: 46, width: 1120, height: 752), display: false)
        panel.fitWindow(to: visible)
        window.contentView?.layoutSubtreeIfNeeded()
        XCTAssertTrue(visible.insetBy(dx: 8, dy: 8).contains(window.frame))
        XCTAssertEqual(window.frame.size, NSSize(width: 1120, height: 752))
        XCTAssertEqual(panel.configurationForOfflinePreview, before)
    }

    func testSmallVisibleFrameAllowsShrinkingAndLargerScreenRestoresMinimum() throws {
        let (panel, defaults, suite) = try controller()
        defer { panel.close(); defaults.removePersistentDomain(forName: suite) }
        let window = try XCTUnwrap(panel.window)
        let visible = NSRect(x: 0, y: 40, width: 1024, height: 620)
        panel.fitWindow(to: visible)
        window.contentView?.layoutSubtreeIfNeeded()
        XCTAssertTrue(visible.insetBy(dx: 8, dy: 8).contains(window.frame))
        XCTAssertLessThan(window.contentMinSize.width, 1040)
        XCTAssertLessThan(window.contentMinSize.height, 650)
        panel.fitWindow(to: NSRect(x: 0, y: 90, width: 1512, height: 859))
        XCTAssertEqual(window.contentMinSize, NSSize(width: 1040, height: 650))
    }

    func testExistingSectionsAreAssignedToTheirSemanticModules() throws {
        let (panel, defaults, suite) = try controller()
        defer { panel.close(); defaults.removePersistentDomain(forName: suite) }
        let expected: [(String, [String])] = [
            ("canvas", ["0. 输入源与自动铺满", "1. 外屏允许显示的矩形范围（AA）", "2. 沿曲面延伸画布（逻辑像素）", "3. 镜像"]),
            ("global", ["4. 基础校畸变", "5. 多项式增量"]),
            ("quality", ["6. 画质与标定"]),
            ("history", ["7. 预设与版本回退", "8. 安全控制与配置文件"])
        ]
        for (module, headings) in expected {
            let labels = try self.labels(in: item(module, in: panel))
            for heading in headings {
                let unnumbered = heading.components(separatedBy: ". ").dropFirst().joined(separator: ". ")
                XCTAssertTrue(labels.contains(heading) || labels.contains(unnumbered), "\(module): \(heading)")
            }
        }
        let historyActions = descendants(try XCTUnwrap(item("history", in: panel).view)).compactMap { ($0 as? NSButton)?.title }
        for title in ["保存预设", "应用预设", "删除预设", "导入参数文件", "导出参数备份", "重置全部参数"] {
            XCTAssertTrue(historyActions.contains(title), title)
        }
    }

    func testSwitchingModulesPreservesUnsubmittedInputsAndNeverAppliesConfiguration() throws {
        let (panel, defaults, suite) = try controller(active: true)
        defer { panel.close(); defaults.removePersistentDomain(forName: suite) }
        let original = panel.configurationForOfflinePreview
        let fields = descendants(try XCTUnwrap(item("canvas", in: panel).view)).compactMap { $0 as? NSTextField }.filter(\.isEditable)
        let width = try XCTUnwrap(fields.first { $0.stringValue == "7680" })
        let height = try XCTUnwrap(fields.first { $0.stringValue == "936" })
        width.stringValue = "8000"
        height.stringValue = "2000"
        let before = defaults.persistentDomain(forName: suite) as NSDictionary?
        for module in modules + modules.reversed() {
            panel.selectModule(module)
            XCTAssertEqual(panel.selectedModuleIdentifier, module)
        }
        XCTAssertEqual(width.stringValue, "8000")
        XCTAssertEqual(height.stringValue, "2000")
        XCTAssertEqual(panel.configurationForOfflinePreview, original)
        XCTAssertEqual(defaults.persistentDomain(forName: suite) as NSDictionary?, before)
    }

    func testOfflineAllModulesNavigateAndGeometryControlsRemainReadOnly() throws {
        let (panel, defaults, suite) = try controller()
        defer { panel.close(); defaults.removePersistentDomain(forName: suite) }
        let original = panel.configurationForOfflinePreview
        let before = defaults.persistentDomain(forName: suite) as NSDictionary?
        for module in modules {
            panel.selectModule(module)
            XCTAssertEqual(panel.selectedModuleIdentifier, module)
            guard module != "protopie", module != "local", module != "mouse" else { continue }
            let controls = descendants(try XCTUnwrap(item(module, in: panel).view)).compactMap { $0 as? NSControl }
            for control in controls {
                if let field = control as? NSTextField, field.isEditable { XCTAssertFalse(field.isEnabled, field.stringValue) }
                if let slider = control as? NSSlider { XCTAssertFalse(slider.isEnabled) }
            }
        }
        let local = panel.showLocalEditor(presentWindow: false)
        local.select(.zero)
        local.nudge(dx: 10, dy: 10)
        let bezier = panel.showBezierEditor(presentWindow: false)
        bezier.selectNode(0)
        bezier.nudge(dx: 10, dy: 10)
        XCTAssertEqual(panel.configurationForOfflinePreview, original)
        XCTAssertEqual(defaults.persistentDomain(forName: suite) as NSDictionary?, before)
    }

    func testSharedPreviewAndEmbeddedEditorsDoNotCreateAdditionalWindows() throws {
        let (panel, defaults, suite) = try controller(active: true)
        defer { panel.close(); defaults.removePersistentDomain(forName: suite) }
        let content = try XCTUnwrap(panel.window?.contentView)
        let previewHost = try identifiedView("nio-workbench-preview", in: panel)
        let initialPreview = try XCTUnwrap(descendants(previewHost).compactMap { $0 as? CanvasGeometryPreviewView }.first)
        let windowsBefore = Set(NSApplication.shared.windows.map(ObjectIdentifier.init))
        let local = panel.showLocalEditor(presentWindow: false)
        let bezier = panel.showBezierEditor(presentWindow: false)
        XCTAssertNil(local.window)
        XCTAssertNil(bezier.window)
        for module in modules + ["local", "global", "canvas"] { panel.selectModule(module) }
        XCTAssertTrue(try identifiedView("nio-workbench-preview", in: panel) === previewHost)
        XCTAssertTrue(descendants(content).contains { $0 === initialPreview })
        XCTAssertTrue(panel.showLocalEditor(presentWindow: false) === local)
        XCTAssertTrue(panel.showBezierEditor(presentWindow: false) === bezier)
        XCTAssertEqual(Set(NSApplication.shared.windows.map(ObjectIdentifier.init)), windowsBefore)
    }

    func testGlobalStatusStaysOutsideModulePagesAcrossNavigation() throws {
        let (panel, defaults, suite) = try controller()
        defer { panel.close(); defaults.removePersistentDomain(forName: suite) }
        let navigation = try tabs(in: panel)
        panel.setStatus("全局测试状态：等待外屏", color: .systemOrange)
        let content = try XCTUnwrap(panel.window?.contentView)
        let status = try XCTUnwrap(descendants(content).compactMap { $0 as? NSTextField }.first { $0.stringValue == "全局测试状态：等待外屏" })
        XCTAssertFalse(status.isDescendant(of: navigation))
        for action in ["toggleWarpVisibility", "rollbackConfiguration"] {
            let button = try XCTUnwrap(descendants(content).compactMap { $0 as? NSButton }.first { $0.action == NSSelectorFromString(action) })
            XCTAssertFalse(button.isDescendant(of: navigation), "暂停/全局撤销必须在所有模块可达")
        }
        for module in modules {
            panel.selectModule(module)
            XCTAssertEqual(status.stringValue, "全局测试状态：等待外屏")
        }
    }

    func testQuitButtonIsUniqueAtTopRightAndAvailableOfflineAcrossAllModules() throws {
        let (panel, defaults, suite) = try controller()
        defer { panel.close(); defaults.removePersistentDomain(forName: suite) }
        let window = try XCTUnwrap(panel.window)
        let content = try XCTUnwrap(window.contentView)
        let quit = try XCTUnwrap(identifiedView("nio-workbench-quit", in: panel) as? NSButton)
        let titleRow = try XCTUnwrap(quit.superview as? NSStackView)
        let navigation = try tabs(in: panel)
        XCTAssertEqual(quit.title, "退出程序")
        XCTAssertTrue(titleRow.arrangedSubviews.last === quit)
        XCTAssertFalse(quit.isDescendant(of: navigation))
        let historyButtons = descendants(try XCTUnwrap(item("history", in: panel).view)).compactMap { $0 as? NSButton }
        XCTAssertFalse(historyButtons.contains { $0.title.contains("退出程序") })
        for size in [NSSize(width: 1040, height: 650), NSSize(width: 1220, height: 790)] {
            window.setContentSize(size)
            for module in modules {
                panel.selectModule(module)
                content.layoutSubtreeIfNeeded()
                XCTAssertTrue(quit.isEnabled)
                XCTAssertFalse(quit.isHiddenOrHasHiddenAncestor)
                XCTAssertEqual(descendants(content).filter { $0.accessibilityIdentifier() == "nio-workbench-quit" }.count, 1)
                let quitFrame = quit.convert(quit.bounds, to: content)
                for control in titleRow.arrangedSubviews.compactMap({ $0 as? NSControl }) {
                    let frame = control.convert(control.bounds, to: content)
                    XCTAssertGreaterThanOrEqual(frame.minX, -1, module)
                    XCTAssertLessThanOrEqual(frame.maxX, content.bounds.width + 1, module)
                    if control !== quit { XCTAssertLessThanOrEqual(frame.maxX, quitFrame.minX, "退出按钮应位于标题行最右侧") }
                }
            }
        }
    }

    private func waitForQuitSheetChange(_ condition: () -> Bool, timeout: TimeInterval = 2) {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition(), Date() < deadline {
            RunLoop.current.run(until: Date().addingTimeInterval(0.01))
        }
        XCTAssertTrue(condition(), "退出确认对话框未在预期时间内更新")
    }

    func testQuitCancellationKeepsConfigurationHistoryAndDraftsUnchanged() throws {
        var terminations = 0
        let (panel, defaults, suite) = try controller(active: true, initialHistory: true, terminateApplication: { terminations += 1 })
        let window = try XCTUnwrap(panel.window)
        defer {
            if let sheet = window.attachedSheet { window.endSheet(sheet, returnCode: .cancel) }
            panel.close(); defaults.removePersistentDomain(forName: suite)
        }
        let quit = try XCTUnwrap(identifiedView("nio-workbench-quit", in: panel) as? NSButton)
        let width = try XCTUnwrap(descendants(try XCTUnwrap(item("canvas", in: panel).view)).compactMap { $0 as? NSTextField }.first { $0.isEditable && $0.stringValue == "7680" })
        width.stringValue = "8123"
        let configuration = panel.configurationForOfflinePreview
        let persisted = defaults.persistentDomain(forName: suite) as NSDictionary?
        quit.performClick(nil)
        waitForQuitSheetChange { window.attachedSheet != nil }
        let sheet = try XCTUnwrap(window.attachedSheet)
        let buttons = descendants(try XCTUnwrap(sheet.contentView)).compactMap { $0 as? NSButton }
        let cancel = try XCTUnwrap(buttons.first { $0.title == "取消" })
        let confirm = try XCTUnwrap(buttons.first { $0.title == "退出程序" })
        XCTAssertTrue(sheet.defaultButtonCell === cancel.cell, "回车默认按钮应为取消")
        XCTAssertTrue(confirm.keyEquivalent.isEmpty)
        XCTAssertEqual(terminations, 0)
        cancel.performClick(nil)
        waitForQuitSheetChange { window.attachedSheet == nil }
        quit.performClick(nil)
        waitForQuitSheetChange { window.attachedSheet != nil }
        let keyboardSheet = try XCTUnwrap(window.attachedSheet)
        let returnKey = try XCTUnwrap(NSEvent.keyEvent(
            with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0,
            windowNumber: keyboardSheet.windowNumber, context: nil,
            characters: "\r", charactersIgnoringModifiers: "\r", isARepeat: false, keyCode: 36
        ))
        XCTAssertTrue(keyboardSheet.performKeyEquivalent(with: returnKey), "确认对话框应处理回车为取消")
        waitForQuitSheetChange { window.attachedSheet == nil }
        XCTAssertEqual(terminations, 0)
        XCTAssertEqual(width.stringValue, "8123")
        XCTAssertEqual(panel.configurationForOfflinePreview, configuration)
        XCTAssertEqual(defaults.persistentDomain(forName: suite) as NSDictionary?, persisted)
    }

    func testQuitConfirmationRequiresSecondClickAndDoesNotStackSheets() throws {
        var terminations = 0
        let (panel, defaults, suite) = try controller(terminateApplication: { terminations += 1 })
        let window = try XCTUnwrap(panel.window)
        defer {
            if let sheet = window.attachedSheet { window.endSheet(sheet, returnCode: .cancel) }
            panel.close(); defaults.removePersistentDomain(forName: suite)
        }
        let quit = try XCTUnwrap(identifiedView("nio-workbench-quit", in: panel) as? NSButton)
        quit.performClick(nil)
        waitForQuitSheetChange { window.attachedSheet != nil }
        let sheet = try XCTUnwrap(window.attachedSheet)
        quit.performClick(nil)
        XCTAssertTrue(window.attachedSheet === sheet)
        XCTAssertEqual(window.sheets.count, 1)
        XCTAssertEqual(terminations, 0)
        let confirm = try XCTUnwrap(descendants(try XCTUnwrap(sheet.contentView)).compactMap { $0 as? NSButton }.first { $0.title == "退出程序" })
        confirm.performClick(nil)
        waitForQuitSheetChange { window.attachedSheet == nil && terminations == 1 }
        XCTAssertEqual(terminations, 1)
    }

    func testCanvasDimensionDraftSurvivesAValidatedBezierSubmission() throws {
        let (panel, defaults, suite) = try controller(active: true, bezierEnabled: true, allowsGeometryCommit: true)
        defer { panel.close(); defaults.removePersistentDomain(forName: suite) }
        let fields = descendants(try XCTUnwrap(item("canvas", in: panel).view)).compactMap { $0 as? NSTextField }.filter(\.isEditable)
        let width = try XCTUnwrap(fields.first { $0.stringValue == "7680" })
        width.stringValue = "8123"
        let editor = panel.showBezierEditor(presentWindow: false)
        editor.selectNode(6)
        editor.nudge(dx: 1, dy: -1)
        panel.selectModule("history")
        let deadline = Date().addingTimeInterval(8)
        while panel.configurationForOfflinePreview.bezierWarp.nodes[6].offset == .zero, Date() < deadline {
            RunLoop.current.run(until: Date().addingTimeInterval(0.01))
        }
        XCTAssertEqual(panel.configurationForOfflinePreview.bezierWarp.nodes[6].offset, SIMD2(1, -1))
        panel.selectModule("canvas")
        XCTAssertEqual(width.stringValue, "8123", "异步局部提交刷新其他模块时，不得覆盖尚未保存的数字草稿")
        XCTAssertEqual(panel.configurationForOfflinePreview.canvas.width, 7680)
    }

    func testOfflineAdvancedPolynomialCanExpandWhileParametersRemainReadOnly() throws {
        let (panel, defaults, suite) = try controller()
        defer { panel.close(); defaults.removePersistentDomain(forName: suite) }
        panel.selectModule("global")
        let original = panel.configurationForOfflinePreview
        let persisted = defaults.persistentDomain(forName: suite) as NSDictionary?
        let content = try XCTUnwrap(item("global", in: panel).view)
        let controls = descendants(content).compactMap { $0 as? NSControl }
        let disclosure = try XCTUnwrap(controls.compactMap { $0 as? NSButton }.first { $0.action == NSSelectorFromString("togglePolynomialDetails") })
        let apply = try XCTUnwrap(controls.compactMap { $0 as? NSButton }.first { $0.action == NSSelectorFromString("applyPolynomialCoefficients") })
        XCTAssertTrue(disclosure.isEnabled, "无外屏仍须能展开查看已保存的高级校正参数")
        XCTAssertTrue(apply.isHiddenOrHasHiddenAncestor)
        disclosure.performClick(nil)
        panel.window?.contentView?.layoutSubtreeIfNeeded()
        XCTAssertEqual(disclosure.state, .on)
        XCTAssertFalse(apply.isHiddenOrHasHiddenAncestor)
        XCTAssertFalse(apply.isEnabled)
        let editable = controls.compactMap { $0 as? NSTextField }.filter { $0.isEditable && !$0.isHiddenOrHasHiddenAncestor }
        XCTAssertFalse(editable.isEmpty)
        XCTAssertTrue(editable.allSatisfy { !$0.isEnabled })
        for slider in controls.compactMap({ $0 as? NSSlider }) { XCTAssertFalse(slider.isEnabled) }
        disclosure.performClick(nil)
        XCTAssertTrue(apply.isHiddenOrHasHiddenAncestor)
        XCTAssertEqual(panel.configurationForOfflinePreview, original)
        XCTAssertEqual(defaults.persistentDomain(forName: suite) as NSDictionary?, persisted)
    }

    func testOfflineUndoDoesNotConsumeSavedHistory() throws {
        let (panel, defaults, suite) = try controller(initialHistory: true)
        defer { panel.close(); defaults.removePersistentDomain(forName: suite) }
        let history = ConfigurationHistoryStore(defaults: defaults)
        let before = panel.configurationForOfflinePreview
        let undo = try XCTUnwrap(descendants(try XCTUnwrap(panel.window?.contentView)).compactMap { $0 as? NSButton }.first { $0.action == NSSelectorFromString("rollbackConfiguration") })
        XCTAssertEqual(history.count, 1)
        XCTAssertFalse(undo.isEnabled)
        undo.sendAction(try XCTUnwrap(undo.action), to: undo.target)
        XCTAssertEqual(history.count, 1)
        XCTAssertEqual(panel.configurationForOfflinePreview, before)
    }

    func testUndoDuringValidationCancelsCandidateWithoutConsumingEarlierHistory() throws {
        let (panel, defaults, suite) = try controller(active: true, initialHistory: true, bezierEnabled: true)
        defer { panel.close(); defaults.removePersistentDomain(forName: suite) }
        let history = ConfigurationHistoryStore(defaults: defaults)
        let before = panel.configurationForOfflinePreview
        let editor = panel.showBezierEditor(presentWindow: false)
        editor.selectNode(6)
        editor.nudge(dx: 1, dy: -1)
        let undo = try XCTUnwrap(descendants(try XCTUnwrap(panel.window?.contentView)).compactMap { $0 as? NSButton }.first { $0.action == NSSelectorFromString("rollbackConfiguration") })
        undo.sendAction(try XCTUnwrap(undo.action), to: undo.target)
        RunLoop.current.run(until: Date().addingTimeInterval(0.3))
        XCTAssertEqual(history.count, 1, "候选尚未落入历史时，撤销只应取消候选")
        XCTAssertEqual(panel.configurationForOfflinePreview, before)
        XCTAssertEqual(ConfigurationStore(defaults: defaults).offlineConfiguration(), before)
        XCTAssertEqual(editor.draftConfiguration, before)
    }

    func testModuleNavigationKeepsTheSharedPreviewContainerSizeFixed() throws {
        let (panel, defaults, suite) = try controller(active: true)
        defer { panel.close(); defaults.removePersistentDomain(forName: suite) }
        let window = try XCTUnwrap(panel.window)
        let content = try XCTUnwrap(window.contentView)
        let preview = try identifiedView("nio-workbench-preview", in: panel)
        for size in [NSSize(width: 1040, height: 650), NSSize(width: 1220, height: 790)] {
            window.setContentSize(size)
            panel.selectModule("canvas")
            content.layoutSubtreeIfNeeded()
            let expected = preview.convert(preview.bounds, to: content)
            for module in modules + modules.reversed() {
                panel.selectModule(module)
                content.layoutSubtreeIfNeeded()
                let actual = preview.convert(preview.bounds, to: content)
                XCTAssertEqual(actual.width, expected.width, accuracy: 1, "\(module) 的参数 intrinsic width 不能挤动画布")
                XCTAssertEqual(actual.height, expected.height, accuracy: 1, "\(module) 的状态区不能压缩共享画布")
                XCTAssertEqual(actual.minX, expected.minX, accuracy: 1, module)
                XCTAssertEqual(actual.minY, expected.minY, accuracy: 1, module)
            }
        }
    }

    func testReconnectRestoresNavigationCameraDraftsAndSelectionOnlyForSameDisplay() throws {
        let (previous, previousDefaults, previousSuite) = try controller(active: true)
        let (restored, defaults, suite) = try controller(active: true)
        let (different, differentDefaults, differentSuite) = try controller(active: true)
        defer {
            previous.close(); restored.close(); different.close()
            previousDefaults.removePersistentDomain(forName: previousSuite)
            defaults.removePersistentDomain(forName: suite)
            differentDefaults.removePersistentDomain(forName: differentSuite)
        }
        previous.selectModule("global")
        let width = try XCTUnwrap(descendants(try XCTUnwrap(item("canvas", in: previous).view)).compactMap { $0 as? NSTextField }.first { $0.isEditable && $0.stringValue == "7680" })
        width.stringValue = "8123"
        previous.showBezierEditor(presentWindow: false).selectNode(6)
        previous.showLocalEditor(presentWindow: false).select(.zero)
        let preview = try XCTUnwrap(descendants(try identifiedView("nio-workbench-preview", in: previous)).compactMap { $0 as? CanvasGeometryPreviewView }.first)
        let camera = WarpEditorViewport(physicalBounds: NSRect(x: 100, y: 150, width: 3000, height: 800), pointsPerPhysicalPixel: 0.12)
        preview.viewport = camera
        let original = restored.configurationForOfflinePreview
        restored.restoreWorkspace(from: previous, sameDisplay: true)
        XCTAssertEqual(restored.selectedModuleIdentifier, "global")
        let restoredPreview = try XCTUnwrap(descendants(try identifiedView("nio-workbench-preview", in: restored)).compactMap { $0 as? CanvasGeometryPreviewView }.first)
        XCTAssertEqual(restoredPreview.viewport, camera)
        XCTAssertEqual(restored.showBezierEditor(presentWindow: false).canvasView.selectedIndex, 6)
        XCTAssertEqual(restored.showLocalEditor(presentWindow: false).canvasView.selectedCoordinate, .zero)
        let restoredFields = descendants(try XCTUnwrap(item("canvas", in: restored).view)).compactMap { $0 as? NSTextField }.filter(\.isEditable)
        XCTAssertTrue(restoredFields.contains { $0.stringValue == "8123" })
        XCTAssertEqual(restored.configurationForOfflinePreview, original)
        different.restoreWorkspace(from: previous, sameDisplay: false)
        XCTAssertEqual(different.selectedModuleIdentifier, "global")
        XCTAssertNil(different.showBezierEditor(presentWindow: false).canvasView.selectedIndex)
        XCTAssertNil(different.showLocalEditor(presentWindow: false).canvasView.selectedCoordinate)
        let differentFields = descendants(try XCTUnwrap(item("canvas", in: different).view)).compactMap { $0 as? NSTextField }.filter(\.isEditable)
        XCTAssertFalse(differentFields.contains { $0.stringValue == "8123" }, "不同外屏不得套用上一显示器的未提交尺寸草稿")
    }

    func testEachInspectorRetainsIndependentScrollPositionAcrossModules() throws {
        let (panel, defaults, suite) = try controller()
        defer { panel.close(); defaults.removePersistentDomain(forName: suite) }
        let window = try XCTUnwrap(panel.window)
        let content = try XCTUnwrap(window.contentView)
        window.setContentSize(NSSize(width: 1040, height: 650))
        panel.selectModule("canvas")
        content.layoutSubtreeIfNeeded()
        let canvas = try XCTUnwrap(item("canvas", in: panel).view as? NSScrollView)
        let document = try XCTUnwrap(canvas.documentView)
        let distance = min(120, document.bounds.height - canvas.contentView.bounds.height)
        XCTAssertGreaterThan(distance, 0, "长参数区应在固定工作台内独立滚动")
        canvas.contentView.scroll(to: NSPoint(x: 0, y: distance))
        canvas.reflectScrolledClipView(canvas.contentView)
        let saved = canvas.contentView.bounds.origin
        for module in ["global", "quality", "history", "mouse", "protopie", "canvas"] { panel.selectModule(module) }
        content.layoutSubtreeIfNeeded()
        XCTAssertTrue(try item("canvas", in: panel).view === canvas)
        XCTAssertEqual(canvas.contentView.bounds.origin.x, saved.x, accuracy: 0.5)
        XCTAssertEqual(canvas.contentView.bounds.origin.y, saved.y, accuracy: 0.5)
    }

    func testMinimumWorkbenchShowsAllSevenTabsAndReachableInspectorControls() throws {
        let (panel, defaults, suite) = try controller(active: true)
        defer { panel.close(); defaults.removePersistentDomain(forName: suite) }
        let window = try XCTUnwrap(panel.window)
        let content = try XCTUnwrap(window.contentView)
        let navigation = try tabs(in: panel)
        let segments = try identifiedView("nio-workbench-modules", in: panel)
        for size in [NSSize(width: 1040, height: 650), NSSize(width: 1220, height: 790)] {
            window.setContentSize(size)
            for module in modules {
                panel.selectModule(module)
                content.layoutSubtreeIfNeeded()
                let segmentFrame = segments.convert(segments.bounds, to: content)
                XCTAssertGreaterThanOrEqual(segmentFrame.minX, -1)
                XCTAssertLessThanOrEqual(segmentFrame.maxX, content.bounds.width + 1)
                let preview = try identifiedView("nio-workbench-preview", in: panel)
                XCTAssertGreaterThan(preview.bounds.width, 420)
                XCTAssertGreaterThan(preview.bounds.height, 300)
                let item = try XCTUnwrap(navigation.selectedTabViewItem?.view)
                let scrolls = descendants(item).compactMap { $0 as? NSScrollView }.filter(\.hasVerticalScroller)
                XCTAssertFalse(scrolls.isEmpty, module)
                for scroll in scrolls {
                    guard let document = scroll.documentView else { continue }
                    XCTAssertFalse(scroll.hasHorizontalScroller, module)
                    XCTAssertEqual(document.bounds.width, scroll.contentView.bounds.width, accuracy: 1, module)
                    for control in descendants(document).compactMap({ $0 as? NSControl }).filter({ !$0.isHiddenOrHasHiddenAncestor }) {
                        let frame = control.convert(control.bounds, to: document)
                        let value = (control as? NSButton)?.title ?? (control as? NSTextField)?.stringValue ?? ""
                        let context = "\(module): \(type(of: control)) \(value), \(frame), document \(document.bounds)"
                        XCTAssertGreaterThanOrEqual(frame.minX, -1, context)
                        XCTAssertLessThanOrEqual(frame.maxX, document.bounds.width + 1, context)
                    }
                }
            }
        }
        if let directory = ProcessInfo.processInfo.environment["NIO_WARP_UI_PREVIEW_DIR"] {
            let folder = URL(fileURLWithPath: directory, isDirectory: true)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            content.wantsLayer = true
            content.layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
            for module in modules {
                panel.selectModule(module)
                content.layoutSubtreeIfNeeded()
                let bitmap = try XCTUnwrap(content.bitmapImageRepForCachingDisplay(in: content.bounds))
                content.cacheDisplay(in: content.bounds, to: bitmap)
                let data = try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
                try data.write(to: folder.appendingPathComponent("\(module).png"))
            }
        }
    }

    func testOutputVerticalPositionMovesWholeImageAndPersistsWithoutChangingCurveOrCanvas() throws {
        let (panel, defaults, suite) = try controller(active: true, allowsGeometryCommit: true)
        defer { panel.close(); defaults.removePersistentDomain(forName: suite) }
        let original = panel.configurationForOfflinePreview
        let slider = try XCTUnwrap(identifiedView("nio-output-vertical-offset", in: panel) as? NSSlider)
        let field = try XCTUnwrap(identifiedView("nio-output-vertical-offset-input", in: panel) as? NSTextField)
        let reset = try XCTUnwrap(identifiedView("nio-output-vertical-offset-reset", in: panel) as? NSButton)
        XCTAssertTrue(slider.isContinuous)
        XCTAssertEqual(slider.minValue, -Double(original.displayPixelHeight))
        XCTAssertEqual(slider.maxValue, Double(original.displayPixelHeight))
        XCTAssertTrue(try labels(in: item("canvas", in: panel)).contains("整幅画面上下位置（物理 px）"))
        for value in [-500.0, 275.5] {
            slider.doubleValue = value
            slider.sendAction(try XCTUnwrap(slider.action), to: slider.target)
            var expected = original; expected.outputVerticalOffsetPixels = value
            XCTAssertEqual(panel.configurationForOfflinePreview, expected, "整幅平移不得改写曲率、镜像、AA、画布或输入裁切")
            XCTAssertEqual(ConfigurationStore(defaults: defaults).offlineConfiguration(), expected)
            XCTAssertEqual(NumericInput.double(from: field.stringValue), value)
        }
        field.stringValue = "-128.25"
        field.sendAction(try XCTUnwrap(field.action), to: field.target)
        XCTAssertEqual(panel.configurationForOfflinePreview.outputVerticalOffsetPixels, -128.25)
        XCTAssertEqual(slider.doubleValue, -128.25)
        field.stringValue = "42.5"
        panel.controlTextDidEndEditing(Notification(name: NSControl.textDidEndEditingNotification, object: field))
        XCTAssertEqual(panel.configurationForOfflinePreview.outputVerticalOffsetPixels, 42.5)
        let stepButtons = try XCTUnwrap(field.superview).subviews.compactMap { $0 as? NSButton }
        let plus = try XCTUnwrap(stepButtons.first { $0.title == "+" })
        plus.performClick(nil)
        XCTAssertEqual(panel.configurationForOfflinePreview.outputVerticalOffsetPixels, 43.5)
        field.stringValue = "50000"
        field.sendAction(try XCTUnwrap(field.action), to: field.target)
        XCTAssertEqual(panel.configurationForOfflinePreview.outputVerticalOffsetPixels, Double(original.displayPixelHeight))
        field.stringValue = "invalid"
        field.sendAction(try XCTUnwrap(field.action), to: field.target)
        XCTAssertEqual(panel.configurationForOfflinePreview.outputVerticalOffsetPixels, Double(original.displayPixelHeight))
        reset.performClick(nil)
        XCTAssertEqual(panel.configurationForOfflinePreview, original)
        XCTAssertEqual(ConfigurationStore(defaults: defaults).offlineConfiguration(), original)
        XCTAssertEqual(slider.doubleValue, 0)
        XCTAssertEqual(field.stringValue, "0")
    }

    func testOfflineOutputVerticalPositionControlsDoNotChangeCalibration() throws {
        let (panel, defaults, suite) = try controller()
        defer { panel.close(); defaults.removePersistentDomain(forName: suite) }
        let original = panel.configurationForOfflinePreview
        let persisted = defaults.persistentDomain(forName: suite) as NSDictionary?
        let slider = try XCTUnwrap(identifiedView("nio-output-vertical-offset", in: panel) as? NSSlider)
        let field = try XCTUnwrap(identifiedView("nio-output-vertical-offset-input", in: panel) as? NSTextField)
        let reset = try XCTUnwrap(identifiedView("nio-output-vertical-offset-reset", in: panel) as? NSButton)
        XCTAssertFalse(slider.isEnabled)
        XCTAssertFalse(field.isEnabled)
        XCTAssertFalse(reset.isEnabled)
        slider.doubleValue = -100
        slider.sendAction(try XCTUnwrap(slider.action), to: slider.target)
        field.stringValue = "80"
        field.sendAction(try XCTUnwrap(field.action), to: field.target)
        XCTAssertEqual(panel.configurationForOfflinePreview, original)
        XCTAssertEqual(defaults.persistentDomain(forName: suite) as NSDictionary?, persisted)
        XCTAssertEqual(slider.doubleValue, original.outputVerticalOffsetPixels)
        XCTAssertEqual(NumericInput.double(from: field.stringValue), original.outputVerticalOffsetPixels)
    }

    func testProtoPieOutputPositionUsesSamePersistedGeometryAsCanvasInBothDirections() throws {
        var preview = ProtoPieConfiguration()
        preview.cloudURL = "https://cloud.protopie.io/p/shared-position-regression"
        preview.fillWidth = true
        preview.widthFitVerticalPosition = -0.9544000123
        let (panel, defaults, suite) = try controller(active: true, allowsGeometryCommit: true, protoPieConfiguration: preview)
        defer { panel.close(); defaults.removePersistentDomain(forName: suite) }
        let original = panel.configurationForOfflinePreview
        let originalPreview = try protoPieConfigurations(in: defaults)
        let canvasSlider = try XCTUnwrap(identifiedView("nio-output-vertical-offset", in: panel) as? NSSlider)
        let canvasField = try XCTUnwrap(identifiedView("nio-output-vertical-offset-input", in: panel) as? NSTextField)
        panel.selectModule("protopie")
        let slider = try XCTUnwrap(identifiedView("nio-protopie-output-vertical-offset", in: panel) as? NSSlider)
        let field = try XCTUnwrap(identifiedView("nio-protopie-output-vertical-offset-input", in: panel) as? NSTextField)
        let internalSlider = try XCTUnwrap(identifiedView("nio-protopie-vertical-position", in: panel) as? NSSlider)
        XCTAssertTrue(slider.isContinuous, "ProtoPie 页的主位置控件必须连续响应真实拖动")
        XCTAssertTrue(slider.isEnabled)
        XCTAssertEqual(slider.minValue, canvasSlider.minValue)
        XCTAssertEqual(slider.maxValue, canvasSlider.maxValue)
        for value in [-280.5, 100.25] {
            slider.doubleValue = value
            slider.sendAction(try XCTUnwrap(slider.action), to: slider.target)
            var expected = original; expected.outputVerticalOffsetPixels = value
            XCTAssertEqual(panel.configurationForOfflinePreview, expected, "ProtoPie 页必须改变输出平移，其他几何保持")
            XCTAssertEqual(ConfigurationStore(defaults: defaults).offlineConfiguration(), expected)
            XCTAssertEqual(canvasSlider.doubleValue, value)
            XCTAssertEqual(NumericInput.double(from: canvasField.stringValue), value)
            XCTAssertEqual(NumericInput.double(from: field.stringValue), value)
            XCTAssertEqual(internalSlider.doubleValue, preview.widthFitVerticalPosition)
            XCTAssertEqual(try protoPieConfigurations(in: defaults), originalPreview, "物理位置不得写入原型内部取景或来源配置")
        }

        panel.selectModule("canvas")
        canvasSlider.doubleValue = -176.125
        canvasSlider.sendAction(try XCTUnwrap(canvasSlider.action), to: canvasSlider.target)
        panel.selectModule("protopie")
        XCTAssertEqual(slider.doubleValue, -176.125, "从画布页修改后，ProtoPie 页必须即时读取同一值")
        XCTAssertEqual(NumericInput.double(from: field.stringValue), -176.125)
        let save = try XCTUnwrap(descendants(try XCTUnwrap(item("protopie", in: panel).view)).compactMap { $0 as? NSButton }.first { $0.title == "保存配置" })
        save.performClick(nil) // Coordinator notification refreshes this panel without changing the Warp setting.
        for module in ["quality", "canvas", "protopie"] { panel.selectModule(module) }
        XCTAssertEqual(slider.doubleValue, -176.125)
        XCTAssertEqual(canvasSlider.doubleValue, -176.125)
        XCTAssertEqual(panel.configurationForOfflinePreview.outputVerticalOffsetPixels, -176.125)
        XCTAssertEqual(ConfigurationStore(defaults: defaults).offlineConfiguration().outputVerticalOffsetPixels, -176.125)
        XCTAssertEqual(try protoPieConfigurations(in: defaults), originalPreview, "保存和面板刷新不得把内部取景混入输出平移")
    }

    func testProtoPieOutputPositionPreciseEntryEndEditingResetAndInternalCropDisclosure() throws {
        let (panel, defaults, suite) = try controller(active: true, allowsGeometryCommit: true)
        defer { panel.close(); defaults.removePersistentDomain(forName: suite) }
        let original = panel.configurationForOfflinePreview
        let originalPreview = try protoPieConfigurations(in: defaults)
        let canvasSlider = try XCTUnwrap(identifiedView("nio-output-vertical-offset", in: panel) as? NSSlider)
        let canvasField = try XCTUnwrap(identifiedView("nio-output-vertical-offset-input", in: panel) as? NSTextField)
        panel.selectModule("protopie")
        let slider = try XCTUnwrap(identifiedView("nio-protopie-output-vertical-offset", in: panel) as? NSSlider)
        let field = try XCTUnwrap(identifiedView("nio-protopie-output-vertical-offset-input", in: panel) as? NSTextField)
        let reset = try XCTUnwrap(identifiedView("nio-protopie-output-vertical-offset-reset", in: panel) as? NSButton)
        let internalGroup = try identifiedView("nio-protopie-internal-crop-controls", in: panel)
        let disclosure = try XCTUnwrap(identifiedView("nio-protopie-internal-crop-toggle", in: panel) as? NSButton)
        let internalSlider = try identifiedView("nio-protopie-vertical-position", in: panel)
        XCTAssertTrue(internalGroup.isHidden, "原型内部取景应默认折叠，避免与物理平移混淆")
        XCTAssertTrue(internalSlider.isHiddenOrHasHiddenAncestor)
        XCTAssertFalse(slider.isHiddenOrHasHiddenAncestor)
        disclosure.performClick(nil)
        XCTAssertFalse(internalGroup.isHidden)
        disclosure.performClick(nil)
        XCTAssertTrue(internalGroup.isHidden)

        field.stringValue = "-128.12345678"
        field.sendAction(try XCTUnwrap(field.action), to: field.target)
        XCTAssertEqual(panel.configurationForOfflinePreview.outputVerticalOffsetPixels, -128.12345678)
        XCTAssertEqual(slider.doubleValue, -128.12345678)
        XCTAssertEqual(canvasSlider.doubleValue, -128.12345678)
        XCTAssertEqual(NumericInput.double(from: canvasField.stringValue), -128.12345678)
        field.stringValue = "42.87654321"
        try MainActor.assumeIsolated {
            let delegate = try XCTUnwrap(field.delegate as? ProtoPiePanel)
            delegate.controlTextDidChange(Notification(name: NSControl.textDidChangeNotification, object: field))
            delegate.controlTextDidEndEditing(Notification(name: NSControl.textDidEndEditingNotification, object: field))
        }
        panel.selectModule("canvas"); panel.selectModule("protopie")
        XCTAssertEqual(panel.configurationForOfflinePreview.outputVerticalOffsetPixels, 42.87654321)
        XCTAssertEqual(slider.doubleValue, 42.87654321)
        XCTAssertEqual(canvasSlider.doubleValue, 42.87654321)
        XCTAssertEqual(ConfigurationStore(defaults: defaults).offlineConfiguration().outputVerticalOffsetPixels, 42.87654321)
        reset.performClick(nil)
        XCTAssertEqual(panel.configurationForOfflinePreview, original)
        XCTAssertEqual(ConfigurationStore(defaults: defaults).offlineConfiguration(), original)
        XCTAssertEqual(slider.doubleValue, 0)
        XCTAssertEqual(canvasSlider.doubleValue, 0)
        XCTAssertEqual(NumericInput.double(from: field.stringValue), 0)
        XCTAssertEqual(try protoPieConfigurations(in: defaults), originalPreview)
    }

    func testOfflineProtoPieOutputPositionCannotMutateSavedGeometry() throws {
        let (panel, defaults, suite) = try controller()
        defer { panel.close(); defaults.removePersistentDomain(forName: suite) }
        let original = panel.configurationForOfflinePreview
        let before = defaults.persistentDomain(forName: suite) as NSDictionary?
        panel.selectModule("protopie")
        let slider = try XCTUnwrap(identifiedView("nio-protopie-output-vertical-offset", in: panel) as? NSSlider)
        let field = try XCTUnwrap(identifiedView("nio-protopie-output-vertical-offset-input", in: panel) as? NSTextField)
        let reset = try XCTUnwrap(identifiedView("nio-protopie-output-vertical-offset-reset", in: panel) as? NSButton)
        XCTAssertFalse(slider.isEnabled)
        XCTAssertFalse(field.isEnabled)
        XCTAssertFalse(reset.isEnabled)
        slider.doubleValue = -100
        slider.sendAction(try XCTUnwrap(slider.action), to: slider.target)
        field.stringValue = "72.5"
        field.sendAction(try XCTUnwrap(field.action), to: field.target)
        reset.sendAction(try XCTUnwrap(reset.action), to: reset.target)
        XCTAssertEqual(panel.configurationForOfflinePreview, original)
        XCTAssertEqual(defaults.persistentDomain(forName: suite) as NSDictionary?, before)
        XCTAssertEqual(slider.doubleValue, original.outputVerticalOffsetPixels)
        XCTAssertEqual(NumericInput.double(from: field.stringValue), original.outputVerticalOffsetPixels)
    }

    func testFocusedUntouchedProtoPiePositionEditorCannotRestoreOldCanvasValueOnBlur() throws {
        let (panel, defaults, suite) = try controller(active: true, allowsGeometryCommit: true)
        defer { panel.window?.makeFirstResponder(nil); panel.close(); defaults.removePersistentDomain(forName: suite) }
        let canvasSlider = try XCTUnwrap(identifiedView("nio-output-vertical-offset", in: panel) as? NSSlider)
        panel.selectModule("protopie")
        let field = try XCTUnwrap(identifiedView("nio-protopie-output-vertical-offset-input", in: panel) as? NSTextField)
        let slider = try XCTUnwrap(identifiedView("nio-protopie-output-vertical-offset", in: panel) as? NSSlider)
        field.selectText(nil)
        let editor = try XCTUnwrap(field.currentEditor(), "必须以真实 AppKit field editor 覆盖焦点内旧值")
        XCTAssertEqual(NumericInput.double(from: editor.string), 0)
        canvasSlider.doubleValue = -73.875
        canvasSlider.sendAction(try XCTUnwrap(canvasSlider.action), to: canvasSlider.target)
        XCTAssertEqual(slider.doubleValue, -73.875)
        XCTAssertEqual(NumericInput.double(from: editor.string), -73.875, "没有输入的已聚焦编辑器也须跟随实际保存值")
        panel.window?.makeFirstResponder(nil)
        XCTAssertEqual(panel.configurationForOfflinePreview.outputVerticalOffsetPixels, -73.875, "失焦不得回写旧的 0")
        XCTAssertEqual(ConfigurationStore(defaults: defaults).offlineConfiguration().outputVerticalOffsetPixels, -73.875)

        field.selectText(nil)
        let dirtyEditor = try XCTUnwrap(field.currentEditor())
        dirtyEditor.string = "26.12345678"
        try MainActor.assumeIsolated {
            let delegate = try XCTUnwrap(field.delegate as? ProtoPiePanel)
            delegate.controlTextDidChange(Notification(name: NSControl.textDidChangeNotification, object: field))
        }
        canvasSlider.doubleValue = -98.5
        canvasSlider.sendAction(try XCTUnwrap(canvasSlider.action), to: canvasSlider.target)
        XCTAssertEqual(dirtyEditor.string, "26.12345678", "正在编辑的输入草稿不能被后台刷新吞掉")
        panel.window?.makeFirstResponder(nil)
        XCTAssertEqual(panel.configurationForOfflinePreview.outputVerticalOffsetPixels, 26.12345678)
        XCTAssertEqual(ConfigurationStore(defaults: defaults).offlineConfiguration().outputVerticalOffsetPixels, 26.12345678)
        XCTAssertEqual(canvasSlider.doubleValue, 26.12345678)
    }

    func testVerticalAspectActionsPersistReadoutAndResetWithoutChangingLegacyCalibration() throws {
        let (panel, defaults, suite) = try controller(active: true, allowsGeometryCommit: true)
        defer { panel.close(); defaults.removePersistentDomain(forName: suite) }
        panel.selectModule("global")
        let original = panel.configurationForOfflinePreview
        let slider = try XCTUnwrap(identifiedView("nio-vertical-aspect-scale", in: panel) as? NSSlider)
        let readout = try XCTUnwrap(identifiedView("nio-vertical-aspect-value", in: panel) as? NSTextField)
        let controls = descendants(try XCTUnwrap(item("global", in: panel).view)).compactMap { $0 as? NSControl }
        let reset = try XCTUnwrap(controls.compactMap { $0 as? NSButton }.first { $0.title == "恢复垂直基准（1.00×）" })
        let arch = try XCTUnwrap(controls.compactMap { $0 as? NSSlider }.first { $0.action == NSSelectorFromString("updateArch:") })
        XCTAssertEqual(slider.minValue, 0.12)
        XCTAssertEqual(slider.maxValue, 5.5)
        XCTAssertEqual(slider.doubleValue, 1)
        XCTAssertEqual(readout.stringValue, "1.00×")
        XCTAssertEqual(arch.maxValue, 3)
        XCTAssertTrue(reset.isEnabled)
        let samples: [SIMD2<Float>] = [SIMD2(0.1, 0.15), SIMD2(0.5, 0.5), SIMD2(0.9, 0.85)]
        let originalPoints = WarpMath.physicalPoints(canvasPoints: samples, configuration: original)

        for factor in [0.12, 0.65, 1.75, 5.5] {
            slider.doubleValue = factor
            slider.sendAction(try XCTUnwrap(slider.action), to: slider.target)
            let current = panel.configurationForOfflinePreview
            let saved = ConfigurationStore(defaults: defaults).offlineConfiguration()
            var expectedManual = original.manual
            expectedManual.verticalAspectScale = factor
            XCTAssertEqual(current.manual, expectedManual, "垂直比例不能改写原有垂直压缩、弧度或其他基础参数")
            XCTAssertEqual(saved.manual, expectedManual, "新字段必须实际落入隔离偏好，而非仅更新滑杆")
            XCTAssertEqual(readout.stringValue, String(format: "%.2f×", factor))
            XCTAssertEqual(slider.doubleValue, factor)
            XCTAssertEqual(current.aaRect, original.aaRect)
            XCTAssertEqual(current.canvas, original.canvas)
            XCTAssertEqual(current.polynomial, original.polynomial)
            XCTAssertEqual(current.bezierWarp, original.bezierWarp)
            XCTAssertEqual(current.localWarp, original.localWarp)
            XCTAssertEqual(current.alignment, original.alignment)
        }

        reset.performClick(nil)
        let restored = panel.configurationForOfflinePreview
        XCTAssertEqual(restored.manual, original.manual)
        XCTAssertEqual(ConfigurationStore(defaults: defaults).offlineConfiguration().manual, original.manual)
        XCTAssertEqual(slider.doubleValue, 1)
        XCTAssertEqual(readout.stringValue, "1.00×")
        let restoredPoints = WarpMath.physicalPoints(canvasPoints: samples, configuration: restored)
        for (before, after) in zip(originalPoints, restoredPoints) {
            XCTAssertEqual(before.x, after.x, accuracy: 0.002)
            XCTAssertEqual(before.y, after.y, accuracy: 0.002)
        }
    }

    func testOfflineVerticalAspectControlsRejectActionsWithoutChangingSavedConfiguration() throws {
        let (panel, defaults, suite) = try controller()
        defer { panel.close(); defaults.removePersistentDomain(forName: suite) }
        panel.selectModule("global")
        let original = panel.configurationForOfflinePreview
        let persisted = defaults.persistentDomain(forName: suite) as NSDictionary?
        let slider = try XCTUnwrap(identifiedView("nio-vertical-aspect-scale", in: panel) as? NSSlider)
        let readout = try XCTUnwrap(identifiedView("nio-vertical-aspect-value", in: panel) as? NSTextField)
        let reset = try XCTUnwrap(descendants(try XCTUnwrap(item("global", in: panel).view)).compactMap { $0 as? NSButton }.first { $0.title == "恢复垂直基准（1.00×）" })
        XCTAssertFalse(slider.isEnabled)
        XCTAssertFalse(reset.isEnabled)
        slider.doubleValue = 2.4
        slider.sendAction(try XCTUnwrap(slider.action), to: slider.target)
        reset.sendAction(try XCTUnwrap(reset.action), to: reset.target)
        XCTAssertEqual(panel.configurationForOfflinePreview, original)
        XCTAssertEqual(defaults.persistentDomain(forName: suite) as NSDictionary?, persisted)
        XCTAssertEqual(slider.doubleValue, 1)
        XCTAssertEqual(readout.stringValue, "1.00×")
    }

    func testVerticalAspectReadoutAndResetRemainReachableInMinimumWorkbench() throws {
        let (panel, defaults, suite) = try controller(active: true)
        defer { panel.close(); defaults.removePersistentDomain(forName: suite) }
        let window = try XCTUnwrap(panel.window)
        window.setContentSize(NSSize(width: 1040, height: 650))
        panel.selectModule("global")
        let content = try XCTUnwrap(window.contentView)
        content.layoutSubtreeIfNeeded()
        let scroll = try XCTUnwrap(item("global", in: panel).view as? NSScrollView)
        let document = try XCTUnwrap(scroll.documentView)
        let slider = try identifiedView("nio-vertical-aspect-scale", in: panel)
        let readout = try identifiedView("nio-vertical-aspect-value", in: panel)
        let reset = try XCTUnwrap(descendants(document).compactMap { $0 as? NSButton }.first { $0.title == "恢复垂直基准（1.00×）" })
        for view in [slider, readout, reset] {
            view.scrollToVisible(view.bounds)
            content.layoutSubtreeIfNeeded()
            let frame = view.convert(view.bounds, to: document)
            XCTAssertGreaterThanOrEqual(frame.minX, -1)
            XCTAssertLessThanOrEqual(frame.maxX, document.bounds.width + 1)
            XCTAssertFalse(view.isHiddenOrHasHiddenAncestor)
            XCTAssertTrue(scroll.contentView.bounds.intersects(view.convert(view.bounds, to: scroll.contentView)))
        }
    }
}
