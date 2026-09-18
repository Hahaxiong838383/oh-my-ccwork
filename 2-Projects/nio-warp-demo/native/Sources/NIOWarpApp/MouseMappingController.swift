import AppKit
import Foundation

struct MouseMappingOutput {
    let window: NSWindow
    let cursor: MouseCursorOverlay
    let displayID: CGDirectDisplayID
    let frame: MouseMappingRenderFrame
    let setInputEnabled: (Bool) -> Void
}

@MainActor final class MouseMappingController {
    var outputProvider: (() -> MouseMappingOutput?)?
    var sessionProvider: (() -> ProtoPieSession?)?
    var onReturnToWorkbench: (() -> Void)?
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
        input.onEnter = { [weak self] point, allowSnap in self?.adoptNativeCursor(at: point, allowSnap: allowSnap) ?? false }
        input.onLeave = { [weak self] in self?.releaseButtons() }
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

    func start() {
        guard !isActive, startTask == nil else { return }
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
                self.sessionID = session.id; self.sourceUV = start; self.buttons = 0
                self.movementEventCount = 0; self.lastRawMovement = nil
                current.setInputEnabled(false)
                current.cursor.physicalPoint = nil
                // Chrome owns the existing CSS circle; the transparent Warp window
                // must never become key or install a replacement cursor.
                NSRunningApplication(processIdentifier: session.processID)?.activate(options: [])
                try await transport.activateBoundTarget()
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
                try self.input.begin(displayID: current.displayID, processID: session.processID,
                    targetWindow: session.windowID, outputWindow: CGWindowID(current.window.windowNumber))
                self.isActive = true; self.startTask = nil
                self.input.adoptCurrentCursorIfInside()
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
        generation = UUID()
        startTask?.cancel(); startTask = nil
        timer?.invalidate(); timer = nil
        input.stop(); isActive = false; buttons = 0
        output?.cursor.physicalPoint = nil
        output?.setInputEnabled(false)
        let oldTransport = transport
        oldTransport?.onFailure = nil
        transport = nil; viewport = nil; region = nil; output = nil; sessionID = nil
        message = reason
        publish(force: true)
        if let oldTransport { closingTask = Task { await oldTransport.releaseAllAndClose() } }
        if returnToWorkbench { onReturnToWorkbench?() }
    }

    func finishClosing() async { await closingTask?.value }

    /// A stable external screen can change its desktop origin during a lid event.
    /// Keep its relative pointer, but end an in-progress gesture on the same page.
    func displayOriginChanged() {
        guard isActive else { return }
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
        publish(force: false)
    }

    private func adoptNativeCursor(at point: CGPoint, allowSnap: Bool) -> Bool {
        guard isActive, let region, let output else { return false }
        let bounds = CGDisplayBounds(output.displayID)
        let pixel = SIMD2(Float((point.x - bounds.minX) / bounds.width) * region.physicalSize.x,
                          Float((point.y - bounds.minY) / bounds.height) * region.physicalSize.y)
        let visible = allowSnap ? region.nearestVisiblePhysicalPoint(to: pixel) : pixel
        guard let visible, let uv = region.sourceUV(forPhysicalPoint: visible) else { return false }
        sourceUV = uv
        updateCursor()
        send(kind: .move)
        return isActive
    }

    private func receive(_ event: MouseCaptureEvent) {
        guard isActive, let region, let viewport, let output else { return }
        guard let current = outputProvider?(), Self.sameBinding(output, current),
              sessionProvider?()?.id == sessionID, transport?.isConnected == true else {
            stop(reason: "画面或播放器已变化，恢复普通鼠标。")
            return
        }
        switch event {
        case .move(let rawDX, let dy, let modifiers):
            guard rawDX.isFinite, dy.isFinite else { return }
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
            send(kind: down ? .down : .up, button: button, clickCount: min(max(clickCount, 1), 2), modifiers: modifiers)
        case .wheel(let dx, let dy, let modifiers):
            send(kind: .wheel, modifiers: modifiers, deltaX: dx, deltaY: dy)
        }
        // The timer publishes diagnostics outside the event-tap callback.
    }

    private func send(kind: MouseInputEvent.Kind, button: MouseInputEvent.Button = .none,
                      clickCount: Int = 1, modifiers: Int = 0, deltaX: Double = 0, deltaY: Double = 0) {
        guard !settings.previewOnly || kind == .move, let viewport, let transport, region?.containsSourceUV(sourceUV) == true else { return }
        let event = MouseInputEvent(viewportID: viewport.bindingID, kind: kind,
            x: min(max(Double(sourceUV.x) * viewport.cssWidth, 0), viewport.cssWidth.nextDown),
            y: min(max(Double(sourceUV.y) * viewport.cssHeight, 0), viewport.cssHeight.nextDown),
            button: button, buttons: buttons, modifiers: modifiers, clickCount: clickCount, deltaX: deltaX, deltaY: deltaY)
        if !transport.send(event) { stop(reason: "输入会话已失效，已恢复普通鼠标。", returnToWorkbench: true) }
    }

    private func releaseButtons() {
        for button in [MouseInputEvent.Button.left, .right, .middle] where buttons & button.mask != 0 {
            buttons &= ~button.mask
            send(kind: .up, button: button)
        }
    }

    private func updateCursor() {
        guard let output, let region else { return }
        output.cursor.physicalPoint = nil
        guard let point = region.physicalPoint(forSourceUV: sourceUV) else { return }
        let bounds = CGDisplayBounds(output.displayID)
        let global = CGPoint(x: bounds.minX + CGFloat(point.x / region.physicalSize.x) * bounds.width,
                             y: bounds.minY + CGFloat(point.y / region.physicalSize.y) * bounds.height)
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
            "pointerKind": "original-system-css", "nativeEngaged": input.engaged,
            "nativeEventCount": input.eventCount, "overlayVisible": false,
            "sourceUV": [sourceUV.x, sourceUV.y], "edgeInsetPixels": 0.5]
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
            throw MouseCaptureError("完整高度播放器使用独立内容画布；原圆形鼠标映射尚未适配此来源，输入保持关闭。")
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
