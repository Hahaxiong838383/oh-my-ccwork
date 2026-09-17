import AppKit
import ApplicationServices
import UniformTypeIdentifiers

/// Embeddable inspector; it has no window and does not take ownership of the shared preview canvas.
@MainActor final class ProtoPiePanel: NSObject, NSTextFieldDelegate {
    let inspectorView = NSScrollView()
    private let inspectorStack = NSStackView()
    let statusView = NSStackView()
    private let coordinator: ProtoPieCoordinator
    private var observer: UUID?
    private let source = NSSegmentedControl(labels: ["云端链接", "本地 .pie"], trackingMode: .selectOne, target: nil, action: nil)
    private let urlField = NSTextField()
    private let fileLabel = NSTextField(wrappingLabelWithString: "尚未选择文件")
    private let cloudGroup = NSStackView()
    private let fileGroup = NSStackView()
    private let autoStart = NSButton(checkboxWithTitle: "打开 NIO Warp 时自动联动", target: nil, action: nil)
    private let autoRecover = NSButton(checkboxWithTitle: "意外中断后自动恢复（最多 3 次）", target: nil, action: nil)
    private let fit = NSButton(checkboxWithTitle: "等比适配播放器窗口", target: nil, action: nil)
    private let hideUI = NSButton(checkboxWithTitle: "隐藏 Cloud 播放工具栏", target: nil, action: nil)
    private let targetLabel = NSTextField(wrappingLabelWithString: "目标：沿用画布与输入的外接显示器")
    private let stateLabel = NSTextField(wrappingLabelWithString: "")
    private let detailLabel = NSTextField(wrappingLabelWithString: "")
    private let activeLabel = NSTextField(wrappingLabelWithString: "")
    private let saveButton = NSButton(title: "保存配置", target: nil, action: nil)
    private let startButton = NSButton(title: "启动预览", target: nil, action: nil)
    private let stopButton = NSButton(title: "停止联动", target: nil, action: nil)
    private let reloadButton = NSButton(title: "重新加载预览", target: nil, action: nil)
    private let openButton = NSButton(title: "打开播放器 / 登录", target: nil, action: nil)
    private var rendering = false

    init(coordinator: ProtoPieCoordinator) {
        self.coordinator = coordinator
        super.init()
        build()
        loadDraft()
        observer = coordinator.observe { [weak self] in self?.refresh() }
    }

    deinit {
        if let observer {
            let coordinator = coordinator
            Task { @MainActor in coordinator.removeObserver(observer) }
        }
    }

    func disconnect() {
        if let observer { coordinator.removeObserver(observer); self.observer = nil }
    }

    private func build() {
        for stack in [inspectorStack, statusView, cloudGroup, fileGroup] {
            stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 10
            stack.translatesAutoresizingMaskIntoConstraints = false
        }
        inspectorStack.edgeInsets = NSEdgeInsets(top: 12, left: 12, bottom: 20, right: 12)
        statusView.edgeInsets = NSEdgeInsets(top: 10, left: 12, bottom: 10, right: 12)
        inspectorView.scrollerStyle = .overlay
        inspectorView.hasVerticalScroller = true
        inspectorView.hasHorizontalScroller = false
        inspectorView.autohidesScrollers = true
        inspectorView.drawsBackground = false
        let document = ProtoPieFlippedDocumentView()
        inspectorView.documentView = document
        document.translatesAutoresizingMaskIntoConstraints = false
        document.addSubview(inspectorStack)
        NSLayoutConstraint.activate([
            document.leadingAnchor.constraint(equalTo: inspectorView.contentView.leadingAnchor),
            document.topAnchor.constraint(equalTo: inspectorView.contentView.topAnchor),
            document.widthAnchor.constraint(equalTo: inspectorView.contentView.widthAnchor),
            inspectorStack.leadingAnchor.constraint(equalTo: document.leadingAnchor),
            inspectorStack.topAnchor.constraint(equalTo: document.topAnchor),
            inspectorStack.widthAnchor.constraint(equalTo: document.widthAnchor),
            document.bottomAnchor.constraint(equalTo: inspectorStack.bottomAnchor)
        ])
        source.target = self; source.action = #selector(sourceChanged)
        source.segmentStyle = .rounded; source.segmentDistribution = .fillEqually
        add(title("预览来源")); add(source)
        urlField.placeholderString = "https://cloud.protopie.io/p/…"
        urlField.font = .systemFont(ofSize: 12); urlField.delegate = self
        urlField.lineBreakMode = .byTruncatingMiddle
        urlField.setAccessibilityLabel("ProtoPie Cloud 预览链接")
        cloudGroup.addArrangedSubview(urlField)
        cloudGroup.addArrangedSubview(note("链接只在本机保存，不会写入校正预设。"))
        constrainChildren(cloudGroup)
        add(cloudGroup)
        fileLabel.font = .systemFont(ofSize: 12); fileLabel.maximumNumberOfLines = 3
        let choose = button("选择 / 替换 .pie 文件…", #selector(chooseFile))
        fileGroup.addArrangedSubview(fileLabel); fileGroup.addArrangedSubview(choose)
        fileGroup.addArrangedSubview(note("使用 Studio 的 Preview 窗口。文件内容保持不变，需辅助功能权限。"))
        constrainChildren(fileGroup)
        add(fileGroup)
        add(separator()); add(title("自动联动"))
        for control in [autoStart, autoRecover, fit, hideUI] {
            control.font = .systemFont(ofSize: 12); control.target = self; control.action = #selector(optionsChanged)
        }
        add(autoStart); add(autoRecover)
        add(separator()); add(title("播放与目标"))
        add(fit); add(hideUI)
        targetLabel.font = .systemFont(ofSize: 12); targetLabel.textColor = .secondaryLabelColor
        add(targetLabel)
        add(note("画布与输入中的目标屏幕是唯一设置入口；更换预览不重置校正参数。"))
        add(separator())
        saveButton.target = self; saveButton.action = #selector(save)
        startButton.target = self; startButton.action = #selector(start)
        startButton.bezelStyle = .rounded
        add(saveButton); add(startButton)
        reloadButton.target = self; reloadButton.action = #selector(reload)
        stopButton.target = self; stopButton.action = #selector(stop)
        add(reloadButton); add(stopButton)
        openButton.target = self; openButton.action = #selector(openPlayer)
        add(openButton)
        add(button("辅助功能权限…", #selector(accessibilitySettings)))
        add(note("保存只更新配置；启动 / 应用并切换才改变当前来源。停止联动会恢复原始桌面，不会退出播放器。"))
        stateLabel.font = .systemFont(ofSize: 13, weight: .semibold)
        activeLabel.font = .systemFont(ofSize: 11); activeLabel.textColor = .secondaryLabelColor
        detailLabel.font = .systemFont(ofSize: 11); detailLabel.textColor = .secondaryLabelColor
        statusView.addArrangedSubview(stateLabel); statusView.addArrangedSubview(activeLabel); statusView.addArrangedSubview(detailLabel)
        constrainChildren(statusView)
    }

    private func add(_ view: NSView) {
        view.translatesAutoresizingMaskIntoConstraints = false
        inspectorStack.addArrangedSubview(view)
        view.widthAnchor.constraint(equalTo: inspectorStack.widthAnchor, constant: -24).isActive = true
    }
    private func constrainChildren(_ stack: NSStackView) {
        for child in stack.arrangedSubviews {
            child.translatesAutoresizingMaskIntoConstraints = false
            child.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: stack === statusView ? -24 : 0).isActive = true
        }
    }
    private func title(_ text: String) -> NSTextField {
        let label = NSTextField(labelWithString: text); label.font = .systemFont(ofSize: 13, weight: .semibold); return label
    }
    private func note(_ text: String) -> NSTextField {
        let label = NSTextField(wrappingLabelWithString: text); label.font = .systemFont(ofSize: 11); label.textColor = .secondaryLabelColor; return label
    }
    private func button(_ text: String, _ action: Selector) -> NSButton {
        let button = NSButton(title: text, target: self, action: action); button.bezelStyle = .rounded; return button
    }
    private func separator() -> NSBox { let box = NSBox(); box.boxType = .separator; return box }

    private func loadDraft() {
        rendering = true
        let draft = coordinator.draft
        source.selectedSegment = draft.source == .cloud ? 0 : 1
        urlField.stringValue = draft.cloudURL
        autoStart.state = draft.autoStart ? .on : .off
        autoRecover.state = draft.autoRecover ? .on : .off
        fit.state = draft.scaleToFit ? .on : .off
        hideUI.state = draft.hidePlayerUI ? .on : .off
        rendering = false
    }
    private func refresh() {
        let cloud = coordinator.draft.source == .cloud
        cloudGroup.isHidden = !cloud; fileGroup.isHidden = cloud
        fileLabel.stringValue = coordinator.draft.filePath.isEmpty ? "尚未选择文件" : coordinator.draft.filePath
        fit.isEnabled = cloud; hideUI.isEnabled = cloud
        let busy = coordinator.state.isBusy
        startButton.isEnabled = !busy; reloadButton.isEnabled = !busy && coordinator.hasActiveSession
        openButton.isEnabled = !busy
        stopButton.isEnabled = busy || coordinator.hasActiveSession || coordinator.state == .waitingForDisplay
        startButton.title = coordinator.hasActiveSession ? "应用并切换" : "启动 / 重试预览"
        saveButton.title = coordinator.hasUnsavedDraft ? "保存配置 · 有未保存修改" : "保存配置"
        targetLabel.stringValue = coordinator.targetDisplayID == nil ? "目标：等待外接显示器" : "目标：沿用当前 Warp 外接显示器"
        stateLabel.stringValue = coordinator.state.summary
        detailLabel.stringValue = coordinator.notice
        detailLabel.isHidden = coordinator.notice.isEmpty
        if let session = coordinator.activeSession {
            activeLabel.stringValue = "当前来源：\(session.configuration.sourceLabel) · 窗口 \(session.windowID)"
        } else { activeLabel.stringValue = "来源配置 → 打开预览 → 确认窗口 → 验证首帧" }
    }
    func controlTextDidChange(_ obj: Notification) {
        guard !rendering else { return }
        coordinator.draft.cloudURL = urlField.stringValue
    }
    @objc private func sourceChanged() { coordinator.draft.source = source.selectedSegment == 0 ? .cloud : .localFile }
    @objc private func optionsChanged() {
        var draft = coordinator.draft
        draft.autoStart = autoStart.state == .on; draft.autoRecover = autoRecover.state == .on
        draft.scaleToFit = fit.state == .on; draft.hidePlayerUI = hideUI.state == .on
        coordinator.draft = draft
    }
    @objc private func chooseFile() {
        let panel = NSOpenPanel(); panel.canChooseDirectories = false; panel.allowsMultipleSelection = false
        panel.allowedContentTypes = [UTType(filenameExtension: "pie") ?? .data]
        let completion: (NSApplication.ModalResponse) -> Void = { [weak self, weak panel] response in
            guard response == .OK, let self, let url = panel?.url else { return }
            do {
                var draft = self.coordinator.draft; try draft.selectFile(url); self.coordinator.draft = draft
                self.loadDraft(); self.refresh()
            } catch {
                let alert = NSAlert(); alert.messageText = "无法选择预览文件"; alert.informativeText = error.localizedDescription
                if let window = self.inspectorView.window { alert.beginSheetModal(for: window) } else { alert.runModal() }
            }
        }
        if let window = inspectorView.window { panel.beginSheetModal(for: window, completionHandler: completion) }
        else { panel.begin(completionHandler: completion) }
    }
    @objc private func save() { _ = coordinator.saveConfiguration() }
    @objc private func start() { coordinator.start() }
    @objc private func reload() { coordinator.reload() }
    @objc private func stop() { coordinator.stop() }
    @objc private func openPlayer() { coordinator.openPlayer() }
    @objc private func accessibilitySettings() {
        _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility") { NSWorkspace.shared.open(url) }
    }
}

private final class ProtoPieFlippedDocumentView: NSView { override var isFlipped: Bool { true } }
