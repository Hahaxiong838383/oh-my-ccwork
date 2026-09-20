import AppKit
import Foundation

struct MouseMappingOutput {
    let window: NSWindow
    let cursor: MouseCursorOverlay
    let displayID: CGDirectDisplayID
    let frame: MouseMappingRenderFrame
    let setInputEnabled: (Bool) -> Void
}

struct MouseCursorPageIdentity: Equatable {
    let targetID: String
    let processID: pid_t
    let timeOrigin: Double
    init(_ viewport: MouseInputViewport) {
        targetID = viewport.targetID; processID = viewport.processID; timeOrigin = viewport.timeOrigin
    }
}

/// A handoff may wait for a browser acknowledgement while physical input keeps
/// arriving. Keep focus-loss releases in order with the actual input; never drop
/// a trailing mouse/key up to fit a bounded queue.
struct MouseAutomationHandoffBuffer {
    enum Event { case mouse(MouseCaptureEvent), keyboard(MouseKeyboardInput), leftSurface }
    static let capacity = 256
    private(set) var events: [Event] = []
    mutating func append(_ event: Event) -> Bool {
        guard events.count < Self.capacity else { return false }
        events.append(event); return true
    }
    mutating func drain() -> [Event] {
        let result = events; events.removeAll(keepingCapacity: true); return result
    }
    mutating func reset() { events.removeAll(keepingCapacity: true) }
}

@MainActor final class MouseMappingController {
    var outputProvider: (() -> MouseMappingOutput?)?
    var outputDiagnosticProvider: (() -> [String: Any])?
    var sessionProvider: (() -> ProtoPieSession?)?
    var onReturnToWorkbench: (() -> Void)?
    var onPresentationTick: (() -> Void)?
    var onAutomationUserActivity: (() -> Void)?
    var onAutomationFailure: ((String) -> Void)?
    var onAutomationExit: (() -> Void)?
    var onPickedPoint: ((Double, Double) -> Void)?
    private(set) var automationOwnsInput = false
    private var automationGeneration = UUID()
    private var handoffTask: Task<Void, Never>?
    private typealias PendingHumanInput = MouseAutomationHandoffBuffer.Event
    private var pendingHumanInputs = MouseAutomationHandoffBuffer()
    private(set) var isActive = false
    private(set) var settings: MouseMappingSettings
    private let defaults: UserDefaults
    private let input = NativeMouseInputCapture()
    private let panels = NSHashTable<MouseMappingPanel>.weakObjects()
    private var transport: MouseInputTransport?
    private var viewport: MouseInputViewport?
    private var output: MouseMappingOutput?
    private var region: MouseMappingRegion?
    private var sessionID: UUID?
    private var sourceUV = SIMD2<Float>(0.5, 0.5)
    private var buttons = 0
    private var startTask: Task<Void, Never>?
    private var closingTask: Task<Void, Never>?
    private var timer: Timer?
    private var presentationTimer: Timer?
    private var armedOutput: MouseMappingOutput?
    private var outputOwned = false
    private var cursorTask: Task<Void, Never>?
    private var cursorRefreshNeeded = false
    private var cursorIdentifier = ""
    private var cursorHidden = false
    private var cursorVisibility = CursorIdleVisibilityPolicy()
    private var cursorRevision: UInt64 = 0
    private var cursorRetryAfter: TimeInterval = 0
    private var lastVerifiedCursor: (page: MouseCursorPageIdentity, style: ProtoPieCursorStyle)?
    private var cursorWarning: String?
    private var generation = UUID()
    private var message = "先启动 ProtoPie 全屏预览，再进入演示鼠标控制。"
    private var lastPublication: TimeInterval = 0
    private var attemptedCapture: [String: Any]?
    private var movementEventCount = 0
    private var lastRawMovement: [Double]?

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        settings = MouseMappingSettings.load(defaults: defaults)
        input.onEvent = { [weak self] event in self?.receive(event) }
        input.onPointerActivity = { [weak self] event in
            guard let self, self.isActive, self.outputOwned else { return }
            // Includes the first real hardware move even when movement priming
            // suppresses its delta. Never consumes the click that wakes us.
            if self.automationOwnsInput { self.beginHumanHandoff() }
            self.cursorVisibility.receiveMouse(event, now: ProcessInfo.processInfo.systemUptime)
            self.reconcileCursorVisibility()
        }
        input.onKeyboardEvent = { [weak self] event in self?.receiveKeyboard(event) }
        input.onCursorScopeChange = { [weak self] owned in
            guard let self else { return }
            self.cursorVisibility.setScope(owned: owned && self.isActive && self.outputOwned,
                now: ProcessInfo.processInfo.systemUptime)
            self.reconcileCursorVisibility()
        }
        input.onEnter = { [weak self] point, allowSnap in self?.adoptNativeCursor(at: point, allowSnap: allowSnap) ?? false }
        input.onLeave = { [weak self] in
            guard let self else { return }
            if self.automationOwnsInput || self.handoffTask != nil {
                self.beginHumanHandoff(.leftSurface)
            } else { self.releaseButtons() }
            self.cursorRevision &+= 1
            self.restoreCursorPresentation()
        }
        input.onExit = { [weak self] reason, returnToWorkbench in self?.stop(reason: reason, returnToWorkbench: returnToWorkbench) }
    }

    func makePanel() -> MouseMappingPanel {
        let panel = MouseMappingPanel(settings: settings)
        panels.add(panel)
        panel.onStart = { [weak self] in self?.start() }
        panel.onStop = { [weak self] in self?.stop(reason: "已返回普通鼠标。", returnToWorkbench: true) }
        panel.onSettingsChange = { [weak self] value in
            guard let self, !self.isActive, self.startTask == nil else { return }
            self.settings = value.sanitized(); self.settings.save(defaults: self.defaults)
            self.panels.allObjects.forEach { $0.load(self.settings) }
            self.publish(force: true)
        }
        publish(force: true)
        return panel
    }

    /// Arm only a verified independent presentation, without taking focus from
    /// the workbench. The first click focuses; subsequent clicks reach the page.
    func monitorPresentation() {
        guard presentationTimer == nil else { return }
        presentationTimer = Timer.scheduledTimer(withTimeInterval: 0.3, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.onPresentationTick?()
                self?.refreshPresentationInput()
            }
        }
    }

    private func refreshPresentationInput() {
        guard !isActive, startTask == nil else { return }
        guard let session = sessionProvider?(), let current = outputProvider?(),
              session.configuration.source == .cloud,
              let sourceID = session.presentationDisplayID, sourceID != current.displayID,
              (try? Self.validate(current, session: session)) != nil else {
            disarmPresentationInput(); return
        }
        if armedOutput?.window !== current.window { disarmPresentationInput() }
        armedOutput = current
        current.cursor.onActivate = { [weak self] in self?.start() }
        current.setInputEnabled(true)
    }

    private func disarmPresentationInput() {
        armedOutput?.cursor.onActivate = nil
        armedOutput?.cursor.sourceCursor = nil
        armedOutput?.setInputEnabled(false)
        armedOutput = nil
    }

    func start(automatic: Bool = false) {
        guard !isActive, startTask == nil else { return }
        if !automatic { onAutomationUserActivity?() }
        // Keep the clicked output surface until its activation gesture ends;
        // dropping hit testing here could leak its mouse-up to the desktop.
        armedOutput?.cursor.onActivate = nil
        let token = UUID(); generation = token
        message = "正在核对全屏来源、捕获尺寸和可点击边界…"
        startTask = Task { @MainActor [weak self] in
            guard let self else { return }
            await self.closingTask?.value
            guard self.generation == token, !Task.isCancelled else { return }
            let transport = MouseInputTransport()
            self.transport = transport
            transport.onFailure = { [weak self] error in
                guard self?.generation == token else { return }
                self?.stop(reason: error.localizedDescription, returnToWorkbench: true)
            }
            do {
                guard let session = self.sessionProvider?(), let initial = self.outputProvider?() else {
                    throw MouseCaptureError("请先启动并接通 ProtoPie Cloud 全屏预览；标定图、暂停或普通桌面不接管输入。")
                }
                let f = initial.frame
                func rect(_ value: CGRect?) -> [Double] { value.map { [Double($0.minX), Double($0.minY), Double($0.width), Double($0.height)] } ?? [] }
                self.attemptedCapture = ["texture": [f.sourceWidth, f.sourceHeight], "windowSize": [f.source.windowSize.width, f.source.windowSize.height],
                    "pointPixelScale": f.source.pointPixelScale, "contentRect": rect(f.metadata.contentRect), "scaleFactor": f.metadata.scaleFactor,
                    "contentScale": f.metadata.contentScale, "screenRect": rect(f.metadata.screenRect), "boundingRect": rect(f.metadata.boundingRect)]
                try Self.validate(initial, session: session)
                let viewport = try await transport.connect(session: session)
                try Task.checkCancellation()
                guard self.generation == token, let current = self.outputProvider?(),
                      self.sessionProvider?()?.id == session.id, Self.sameBinding(initial, current) else {
                    throw MouseCaptureError("准备期间画面或来源发生变化，请在稳定后重新进入。")
                }
                try Self.validate(current, session: session, viewport: viewport)
                // Immutable mapping is built from the same completed render frame.
                let frame = current.frame
                let region = MouseMappingRegion(mesh: frame.mesh, configuration: frame.configuration,
                    sourceWidth: frame.sourceWidth, sourceHeight: frame.sourceHeight)
                guard region.isValid, let start = region.nearestVisibleSourceUV(to: self.sourceUV) else {
                    throw MouseCaptureError("当前画面没有可用的可点击区域。")
                }
                self.region = region; self.output = current; self.viewport = viewport
                if self.lastVerifiedCursor?.page != MouseCursorPageIdentity(viewport) { self.lastVerifiedCursor = nil }
                self.cursorRetryAfter = 0; self.cursorWarning = nil; self.cursorRevision &+= 1
                if armedOutput?.window !== current.window { disarmPresentationInput() }
                else { armedOutput = nil }
                self.outputOwned = session.presentationDisplayID.map { $0 != current.displayID } ?? false
                self.sessionID = session.id; self.sourceUV = start; self.buttons = 0
                self.movementEventCount = 0; self.lastRawMovement = nil
                current.setInputEnabled(self.outputOwned)
                current.cursor.physicalPoint = nil
                // The legacy same-screen path leaves Chrome in charge of input.
                // Independent sources bridge their original CSS system cursor
                // to the physical output, which owns real mouse focus instead.
                if self.outputOwned {
                    try await transport.setPageFocusEmulation(true)
                } else {
                    NSRunningApplication(processIdentifier: session.processID)?.activate(options: [])
                    try await transport.activateBoundTarget()
                }
                try await Task.sleep(nanoseconds: 120_000_000)
                try Task.checkCancellation()
                guard self.generation == token, let latest = self.outputProvider?(),
                      Self.sameBinding(current, latest), self.sessionProvider?()?.id == session.id else {
                    throw MouseCaptureError("画面发生变化，已取消输入接管。")
                }
                _ = try await transport.refreshViewport()
                try Task.checkCancellation()
                guard self.generation == token, let confirmed = self.outputProvider?(),
                      Self.sameBinding(current, confirmed), self.sessionProvider?()?.id == session.id else { throw CancellationError() }
                if self.outputOwned {
                    NSApp.activate(ignoringOtherApps: true)
                    current.window.makeKeyAndOrderFront(nil)
                    // Activation crosses from Chrome to this accessory app. The
                    // key-window notification arrives on a later run-loop turn.
                    for _ in 0..<12 {
                        if current.window.isKeyWindow,
                           NSWorkspace.shared.frontmostApplication?.processIdentifier == ProcessInfo.processInfo.processIdentifier { break }
                        try await Task.sleep(nanoseconds: 50_000_000)
                        try Task.checkCancellation()
                        guard self.generation == token, self.sessionProvider?()?.id == session.id,
                              let latest = self.outputProvider?(), Self.sameBinding(current, latest) else { throw CancellationError() }
                        current.window.makeKeyAndOrderFront(nil)
                    }
                    guard current.window.isKeyWindow,
                          NSWorkspace.shared.frontmostApplication?.processIdentifier == ProcessInfo.processInfo.processIdentifier else {
                        throw MouseCaptureError("演示输出尚未取得鼠标焦点，请再次点击画面。")
                    }
                }
                let outputWindow = CGWindowID(current.window.windowNumber)
                try self.input.begin(displayID: current.displayID,
                    processID: self.outputOwned ? ProcessInfo.processInfo.processIdentifier : session.processID,
                    targetWindow: self.outputOwned ? outputWindow : session.windowID,
                    outputWindow: outputWindow, outputOwned: self.outputOwned)
                self.isActive = true; self.startTask = nil
                self.input.adoptCurrentCursorIfInside()
                if self.outputOwned, self.input.engaged, let saved = self.lastVerifiedCursor {
                    self.applyOriginalCursor(saved.style)
                }
                self.refreshOriginalCursor()
                let direction = self.settings.reverseHorizontal ? "左右反向：开" : "左右反向：关"
                self.message = self.settings.previewOnly ? "原圆形鼠标校正 · \(direction) · 仅检查移动 · Esc 暂停" : "原圆形鼠标校正 · \(direction) · 点击已接通 · Esc 暂停"
                self.timer = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { [weak self] _ in
                    MainActor.assumeIsolated { self?.checkBinding() }
                }
                self.publish(force: true)
            } catch {
                if self.generation == token { self.stop(reason: error.localizedDescription, returnToWorkbench: true) }
                else { await transport.releaseAllAndClose() }
            }
        }
        publish(force: true)
    }

    /// Restore system input synchronously, before waiting for any network release.
    func stop(reason: String = "已返回普通鼠标。", returnToWorkbench: Bool = false) {
        let wasAutomation = automationOwnsInput
        let wasHandoff = handoffTask != nil
        onPickedPoint = nil
        automationOwnsInput = false; automationGeneration = UUID()
        handoffTask?.cancel(); handoffTask = nil; pendingHumanInputs.reset()
        let hadSession = isActive || startTask != nil || transport != nil
        if hadSession { recordStop(reason: reason, returnToWorkbench: returnToWorkbench) }
        generation = UUID()
        startTask?.cancel(); startTask = nil
        timer?.invalidate(); timer = nil
        cursorTask?.cancel(); cursorTask = nil; cursorRefreshNeeded = false
        disarmPresentationInput()
        // Handoff-buffered downs may never have reached Chrome. Do not forward
        // Native capture's cleanup key-ups for those discarded downs. The old
        // transport still releases every input it actually sent below.
        if wasHandoff { isActive = false }
        input.stop(); isActive = false; buttons = 0
        output?.cursor.physicalPoint = nil
        restoreCursorPresentation()
        output?.setInputEnabled(false)
        if outputOwned { NSCursor.arrow.set() }
        outputOwned = false; cursorIdentifier = ""
        let oldTransport = transport
        oldTransport?.onFailure = nil
        transport = nil; viewport = nil; region = nil; output = nil; sessionID = nil
        // Workbench recovery can call stop again after a failure. Preserve the
        // first cause instead of replacing it with the ordinary idle message.
        if hadSession || reason != "已返回普通鼠标。" { message = reason }
        publish(force: true)
        if let oldTransport { closingTask = Task { await oldTransport.releaseAllAndClose() } }
        if wasAutomation, returnToWorkbench {
            if reason.contains("Esc") { onAutomationExit?(); onReturnToWorkbench?() }
            else { onAutomationFailure?(reason) }
        } else if returnToWorkbench { onReturnToWorkbench?() }
    }

    func finishClosing() async { await closingTask?.value }

    func pickAutomationPoint(_ callback: @escaping (Double, Double) -> Void) async {
        stop(reason: "正在准备脚本取点。")
        let token = generation
        await finishClosing()
        guard generation == token, !Task.isCancelled else { return }
        onPickedPoint = callback
        start()
    }

    func beginAutomation() async throws {
        if automationOwnsInput, isActive, transport?.isConnected == true { return }
        stop(reason: "正在准备自动演示输入。")
        await finishClosing()
        try Task.checkCancellation()
        guard !settings.previewOnly else { throw MouseCaptureError("请在鼠标映射中关闭“仅检查移动”，再运行自动脚本。") }
        let token = UUID(); automationGeneration = token; automationOwnsInput = true
        start(automatic: true)
        for _ in 0..<200 {
            try Task.checkCancellation()
            guard automationOwnsInput, automationGeneration == token else { throw MouseCaptureError(message) }
            if isActive, transport?.isConnected == true { return }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        stop(reason: "自动演示输入连接超时。")
        throw MouseCaptureError("自动演示输入未就绪，请检查辅助功能权限与预览。")
    }

    func releaseAutomationInput() async {
        if let handoffTask { await handoffTask.value; return }
        guard automationOwnsInput else { return }
        stop(reason: "自动演示输入已释放。")
        await finishClosing()
    }

    var automationDiagnostic: [String: String] {
        var result = ["inputConnected": String(transport?.isConnected == true),
            "inputOwner": automationOwnsInput ? "automatic" : isActive ? "human" : "none"]
        if let snapshot = transport?.diagnosticSnapshot {
            if let count = snapshot["queueLength"] { result["inputQueue"] = String(describing: count) }
            if let error = snapshot["lastErrorKind"] { result["inputError"] = String(describing: error) }
        }
        return result
    }

    private func beginHumanHandoff(_ event: PendingHumanInput? = nil) {
        if let event, !pendingHumanInputs.append(event) {
            stop(reason: "人工接管输入积压，已安全释放输入并返回工作台。", returnToWorkbench: true)
            return
        }
        guard handoffTask == nil, automationOwnsInput, let transport else { return }
        automationOwnsInput = false; automationGeneration = UUID()
        let token = generation
        handoffTask = Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                try await transport.releaseHeldInputs()
                guard self.generation == token, !Task.isCancelled, self.isActive else { return }
                self.buttons = 0
                let now = ProcessInfo.processInfo.systemUptime
                self.cursorVisibility.setScope(owned: false, now: now)
                self.cursorVisibility.setScope(owned: self.outputOwned && self.input.engaged, now: now)
                let pending = self.pendingHumanInputs.drain()
                self.handoffTask = nil
                for value in pending {
                    guard self.generation == token, self.isActive else { break }
                    switch value { case .mouse(let mouse):
                        self.cursorVisibility.receiveMouse(mouse, now: now)
                        self.receive(mouse)
                    case .keyboard(let keyboard): self.receiveKeyboard(keyboard)
                    case .leftSurface:
                        // A scope exit consumes the later physical up. Balance
                        // buffered downs here before replaying a re-entry click.
                        self.releaseButtons()
                        self.cursorVisibility.setScope(owned: false, now: now)
                        self.cursorVisibility.setScope(owned: self.outputOwned && self.input.engaged, now: now)
                        self.reconcileCursorVisibility()
                    }
                }
            } catch {
                if self.generation == token { self.stop(reason: "人工接管前输入释放失败，已恢复普通鼠标。", returnToWorkbench: true) }
            }
        }
        onAutomationUserActivity?()
    }

    func performAutomation(_ step: ProtoPieScriptStep) async throws {
        try step.validate()
        guard automationOwnsInput, isActive, let viewport, let transport, let region else {
            throw MouseCaptureError("自动输入所有权已结束。")
        }
        let token = automationGeneration
        func check() throws {
            try Task.checkCancellation()
            guard automationOwnsInput, automationGeneration == token, isActive,
                  self.transport === transport, transport.isConnected,
                  sessionProvider?()?.id == sessionID else { throw CancellationError() }
        }
        func delay(_ seconds: Double) async throws {
            try check()
            if seconds > 0 { try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000)) }
            try check()
        }
        func key(_ down: Bool) async throws {
            try check()
            guard let input = MouseKeyboardEvent.scriptedInput(code: step.key, down: down),
                  transport.sendKey(MouseKeyboardEvent(viewportID: viewport.bindingID, input: input)) else {
                throw MouseInputTransportError.invalidEvent
            }
            try await transport.flush(); try check()
        }
        let button: MouseInputEvent.Button = step.button == .left ? .left : step.button == .right ? .right : .middle
        func move(_ x: Double, _ y: Double, kind: MouseInputEvent.Kind = .move, count: Int = 1) async throws {
            try check()
            let uv = SIMD2<Float>(Float(x), Float(y))
            guard region.containsSourceUV(uv), let point = viewport.point(forVisibleSourceUV: uv) else {
                throw MouseCaptureError("脚本位置不在当前可见画面内，请重新取点。")
            }
            self.sourceUV = uv
            if kind == .down { self.buttons |= button.mask }
            if kind == .up { self.buttons &= ~button.mask }
            let event = MouseInputEvent(viewportID: viewport.bindingID, kind: kind,
                x: point.x, y: point.y, button: kind == .down || kind == .up ? button : .none,
                buttons: self.buttons, clickCount: count, deltaX: kind == .wheel ? step.deltaX : 0,
                deltaY: kind == .wheel ? step.deltaY : 0)
            guard transport.send(event) else { throw MouseInputTransportError.invalidEvent }
            try await transport.flush(); try check()
            if self.outputOwned, self.input.engaged {
                self.updateCursor(); self.cursorRevision &+= 1
                let activity: MouseCaptureEvent = kind == .down || kind == .up
                    ? .button(down: kind == .down, number: button == .left ? 0 : button == .right ? 1 : 2, clickCount: count, modifiers: 0)
                    : .move(dx: 1, dy: 0, modifiers: 0)
                self.cursorVisibility.receiveMouse(activity, now: ProcessInfo.processInfo.systemUptime)
                self.refreshOriginalCursor(); self.reconcileCursorVisibility()
            }
        }
        switch step.kind {
        case .wait: try await delay(step.duration)
        case .keyPress, .keyHold:
            try await key(true); try await delay(step.kind == .keyHold ? step.duration : 0.05); try await key(false)
        case .mouseMove: try await move(step.x, step.y)
        case .scroll: try await move(step.x, step.y, kind: .wheel)
        case .mouseClick, .mouseDoubleClick, .mouseHold:
            try await move(step.x, step.y)
            for count in 1...(step.kind == .mouseDoubleClick ? 2 : 1) {
                try await move(step.x, step.y, kind: .down, count: count)
                try await delay(step.kind == .mouseHold ? step.duration : 0.05)
                try await move(step.x, step.y, kind: .up, count: count)
                if step.kind == .mouseDoubleClick, count == 1 { try await delay(0.08) }
            }
        case .mouseDrag:
            // Check the whole path before pressing down; never snap to another control.
            let pieces = max(1, min(240, Int(max(0.1, step.duration) * 30)))
            for i in 0...pieces {
                let t = Double(i) / Double(pieces)
                guard region.containsSourceUV(SIMD2(Float(step.x + (step.endX - step.x) * t), Float(step.y + (step.endY - step.y) * t))) else {
                    throw MouseCaptureError("拖动路径超出可见画面，请重新取点。")
                }
            }
            try await move(step.x, step.y); try await move(step.x, step.y, kind: .down)
            for i in 1...pieces {
                try await delay(step.duration / Double(pieces))
                let t = Double(i) / Double(pieces)
                try await move(step.x + (step.endX - step.x) * t, step.y + (step.endY - step.y) * t)
            }
            try await move(step.endX, step.endY, kind: .up)
        }
    }

    private func recordStop(reason: String, returnToWorkbench: Bool) {
        var entry: [String: Any] = ["timestamp": Date().timeIntervalSince1970,
            "reason": reason, "returnToWorkbench": returnToWorkbench,
            "active": isActive, "busy": startTask != nil, "buttons": buttons,
            "nativeEngaged": input.engaged, "outputOwned": outputOwned,
            "cursorIdentifier": cursorIdentifier]
        if let point = CGEvent(source: nil)?.location { entry["actualPointer"] = [point.x, point.y] }
        if let transport { entry["transport"] = transport.diagnosticSnapshot }
        let current = outputProvider?()
        entry["outputState"] = outputDiagnosticProvider?()
        entry["currentOutputAvailable"] = current != nil
        entry["sessionMatches"] = sessionProvider?()?.id == sessionID
        if let output {
            entry["meshRevision"] = output.frame.revision
            if let current {
                entry["binding"] = ["window": output.window === current.window,
                    "display": output.displayID == current.displayID,
                    "revision": output.frame.revision == current.frame.revision,
                    "configuration": output.frame.configuration == current.frame.configuration,
                    "source": output.frame.source == current.frame.source,
                    "size": output.frame.sourceWidth == current.frame.sourceWidth && output.frame.sourceHeight == current.frame.sourceHeight,
                    "metadata": output.frame.metadata.hasSameMapping(as: current.frame.metadata)]
            }
        }
        // A stop may originate in the event tap. Capture only cheap state above;
        // release native input before serializing or writing diagnostic history.
        let defaults = self.defaults
        DispatchQueue.main.async {
            let key = "nioWarpMouseMapping.stops.v1"
            var history = defaults.data(forKey: key).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [[String: Any]] } ?? []
            history.append(entry)
            if let data = try? JSONSerialization.data(withJSONObject: Array(history.suffix(16)), options: [.sortedKeys]) {
                defaults.set(data, forKey: key)
            }
        }
    }

    /// A stable external screen can change its desktop origin during a lid event.
    /// Keep its relative pointer, but end an in-progress gesture on the same page.
    func displayOriginChanged() {
        guard isActive else { return }
        if automationOwnsInput || handoffTask != nil {
            stop(reason: "显示器坐标已变化，需要重新接通自动演示输入。", returnToWorkbench: true)
            return
        }
        releaseButtons()
        input.refreshScope()
        if input.engaged { updateCursor() }
    }

    private func checkBinding() {
        guard isActive, let previous = output, let current = outputProvider?(),
              let session = sessionProvider?(), session.id == sessionID,
              Self.sameBinding(previous, current), transport?.isConnected == true else {
            if isActive { stop(reason: "画面、参数或输入来源发生变化，已恢复普通鼠标；重新进入即可使用最新参数。", returnToWorkbench: true) }
            return
        }
        do { try Self.validate(current, session: session, viewport: viewport) }
        catch { stop(reason: error.localizedDescription, returnToWorkbench: true); return }
        input.refreshScope()
        if outputOwned, !input.engaged { input.adoptCurrentCursorIfInside() }
        refreshCursorVisibility()
        if outputOwned, input.engaged { refreshOriginalCursor() }
        publish(force: false)
    }

    private func adoptNativeCursor(at point: CGPoint, allowSnap: Bool) -> Bool {
        guard isActive, let region, let output else { return false }
        let bounds = CGDisplayBounds(output.displayID)
        let pixel = SIMD2(Float((point.x - bounds.minX) / bounds.width) * region.physicalSize.x,
                          Float((point.y - bounds.minY) / bounds.height) * region.physicalSize.y)
        let visible = allowSnap ? region.nearestVisiblePhysicalPoint(to: pixel) : pixel
        guard let visible, let uv = region.sourceUV(forPhysicalPoint: visible) else { return false }
        sourceUV = uv; cursorRevision &+= 1
        updateCursor()
        // A handoff has already queued its held-input releases. A scope refresh
        // must not inject the controller's old scripted button mask behind them.
        if handoffTask == nil { send(kind: .move) }
        refreshOriginalCursor()
        return isActive
    }

    private func receive(_ event: MouseCaptureEvent) {
        if automationOwnsInput || handoffTask != nil {
            if case .move(let dx, let dy, _) = event, dx == 0, dy == 0 { return }
            beginHumanHandoff(.mouse(event)); return
        }
        guard isActive, let region, let viewport, let output else { return }
        guard let current = outputProvider?(), Self.sameBinding(output, current),
              sessionProvider?()?.id == sessionID, transport?.isConnected == true else {
            stop(reason: "画面或播放器已变化，恢复普通鼠标。")
            return
        }
        switch event {
        case .move(let rawDX, let dy, let modifiers):
            guard rawDX.isFinite, dy.isFinite else { return }
            // These are already compensated deltas. A stationary/priming
            // event must not warp again or enqueue a second browser move.
            guard rawDX != 0 || dy != 0 else { return }
            cursorRevision &+= 1
            movementEventCount += 1
            lastRawMovement = [rawDX, dy]
            // Direction is an explicit input preference, independent of the image
            // mirror and geometry. Apply it once before either coordinate mode.
            let dx = settings.reverseHorizontal ? -rawDX : rawDX
            if settings.mode == .glass {
                let proposed = sourceUV + SIMD2(Float(dx * settings.speed / viewport.cssWidth), Float(dy * settings.speed / viewport.cssHeight))
                sourceUV = region.constrainedSourceMove(from: sourceUV, to: proposed)
            } else if let point = region.physicalPoint(forSourceUV: sourceUV) {
                let delta = SIMD2(Float(dx * settings.speed) * region.physicalSize.x / Float(max(output.window.frame.width, 1)),
                                 Float(dy * settings.speed) * region.physicalSize.y / Float(max(output.window.frame.height, 1)))
                let next = region.constrainedPhysicalMove(from: point, to: point + delta)
                if let uv = region.sourceUV(forPhysicalPoint: next) { sourceUV = uv }
            }
            updateCursor()
            send(kind: .move, modifiers: modifiers)
        case .button(let down, let number, let clickCount, let modifiers):
            if down, number == 0, let callback = onPickedPoint {
                onPickedPoint = nil
                let picked = sourceUV
                stop(reason: "脚本坐标已选取，返回工作台。", returnToWorkbench: true)
                callback(Double(picked.x), Double(picked.y))
                return
            }
            guard !settings.previewOnly else { return }
            let button: MouseInputEvent.Button
            switch number { case 0: button = .left; case 1: button = .right; case 2: button = .middle; default: return }
            guard region.containsSourceUV(sourceUV) else { return }
            if down {
                guard buttons & button.mask == 0 else { return }
                buttons |= button.mask
            } else {
                guard buttons & button.mask != 0 else { return }
                buttons &= ~button.mask
            }
            cursorRevision &+= 1
            send(kind: down ? .down : .up, button: button, clickCount: min(max(clickCount, 1), 2), modifiers: modifiers)
            refreshOriginalCursor()
        case .wheel(let dx, let dy, let modifiers):
            send(kind: .wheel, modifiers: modifiers, deltaX: dx, deltaY: dy)
        }
        // The timer publishes diagnostics outside the event-tap callback.
    }

    private func send(kind: MouseInputEvent.Kind, button: MouseInputEvent.Button = .none,
                      clickCount: Int = 1, modifiers: Int = 0, deltaX: Double = 0, deltaY: Double = 0) {
        guard !settings.previewOnly || kind == .move, let viewport, let transport,
              region?.containsSourceUV(sourceUV) == true,
              let point = viewport.point(forVisibleSourceUV: sourceUV) else { return }
        let event = MouseInputEvent(viewportID: viewport.bindingID, kind: kind,
            x: point.x, y: point.y,
            button: button, buttons: buttons, modifiers: modifiers, clickCount: clickCount, deltaX: deltaX, deltaY: deltaY)
        if !transport.send(event) { stop(reason: "输入会话已失效，已恢复普通鼠标。", returnToWorkbench: true) }
    }

    private func receiveKeyboard(_ event: MouseKeyboardInput) {
        if automationOwnsInput || handoffTask != nil { beginHumanHandoff(.keyboard(event)); return }
        guard isActive, outputOwned, !settings.previewOnly,
              let viewport, let transport else { return }
        // Releases produced on focus loss/stop still belong to the old page.
        // Native capture decides ownership and drains the later physical up.
        if event.kind == .down {
            guard let previous = output, let current = outputProvider?(),
                  Self.sameBinding(previous, current), sessionProvider?()?.id == sessionID else { return }
        }
        if !transport.sendKey(MouseKeyboardEvent(viewportID: viewport.bindingID, input: event)) {
            stop(reason: "键盘输入会话已失效，已恢复普通输入。", returnToWorkbench: true)
        }
    }

    private func releaseButtons() {
        if buttons != 0 { cursorRevision &+= 1 }
        for button in [MouseInputEvent.Button.left, .right, .middle] where buttons & button.mask != 0 {
            buttons &= ~button.mask
            send(kind: .up, button: button)
        }
    }

    private func refreshOriginalCursor() {
        guard isActive, outputOwned, input.engaged, let transport, let viewport,
              ProcessInfo.processInfo.systemUptime >= cursorRetryAfter else { return }
        cursorRefreshNeeded = true
        guard cursorTask == nil else { return }
        let token = generation
        cursorTask = Task { @MainActor [weak self] in
            guard let self else { return }
            defer { if self.generation == token { self.cursorTask = nil } }
            do {
                while self.cursorRefreshNeeded, self.generation == token, self.isActive {
                    self.cursorRefreshNeeded = false
                    let revision = self.cursorRevision
                    // Geometry includes UV edge endpoints; query the same legal
                    // browser point as clicks without shrinking the AA hotspot.
                    guard let point = viewport.point(forVisibleSourceUV: self.sourceUV) else {
                        throw MouseInputTransportError.invalidEvent
                    }
                    let style: ProtoPieCursorStyle
                    do { style = try await transport.cursorStyle(at: point) }
                    catch is ProtoPieCursorArtworkError {
                        guard self.generation == token, !Task.isCancelled, self.isActive else { return }
                        // A superseded pressed request must not delay the newer
                        // released/hover style behind its own retry cooldown.
                        guard self.cursorRevision == revision else {
                            self.cursorRefreshNeeded = true
                            continue
                        }
                        self.cursorWarning = "原光标资源暂不可用，保留原样式并稍后重试。"
                        self.cursorRetryAfter = ProcessInfo.processInfo.systemUptime + 3
                        self.cursorRefreshNeeded = false
                        self.publish(force: true)
                        return
                    }
                    try Task.checkCancellation()
                    guard self.generation == token, self.outputOwned, self.input.engaged,
                          self.input.ownsCurrentSurface() else { return }
                    // The artwork fetch runs outside the input queue. A later
                    // mouse-up/move wins over an old pressed/hover image.
                    guard self.cursorRevision == revision else {
                        self.cursorRefreshNeeded = true
                        continue
                    }
                    // Esc/re-entry must never resurrect an old pressed or
                    // hidden state. Keep only a visible, released original.
                    if self.buttons == 0, !style.isHidden {
                        self.lastVerifiedCursor = (MouseCursorPageIdentity(viewport), style)
                    }
                    self.cursorWarning = nil; self.cursorRetryAfter = 0
                    self.applyOriginalCursor(style)
                }
            } catch {
                if self.generation == token, !Task.isCancelled {
                    self.stop(reason: "无法同步原型鼠标样式，已恢复普通输入。", returnToWorkbench: true)
                }
            }
        }
    }

    private func applyOriginalCursor(_ style: ProtoPieCursorStyle) {
        guard isActive, outputOwned, input.engaged, input.ownsCurrentSurface() else {
            restoreCursorPresentation(); return
        }
        cursorIdentifier = style.identifier
        cursorVisibility.setPageHidden(style.isHidden)
        input.registerCursorImage(style.cursor ?? .arrow)
        output?.cursor.sourceCursor = style.cursor ?? .arrow
        (style.cursor ?? .arrow).set()
        refreshCursorVisibility()
    }

    private func refreshCursorVisibility() {
        let now = ProcessInfo.processInfo.systemUptime
        cursorVisibility.setScope(owned: isActive && outputOwned && input.engaged && input.ownsCurrentSurface(), now: now)
        cursorVisibility.update(now: now, enabled: settings.cursorAutoHideEnabled, delay: settings.cursorAutoHideDelay)
        reconcileCursorVisibility()
    }

    private func reconcileCursorVisibility() {
        let hidden = cursorVisibility.wantsHidden
        guard hidden != cursorHidden else { return }
        if hidden { NSCursor.hide() } else { NSCursor.unhide() }
        cursorHidden = hidden
    }

    private func restoreCursorPresentation() {
        cursorVisibility.setScope(owned: false, now: ProcessInfo.processInfo.systemUptime)
        reconcileCursorVisibility()
        output?.cursor.sourceCursor = nil
    }

    private func updateCursor() {
        guard let output, let region, let physicalAA = region.physicalCursorBounds else { return }
        output.cursor.physicalPoint = nil
        guard let point = region.physicalPoint(forSourceUV: sourceUV) else { return }
        let bounds = CGDisplayBounds(output.displayID)
        let proposed = CGPoint(x: bounds.minX + CGFloat(point.x / region.physicalSize.x) * bounds.width,
                             y: bounds.minY + CGFloat(point.y / region.physicalSize.y) * bounds.height)
        let globalAA = CGRect(x: bounds.minX + physicalAA.minX / CGFloat(region.physicalSize.x) * bounds.width,
                              y: bounds.minY + physicalAA.minY / CGFloat(region.physicalSize.y) * bounds.height,
                              width: physicalAA.width / CGFloat(region.physicalSize.x) * bounds.width,
                              height: physicalAA.height / CGFloat(region.physicalSize.y) * bounds.height)
        guard let global = NativeMouseInputCapture.confinedCursorPoint(proposed, within: globalAA) else {
            stop(reason: "AA 区没有可用的系统指针位置，已恢复普通鼠标。", returnToWorkbench: true)
            return
        }
        if !input.placeCursor(at: global) {
            stop(reason: "无法定位原圆形指针，已恢复普通鼠标。", returnToWorkbench: true)
        }
    }

    private func publish(force: Bool) {
        let now = ProcessInfo.processInfo.systemUptime
        guard force || now - lastPublication >= 0.2 else { return }
        lastPublication = now
        let point = region?.physicalPoint(forSourceUV: sourceUV)
        let detail = point.map { String(format: "外屏热点 %.1f, %.1f px · 全可见边缘 / 0.5 px", $0.x, $0.y) }
        panels.allObjects.forEach { $0.update(active: isActive, busy: startTask != nil, message: message, detail: detail) }
        var diagnostic: [String: Any] = ["active": isActive, "busy": startTask != nil, "message": message,
            "mode": settings.mode.rawValue, "previewOnly": settings.previewOnly, "buttons": buttons,
            "reverseHorizontal": settings.reverseHorizontal, "movementEventCount": movementEventCount,
            "updatedAt": Date().timeIntervalSince1970,
            "pointerKind": outputOwned ? "original-css-system-on-output" : "original-system-css", "nativeEngaged": input.engaged,
            "nativeEventCount": input.eventCount, "overlayVisible": false,
            "sourceUV": [sourceUV.x, sourceUV.y], "edgeInsetPixels": 0.5]
        diagnostic["outputOwned"] = outputOwned
        diagnostic["cursorIdentifier"] = cursorIdentifier
        diagnostic["cursorAutoHideEnabled"] = settings.cursorAutoHideEnabled
        diagnostic["cursorAutoHideDelay"] = settings.cursorAutoHideDelay
        diagnostic["cursorHidden"] = cursorHidden
        diagnostic["cursorIdleHidden"] = cursorVisibility.idleHidden
        diagnostic["cursorPageHidden"] = cursorVisibility.pageHidden
        diagnostic["cursorHeldButtons"] = cursorVisibility.heldButtons
        if let activity = cursorVisibility.lastMouseActivity { diagnostic["cursorIdleSeconds"] = max(0, now - activity) }
        diagnostic["cursorWarning"] = cursorWarning
        if let transport { diagnostic["transport"] = transport.diagnosticSnapshot }
        if isActive { diagnostic["nativeScope"] = input.scopeDiagnostic() }
        if let value = input.lastRawDelta { diagnostic["nativeRawDelta"] = [value.x, value.y] }
        if let value = input.lastCorrectedDelta { diagnostic["nativeCorrectedDelta"] = [value.x, value.y] }
        if let value = input.lastWarpCorrection { diagnostic["nativeWarpCorrection"] = [value.x, value.y] }
        if let placement = input.placement { diagnostic["nativeCursorTarget"] = [placement.x, placement.y] }
        if let current = CGEvent(source: nil)?.location { diagnostic["nativeCursorActual"] = [current.x, current.y] }
        if let attemptedCapture { diagnostic["capture"] = attemptedCapture }
        if let viewport { diagnostic["inputWindowID"] = viewport.windowID; diagnostic["inputBrowserWindowID"] = viewport.browserWindowID; diagnostic["inputProcessID"] = viewport.processID }
        if let lastRawMovement { diagnostic["lastRawMovement"] = lastRawMovement }
        if let point { diagnostic["physicalPoint"] = [point.x, point.y] }
        if let frame = output?.frame {
            diagnostic["meshRevision"] = frame.revision
            diagnostic["sourceSize"] = [frame.sourceWidth, frame.sourceHeight]
            diagnostic["visiblePolygons"] = region?.visiblePolygonCount
        }
        if let data = try? JSONSerialization.data(withJSONObject: diagnostic, options: [.sortedKeys]) {
            defaults.set(data, forKey: "nioWarpMouseMapping.runtime.v1")
        }
    }

    private static func sameBinding(_ first: MouseMappingOutput, _ second: MouseMappingOutput) -> Bool {
        first.window === second.window && first.displayID == second.displayID
            && first.frame.revision == second.frame.revision
            && first.frame.configuration == second.frame.configuration
            && first.frame.source == second.frame.source
            && first.frame.sourceWidth == second.frame.sourceWidth && first.frame.sourceHeight == second.frame.sourceHeight
            && first.frame.metadata.hasSameMapping(as: second.frame.metadata)
    }

    private static func validate(_ output: MouseMappingOutput, session: ProtoPieSession,
                                 viewport: MouseInputViewport? = nil) throws {
        let frame = output.frame
        if let sourceDisplayID = session.presentationDisplayID, sourceDisplayID != output.displayID {
            guard OwnedPresentationDisplay.isOwnedDisplay(sourceDisplayID), CGDisplayIsActive(sourceDisplayID) != 0 else {
                throw MouseCaptureError("独立播放器内容屏已不可用，输入保持关闭。")
            }
        }
        guard output.window.isVisible, CGDisplayIsActive(output.displayID) != 0, CGDisplayIsAsleep(output.displayID) == 0,
              frame.configuration.render.testPattern == .off,
              frame.source.windowID == session.windowID, frame.source.processID == session.processID else {
            throw MouseCaptureError("演示输出与捕获来源不一致，输入保持关闭。")
        }
        guard frame.metadata.coversTexture(width: frame.sourceWidth, height: frame.sourceHeight) else {
            let rect = frame.metadata.contentRect
            throw MouseCaptureError(String(format: "捕获内容未充满输入纹理（%.0f,%.0f / %.0f×%.0f；缩放 %.3f），暂不接管输入。",
                rect.minX, rect.minY, rect.width, rect.height, frame.metadata.contentScale))
        }
        if let viewport {
            guard viewport.windowID == session.windowID, viewport.processID == session.processID,
                  abs(viewport.pixelSize.width - Double(frame.sourceWidth)) <= 1,
                  abs(viewport.pixelSize.height - Double(frame.sourceHeight)) <= 1 else {
                throw MouseCaptureError("网页视口与捕获纹理尺寸未对齐，请恢复无边框全屏后重试。")
            }
        }
    }
}
