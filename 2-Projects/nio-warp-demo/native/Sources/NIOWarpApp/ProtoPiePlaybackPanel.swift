import AppKit

/// Cloud playlist, script editor and runtime controls. It is deliberately embeddable:
/// the existing ProtoPie inspector continues to own display and calibration controls.
@MainActor final class ProtoPiePlaybackPanel: NSObject {
    let view = NSView()
    var onPickPosition: ((@escaping (Double, Double) -> Void) -> Void)? {
        didSet { if section.selectedSegment == 1 { renderContent() } }
    }

    private let controller: ProtoPiePlaybackController
    private let coordinator: ProtoPieCoordinator?
    private var draft: ProtoPiePlaybackLibrary
    private var observer: UUID?
    private var previewObserver: UUID?
    private var disconnected = false
    private var dirty = false
    private var saving = false
    private var initializationSelected = false
    private var selectedStepID: UUID?
    private var deletedItem: (ProtoPiePlaylistItem, Int)?
    private let sidebar = NSStackView()
    private let content = NSStackView()
    private let heading = NSTextField(labelWithString: "云端演示")
    private let message = NSTextField(wrappingLabelWithString: "")
    private let section = PBPlaybackSegment(labels: ["链接与画面", "自动操作脚本", "播放计划", "运行日志"])
    private let runTitle = NSTextField(labelWithString: "等待开始")
    private let runDetail = NSTextField(wrappingLabelWithString: "")
    private let itemClock = NSTextField(labelWithString: "—")
    private let totalClock = NSTextField(labelWithString: "—")
    private let progress = NSProgressIndicator()
    private var runButton: PBPlaybackButton!
    private var stopButton: PBPlaybackButton!
    private var previousButton: PBPlaybackButton!
    private var nextButton: PBPlaybackButton!
    private var saveButton: PBPlaybackButton!
    private var previewButton: PBPlaybackButton!
    private var trialButtons: [NSButton] = []
    private var sidebarRuntimeLabels: [UUID: NSTextField] = [:]
    private var stepCards: [UUID: NSView] = [:]
    private var logText: NSTextView?
    private var renderedLogCount = -1
    private var lastLogTimestamp: Date?
    private var exportTask: Task<Void, Never>?
    private var displayedRunID: UUID?
    private var runningDurations: [UUID: Double] = [:]

    init(controller: ProtoPiePlaybackController, coordinator: ProtoPieCoordinator? = nil) {
        self.controller = controller
        self.coordinator = coordinator
        draft = controller.library
        super.init()
        build()
        renderSidebar()
        renderContent()
        refreshRuntime()
        observer = controller.observe { [weak self] in self?.controllerChanged() }
        previewObserver = coordinator?.observe { [weak self] in
            guard let self, !self.disconnected else { return }
            self.refreshRuntime()
        }
    }

    deinit {
        if let observer {
            let controller = controller
            Task { @MainActor in controller.removeObserver(observer) }
        }
        if let previewObserver, let coordinator {
            Task { @MainActor in coordinator.removeObserver(previewObserver) }
        }
    }

    func disconnect() {
        disconnected = true
        exportTask?.cancel(); exportTask = nil
        if let observer { controller.removeObserver(observer); self.observer = nil }
        if let previewObserver { coordinator?.removeObserver(previewObserver); self.previewObserver = nil }
    }

    private var selectedItem: ProtoPiePlaylistItem? {
        draft.items.first { $0.id == draft.selectedItemID } ?? draft.items.first
    }

    private var selectionBackground: NSColor {
        NSColor.controlAccentColor.blended(withFraction: 0.91, of: .controlBackgroundColor) ?? .controlBackgroundColor
    }

    private func build() {
        view.setAccessibilityIdentifier("nio-playback-panel")
        view.translatesAutoresizingMaskIntoConstraints = false
        view.wantsLayer = true
        view.layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
        let shell = vertical(spacing: 0)
        shell.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(shell)
        NSLayoutConstraint.activate([
            shell.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            shell.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            shell.topAnchor.constraint(equalTo: view.topAnchor),
            shell.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        ])
        let preferredHeight = view.heightAnchor.constraint(greaterThanOrEqualToConstant: 520)
        preferredHeight.priority = .defaultHigh; preferredHeight.isActive = true

        let body = NSView()
        body.translatesAutoresizingMaskIntoConstraints = false
        let rail = vertical(spacing: 10)
        rail.edgeInsets = NSEdgeInsets(top: 14, left: 10, bottom: 10, right: 10)
        rail.wantsLayer = true; rail.layer?.backgroundColor = NSColor.controlBackgroundColor.cgColor
        let railHead = horizontal([title("云端来源"), spacer(), label("可直接编辑名称", small: true)])
        rail.addArrangedSubview(railHead)
        configure(sidebar)
        sidebar.spacing = 7
        let listScroll = scroll(sidebar)
        rail.addArrangedSubview(listScroll)
        let add = button("＋ 添加", id: "add-item") { [weak self] in self?.addItem() }
        let duplicate = button("复制", id: "duplicate-item") { [weak self] in self?.duplicateItem() }
        let remove = button("删除", id: "delete-item") { [weak self] in self?.deleteItem() }
        rail.addArrangedSubview(horizontal([add, duplicate, remove]))
        rail.addArrangedSubview(horizontal([
            button("↑ 上移", id: "item-up") { [weak self] in self?.moveItem(-1) },
            button("↓ 下移", id: "item-down") { [weak self] in self?.moveItem(1) },
            button("撤销删除", id: "undo-delete") { [weak self] in self?.undoDelete() }
        ], spacing: 3))
        rail.addArrangedSubview(note("勾选的来源参与顺序轮播。选中编辑与正在播放相互独立。"))
        constrainWidth(rail)

        let editor = vertical(spacing: 10)
        editor.edgeInsets = NSEdgeInsets(top: 14, left: 16, bottom: 12, right: 14)
        editor.wantsLayer = true; editor.layer?.backgroundColor = NSColor.textBackgroundColor.cgColor
        heading.font = .systemFont(ofSize: 18, weight: .semibold)
        heading.lineBreakMode = .byTruncatingTail
        heading.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        previewButton = button("预览所选", id: "preview-selected") { [weak self] in self?.performSaved { $0.previewSelected() } }
        editor.addArrangedSubview(horizontal([heading, spacer(), previewButton]))
        editor.addArrangedSubview(note("独立云端播放列表 · 更换链接不改动现有 Warp 校正参数"))
        section.segmentDistribution = .fillEqually; section.selectedSegment = 0
        section.setAccessibilityIdentifier("nio-playback-sections")
        section.onAction = { [weak self] in self?.commitEditing(); self?.renderContent() }
        editor.addArrangedSubview(section)
        message.font = .systemFont(ofSize: 11)
        message.textColor = .secondaryLabelColor
        message.setAccessibilityIdentifier("nio-playback-message")
        editor.addArrangedSubview(message)
        configure(content); content.spacing = 12
        editor.addArrangedSubview(scroll(content))
        constrainWidth(editor)

        body.addSubview(rail); body.addSubview(editor)
        rail.translatesAutoresizingMaskIntoConstraints = false
        editor.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            rail.leadingAnchor.constraint(equalTo: body.leadingAnchor), rail.topAnchor.constraint(equalTo: body.topAnchor),
            rail.bottomAnchor.constraint(equalTo: body.bottomAnchor), rail.widthAnchor.constraint(equalToConstant: 218),
            editor.leadingAnchor.constraint(equalTo: rail.trailingAnchor), editor.trailingAnchor.constraint(equalTo: body.trailingAnchor),
            editor.topAnchor.constraint(equalTo: body.topAnchor), editor.bottomAnchor.constraint(equalTo: body.bottomAnchor),
            body.heightAnchor.constraint(greaterThanOrEqualToConstant: 330)
        ])
        shell.addArrangedSubview(body)
        shell.addArrangedSubview(separator())
        shell.addArrangedSubview(buildRuntimeBar())
        constrainWidth(shell)
    }

    private func buildRuntimeBar() -> NSView {
        let bar = vertical(spacing: 7)
        bar.edgeInsets = NSEdgeInsets(top: 10, left: 14, bottom: 10, right: 14)
        runTitle.font = .systemFont(ofSize: 13, weight: .semibold)
        runTitle.lineBreakMode = .byTruncatingTail
        runTitle.setAccessibilityIdentifier("nio-playback-runtime-title")
        runDetail.font = .systemFont(ofSize: 11); runDetail.textColor = .secondaryLabelColor
        runDetail.maximumNumberOfLines = 2
        runDetail.setAccessibilityIdentifier("nio-playback-runtime-detail")
        for clock in [itemClock, totalClock] {
            clock.font = .monospacedDigitSystemFont(ofSize: 17, weight: .medium)
            clock.widthAnchor.constraint(greaterThanOrEqualToConstant: 72).isActive = true
        }
        let clocks = horizontal([field("计划本项剩余", itemClock), field("计划总剩余", totalClock)], spacing: 18)
        let status = vertical(spacing: 3); status.addArrangedSubview(runTitle); status.addArrangedSubview(runDetail)
        status.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        bar.addArrangedSubview(horizontal([status, spacer(), clocks]))
        progress.isIndeterminate = false; progress.minValue = 0; progress.maxValue = 1
        progress.style = .bar; progress.controlSize = .small
        bar.addArrangedSubview(progress)
        previousButton = button("上一项", id: "previous") { [weak self] in self?.controller.previous() }
        nextButton = button("下一项", id: "next") { [weak self] in self?.controller.next() }
        runButton = button("开始计划", id: "start-pause") { [weak self] in self?.toggleRun() }
        runButton.bezelColor = .controlAccentColor
        stopButton = button("停止", id: "stop") { [weak self] in self?.controller.stop() }
        saveButton = button("保存配置", id: "save") { [weak self] in self?.commitEditing(); _ = self?.saveDraft() }
        bar.addArrangedSubview(horizontal([note("Esc 返回工作台 · 人工操作优先"), spacer(), saveButton,
                                          previousButton, nextButton, runButton, stopButton], spacing: 6))
        constrainWidth(bar)
        return bar
    }

    private func renderSidebar() {
        clear(sidebar); sidebarRuntimeLabels.removeAll()
        for (index, item) in draft.items.enumerated() {
            let card = vertical(spacing: 5)
            card.edgeInsets = NSEdgeInsets(top: 8, left: 8, bottom: 8, right: 8)
            card.wantsLayer = true; card.layer?.cornerRadius = 7
            card.layer?.backgroundColor = (item.id == selectedItem?.id ? selectionBackground : NSColor.controlBackgroundColor).cgColor
            let enabled = check("", value: item.enabled, id: "item-enabled-\(item.id)") { [weak self] value in
                self?.editItem(item.id) { $0.enabled = value }
            }
            enabled.toolTip = "参与轮播"
            let name = text(item.name, id: "item-name-\(item.id)") { [weak self] value in
                self?.editItem(item.id) { $0.name = value }
                self?.heading.stringValue = self?.selectedItem?.name ?? "云端演示"
            }
            name.font = .systemFont(ofSize: 12, weight: .semibold)
            name.setAccessibilityLabel("第 \(index + 1) 个演示名称，可直接编辑")
            card.addArrangedSubview(horizontal([enabled, name], spacing: 3))
            let detail = label("", small: true)
            sidebarRuntimeLabels[item.id] = detail
            let choose = button(item.id == selectedItem?.id ? "正在编辑" : "选择编辑", id: "select-item-\(item.id)") { [weak self] in
                self?.selectItem(item.id)
            }
            choose.controlSize = .small; choose.font = .systemFont(ofSize: 10)
            card.addArrangedSubview(horizontal([detail, spacer(), choose], spacing: 2))
            constrainWidth(card)
            add(card, to: sidebar)
        }
        if draft.items.isEmpty { add(note("点击「＋ 添加」建立第一个云端演示。"), to: sidebar) }
        refreshRuntime()
    }

    private func renderContent() {
        clear(content); trialButtons = []; stepCards.removeAll(); logText = nil
        heading.stringValue = selectedItem?.name ?? "云端演示"
        switch section.selectedSegment {
        case 1: buildScript()
        case 2: buildPlan()
        case 3: buildLogs()
        default: buildSource()
        }
        refreshRuntime()
    }

    private func buildSource() {
        guard let item = selectedItem else { add(note("先在左侧添加一个云端链接。")); return }
        add(field("演示名称 · 与左侧列表一致", text(item.name, id: "source-name") { [weak self] value in
            self?.editItem(item.id) { $0.name = value }; self?.renderSidebar()
            self?.heading.stringValue = value
        }))
        let url = text(item.cloudURL, id: "source-url") { [weak self] value in self?.editItem(item.id) { $0.cloudURL = value } }
        url.placeholderString = "https://cloud.protopie.io/p/…"
        url.lineBreakMode = .byTruncatingMiddle
        add(field("ProtoPie Cloud 链接", url))
        add(check("启用此来源，参与顺序轮播", value: item.enabled, id: "source-enabled") { [weak self] value in
            self?.editItem(item.id) { $0.enabled = value }; self?.renderSidebar()
        })
        if item.cloudURL.isEmpty { add(note("新来源暂不参与轮播；填入有效链接后勾选启用。")) }
        add(title("本链接演示时长"))
        add(durationFields(seconds: item.durationSeconds, prefix: "item-duration") { [weak self] value in
            self?.editItem(item.id) { $0.durationSeconds = value }
        })
        add(note("画面与输入就绪后开始计时；加载、故障恢复和暂停不消耗本链接演示时长。"))
        add(separator()); add(title("此链接的画面取景"))
        add(popup(["沿用原有横向显示设置", "等比例横向顶满", "关闭横向顶满（沿用原缩放）"],
                  selected: item.fillWidth.map { $0 ? 1 : 2 } ?? 0, id: "source-fill-width") { [weak self] index in
            self?.editItem(item.id) { $0.fillWidth = index == 0 ? nil : index == 1 }
        })
        add(check("为此链接设置原型内部上下取景", value: item.verticalPosition != nil, id: "source-position-override") { [weak self] enabled in
            self?.editItem(item.id) { $0.verticalPosition = enabled ? 0 : nil }; self?.renderContent()
        })
        if let position = item.verticalPosition {
            add(field("内部取景位置（−1 至 +1）", number(position, id: "source-position", range: -1...1) { [weak self] value in
                self?.editItem(item.id) { $0.verticalPosition = value }
            }))
        }
        add(note("仅保存本链接的播放器取景。整幅位置、AA 区、镜像和曲面校正仍使用已固化的显示设置。"))
    }

    private func buildScript() {
        guard let item = selectedItem else { add(note("先在左侧添加一个云端链接。")); return }
        add(check("为此链接启用自动操作", value: item.script.enabled, id: "script-enabled") { [weak self] value in
            self?.editItem(item.id) { $0.script.enabled = value }
        })
        add(field("脚本名称", text(item.script.name, id: "script-name") { [weak self] value in
            self?.editItem(item.id) { $0.script.name = value }
        }))
        let stages = PBPlaybackSegment(labels: ["初始化（每次进入 / 重置）", "演示步骤"])
        stages.segmentDistribution = .fillEqually; stages.selectedSegment = initializationSelected ? 0 : 1
        stages.setAccessibilityIdentifier("nio-playback-script-stage")
        stages.onAction = { [weak self, weak stages] in
            self?.commitEditing(); self?.initializationSelected = stages?.selectedSegment == 0
            self?.selectedStepID = nil; self?.renderContent()
        }
        add(stages)
        add(note(initializationSelected ? "用于回到约定初始场景；每次进入链接、故障恢复或每轮刷新后执行。" : "按列表顺序执行。重复脚本不会自动还原场景，请配置初始化或启用每轮重新加载。"))
        let steps = initializationSelected ? item.script.initialization : item.script.steps
        if selectedStepID == nil || !steps.contains(where: { $0.id == selectedStepID }) { selectedStepID = steps.first?.id }
        if steps.isEmpty { add(note("暂无步骤。可先添加等待或按键，再逐步试播。")) }
        for (index, step) in steps.enumerated() { add(stepEditor(step, index: index, count: steps.count, itemID: item.id)) }
        add(horizontal([
            button("＋ 添加步骤", id: "add-step") { [weak self] in self?.addStep() },
            button("添加数字键盘示例", id: "keypad-example") { [weak self] in self?.addKeypadExample() }, spacer()
        ]))
        let single = button("单步试播", id: "try-step") { [weak self] in self?.tryScript(single: true) }
        let trial = button("试播此脚本", id: "try-script") { [weak self] in self?.tryScript(single: false) }
        trialButtons = [single, trial]
        add(horizontal([note("单步针对已选演示步骤"), spacer(), single, trial]))
        add(separator()); add(title("循环方式"))
        add(horizontal([
            field("执行轮数（0 = 驻留期循环）", integer(item.script.repeatCount, id: "script-repeat", range: 0...10000) { [weak self] value in
                self?.editItem(item.id) { $0.script.repeatCount = value }
            }),
            field("每轮间隔（秒）", number(item.script.loopInterval, id: "script-gap", range: 0.1...86400) { [weak self] value in
                self?.editItem(item.id) { $0.script.loopInterval = value }
            })
        ]))
        add(check("每轮重新加载原型，再执行初始化", value: item.script.reloadEachLoop, id: "script-reload") { [weak self] value in
            self?.editItem(item.id) { $0.script.reloadEachLoop = value }
        })
        add(note("按键可使用 Numpad2、Digit2、KeyA、ArrowLeft、Space 等。Esc 保留返回工作台；Cmd / Ctrl 组合不作为脚本按键。"))
    }

    private func stepEditor(_ step: ProtoPieScriptStep, index: Int, count: Int, itemID: UUID) -> NSView {
        let stage = initializationSelected
        let card = vertical(spacing: 8)
        card.edgeInsets = NSEdgeInsets(top: 9, left: 10, bottom: 9, right: 10)
        card.wantsLayer = true; card.layer?.cornerRadius = 6
        card.layer?.borderWidth = 1; card.layer?.borderColor = NSColor.separatorColor.cgColor
        stepCards[step.id] = card
        let select = button("\(index + 1)", id: "select-step-\(step.id)") { [weak self] in
            self?.commitEditing(); self?.selectedStepID = step.id; self?.renderContent()
        }
        select.toolTip = "选择此步骤进行单步试播"
        let kinds: [ProtoPieScriptStep.Kind] = [.wait, .keyPress, .keyHold, .mouseMove, .mouseClick, .mouseDoubleClick, .mouseHold, .mouseDrag, .scroll]
        let names = ["等待", "按一下键", "按住键后释放", "移动鼠标", "单击", "双击", "长按鼠标后释放", "拖动", "滚轮"]
        let kind = popup(names, selected: kinds.firstIndex(of: step.kind) ?? 0, id: "step-kind-\(step.id)") { [weak self] value in
            self?.editStep(itemID: itemID, stepID: step.id, initialization: stage) { $0.kind = kinds[value] }
            self?.selectedStepID = step.id
            self?.renderContent()
        }
        let up = button("↑", id: "step-up-\(step.id)") { [weak self] in self?.moveStep(step.id, by: -1) }
        let down = button("↓", id: "step-down-\(step.id)") { [weak self] in self?.moveStep(step.id, by: 1) }
        up.isEnabled = index > 0; down.isEnabled = index + 1 < count
        let remove = button("删除", id: "step-delete-\(step.id)") { [weak self] in self?.deleteStep(step.id) }
        card.addArrangedSubview(horizontal([select, kind, spacer(), up, down, remove], spacing: 4))
        if selectedStepID != step.id {
            let summary: String
            switch step.kind {
            case .keyPress, .keyHold: summary = "\(step.key) · \(step.duration) 秒"
            case .wait: summary = "等待 \(step.duration) 秒"
            case .mouseDrag: summary = String(format: "(%.1f%%, %.1f%%) → (%.1f%%, %.1f%%)", step.x * 100, step.y * 100, step.endX * 100, step.endY * 100)
            default: summary = String(format: "位置 %.1f%%, %.1f%%", step.x * 100, step.y * 100)
            }
            card.addArrangedSubview(note("\(summary) · 随后等待 \(step.waitAfter) 秒 · 点击步骤号编辑"))
            constrainWidth(card)
            return card
        }
        let edit: (@escaping (inout ProtoPieScriptStep) -> Void) -> Void = { [weak self] change in
            self?.editStep(itemID: itemID, stepID: step.id, initialization: stage, change)
        }
        if step.kind == .keyPress || step.kind == .keyHold {
            let key = text(step.key, id: "step-key-\(step.id)") { value in edit { $0.key = value } }
            key.placeholderString = "Numpad2 / Digit2 / KeyA"
            card.addArrangedSubview(field("按键（区分主键盘 / 小键盘）", key))
        }
        let mouseKinds: [ProtoPieScriptStep.Kind] = [.mouseMove, .mouseClick, .mouseDoubleClick, .mouseHold, .mouseDrag, .scroll]
        if mouseKinds.contains(step.kind) {
            card.addArrangedSubview(horizontal([
                field(step.kind == .mouseDrag ? "起点 X %" : "X %", number(step.x * 100, id: "step-x-\(step.id)", range: 0...100) { value in edit { $0.x = value / 100 } }),
                field(step.kind == .mouseDrag ? "起点 Y %" : "Y %", number(step.y * 100, id: "step-y-\(step.id)", range: 0...100) { value in edit { $0.y = value / 100 } }),
                pickButton(stepID: step.id, itemID: itemID, initialization: stage, end: false)
            ], spacing: 7))
            if step.kind == .mouseDrag {
                card.addArrangedSubview(horizontal([
                    field("终点 X %", number(step.endX * 100, id: "step-end-x-\(step.id)", range: 0...100) { value in edit { $0.endX = value / 100 } }),
                    field("终点 Y %", number(step.endY * 100, id: "step-end-y-\(step.id)", range: 0...100) { value in edit { $0.endY = value / 100 } }),
                    pickButton(stepID: step.id, itemID: itemID, initialization: stage, end: true)
                ], spacing: 7))
            }
            if step.kind != .mouseMove && step.kind != .scroll {
                let buttons: [ProtoPieScriptStep.Button] = [.left, .right, .middle]
                card.addArrangedSubview(field("鼠标按钮", popup(["左键", "右键", "中键"], selected: buttons.firstIndex(of: step.button) ?? 0,
                     id: "step-button-\(step.id)") { value in edit { $0.button = buttons[value] } }))
            }
            if step.kind == .scroll {
                card.addArrangedSubview(horizontal([
                    field("水平滚动量", number(step.deltaX, id: "step-delta-x-\(step.id)", range: -100000...100000) { value in edit { $0.deltaX = value } }),
                    field("垂直滚动量", number(step.deltaY, id: "step-delta-y-\(step.id)", range: -100000...100000) { value in edit { $0.deltaY = value } })
                ]))
            }
        }
        let durationLabel: String
        switch step.kind {
        case .wait: durationLabel = "等待时长（秒）"
        case .keyPress, .keyHold, .mouseHold: durationLabel = "按住时长（秒）"
        case .mouseMove, .mouseDrag: durationLabel = "移动时长（秒）"
        default: durationLabel = "动作时长（秒）"
        }
        var timing: [NSView] = []
        if ![ProtoPieScriptStep.Kind.mouseClick, .mouseDoubleClick, .scroll].contains(step.kind) {
            timing.append(field(durationLabel, number(step.duration, id: "step-duration-\(step.id)", range: 0.01...86400) { value in edit { $0.duration = value } }))
        }
        timing.append(field("随后等待（秒）", number(step.waitAfter, id: "step-wait-\(step.id)", range: 0...86400) { value in edit { $0.waitAfter = value } }))
        timing.append(field("重复次数", integer(step.repeatCount, id: "step-repeat-\(step.id)", range: 1...1000) { value in edit { $0.repeatCount = value } }))
        card.addArrangedSubview(horizontal(timing, spacing: 7))
        constrainWidth(card)
        return card
    }

    private func pickButton(stepID: UUID, itemID: UUID, initialization: Bool, end: Bool) -> NSButton {
        let result = button(end ? "取终点" : "从预览取点", id: "pick-\(end ? "end" : "start")-\(stepID)") { [weak self] in
            guard let self, let picker = self.onPickPosition else { return }
            self.commitEditing()
            self.showMessage("请在预览的可点击 AA 区选择位置；Esc 可取消。")
            picker { [weak self] x, y in
                guard let self, !self.disconnected, x.isFinite, y.isFinite,
                      (0...1).contains(x), (0...1).contains(y) else { return }
                self.editStep(itemID: itemID, stepID: stepID, initialization: initialization) {
                    if end { $0.endX = x; $0.endY = y } else { $0.x = x; $0.y = y }
                }
                self.renderContent()
            }
        }
        // The host pauses its plan and serializes release before beginning the
        // existing AA-bound pointer picker; a paused plan may still be active.
        result.isEnabled = onPickPosition != nil
        result.toolTip = "记录源画面的百分比坐标；不会使用玻璃屏幕的绝对像素。"
        return result
    }

    private func buildPlan() {
        add(title("播放方式"))
        add(popup(["按列表顺序循环", "只播放所选链接"], selected: draft.plan.mode == .sequence ? 0 : 1, id: "plan-mode") { [weak self] index in
            self?.editLibrary { $0.plan.mode = index == 0 ? .sequence : .single }; self?.renderContent()
        })
        add(separator()); add(title("整场播放时长"))
        add(check("持续播放，不设结束时限", value: draft.plan.totalDurationSeconds == nil, id: "plan-unlimited") { [weak self] value in
            self?.editLibrary { $0.plan.totalDurationSeconds = value ? nil : 7200 }; self?.renderContent()
        })
        if let seconds = draft.plan.totalDurationSeconds {
            add(durationFields(seconds: seconds, prefix: "total-duration") { [weak self] value in
                self?.editLibrary { $0.plan.totalDurationSeconds = value }
            })
        }
        add(note("从开始计划起计时，包含加载、暂停及重试。到时立即取消剩余自动操作并释放按键。"))
        add(title("每项有效演示时长"))
        let items = draft.plan.mode == .single ? selectedItem.map { [$0] } ?? [] : draft.items.filter(\.enabled)
        if items.isEmpty { add(note("尚无启用的来源，请在左侧勾选。")) }
        for item in items { add(horizontal([label(item.name), spacer(), label(Self.durationText(item.durationSeconds), small: true)])) }
        add(note("在「链接与画面」中分别设置。修改已保存，正在运行的计划仍使用启动时快照，下次开始生效。"))
        add(separator())
        add(field("到时结束动作", popup(["停止自动操作，保留预览", "停止联动，返回工作台"], selected: draft.plan.endAction == .keepPreview ? 0 : 1,
             id: "plan-end-action") { [weak self] index in self?.editLibrary { $0.plan.endAction = index == 0 ? .keepPreview : .workbench } }))
        add(field("单链接最多恢复次数", integer(draft.plan.retryLimit, id: "plan-retries", range: 0...10) { [weak self] value in
            self?.editLibrary { $0.plan.retryLimit = value }
        }))
        add(note("达到恢复次数后跳过失败项；全部失败则暂停等待处理。保留预览时，原型自身的动画可能继续。"))
    }

    private func buildLogs() {
        add(title("浏览器控制"))
        let effective = (UserDefaults.standard.dictionary(forKey: ProtoPieBrowserControl.runtimeKey)?["mode"] as? String)
            .flatMap(ProtoPieControlMode.init(rawValue:)) ?? .persistent
        add(note("本次运行：\(effective.title)。更改下面的选项后，退出并重新打开 NIO Warp 生效。"))
        add(check("使用兼容控制（原机制）", value: ProtoPieControlMode.selected() == .legacy, id: "control-legacy") { [weak self] enabled in
            UserDefaults.standard.set((enabled ? ProtoPieControlMode.legacy : .persistent).rawValue,
                                      forKey: ProtoPieControlMode.preferenceKey)
            self?.showMessage("已保存，下次打开 NIO Warp 时使用\(enabled ? "兼容控制（原机制）" : "持久连接")。")
        })
        add(note("兼容控制用于临时降级，保留原来的预览操作方式；持续播放时仍可能出现原有内存增长。"))
        add(separator())
        add(horizontal([title("运行日志"), spacer(), button("导出诊断日志…", id: "export-logs") { [weak self] in self?.exportLogs() }]))
        add(note("记录计划、切源、步骤、恢复及异常。最近 200 条在此显示，完整日志按容量轮转保留；不记录私有链接及按键内容。"))
        if let warning = controller.log.warning { add(note(warning)) }
        let log = NSTextView()
        log.isEditable = false; log.isSelectable = true; log.drawsBackground = false
        log.font = .monospacedSystemFont(ofSize: 10, weight: .regular)
        log.textContainerInset = NSSize(width: 5, height: 5)
        log.isHorizontallyResizable = false; log.isVerticallyResizable = true
        log.autoresizingMask = [.width]
        log.textContainer?.widthTracksTextView = true
        log.setAccessibilityIdentifier("nio-playback-log-text")
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true; scroll.hasHorizontalScroller = false
        scroll.borderType = .bezelBorder; scroll.documentView = log
        scroll.heightAnchor.constraint(equalToConstant: 270).isActive = true
        add(scroll); logText = log
        renderedLogCount = -1; refreshLogs()
        add(note("异常导出后可核对：卡在哪个链接 / 步骤、是否仍有捕获帧、输入响应和自动恢复结果。"))
    }

    private func controllerChanged() {
        guard !disconnected else { return }
        // Runtime ticks must never replace a field editor or reset a scroll position.
        if !saving, !dirty, draft != controller.library, !hasEditingField {
            draft = controller.library
            renderSidebar(); renderContent()
        }
        refreshRuntime()
    }

    private var hasEditingField: Bool {
        guard let editor = view.window?.firstResponder as? NSTextView,
              let field = editor.delegate as? NSTextField else { return false }
        return field.isDescendant(of: view)
    }

    /// Independent preview animation does not mean the timed playlist is running.
    /// Pure presentation text: observing this state never takes playback ownership.
    static func idlePreviewStatus(_ state: ProtoPieRuntimeState?) -> (title: String, detail: String) {
        switch state {
        case .running:
            return ("单链接预览中 · 自动计划未开始", "当前仅显示独立预览；点击“开始计划”后才会按计划计时和切换链接。")
        case .paused:
            return ("预览输出已暂停 · 自动计划未开始", "预览来源仍保留，Warp 输出已暂停；计划计时尚未开始。")
        case .launching, .waitingForPreview, .capturing:
            return ("单链接预览准备中 · 自动计划未开始", state?.summary ?? "")
        case .waitingForDisplay:
            return ("等待目标外屏 · 自动计划未开始", "外屏就绪后可显示预览；自动计划需点击“开始计划”。")
        case .failed(let reason):
            return ("单链接预览异常 · 自动计划未开始", reason)
        case .stopped:
            return ("预览联动已停止 · 自动计划未开始", "点击“开始计划”可按当前配置准备预览、计时和切换链接。")
        case .idle, .none:
            return ("自动计划未开始", "点击“开始计划”后才会按计划计时和切换链接。")
        }
    }

    private func refreshRuntime() {
        let runtime = controller.runtime
        if runtime.runID != displayedRunID {
            displayedRunID = runtime.runID
            runningDurations = Dictionary(uniqueKeysWithValues: controller.library.items.map { ($0.id, $0.durationSeconds) })
        }
        let status: String
        switch runtime.state {
        case .idle: status = Self.idlePreviewStatus(coordinator?.state).title
        case .preparing: status = "准备播放"
        case .running: status = "自动演示"
        case .paused: status = "已暂停"
        case .recovering: status = "正在恢复"
        case .completed: status = "已完成"
        case .failed: status = "播放失败"
        }
        runTitle.stringValue = runtime.state == .idle || runtime.itemName.isEmpty ? status : "\(runtime.itemName) · \(status)"
        let step = runtime.stepIndex.map { " · 步骤 \($0 + 1)" } ?? ""
        runDetail.stringValue = runtime.notice.isEmpty ? "\(draft.items.filter(\.enabled).count) 个启用链接 · 已执行 \(runtime.loopCount) 轮\(step)" : runtime.notice
        if runtime.state == .idle {
            let detail = Self.idlePreviewStatus(coordinator?.state).detail
            runDetail.stringValue = runtime.notice.isEmpty ? detail : "\(runtime.notice) · \(detail)"
        }
        itemClock.stringValue = runtime.isActive ? Self.durationText(runtime.remainingItemSeconds) : selectedItem.map { Self.durationText($0.durationSeconds) } ?? "—"
        let displayedTotal = runtime.isActive || runtime.state == .completed || runtime.state == .failed
            ? runtime.remainingTotalSeconds : draft.plan.totalDurationSeconds
        totalClock.stringValue = displayedTotal.map(Self.durationText) ?? "持续播放"
        runButton.title = runtime.state == .paused ? "继续" : runtime.isActive ? "暂停" : "开始计划"
        runButton.isEnabled = runtime.isActive || !draft.items.isEmpty
        stopButton.isEnabled = runtime.isActive
        previousButton.isEnabled = runtime.isActive
        nextButton.isEnabled = runtime.isActive
        previewButton?.isEnabled = selectedItem != nil && !runtime.isActive
        saveButton?.title = dirty ? "保存未完成修改" : "保存配置"
        for button in trialButtons { button.isEnabled = !runtime.isActive && !initializationSelected && !(selectedItem?.script.steps.isEmpty ?? true) }
        if let itemID = runtime.itemID, let duration = runningDurations[itemID], duration > 0, runtime.isActive {
            progress.doubleValue = max(0, min(1, 1 - runtime.remainingItemSeconds / duration))
        } else { progress.doubleValue = 0 }
        for item in draft.items {
            sidebarRuntimeLabels[item.id]?.stringValue = runtime.isActive && runtime.itemID == item.id ? "● 正在播放" : "\(Self.durationText(item.durationSeconds)) · \(item.script.enabled ? "自动操作" : "仅预览")"
            sidebarRuntimeLabels[item.id]?.textColor = runtime.isActive && runtime.itemID == item.id ? .controlAccentColor : .secondaryLabelColor
        }
        let steps = initializationSelected ? selectedItem?.script.initialization ?? [] : selectedItem?.script.steps ?? []
        for step in steps {
            let selected = selectedStepID == step.id
            let running = !initializationSelected && runtime.state == .running && runtime.itemID == selectedItem?.id
                && runtime.stepIndex.flatMap { steps.indices.contains($0) ? steps[$0].id : nil } == step.id
            stepCards[step.id]?.layer?.backgroundColor = (selected ? selectionBackground : NSColor.controlBackgroundColor).cgColor
            stepCards[step.id]?.layer?.borderColor = (running ? NSColor.systemGreen : NSColor.separatorColor).cgColor
        }
        refreshLogs()
    }

    private func refreshLogs() {
        guard let logText else { return }
        let entries = controller.log.entries
        guard entries.count != renderedLogCount || entries.last?.timestamp != lastLogTimestamp else { return }
        renderedLogCount = entries.count; lastLogTimestamp = entries.last?.timestamp
        let formatter = DateFormatter(); formatter.dateFormat = "HH:mm:ss"
        logText.string = entries.reversed().map { entry in
            let item = entry.itemID.flatMap { id in draft.items.first { $0.id == id }?.name } ?? "计划"
            let step = entry.step.map { " · 步骤 \($0 + 1)" } ?? ""
            let detail = entry.details.keys.sorted().map { "\($0)=\(entry.details[$0] ?? "")" }.joined(separator: " · ")
            return "\(formatter.string(from: entry.timestamp))  [\(entry.level)]  \(item)\(step)\n\(entry.event)\(detail.isEmpty ? "" : " · " + detail)"
        }.joined(separator: "\n\n")
        if entries.isEmpty { logText.string = "暂无运行记录。开始计划后会自动记录关键事件。" }
    }

    private func commitEditing() { view.window?.makeFirstResponder(nil) }

    @discardableResult private func saveDraft() -> Bool {
        guard !saving else { return false }
        saving = true; defer { saving = false }
        do {
            try controller.saveLibrary(draft)
            draft = controller.library; dirty = false
            showMessage(controller.runtime.isActive ? "配置已保存，当前计划继续使用启动时快照，下次开始生效。" : "配置已保存；保存不会启动或切换预览。")
            refreshRuntime(); return true
        } catch {
            dirty = true; showMessage(error.localizedDescription, error: true); refreshRuntime(); return false
        }
    }

    private func editLibrary(_ edit: (inout ProtoPiePlaybackLibrary) -> Void) {
        edit(&draft); dirty = true; _ = saveDraft()
    }

    private func editItem(_ id: UUID, _ edit: (inout ProtoPiePlaylistItem) -> Void) {
        guard let index = draft.items.firstIndex(where: { $0.id == id }) else { return }
        edit(&draft.items[index]); dirty = true; _ = saveDraft()
    }

    private func editStep(itemID: UUID, stepID: UUID, initialization: Bool, _ edit: (inout ProtoPieScriptStep) -> Void) {
        editItem(itemID) { item in
            if initialization {
                if let index = item.script.initialization.firstIndex(where: { $0.id == stepID }) { edit(&item.script.initialization[index]) }
            } else if let index = item.script.steps.firstIndex(where: { $0.id == stepID }) { edit(&item.script.steps[index]) }
        }
    }

    private func selectItem(_ id: UUID) {
        commitEditing(); draft.selectedItemID = id; dirty = true; _ = saveDraft()
        selectedStepID = nil; renderSidebar(); renderContent()
    }

    private func addItem() {
        commitEditing()
        var item = ProtoPiePlaylistItem(); item.enabled = false
        item.name = "新演示 \(draft.items.count + 1)"
        draft.items.append(item); draft.selectedItemID = item.id; dirty = true
        _ = saveDraft(); selectedStepID = nil; renderSidebar(); renderContent()
        showMessage("已添加未启用的来源。填写云端链接后勾选启用。")
    }

    private func duplicateItem() {
        commitEditing(); guard var copy = selectedItem else { return }
        copy.id = UUID(); copy.name += " 副本"
        copy.script.initialization = copy.script.initialization.map { var s = $0; s.id = UUID(); return s }
        copy.script.steps = copy.script.steps.map { var s = $0; s.id = UUID(); return s }
        draft.items.append(copy); draft.selectedItemID = copy.id; dirty = true
        _ = saveDraft(); renderSidebar(); renderContent()
    }

    private func deleteItem() {
        commitEditing(); guard let item = selectedItem, let index = draft.items.firstIndex(where: { $0.id == item.id }) else { return }
        deletedItem = (item, index); draft.items.remove(at: index)
        draft.selectedItemID = draft.items.isEmpty ? nil : draft.items[min(index, draft.items.count - 1)].id
        dirty = true; _ = saveDraft(); renderSidebar(); renderContent()
        showMessage("已从列表删除「\(item.name)」，可点左侧「撤销删除」。正在运行的快照不受影响。")
    }

    private func undoDelete() {
        guard let (item, index) = deletedItem else { return }
        draft.items.insert(item, at: min(index, draft.items.count)); draft.selectedItemID = item.id
        deletedItem = nil; dirty = true; _ = saveDraft(); renderSidebar(); renderContent()
    }

    private func moveItem(_ offset: Int) {
        commitEditing(); guard let item = selectedItem, let index = draft.items.firstIndex(where: { $0.id == item.id }),
              draft.items.indices.contains(index + offset) else { return }
        draft.items.swapAt(index, index + offset); dirty = true; _ = saveDraft(); renderSidebar()
    }

    private func addStep() {
        guard let item = selectedItem else { return }; commitEditing()
        let step = ProtoPieScriptStep(); selectedStepID = step.id
        editItem(item.id) { if initializationSelected { $0.script.initialization.append(step) } else { $0.script.steps.append(step) } }
        renderContent()
    }

    private func addKeypadExample() {
        guard let item = selectedItem else { return }; commitEditing()
        let steps = [2, 0, 1, 2, 3, 4].map { key -> ProtoPieScriptStep in
            var step = ProtoPieScriptStep(); step.key = "Numpad\(key)"; return step
        }
        editItem(item.id) { if initializationSelected { $0.script.initialization += steps } else { $0.script.steps += steps } }
        selectedStepID = steps.first?.id; renderContent()
    }

    private func deleteStep(_ id: UUID) {
        guard let item = selectedItem else { return }; commitEditing()
        editItem(item.id) { if initializationSelected { $0.script.initialization.removeAll { $0.id == id } } else { $0.script.steps.removeAll { $0.id == id } } }
        if selectedStepID == id { selectedStepID = nil }; renderContent()
    }

    private func moveStep(_ id: UUID, by offset: Int) {
        guard let item = selectedItem else { return }; commitEditing()
        editItem(item.id) {
            if initializationSelected, let index = $0.script.initialization.firstIndex(where: { $0.id == id }), $0.script.initialization.indices.contains(index + offset) {
                $0.script.initialization.swapAt(index, index + offset)
            } else if !initializationSelected, let index = $0.script.steps.firstIndex(where: { $0.id == id }), $0.script.steps.indices.contains(index + offset) {
                $0.script.steps.swapAt(index, index + offset)
            }
        }
        renderContent()
    }

    private func performSaved(_ operation: (ProtoPiePlaybackController) -> Void) {
        commitEditing(); guard saveDraft() else { return }; operation(controller)
    }

    private func toggleRun() {
        if controller.runtime.state == .paused { controller.resume() }
        else if controller.runtime.isActive { controller.pause() }
        else { performSaved { $0.start() } }
    }

    private func tryScript(single: Bool) {
        guard !initializationSelected else { return }
        let index = selectedItem?.script.steps.firstIndex { $0.id == selectedStepID }
        performSaved { $0.tryScript(singleStep: single, stepIndex: single ? index : nil) }
    }

    private func exportLogs() {
        guard exportTask == nil else { return }
        let save = NSSavePanel()
        save.title = "导出 ProtoPie 自动演示日志"
        save.nameFieldStringValue = "NIO-Warp-播放诊断.zip"
        save.canCreateDirectories = true
        let completion: (NSApplication.ModalResponse) -> Void = { [weak self, weak save] response in
            guard let self, response == .OK, let url = save?.url else { return }
            self.exportTask = Task { @MainActor [weak self] in
                guard let self else { return }
                defer { self.exportTask = nil }
                do { try await self.controller.log.export(to: url); if !self.disconnected { self.showMessage("日志已导出至 \(url.lastPathComponent)。") } }
                catch { if !self.disconnected { self.showMessage("导出失败：\(error.localizedDescription)", error: true) } }
            }
        }
        if let window = view.window { save.beginSheetModal(for: window, completionHandler: completion) }
        else { save.begin(completionHandler: completion) }
    }

    private func durationFields(seconds: Double, prefix: String, onChange: @escaping (Double) -> Void) -> NSView {
        let total = max(0, Int(seconds.isFinite ? min(seconds, 31_536_000) : 0))
        var hours = total / 3600, minutes = (total % 3600) / 60, remainder = total % 60
        return horizontal([
            field("小时", integer(hours, id: "\(prefix)-hours", range: 0...8760) { value in hours = value; onChange(Double(hours * 3600 + minutes * 60 + remainder)) }),
            field("分钟", integer(minutes, id: "\(prefix)-minutes", range: 0...59) { value in minutes = value; onChange(Double(hours * 3600 + minutes * 60 + remainder)) }),
            field("秒", integer(remainder, id: "\(prefix)-seconds", range: 0...59) { value in remainder = value; onChange(Double(hours * 3600 + minutes * 60 + remainder)) })
        ])
    }

    static func durationText(_ value: Double) -> String {
        guard value.isFinite else { return "—" }
        let whole = max(0, Int(min(value.rounded(.up), Double(Int.max / 2))))
        return whole >= 3600 ? String(format: "%02d:%02d:%02d", whole / 3600, whole / 60 % 60, whole % 60)
                            : String(format: "%02d:%02d", whole / 60, whole % 60)
    }

    private func showMessage(_ value: String, error: Bool = false) {
        message.stringValue = value; message.textColor = error ? .systemRed : .secondaryLabelColor
    }
    private func add(_ child: NSView, to target: NSStackView? = nil) {
        let stack = target ?? content; stack.addArrangedSubview(child)
        child.translatesAutoresizingMaskIntoConstraints = false
        child.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
    }
    private func clear(_ stack: NSStackView) { for child in stack.arrangedSubviews { stack.removeArrangedSubview(child); child.removeFromSuperview() } }
    private func configure(_ stack: NSStackView) { stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 10 }
    private func vertical(spacing: CGFloat = 10) -> NSStackView { let s = NSStackView(); configure(s); s.spacing = spacing; return s }
    private func horizontal(_ children: [NSView], spacing: CGFloat = 9) -> NSStackView {
        let stack = NSStackView(views: children); stack.orientation = .horizontal; stack.alignment = .centerY; stack.spacing = spacing
        return stack
    }
    private func constrainWidth(_ stack: NSStackView) {
        for child in stack.arrangedSubviews {
            child.translatesAutoresizingMaskIntoConstraints = false
            child.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -stack.edgeInsets.left - stack.edgeInsets.right).isActive = true
        }
    }
    private func scroll(_ stack: NSStackView) -> NSScrollView {
        let scroll = NSScrollView(); scroll.hasVerticalScroller = true; scroll.hasHorizontalScroller = false
        scroll.autohidesScrollers = true; scroll.drawsBackground = false; scroll.scrollerStyle = .overlay
        let document = PBPlaybackDocument(); document.translatesAutoresizingMaskIntoConstraints = false
        stack.translatesAutoresizingMaskIntoConstraints = false
        document.addSubview(stack); scroll.documentView = document
        NSLayoutConstraint.activate([
            document.leadingAnchor.constraint(equalTo: scroll.contentView.leadingAnchor),
            document.topAnchor.constraint(equalTo: scroll.contentView.topAnchor),
            document.widthAnchor.constraint(equalTo: scroll.contentView.widthAnchor),
            stack.leadingAnchor.constraint(equalTo: document.leadingAnchor), stack.topAnchor.constraint(equalTo: document.topAnchor),
            stack.widthAnchor.constraint(equalTo: document.widthAnchor), document.bottomAnchor.constraint(equalTo: stack.bottomAnchor)
        ])
        scroll.setContentHuggingPriority(.defaultLow, for: .vertical)
        return scroll
    }
    private func label(_ text: String, small: Bool = false) -> NSTextField {
        let label = NSTextField(labelWithString: text); label.font = .systemFont(ofSize: small ? 10 : 12)
        label.lineBreakMode = .byTruncatingTail; label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        if small { label.textColor = .secondaryLabelColor }; return label
    }
    private func title(_ text: String) -> NSTextField { let label = label(text); label.font = .systemFont(ofSize: 12, weight: .semibold); return label }
    private func note(_ text: String) -> NSTextField {
        let result = NSTextField(wrappingLabelWithString: text); result.font = .systemFont(ofSize: 11); result.textColor = .secondaryLabelColor
        result.setContentCompressionResistancePriority(.defaultLow, for: .horizontal); return result
    }
    private func field(_ title: String, _ editor: NSView) -> NSView {
        let group = vertical(spacing: 4); group.addArrangedSubview(label(title, small: true)); group.addArrangedSubview(editor)
        constrainWidth(group); group.setContentHuggingPriority(.defaultLow, for: .horizontal)
        return group
    }
    private func spacer() -> NSView {
        let view = NSView(); view.setContentHuggingPriority(.init(1), for: .horizontal)
        view.setContentCompressionResistancePriority(.init(1), for: .horizontal); return view
    }
    private func separator() -> NSView { let box = NSBox(); box.boxType = .separator; return box }
    private func button(_ title: String, id: String, action: @escaping () -> Void) -> PBPlaybackButton {
        let button = PBPlaybackButton(title: title, action: action); button.setAccessibilityIdentifier("nio-playback-\(id)")
        button.font = .systemFont(ofSize: 11); return button
    }
    private func check(_ title: String, value: Bool, id: String, action: @escaping (Bool) -> Void) -> PBPlaybackButton {
        let result = PBPlaybackButton(title: title, action: {})
        result.setButtonType(.switch); result.state = value ? .on : .off; result.font = .systemFont(ofSize: 12)
        result.setAccessibilityIdentifier("nio-playback-\(id)")
        result.onAction = { [weak result] in action(result?.state == .on) }; return result
    }
    private func text(_ value: String, id: String, action: @escaping (String) -> Void) -> PBPlaybackTextField {
        let field = PBPlaybackTextField(value: value, onCommit: action)
        field.setAccessibilityIdentifier("nio-playback-\(id)"); field.font = .systemFont(ofSize: 12)
        field.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        field.setContentHuggingPriority(.defaultLow, for: .horizontal); return field
    }
    private func number(_ value: Double, id: String, range: ClosedRange<Double>, action: @escaping (Double) -> Void) -> PBPlaybackTextField {
        let field = text(String(format: "%.8g", value), id: id) { text in
            if let number = Double(text) { action(number) }
        }
        field.validate = { [weak self] text in
            guard let number = Double(text), number.isFinite, range.contains(number) else {
                self?.showMessage("请输入 \(range.lowerBound) 至 \(range.upperBound) 之间的有效数值，已恢复原值。", error: true); return false
            }
            return true
        }
        field.widthAnchor.constraint(greaterThanOrEqualToConstant: 64).isActive = true
        return field
    }
    private func integer(_ value: Int, id: String, range: ClosedRange<Int>, action: @escaping (Int) -> Void) -> PBPlaybackTextField {
        let field = text(String(value), id: id) { text in if let number = Int(text) { action(number) } }
        field.validate = { [weak self] text in
            guard let number = Int(text), range.contains(number) else {
                self?.showMessage("请输入 \(range.lowerBound) 至 \(range.upperBound) 之间的整数，已恢复原值。", error: true); return false
            }
            return true
        }
        field.widthAnchor.constraint(greaterThanOrEqualToConstant: 64).isActive = true
        return field
    }
    private func popup(_ labels: [String], selected: Int, id: String, action: @escaping (Int) -> Void) -> PBPlaybackPopup {
        let result = PBPlaybackPopup(); result.addItems(withTitles: labels); result.selectItem(at: selected)
        result.font = .systemFont(ofSize: 11); result.setAccessibilityIdentifier("nio-playback-\(id)")
        result.onAction = { [weak result] in if let index = result?.indexOfSelectedItem { action(index) } }
        result.setContentCompressionResistancePriority(.defaultLow, for: .horizontal); return result
    }
}

@MainActor private final class PBPlaybackDocument: NSView { override var isFlipped: Bool { true } }

@MainActor private final class PBPlaybackButton: NSButton {
    var onAction: () -> Void
    init(title: String, action: @escaping () -> Void) {
        onAction = action; super.init(frame: .zero); self.title = title
        bezelStyle = .rounded; target = self; self.action = #selector(activate)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    @objc private func activate() { onAction() }
}

@MainActor private final class PBPlaybackPopup: NSPopUpButton {
    var onAction: (() -> Void)?
    init() { super.init(frame: .zero, pullsDown: false); target = self; action = #selector(activate) }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    @objc private func activate() { onAction?() }
}

@MainActor private final class PBPlaybackSegment: NSSegmentedControl {
    var onAction: (() -> Void)?
    init(labels: [String]) {
        super.init(frame: .zero); segmentCount = labels.count; trackingMode = .selectOne; segmentStyle = .rounded
        for (index, label) in labels.enumerated() { setLabel(label, forSegment: index) }
        target = self; action = #selector(activate)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    @objc private func activate() { onAction?() }
}

@MainActor private final class PBPlaybackTextField: NSTextField, NSTextFieldDelegate {
    var validate: ((String) -> Bool)?
    private var lastCommitted: String
    private let onCommit: (String) -> Void
    init(value: String, onCommit: @escaping (String) -> Void) {
        lastCommitted = value; self.onCommit = onCommit
        super.init(frame: .zero); stringValue = value; delegate = self
        target = self; action = #selector(commit)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    func controlTextDidEndEditing(_ obj: Notification) { commit() }
    @objc private func commit() {
        guard stringValue != lastCommitted else { return }
        let normalized = stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard validate?(normalized) != false else { stringValue = lastCommitted; return }
        lastCommitted = normalized; stringValue = normalized; onCommit(normalized)
    }
}
