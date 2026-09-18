import AppKit
import Foundation

enum MouseMappingMode: String, Codable, CaseIterable {
    case glass, physical
    var title: String { self == .glass ? "玻璃观察（推荐）" : "直看外屏" }
}

struct MouseMappingSettings: Codable, Equatable {
    var mode: MouseMappingMode = .glass
    var previewOnly = true
    var speed = 1.0
    var pointerSize = 28.0
    var reverseHorizontal = false
    static let key = "nioWarpMouseMapping.settings.v1"

    init(mode: MouseMappingMode = .glass, previewOnly: Bool = true, speed: Double = 1,
         pointerSize: Double = 28, reverseHorizontal: Bool = false) {
        self.mode = mode; self.previewOnly = previewOnly; self.speed = speed
        self.pointerSize = pointerSize; self.reverseHorizontal = reverseHorizontal
    }

    private enum CodingKeys: String, CodingKey {
        case mode, previewOnly, speed, pointerSize, reverseHorizontal
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        mode = try values.decode(MouseMappingMode.self, forKey: .mode)
        previewOnly = try values.decode(Bool.self, forKey: .previewOnly)
        speed = try values.decode(Double.self, forKey: .speed)
        pointerSize = try values.decode(Double.self, forKey: .pointerSize)
        // v0.12.0 / v0.12.1 have no explicit direction preference. Preserve all
        // existing choices while adopting the current onsite-calibrated default.
        reverseHorizontal = try values.decodeIfPresent(Bool.self, forKey: .reverseHorizontal) ?? false
    }

    func sanitized() -> Self {
        var result = self
        result.speed = speed.isFinite ? min(max(speed, 0.25), 4) : 1
        result.pointerSize = pointerSize.isFinite ? min(max(pointerSize, 12), 64) : 28
        return result
    }
    static func load(defaults: UserDefaults = .standard) -> Self {
        guard let data = defaults.data(forKey: key), let value = try? JSONDecoder().decode(Self.self, from: data) else { return Self() }
        return value.sanitized()
    }
    func save(defaults: UserDefaults = .standard) {
        if let data = try? JSONEncoder().encode(sanitized()) { defaults.set(data, forKey: Self.key) }
    }
}

/// This module owns no Warp geometry or source configuration.
@MainActor final class MouseMappingPanel: NSObject {
    let inspectorView = NSScrollView()
    var onStart: (() -> Void)?
    var onStop: (() -> Void)?
    var onSettingsChange: ((MouseMappingSettings) -> Void)?
    private let stack = NSStackView()
    private let status = NSTextField(wrappingLabelWithString: "等待已接通的 ProtoPie Cloud 全屏预览。")
    private let coordinates = NSTextField(wrappingLabelWithString: "热点沿全部可见曲面贴边，可到最后一个物理像素中心。")
    private let start = NSButton(title: "进入演示鼠标控制", target: nil, action: nil)
    private let stop = NSButton(title: "返回普通鼠标", target: nil, action: nil)
    private let mode = NSPopUpButton()
    private let reverse = NSButton(checkboxWithTitle: "鼠标左右反向", target: nil, action: nil)
    private let preview = NSButton(checkboxWithTitle: "仅显示落点，不发送点击", target: nil, action: nil)
    private let speed = NSSlider(value: 1, minValue: 0.25, maxValue: 4, target: nil, action: nil)
    private let size = NSSlider(value: 28, minValue: 12, maxValue: 64, target: nil, action: nil)
    private let speedLabel = NSTextField(labelWithString: "移动速度 · 1.00×")
    private let sizeLabel = NSTextField(labelWithString: "指针直径 · 28 px")
    private var settings: MouseMappingSettings

    init(settings: MouseMappingSettings) {
        self.settings = settings
        super.init()
        let document = MousePanelDocument()
        document.translatesAutoresizingMaskIntoConstraints = false
        inspectorView.documentView = document
        inspectorView.hasVerticalScroller = true; inspectorView.autohidesScrollers = true
        inspectorView.hasHorizontalScroller = false; inspectorView.drawsBackground = false
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 12
        stack.edgeInsets = NSEdgeInsets(top: 14, left: 12, bottom: 18, right: 12)
        stack.translatesAutoresizingMaskIntoConstraints = false; document.addSubview(stack)
        NSLayoutConstraint.activate([
            document.leadingAnchor.constraint(equalTo: inspectorView.contentView.leadingAnchor),
            document.topAnchor.constraint(equalTo: inspectorView.contentView.topAnchor),
            document.widthAnchor.constraint(equalTo: inspectorView.contentView.widthAnchor),
            stack.leadingAnchor.constraint(equalTo: document.leadingAnchor),
            stack.topAnchor.constraint(equalTo: document.topAnchor),
            stack.trailingAnchor.constraint(equalTo: document.trailingAnchor),
            document.bottomAnchor.constraint(equalTo: stack.bottomAnchor)
        ])
        let title = NSTextField(labelWithString: "演示鼠标控制")
        title.font = .systemFont(ofSize: 16, weight: .semibold); add(title)
        status.setAccessibilityIdentifier("nio-mouse-status"); add(status)
        start.target = self; start.action = #selector(begin)
        stop.target = self; stop.action = #selector(end)
        start.setAccessibilityIdentifier("nio-mouse-start"); stop.setAccessibilityIdentifier("nio-mouse-stop")
        let actions = NSStackView(views: [start, stop]); actions.orientation = .horizontal; actions.spacing = 8; add(actions)
        add(NSTextField(wrappingLabelWithString: "Esc 返回普通鼠标；⌃⌥⌘Esc 紧急隐藏演示。进入后看着玻璃操作，退出后可继续使用内屏工作台。"))
        add(NSTextField(labelWithString: "操作方向"))
        MouseMappingMode.allCases.forEach { mode.addItem(withTitle: $0.title) }
        mode.target = self; mode.action = #selector(changed)
        mode.setAccessibilityIdentifier("nio-mouse-mode"); add(mode)
        reverse.target = self; reverse.action = #selector(changed)
        reverse.setAccessibilityIdentifier("nio-mouse-reverse-horizontal"); add(reverse)
        add(NSTextField(wrappingLabelWithString: "仅改变鼠标左右方向，不改变画面镜像和上下方向。若圆圈十字与手部移动相反，按 Esc 返回后切换此项。"))
        preview.target = self; preview.action = #selector(changed)
        preview.setAccessibilityIdentifier("nio-mouse-preview-only"); add(preview)
        add(speedLabel); speed.target = self; speed.action = #selector(changed)
        speed.setAccessibilityIdentifier("nio-mouse-speed"); add(speed)
        add(sizeLabel); size.target = self; size.action = #selector(changed)
        size.setAccessibilityIdentifier("nio-mouse-pointer-size"); add(size)
        let edge = NSTextField(labelWithString: "边缘范围 · 全部可见区域")
        edge.font = .systemFont(ofSize: 13, weight: .semibold); add(edge)
        add(NSTextField(wrappingLabelWithString: "按真实曲面、镜像与屏幕边界自动计算，不缩成内接矩形。热点仅保留半个物理像素，光标图案可在边缘裁切；沿弧形边缘继续滑动。"))
        coordinates.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
        coordinates.setAccessibilityIdentifier("nio-mouse-coordinates"); add(coordinates)
        let scope = NSTextField(wrappingLabelWithString: "支持当前专用 ProtoPie Cloud 页面的点击、双击、拖动和滚轮。不可见区域不转发点击；切换原型、暂停或离开演示输入时恢复普通鼠标。")
        scope.textColor = .secondaryLabelColor; add(scope)
        load(settings)
        update(active: false, busy: false, message: status.stringValue)
    }

    func load(_ value: MouseMappingSettings) {
        settings = value.sanitized()
        mode.selectItem(at: settings.mode == .glass ? 0 : 1)
        reverse.state = settings.reverseHorizontal ? .on : .off
        preview.state = settings.previewOnly ? .on : .off
        speed.doubleValue = settings.speed; size.doubleValue = settings.pointerSize
        speedLabel.stringValue = String(format: "移动速度 · %.2f×", settings.speed)
        sizeLabel.stringValue = String(format: "指针直径 · %.0f px", settings.pointerSize)
    }

    func update(active: Bool, busy: Bool, message: String, detail: String? = nil) {
        status.stringValue = message
        start.isEnabled = !active && !busy; stop.isEnabled = active || busy
        [mode, reverse, preview, speed, size].forEach { $0.isEnabled = !active && !busy }
        if let detail { coordinates.stringValue = detail }
    }

    private func add(_ view: NSView) {
        stack.addArrangedSubview(view)
        view.translatesAutoresizingMaskIntoConstraints = false
        view.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -24).isActive = true
        if let field = view as? NSTextField { field.maximumNumberOfLines = 0; field.preferredMaxLayoutWidth = 370 }
    }
    @objc private func begin() { onStart?() }
    @objc private func end() { onStop?() }
    @objc private func changed() {
        settings.mode = mode.indexOfSelectedItem == 0 ? .glass : .physical
        settings.reverseHorizontal = reverse.state == .on
        settings.previewOnly = preview.state == .on
        settings.speed = speed.doubleValue; settings.pointerSize = size.doubleValue
        load(settings); onSettingsChange?(settings)
    }
}

private final class MousePanelDocument: NSView { override var isFlipped: Bool { true } }
