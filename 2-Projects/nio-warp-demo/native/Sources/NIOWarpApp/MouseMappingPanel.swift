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
    var cursorAutoHideEnabled = true
    var cursorAutoHideDelay = 3.0
    static let key = "nioWarpMouseMapping.settings.v1"

    init(mode: MouseMappingMode = .glass, previewOnly: Bool = true, speed: Double = 1,
         pointerSize: Double = 28, reverseHorizontal: Bool = false,
         cursorAutoHideEnabled: Bool = true, cursorAutoHideDelay: Double = 3) {
        self.mode = mode; self.previewOnly = previewOnly; self.speed = speed
        self.pointerSize = pointerSize; self.reverseHorizontal = reverseHorizontal
        self.cursorAutoHideEnabled = cursorAutoHideEnabled; self.cursorAutoHideDelay = cursorAutoHideDelay
    }

    private enum CodingKeys: String, CodingKey {
        case mode, previewOnly, speed, pointerSize, reverseHorizontal, cursorAutoHideEnabled, cursorAutoHideDelay
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        mode = try values.decode(MouseMappingMode.self, forKey: .mode)
        previewOnly = try values.decode(Bool.self, forKey: .previewOnly)
        speed = try values.decode(Double.self, forKey: .speed)
        pointerSize = try values.decode(Double.self, forKey: .pointerSize)
        // v0.12.0 / v0.12.1 have no explicit direction preference. Preserve all
        // existing choices while leaving horizontal reversal off by default.
        reverseHorizontal = try values.decodeIfPresent(Bool.self, forKey: .reverseHorizontal) ?? false
        cursorAutoHideEnabled = try values.decodeIfPresent(Bool.self, forKey: .cursorAutoHideEnabled) ?? true
        cursorAutoHideDelay = try values.decodeIfPresent(Double.self, forKey: .cursorAutoHideDelay) ?? 3
    }

    func sanitized() -> Self {
        var result = self
        result.speed = speed.isFinite ? min(max(speed, 0.25), 4) : 1
        result.pointerSize = pointerSize.isFinite ? min(max(pointerSize, 12), 64) : 28
        result.cursorAutoHideDelay = cursorAutoHideDelay.isFinite ? min(max(cursorAutoHideDelay, 1), 30) : 3
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
    var settingsEditingAllowed: (() -> Bool)?
    private let stack = NSStackView()
    private let status = NSTextField(wrappingLabelWithString: "等待已接通的 ProtoPie Cloud 全屏预览。")
    private let coordinates = NSTextField(wrappingLabelWithString: "热点沿全部可见曲面贴边，可到最后一个物理像素中心。")
    private let start = NSButton(title: "启用原有鼠标校正", target: nil, action: nil)
    private let stop = NSButton(title: "暂停鼠标校正", target: nil, action: nil)
    private let mode = NSPopUpButton()
    private let reverse = NSButton(checkboxWithTitle: "鼠标左右反向", target: nil, action: nil)
    private let preview = NSButton(checkboxWithTitle: "仅检查移动，暂不发送点击", target: nil, action: nil)
    private let speed = NSSlider(value: 1, minValue: 0.25, maxValue: 4, target: nil, action: nil)
    private let speedLabel = NSTextField(labelWithString: "移动速度 · 1.00×")
    private let autoHide = NSButton(checkboxWithTitle: "鼠标静止时自动隐藏圆圈", target: nil, action: nil)
    private let autoHideDelay = NSTextField(string: "3")
    private var settingsEditable = true
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
        let title = NSTextField(labelWithString: "原生鼠标校正")
        title.font = .systemFont(ofSize: 16, weight: .semibold); add(title)
        status.setAccessibilityIdentifier("nio-mouse-status"); add(status)
        start.target = self; start.action = #selector(begin)
        stop.target = self; stop.action = #selector(end)
        start.setAccessibilityIdentifier("nio-mouse-start"); stop.setAccessibilityIdentifier("nio-mouse-stop")
        let actions = NSStackView(views: [start, stop]); actions.orientation = .horizontal; actions.spacing = 8; add(actions)
        add(NSTextField(wrappingLabelWithString: "使用 ProtoPie 自带的圆形指针，不新增指针。Esc 返回工作台并恢复普通移动；⌃⌥⌘Esc 紧急隐藏演示。"))
        add(NSTextField(wrappingLabelWithString: "完整高度预览：首次点击外屏画面进入操作，再次点击操作原型，数字键盘等演示按键同步可用；原型指针样式同步到外屏。切回工作台可继续调参。"))
        add(NSTextField(labelWithString: "操作方向"))
        MouseMappingMode.allCases.forEach { mode.addItem(withTitle: $0.title) }
        mode.target = self; mode.action = #selector(changed)
        mode.setAccessibilityIdentifier("nio-mouse-mode"); add(mode)
        reverse.target = self; reverse.action = #selector(changed)
        reverse.setAccessibilityIdentifier("nio-mouse-reverse-horizontal"); add(reverse)
        add(NSTextField(wrappingLabelWithString: "仅改变演示外屏的鼠标左右方向，不改变画面镜像、上下方向或内屏鼠标。若原有圆形指针与手部移动相反，按 Esc 返回后切换此项。"))
        preview.target = self; preview.action = #selector(changed)
        preview.setAccessibilityIdentifier("nio-mouse-preview-only"); add(preview)
        add(speedLabel); speed.target = self; speed.action = #selector(changed)
        speed.setAccessibilityIdentifier("nio-mouse-speed"); add(speed)
        autoHide.target = self; autoHide.action = #selector(changed)
        autoHide.setAccessibilityIdentifier("nio-mouse-auto-hide"); add(autoHide)
        autoHideDelay.target = self; autoHideDelay.action = #selector(changed)
        autoHideDelay.alignment = .right
        autoHideDelay.placeholderString = "1～30"
        autoHideDelay.setAccessibilityIdentifier("nio-mouse-auto-hide-delay")
        autoHideDelay.setAccessibilityLabel("自动隐藏等待秒数")
        autoHideDelay.setAccessibilityHelp("1 到 30 秒；按回车或离开输入框保存。")
        let hideDelayRow = NSStackView(views: [NSTextField(labelWithString: "静止后隐藏"), autoHideDelay,
                                              NSTextField(labelWithString: "秒（1～30）")])
        hideDelayRow.orientation = .horizontal; hideDelayRow.spacing = 8
        autoHideDelay.widthAnchor.constraint(equalToConstant: 68).isActive = true
        add(hideDelayRow)
        add(NSTextField(wrappingLabelWithString: "移动、点击或滚轮立即恢复原圆圈，首次操作仍然生效。长按和拖动时不隐藏，松开后重新计时；仅用键盘演示不会唤醒圆圈。按 Esc 返回工作台后可修改设置。"))
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
        speed.doubleValue = settings.speed
        speedLabel.stringValue = String(format: "移动速度 · %.2f×", settings.speed)
        autoHide.state = settings.cursorAutoHideEnabled ? .on : .off
        autoHideDelay.stringValue = String(format: "%g", settings.cursorAutoHideDelay)
        autoHideDelay.isEnabled = settingsEditable && (settingsEditingAllowed?() ?? true) && settings.cursorAutoHideEnabled
    }

    func update(active: Bool, busy: Bool, message: String, detail: String? = nil) {
        status.stringValue = message
        settingsEditable = !active && !busy && (settingsEditingAllowed?() ?? true)
        start.isEnabled = !active && !busy; stop.isEnabled = active || busy
        [mode, reverse, preview, speed, autoHide].forEach { $0.isEnabled = settingsEditable }
        autoHideDelay.isEnabled = settingsEditable && settings.cursorAutoHideEnabled
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
        guard settingsEditable, settingsEditingAllowed?() ?? true else { load(settings); return }
        guard let delay = Double(autoHideDelay.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)) else {
            load(settings); return
        }
        settings.mode = mode.indexOfSelectedItem == 0 ? .glass : .physical
        settings.reverseHorizontal = reverse.state == .on
        settings.previewOnly = preview.state == .on
        settings.speed = speed.doubleValue
        settings.cursorAutoHideEnabled = autoHide.state == .on
        settings.cursorAutoHideDelay = delay
        load(settings); onSettingsChange?(settings)
    }
}

private final class MousePanelDocument: NSView { override var isFlipped: Bool { true } }
