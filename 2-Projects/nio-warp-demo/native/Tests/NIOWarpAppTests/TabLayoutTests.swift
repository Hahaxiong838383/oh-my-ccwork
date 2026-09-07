import AppKit
import MetalKit
import XCTest
@testable import NIOWarpApp

final class TabLayoutTests: XCTestCase {
    private func descendants(_ view: NSView) -> [NSView] {
        [view] + view.subviews.flatMap(descendants)
    }

    private func controller(active: Bool = false) throws -> (ControlPanelController, UserDefaults, String) {
        _ = NSApplication.shared
        let suite = "NIOWarp.TabLayout.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        let config = WarpConfiguration.defaultConfiguration(displayWidth: 5120, displayHeight: 2880)
        var renderer: WarpRenderer?
        if active {
            guard MTLCreateSystemDefaultDevice() != nil else { throw XCTSkip("需要 Metal 设备") }
            renderer = try XCTUnwrap(WarpRenderer(view: MTKView(frame: .zero), frameStore: LatestFrameStore(), configuration: config))
        }
        let panel = ControlPanelController(
            renderer: renderer, store: ConfigurationStore(defaults: defaults), configuration: config,
            sourceScreen: nil, outputScreen: nil,
            setWarpVisible: { _ in XCTFail("切换页面不能改变输出状态") }, isWarpVisible: { false },
            applyCaptureConfiguration: { _ in XCTFail("切换页面不能重启捕获") },
            updateAABoundary: { _, _ in XCTFail("切换页面不能更新 AA") },
            updateWarpBoundary: { _, _ in XCTFail("切换页面不能更新 Warp") }, presentWindow: false
        )
        return (panel, defaults, suite)
    }

    private func tabs(in panel: ControlPanelController) throws -> NSTabView {
        let content = try XCTUnwrap(panel.window?.contentView)
        return try XCTUnwrap(content.subviews.compactMap { $0 as? NSTabView }.first)
    }

    private func labels(in item: NSTabViewItem) throws -> [String] {
        descendants(try XCTUnwrap(item.view)).compactMap { ($0 as? NSTextField)?.stringValue }
    }

    func testThreeTopTabsHaveRequestedNamesOrderAndDefault() throws {
        let (panel, defaults, suite) = try controller()
        defer { panel.close(); defaults.removePersistentDomain(forName: suite) }
        let navigation = try tabs(in: panel)
        XCTAssertEqual(navigation.tabViewItems.map(\.label), ["基础配置", "光学标定", "属性设置"])
        XCTAssertEqual(navigation.tabViewType, .topTabsBezelBorder)
        XCTAssertEqual(navigation.selectedTabViewItem?.identifier as? String, "basic")
    }

    func testSectionsAreMovedWithoutChangingTheirControls() throws {
        let (panel, defaults, suite) = try controller()
        defer { panel.close(); defaults.removePersistentDomain(forName: suite) }
        let items = try tabs(in: panel).tabViewItems
        let basic = try labels(in: items[0])
        let optical = try labels(in: items[1])
        let settings = try labels(in: items[2])
        for title in ["0. 输入源与自动铺满", "1. 外屏允许显示的矩形范围（AA）", "2. 沿曲面延伸画布（逻辑像素）", "4. 基础校畸变"] {
            XCTAssertTrue(basic.contains(title), title)
            XCTAssertFalse(optical.contains(title))
            XCTAssertFalse(settings.contains(title))
        }
        for title in ["3. 镜像", "5. 多项式增量", "6. 画质与标定"] {
            XCTAssertTrue(optical.contains(title), title)
            XCTAssertFalse(basic.contains(title))
            XCTAssertFalse(settings.contains(title))
        }
        for title in ["7. 预设与版本回退", "8. 安全控制与配置文件"] {
            XCTAssertTrue(settings.contains(title), title)
            XCTAssertFalse(basic.contains(title))
            XCTAssertFalse(optical.contains(title))
        }
        let actions = descendants(try XCTUnwrap(items[2].view)).compactMap { ($0 as? NSButton)?.title }
        for title in ["保存预设", "应用预设", "删除预设", "导入参数文件", "导出参数备份", "重置全部参数", "退出程序，恢复原始桌面"] {
            XCTAssertTrue(actions.contains(title), title)
        }
    }

    func testSwitchingTabsPreservesPendingInputsWithoutApplyingThem() throws {
        let (panel, defaults, suite) = try controller(active: true)
        defer { panel.close(); defaults.removePersistentDomain(forName: suite) }
        let navigation = try tabs(in: panel)
        let original = panel.configurationForOfflinePreview
        let fields = descendants(try XCTUnwrap(navigation.tabViewItems[0].view)).compactMap { $0 as? NSTextField }.filter(\.isEditable)
        let width = try XCTUnwrap(fields.first { $0.stringValue == "7680" })
        let height = try XCTUnwrap(fields.first { $0.stringValue == "936" })
        width.stringValue = "8000"
        height.stringValue = "2000"
        for selection in [1, 2, 0, 2, 1, 0] { navigation.selectTabViewItem(at: selection) }
        XCTAssertEqual(width.stringValue, "8000")
        XCTAssertEqual(height.stringValue, "2000")
        XCTAssertEqual(panel.configurationForOfflinePreview, original)
        XCTAssertNil(defaults.persistentDomain(forName: suite))
    }

    func testOfflineTabsRemainNavigableWhileAllPagesStayReadOnly() throws {
        let (panel, defaults, suite) = try controller()
        defer { panel.close(); defaults.removePersistentDomain(forName: suite) }
        let navigation = try tabs(in: panel)
        for selection in 0..<3 {
            navigation.selectTabViewItem(at: selection)
            XCTAssertTrue(navigation.selectedTabViewItem === navigation.tabViewItems[selection])
            let controls = descendants(try XCTUnwrap(navigation.selectedTabViewItem?.view)).compactMap { $0 as? NSControl }
            for control in controls {
                if let field = control as? NSTextField {
                    if field.isEditable { XCTAssertFalse(field.isEnabled) }
                } else if let button = control as? NSButton {
                    let allowed = ["看完整曲面（含超出 AA 的部分）", "导出参数备份", "退出程序，恢复原始桌面"].contains(button.title)
                    XCTAssertEqual(button.isEnabled, allowed, button.title)
                } else if control is NSSlider {
                    XCTAssertFalse(control.isEnabled)
                }
            }
        }
        XCTAssertNil(defaults.persistentDomain(forName: suite))
    }

    func testStatusIsOutsideTabPagesAndScrollingIsIndependent() throws {
        let (panel, defaults, suite) = try controller()
        defer { panel.close(); defaults.removePersistentDomain(forName: suite) }
        let navigation = try tabs(in: panel)
        let content = try XCTUnwrap(panel.window?.contentView)
        panel.setStatus("全局测试状态：等待外屏", color: .systemOrange)
        let shared = descendants(content).compactMap { $0 as? NSTextField }.filter {
            $0.stringValue == "全局测试状态：等待外屏" && !$0.isDescendant(of: navigation)
        }
        XCTAssertEqual(shared.count, 1)
        let scrollViews = try navigation.tabViewItems.map { try XCTUnwrap($0.view as? NSScrollView) }
        XCTAssertEqual(Set(scrollViews.map(ObjectIdentifier.init)).count, 3)
        for scroll in scrollViews {
            XCTAssertTrue(scroll.hasVerticalScroller)
            XCTAssertFalse(scroll.hasHorizontalScroller)
        }
        for selection in 0..<3 {
            navigation.selectTabViewItem(at: selection)
            XCTAssertEqual(shared[0].stringValue, "全局测试状态：等待外屏")
        }
    }

    func testPagesFitMinimumWidthAndProduceOptionalSyntheticPreviews() throws {
        let (panel, defaults, suite) = try controller(active: true)
        defer { panel.close(); defaults.removePersistentDomain(forName: suite) }
        let window = try XCTUnwrap(panel.window)
        let content = try XCTUnwrap(window.contentView)
        let navigation = try tabs(in: panel)
        for size in [NSSize(width: 600, height: 500), NSSize(width: 600, height: 790)] {
            window.setContentSize(size)
            for selection in 0..<3 {
                navigation.selectTabViewItem(at: selection)
                content.layoutSubtreeIfNeeded()
                let scroll = try XCTUnwrap(navigation.selectedTabViewItem?.view as? NSScrollView)
                let document = try XCTUnwrap(scroll.documentView)
                XCTAssertGreaterThan(navigation.bounds.height, 200)
                XCTAssertGreaterThan(scroll.contentView.bounds.width, 490)
                XCTAssertEqual(document.bounds.width, scroll.contentView.bounds.width, accuracy: 1)
                for control in descendants(document).compactMap({ $0 as? NSControl }) {
                    let frame = control.convert(control.bounds, to: document)
                    let value = (control as? NSButton)?.title ?? (control as? NSTextField)?.stringValue ?? ""
                    let context = "\(navigation.tabViewItems[selection].label): \(type(of: control)) \(value), frame=\(frame), width=\(document.bounds.width)"
                    XCTAssertGreaterThanOrEqual(frame.minX, -1, context)
                    XCTAssertLessThanOrEqual(frame.maxX, document.bounds.width + 1, context)
                }
            }
        }
        if let directory = ProcessInfo.processInfo.environment["NIO_WARP_UI_PREVIEW_DIR"] {
            let folder = URL(fileURLWithPath: directory, isDirectory: true)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            content.wantsLayer = true
            content.layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
            for selection in 0..<3 {
                navigation.selectTabViewItem(at: selection)
                content.layoutSubtreeIfNeeded()
                let bitmap = try XCTUnwrap(content.bitmapImageRepForCachingDisplay(in: content.bounds))
                content.cacheDisplay(in: content.bounds, to: bitmap)
                let data = try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
                let name = try XCTUnwrap(navigation.selectedTabViewItem?.identifier as? String)
                try data.write(to: folder.appendingPathComponent("\(name).png"))
            }
        }
    }
}
