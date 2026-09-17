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
    private let modules = ["canvas", "global", "local", "quality", "history", "protopie"]
    private let titles = ["画布与输入", "整体校正", "局部微调", "标定与画质", "预设与历史", "ProtoPie 联动"]

    private func descendants(_ view: NSView) -> [NSView] {
        [view] + view.subviews.flatMap(descendants)
    }

    private func controller(active: Bool = false, initialHistory: Bool = false, bezierEnabled: Bool = false, allowsGeometryCommit: Bool = false) throws -> (ControlPanelController, UserDefaults, String) {
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
        let protoPie = MainActor.assumeIsolated { ProtoPieCoordinator(defaults: defaults, driver: WorkbenchNoLaunchDriver()) }
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
            updateAABoundary: { _, _ in XCTFail("切换模块不能更新 AA") },
            updateWarpBoundary: { _, _ in if !allowsGeometryCommit { XCTFail("切换模块不能更新 Warp") } }, presentWindow: false,
            historyStore: history, presetStore: PresetStore(defaults: defaults), protoPie: protoPie
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

    func testSixModulesHaveRequestedOrderWithProtoPieLastAndCanvasDefault() throws {
        let (panel, defaults, suite) = try controller()
        defer { panel.close(); defaults.removePersistentDomain(forName: suite) }
        let navigation = try tabs(in: panel)
        XCTAssertEqual(navigation.tabViewItems.map(\.label), titles)
        XCTAssertEqual(navigation.tabViewItems.compactMap { $0.identifier as? String }, modules)
        XCTAssertEqual(navigation.tabViewType, .noTabsNoBorder)
        XCTAssertEqual(panel.selectedModuleIdentifier, "canvas")
        let segments = try XCTUnwrap(identifiedView("nio-workbench-modules", in: panel) as? NSSegmentedControl)
        XCTAssertEqual(segments.segmentCount, 6)
        XCTAssertEqual((0..<6).compactMap { segments.label(forSegment: $0) }, titles)
        XCTAssertEqual(segments.selectedSegment, 0)
        for (index, module) in modules.enumerated() {
            segments.selectedSegment = index
            segments.sendAction(try XCTUnwrap(segments.action), to: segments.target)
            XCTAssertEqual(panel.selectedModuleIdentifier, module)
            XCTAssertEqual(navigation.selectedTabViewItem?.identifier as? String, module)
        }
        XCTAssertEqual(panel.window?.level, .normal, "工作台默认不能遮挡普通编辑或播放器窗口")
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
            guard module != "protopie", module != "local" else { continue }
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
        for module in ["global", "quality", "history", "protopie", "canvas"] { panel.selectModule(module) }
        content.layoutSubtreeIfNeeded()
        XCTAssertTrue(try item("canvas", in: panel).view === canvas)
        XCTAssertEqual(canvas.contentView.bounds.origin.x, saved.x, accuracy: 0.5)
        XCTAssertEqual(canvas.contentView.bounds.origin.y, saved.y, accuracy: 0.5)
    }

    func testMinimumWorkbenchShowsAllSixTabsAndReachableInspectorControls() throws {
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
}
