import AppKit
import ApplicationServices
import UniformTypeIdentifiers

/// Embeddable inspector; it has no window and does not take ownership of the shared preview canvas.
@MainActor final class ProtoPiePanel: NSObject, NSTextFieldDelegate {
    struct OutputPositionState {
        let value: Double
        let range: ClosedRange<Double>
        let isEnabled: Bool
    }
    struct OutputPositionBinding {
        let read: () -> OutputPositionState
        let apply: (Double) -> Void
    }
    let inspectorView = NSScrollView()
    private let inspectorStack = NSStackView()
    let statusView = NSStackView()
    private let coordinator: ProtoPieCoordinator
    private let outputPositionBinding: OutputPositionBinding?
    private let outputPosition = NSSlider(value: 0, minValue: -1, maxValue: 1, target: nil, action: nil)
    private let outputPositionInput = NSTextField(string: "0")
    private let outputPositionReset = NSButton(title: "整幅位置归零", target: nil, action: nil)
    private var outputPositionInputDirty = false
    private let internalCropGroup = NSStackView()
    private let internalCropToggle = NSButton(checkboxWithTitle: "高级 · 原型内部取景", target: nil, action: nil)
    private var observer: UUID?
    private let source = NSSegmentedControl(labels: ["云端链接", "本地 .pie", "ProtoPie Connect"], trackingMode: .selectOne, target: nil, action: nil)
    private let urlField = NSTextField()
    private let fileLabel = NSTextField(wrappingLabelWithString: "尚未选择文件")
    private let cloudGroup = NSStackView()
    private let fileGroup = NSStackView()
    private let connectGroup = NSStackView()
    private let connectStatus = NSTextField(wrappingLabelWithString: "消息连通性未验证")
    private var connectTest: Task<Void, Never>?
    private let autoStart = NSButton(checkboxWithTitle: "打开 NIO Warp 时自动联动", target: nil, action: nil)
    private let autoRecover = NSButton(checkboxWithTitle: "意外中断后自动恢复（最多 3 次）", target: nil, action: nil)
    private let fit = NSButton(checkboxWithTitle: "等比适配播放器窗口", target: nil, action: nil)
    private let fillWidth = NSButton(checkboxWithTitle: "横向顶满（等比例）", target: nil, action: nil)
    private let verticalPosition = NSSlider(value: 0, minValue: -1, maxValue: 1, target: nil, action: nil)
    private let verticalPositionInput = NSTextField(string: "0.000")
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
    private var verticalPositionInputDirty = false

    init(coordinator: ProtoPieCoordinator, outputPositionBinding: OutputPositionBinding? = nil) {
        self.coordinator = coordinator
        self.outputPositionBinding = outputPositionBinding
        super.init()
        build()
        loadDraft()
        observer = coordinator.observe { [weak self] in self?.refresh() }
    }

    deinit {
        connectTest?.cancel()
        if let observer {
            let coordinator = coordinator
            Task { @MainActor in coordinator.removeObserver(observer) }
        }
    }

    func disconnect() {
        connectTest?.cancel(); connectTest = nil
        if let observer { coordinator.removeObserver(observer); self.observer = nil }
    }

    private func build() {
        for stack in [inspectorStack, statusView, cloudGroup, fileGroup, connectGroup, internalCropGroup] {
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
        add(title("整幅画面上下位置（物理 px）"))
        outputPosition.target = self; outputPosition.action = #selector(outputPositionChanged)
        outputPosition.isContinuous = true
        outputPosition.setAccessibilityIdentifier("nio-protopie-output-vertical-offset")
        outputPosition.setAccessibilityLabel("整幅画面上下位置，物理像素，负值上移，正值下移")
        add(outputPosition)
        outputPositionInput.target = self; outputPositionInput.action = #selector(outputPositionEdited)
        outputPositionInput.delegate = self
        outputPositionInput.setAccessibilityIdentifier("nio-protopie-output-vertical-offset-input")
        outputPositionInput.setAccessibilityLabel("整幅画面上下位置数值，物理像素")
        add(outputPositionInput)
        outputPositionReset.target = self; outputPositionReset.action = #selector(resetOutputPosition)
        outputPositionReset.setAccessibilityIdentifier("nio-protopie-output-vertical-offset-reset")
        add(outputPositionReset)
        add(note("拖动即时移动整块校正画面，保持宽度和曲面形状。负值向上，正值向下；自动保存，与「画布与输入」同步。超出实体屏幕的部分不可见。"))
        add(separator())
        source.target = self; source.action = #selector(sourceChanged)
        source.segmentStyle = .rounded; source.segmentDistribution = .fillEqually
        source.setAccessibilityIdentifier("nio-protopie-source-kind")
        add(title("预览来源")); add(source)
        urlField.placeholderString = "https://cloud.protopie.io/p/…"
        urlField.font = .systemFont(ofSize: 12); urlField.delegate = self
        urlField.lineBreakMode = .byTruncatingMiddle
        urlField.setAccessibilityLabel("ProtoPie Cloud 预览链接")
        cloudGroup.addArrangedSubview(urlField)
        cloudGroup.addArrangedSubview(note("链接只在本机保存，不会写入校正预设。"))
        cloudGroup.addArrangedSubview(note("启动预览时自动进入外屏无边框全屏；登录或操作播放器时可返回控制屏。"))
        constrainChildren(cloudGroup)
        add(cloudGroup)
        let probe = button("测试 Connect 链接", #selector(testConnect))
        probe.setAccessibilityIdentifier("nio-protopie-connect-test")
        connectGroup.addArrangedSubview(probe)
        connectGroup.addArrangedSubview(button("打开本机 ProtoPie Connect", #selector(openConnect)))
        connectGroup.addArrangedSubview(note("本机主服务使用 localhost 完整播放器链接；请先在 Connect 登录并加载原型。远端控制程序使用这台电脑的网络地址。"))
        connectGroup.addArrangedSubview(note("Connect 使用原生舞台等比适应或原始尺寸；本候选版不覆盖舞台缩放，横向顶满和原型内部取景暂不可用。整幅画面位置仍由 Warp 控制。"))
        connectStatus.font = .systemFont(ofSize: 11); connectStatus.textColor = .secondaryLabelColor
        connectStatus.setAccessibilityIdentifier("nio-protopie-connect-status")
        connectGroup.addArrangedSubview(connectStatus)
        constrainChildren(connectGroup); add(connectGroup)
        fileLabel.font = .systemFont(ofSize: 12); fileLabel.maximumNumberOfLines = 3
        let choose = button("选择 / 替换 .pie 文件…", #selector(chooseFile))
        fileGroup.addArrangedSubview(fileLabel); fileGroup.addArrangedSubview(choose)
        fileGroup.addArrangedSubview(note("使用 Studio 的 Preview 窗口。文件内容保持不变，需辅助功能权限。"))
        constrainChildren(fileGroup)
        add(fileGroup)
        add(separator()); add(title("自动联动"))
        for control in [autoStart, autoRecover, fit, fillWidth, hideUI] {
            control.font = .systemFont(ofSize: 12); control.target = self; control.action = #selector(optionsChanged)
        }
        add(autoStart); add(autoRecover)
        add(separator()); add(title("播放与目标"))
        fit.setAccessibilityIdentifier("nio-protopie-scale-to-fit")
        fillWidth.setAccessibilityIdentifier("nio-protopie-fill-width")
        add(fit); add(fillWidth)
        add(note("播放器高度跟随当前 Warp 画布高度，先捕获完整内容。保持比例完整显示时，画面左右可能留边。"))
        add(note("Cloud 预览按宽度等比放大，超出屏幕的上下内容可调整裁切位置；不改变 Warp 校正参数。"))
        internalCropToggle.target = self; internalCropToggle.action = #selector(toggleInternalCrop(_:))
        internalCropToggle.setAccessibilityIdentifier("nio-protopie-internal-crop-toggle")
        add(internalCropToggle)
        internalCropGroup.setAccessibilityIdentifier("nio-protopie-internal-crop-controls")
        internalCropGroup.isHidden = true
        verticalPosition.target = self; verticalPosition.action = #selector(verticalPositionChanged)
        verticalPosition.isContinuous = true
        verticalPosition.setAccessibilityIdentifier("nio-protopie-vertical-position")
        verticalPosition.setAccessibilityLabel("原型内部取景，仅内容高度溢出时有效")
        internalCropGroup.addArrangedSubview(verticalPosition)
        verticalPositionInput.target = self; verticalPositionInput.action = #selector(verticalPositionEdited)
        verticalPositionInput.delegate = self
        verticalPositionInput.setAccessibilityIdentifier("nio-protopie-vertical-position-input")
        verticalPositionInput.setAccessibilityLabel("原型内部取景数值，范围负一至正一")
        internalCropGroup.addArrangedSubview(verticalPositionInput)
        internalCropGroup.addArrangedSubview(note("仅调整播放器内部溢出内容，范围 −1 至 +1；内容与播放器同高时不移动。需要整块画面上下移动，请用本页顶部的物理像素滑块。保存配置可保留内部取景值。"))
        constrainChildren(internalCropGroup)
        add(internalCropGroup)
        add(hideUI)
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
        source.selectedSegment = draft.source == .cloud ? 0 : draft.source == .localFile ? 1 : 2
        urlField.stringValue = draft.source == .connect ? draft.connectURL : draft.cloudURL
        autoStart.state = draft.autoStart ? .on : .off
        autoRecover.state = draft.autoRecover ? .on : .off
        fit.state = draft.scaleToFit || draft.fillWidth ? .on : .off
        fillWidth.state = draft.fillWidth ? .on : .off
        loadVerticalPosition()
        hideUI.state = draft.hidePlayerUI ? .on : .off
        rendering = false
    }
    private func refresh() {
        refreshOutputPosition()
        let cloud = coordinator.draft.source == .cloud
        let browser = coordinator.draft.source != .localFile
        let connect = coordinator.draft.source == .connect
        cloudGroup.isHidden = !browser; fileGroup.isHidden = browser
        connectGroup.isHidden = !connect
        urlField.placeholderString = connect ? "http://localhost:9981/pie?pieid=…" : "https://cloud.protopie.io/p/…"
        urlField.setAccessibilityLabel(connect ? "ProtoPie Connect 完整播放器链接" : "ProtoPie Cloud 预览链接")
        fileLabel.stringValue = coordinator.draft.filePath.isEmpty ? "尚未选择文件" : coordinator.draft.filePath
        fit.state = coordinator.draft.scaleToFit || (cloud && coordinator.draft.fillWidth) ? .on : .off
        fillWidth.state = cloud && coordinator.draft.fillWidth ? .on : .off
        fit.isEnabled = browser && (connect || !coordinator.draft.fillWidth)
        fillWidth.isEnabled = cloud; hideUI.isEnabled = cloud
        verticalPosition.isEnabled = cloud && coordinator.draft.fillWidth
        verticalPositionInput.isEnabled = verticalPosition.isEnabled
        internalCropToggle.isEnabled = cloud
        internalCropGroup.isHidden = !cloud || internalCropToggle.state != .on
        loadVerticalPosition()
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
        if obj.object as? NSTextField === urlField {
            connectTest?.cancel(); connectTest = nil
            if coordinator.draft.source == .connect {
                coordinator.draft.connectURL = urlField.stringValue
                connectStatus.stringValue = "链接已编辑 · 播放器及消息连通性未验证"
            } else { coordinator.draft.cloudURL = urlField.stringValue }
        } else if obj.object as? NSTextField === verticalPositionInput {
            verticalPositionInputDirty = true
        } else if obj.object as? NSTextField === outputPositionInput {
            outputPositionInputDirty = true
        }
    }
    func controlTextDidEndEditing(_ obj: Notification) {
        guard !rendering else { return }
        if obj.object as? NSTextField === verticalPositionInput { commitVerticalPositionInput() }
        if obj.object as? NSTextField === outputPositionInput { commitOutputPositionInput() }
    }
    /// Pull back the renderer's accepted configuration, never a second ProtoPie preference.
    func refreshOutputPosition() {
        let state = outputPositionBinding?.read() ?? OutputPositionState(value: 0, range: -1...1, isEnabled: false)
        outputPosition.minValue = state.range.lowerBound
        outputPosition.maxValue = state.range.upperBound
        outputPosition.doubleValue = state.value
        outputPosition.isEnabled = state.isEnabled
        outputPositionInput.isEnabled = state.isEnabled
        outputPositionReset.isEnabled = state.isEnabled
        if !outputPositionInputDirty {
            let text = NumericInput.formattedDouble(state.value)
            outputPositionInput.stringValue = text
            outputPositionInput.currentEditor()?.string = text
        }
    }
    private func applyOutputPosition(_ value: Double) {
        guard value.isFinite else { return }
        outputPositionInputDirty = false
        outputPositionBinding?.apply(value)
        refreshOutputPosition()
        if let state = outputPositionBinding?.read() {
            let text = NumericInput.formattedDouble(state.value)
            outputPositionInput.stringValue = text
            outputPositionInput.currentEditor()?.string = text
        }
    }
    @objc private func outputPositionChanged() { applyOutputPosition(outputPosition.doubleValue) }
    @objc private func outputPositionEdited() { commitOutputPositionInput(force: true) }
    @objc private func resetOutputPosition() { applyOutputPosition(0) }
    private func commitOutputPositionInput(force: Bool = false) {
        guard let state = outputPositionBinding?.read() else { return }
        let text = outputPositionInput.currentEditor()?.string ?? outputPositionInput.stringValue
        guard force || outputPositionInputDirty else { return }
        if let value = NumericInput.double(from: text), value.isFinite {
            applyOutputPosition(value)
        } else {
            applyOutputPosition(state.value)
        }
    }
    @objc private func toggleInternalCrop(_ sender: NSButton) {
        guard coordinator.draft.source == .cloud else { return }
        internalCropGroup.isHidden = sender.state != .on
    }
    @objc private func sourceChanged() {
        connectTest?.cancel(); connectTest = nil
        coordinator.draft.source = source.selectedSegment == 0 ? .cloud : source.selectedSegment == 1 ? .localFile : .connect
        connectStatus.stringValue = "消息连通性未验证"
        loadDraft(); refresh()
    }
    @objc private func testConnect() {
        connectTest?.cancel()
        let configuration = coordinator.draft
        guard configuration.source == .connect else { return }
        do {
            let url = try configuration.playbackURL()
            connectStatus.stringValue = "正在检查播放器页面；消息连通性未验证…"
            connectTest = Task { [weak self] in
                do {
                    let result = try await ProtoPieConnectServiceProbe().probe(url)
                    guard let self, !Task.isCancelled, self.coordinator.draft.source == .connect,
                          self.coordinator.draft.connectURL == configuration.connectURL else { return }
                    self.connectStatus.stringValue = result.summary + " · 消息连通性未验证"
                } catch {
                    guard let self, !Task.isCancelled else { return }
                    self.connectStatus.stringValue = "链接检查未完成；请确认 Connect 运行、原型及端口。消息连通性未验证。"
                }
            }
        } catch { connectStatus.stringValue = error.localizedDescription }
    }
    @objc private func openConnect() {
        Task { [weak self] in
            do { try await ProtoPieConnectApplication.open() }
            catch { self?.connectStatus.stringValue = error.localizedDescription }
        }
    }
    private func loadVerticalPosition() {
        verticalPosition.doubleValue = coordinator.draft.widthFitVerticalPosition
        if verticalPositionInput.currentEditor() == nil {
            verticalPositionInput.stringValue = String(format: "%.3f", coordinator.draft.widthFitVerticalPosition)
        }
    }
    @objc private func verticalPositionChanged() {
        guard coordinator.draft.source == .cloud, coordinator.draft.fillWidth else { return }
        verticalPositionInputDirty = false
        coordinator.setVerticalPosition(verticalPosition.doubleValue)
    }
    @objc private func verticalPositionEdited() {
        commitVerticalPositionInput(force: true)
    }
    private func commitVerticalPositionInput(force: Bool = false) {
        guard coordinator.draft.source == .cloud, coordinator.draft.fillWidth else { return }
        let text = verticalPositionInput.currentEditor()?.string ?? verticalPositionInput.stringValue
        let formatted = String(format: "%.3f", coordinator.draft.widthFitVerticalPosition)
        // Do not round an untouched full-precision value merely because its field
        // displays three decimals when the user clicks Save or Apply.
        if force || verticalPositionInputDirty || text != formatted,
           let value = Double(text.trimmingCharacters(in: .whitespacesAndNewlines)), value.isFinite {
            coordinator.setVerticalPosition(value)
        }
        verticalPositionInputDirty = false
        verticalPositionInput.stringValue = String(format: "%.3f", coordinator.draft.widthFitVerticalPosition)
    }
    @objc private func optionsChanged() {
        var draft = coordinator.draft
        draft.autoStart = autoStart.state == .on; draft.autoRecover = autoRecover.state == .on
        // Width fill uses native fitting but remembers the ordinary fit choice
        // so switching width fill off restores the user's previous setting.
        if draft.source == .connect {
            draft.scaleToFit = fit.state == .on
        } else if draft.source == .cloud {
            if !draft.fillWidth { draft.scaleToFit = fit.state == .on }
            draft.fillWidth = fillWidth.state == .on
            draft.hidePlayerUI = hideUI.state == .on
        }
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
    @objc private func save() { commitOutputPositionInput(); commitVerticalPositionInput(); _ = coordinator.saveConfiguration() }
    @objc private func start() { commitOutputPositionInput(); commitVerticalPositionInput(); coordinator.start() }
    @objc private func reload() { coordinator.reload() }
    @objc private func stop() { coordinator.stop() }
    @objc private func openPlayer() { coordinator.openPlayer() }
    @objc private func accessibilitySettings() {
        _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility") { NSWorkspace.shared.open(url) }
    }
}

private final class ProtoPieFlippedDocumentView: NSView { override var isFlipped: Bool { true } }
