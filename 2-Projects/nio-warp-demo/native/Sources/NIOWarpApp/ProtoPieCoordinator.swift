import AppKit
import Foundation

@MainActor final class ProtoPieCoordinator {
    static let savedKey = "nioWarpProtoPie.configuration.v1"
    static let draftKey = "nioWarpProtoPie.draft.v1"
    static let lastSuccessfulKey = "nioWarpProtoPie.lastSuccessful.v1"

    var onCapture: ((CGWindowID, pid_t) async throws -> Void)?
    var onStop: (() -> Void)?
    var onStateChange: ((ProtoPieRuntimeState) -> Void)?
    var onManualControl: (() -> Void)?
    /// The playlist supplies the bounded recovery policy while it owns a run.
    /// Existing single-source behavior is unchanged when false.
    private(set) var playbackManaged = false
    /// Local Studio can reuse a Preview window while changing documents. Hide the output before that change.
    var onSuspendOutput: (() -> Void)?
    var onResumeOutput: (() -> Void)?
    var draft: ProtoPieConfiguration { didSet { persist(draft, key: Self.draftKey); notify() } }
    private(set) var saved: ProtoPieConfiguration
    private(set) var lastSuccessful: ProtoPieConfiguration?
    private(set) var state: ProtoPieRuntimeState = .idle { didSet { notify() } }
    private(set) var activeSession: ProtoPieSession?
    private(set) var targetDisplayID: CGDirectDisplayID?
    private(set) var presentationCanvas: CanvasConfiguration?
    private(set) var notice = ""
    private let defaults: UserDefaults
    private let driver: ProtoPiePreviewDriving
    private var observers: [UUID: () -> Void] = [:]
    private var operation: Task<Void, Never>?
    private var monitor: Task<Void, Never>?
    private var layoutOperation: Task<Void, Never>?
    /// Cancellation alone does not await a driver already crossing an async API.
    /// Keep its completion reachable until the next operation has drained it.
    private var cancellationDrain: Task<Void, Never>?
    private var playbackRequestID: UUID?
    private var playbackInterruptionReason: String?
    private var pendingVerticalPosition: Double?
    private var generation = UUID()
    private var wantsToRun = false
    private var manuallyStopped = false
    private var outputPaused = false
    private var manualPlayerOpen = false
    private var recoveryAttempts = 0
    private var pendingConfiguration: ProtoPieConfiguration?
    private var canvasRebuildPending = false
    private let monitoringInterval: UInt64
    private let recoveryDelay: UInt64

    init(defaults: UserDefaults = .standard, driver: ProtoPiePreviewDriving? = nil,
         monitoringInterval: UInt64 = 3_000_000_000, recoveryDelay: UInt64 = 2_000_000_000) {
        self.defaults = defaults
        self.driver = driver ?? ProtoPieSystemDriver()
        self.monitoringInterval = monitoringInterval
        self.recoveryDelay = recoveryDelay
        let saved = Self.read(defaults, key: Self.savedKey) ?? ProtoPieConfiguration()
        self.saved = saved
        draft = Self.read(defaults, key: Self.draftKey) ?? saved
        lastSuccessful = Self.read(defaults, key: Self.lastSuccessfulKey)
    }

    @discardableResult func observe(_ callback: @escaping () -> Void) -> UUID {
        let id = UUID(); observers[id] = callback; callback(); return id
    }
    func removeObserver(_ id: UUID) { observers.removeValue(forKey: id) }
    var hasUnsavedDraft: Bool { draft != saved }
    var hasActiveSession: Bool { activeSession != nil }

    /// Preview only this framing field, against the already-bound player. Never
    /// start another source or silently apply unrelated edits in the draft.
    func setVerticalPosition(_ value: Double) {
        draft.widthFitVerticalPosition = value
        guard let session = activeSession, state == .running, wantsToRun,
              !manuallyStopped, !manualPlayerOpen, !outputPaused,
              session.configuration.source == .cloud, session.configuration.fillWidth,
              draft.source == .cloud, draft.fillWidth,
              let expected = try? session.configuration.playbackURL(),
              let requested = try? draft.playbackURL(), expected == requested else {
            notice = "位置已记入草稿；请先应用并启动当前 Cloud 横向顶满预览。"
            notify(); return
        }
        pendingVerticalPosition = draft.widthFitVerticalPosition
        guard layoutOperation == nil else { return }
        // Drain any monitor command already in flight before moving the content;
        // otherwise its old session snapshot can reset the new position.
        let previousMonitor = monitor
        previousMonitor?.cancel(); monitor = nil
        let token = generation
        let sessionID = session.id
        layoutOperation = Task { [weak self] in
            await previousMonitor?.value
            guard let self else { return }
            while self.generation == token, !Task.isCancelled,
                  self.activeSession?.id == sessionID, self.pendingVerticalPosition != nil {
                do {
                    try await Task.sleep(nanoseconds: 80_000_000)
                    try self.requireCurrent(token)
                    guard self.state == .running, !self.manualPlayerOpen, !self.outputPaused,
                          var updated = self.activeSession, updated.id == sessionID,
                          let position = self.pendingVerticalPosition else { break }
                    self.pendingVerticalPosition = nil
                    updated.configuration.widthFitVerticalPosition = position
                    try await self.driver.updatePresentationLayout(updated)
                    try self.requireCurrent(token)
                    guard self.activeSession?.id == sessionID else { return }
                    self.activeSession = updated
                    if !self.playbackManaged {
                        self.lastSuccessful = updated.configuration
                        self.persist(updated.configuration, key: Self.lastSuccessfulKey)
                    }
                    self.notice = "上下位置已实时预览；满意后点击保存配置。"
                    self.notify()
                } catch {
                    guard self.generation == token, !Task.isCancelled else { return }
                    self.pendingVerticalPosition = nil
                    self.notice = "实时位置调节未完成：\(error.localizedDescription)"
                    self.notify(); break
                }
            }
            guard self.generation == token, !Task.isCancelled else { return }
            self.layoutOperation = nil
            self.pendingVerticalPosition = nil
            if self.activeSession != nil, self.wantsToRun { self.startMonitor() }
        }
    }

    @discardableResult func saveConfiguration() -> Bool {
        do {
            try draft.validate()
            saved = draft
            persist(saved, key: Self.savedKey)
            notice = "配置已保存；当前播放内容保持不变。"
            notify()
            return true
        } catch { notice = error.localizedDescription; notify(); return false }
    }

    /// Runtime presentation dimensions come from the accepted Warp canvas, not
    /// from a second persisted copy of the player's or calibration settings.
    func setPresentationCanvas(_ canvas: CanvasConfiguration?) {
        guard canvas != presentationCanvas else { return }
        if let canvas, !(64...32768).contains(canvas.width) || !(64...32768).contains(canvas.height) { return }
        let heightChanged = canvas?.height != presentationCanvas?.height
        presentationCanvas = canvas
        // The Cloud source width follows the physical output screen, so changing
        // only the Warp canvas width must not rebuild the browser or its capture.
        guard heightChanged else {
            // A width-only edit can follow a pending height edit. Keep it queued
            // with that resize instead of bypassing the old-operation drain.
            if !canvasRebuildPending { driver.setPresentationCanvas(canvas) }
            notify()
            return
        }
        if playbackManaged {
            driver.setPresentationCanvas(canvas)
            if wantsToRun, !manuallyStopped {
                handleInterruptedSession(reason: "播放画布尺寸已变化，请重新确认完整画面。")
            } else { notify() }
            return
        }
        let configuration = pendingConfiguration ?? activeSession?.configuration ?? lastSuccessful ?? saved
        guard wantsToRun, !manuallyStopped, !manualPlayerOpen,
              targetDisplayID != nil, configuration.source == .cloud else {
            driver.setPresentationCanvas(canvas)
            notify()
            return
        }
        // A canvas change can arrive while an older resize/prepare is suspended.
        // Let its cancellation finish before the driver changes the owned source
        // display, then prepare and capture only the latest requested dimensions.
        let previousOperation = operation
        let previousLayout = layoutOperation
        let previousMonitor = monitor
        cancelOperation()
        previousMonitor?.cancel(); monitor = nil
        let token = generation
        canvasRebuildPending = true
        notice = "画布尺寸已更新，正在调整播放器并重新确认完整画面…"
        state = .launching
        onSuspendOutput?()
        operation = Task { [weak self] in
            await previousOperation?.value
            await previousLayout?.value
            await previousMonitor?.value
            guard let self, self.generation == token, !Task.isCancelled,
                  self.wantsToRun, !self.manuallyStopped, !self.manualPlayerOpen,
                  self.targetDisplayID != nil else { return }
            self.driver.setPresentationCanvas(self.presentationCanvas)
            self.state = .idle
            self.begin(configuration: configuration, resetRecovery: true)
        }
    }

    func setTargetDisplay(_ displayID: CGDirectDisplayID?) {
        guard targetDisplayID != displayID else { return }
        let changingActiveDisplay = targetDisplayID != nil && displayID != nil && wantsToRun
        targetDisplayID = displayID
        if playbackManaged {
            if wantsToRun, !manuallyStopped {
                handleInterruptedSession(reason: "播放目标显示器已变化。")
            } else { cancelOperation(); notify() }
            return
        }
        if changingActiveDisplay { cancelOperation(); state = .idle }
        if displayID == nil {
            suspendForDisplayChange()
        } else if manualPlayerOpen {
            // A display reconnect must not take the login/editor window away from the user.
            state = activeSession == nil ? .idle : .paused
        } else if wantsToRun && !manuallyStopped {
            begin(configuration: pendingConfiguration ?? activeSession?.configuration ?? lastSuccessful ?? saved, resetRecovery: false)
        } else { notify() }
    }

    func suspendForDisplayChange() {
        targetDisplayID = nil
        if playbackManaged {
            if wantsToRun, !manuallyStopped {
                handleInterruptedSession(reason: "等待播放目标显示器恢复。")
            } else { cancelOperation(); notify() }
            return
        }
        cancelOperation()
        monitor?.cancel(); monitor = nil
        if wantsToRun || activeSession != nil {
            state = .waitingForDisplay
            onStop?()
        }
    }

    func startIfConfigured() {
        guard !playbackManaged, saved.autoStart, !manuallyStopped, !wantsToRun else { return }
        wantsToRun = true
        begin(configuration: saved, resetRecovery: true)
    }

    private func takeManualControl() {
        onManualControl?()
        // Also cancel locally when no integration callback is installed. Never
        // just flip the owner flag while its candidate can still complete.
        if playbackManaged {
            cancelPlaybackPreparation()
            playbackManaged = false
        }
    }

    func start() {
        takeManualControl()
        guard !state.isBusy else { return }
        manualPlayerOpen = false
        manuallyStopped = false; wantsToRun = true
        begin(configuration: draft, resetRecovery: true)
    }

    func reload() {
        takeManualControl()
        guard !state.isBusy else { return }
        manualPlayerOpen = false
        driver.requestFreshPreview()
        manuallyStopped = false; wantsToRun = true
        begin(configuration: activeSession?.configuration ?? saved, resetRecovery: true)
    }

    func stop() {
        takeManualControl()
        manualPlayerOpen = false
        canvasRebuildPending = false
        manuallyStopped = true; wantsToRun = false; pendingConfiguration = nil
        cancelOperation(); monitor?.cancel(); monitor = nil
        // Do not close player applications or discard any Studio changes.
        if let activeSession { driver.detach(activeSession) }
        activeSession = nil
        onStop?()
        state = .stopped
    }

    func shutdown() {
        playbackManaged = false
        canvasRebuildPending = false
        wantsToRun = false; manuallyStopped = true
        cancelOperation(); monitor?.cancel(); monitor = nil
        if let activeSession { driver.detach(activeSession) }
        activeSession = nil
        onStop?()
    }

    /// Called after the application has awaited capture shutdown, so removing
    /// the owned source display cannot race an active ScreenCaptureKit stream.
    func finishShutdownPresentation() { driver.shutdownPresentation() }

    func setOutputPaused(_ paused: Bool) {
        outputPaused = paused
        guard activeSession != nil, !state.isBusy, targetDisplayID != nil else { return }
        // Failure information stays visible until the user retries.
        if case .failed = state { notify(); return }
        state = paused ? .paused : .running
    }

    func openPlayer() {
        takeManualControl()
        guard !state.isBusy else { return }
        let configuration = draft
        let previousState = state
        let previousManualPlayerOpen = manualPlayerOpen
        manualPlayerOpen = true
        cancelOperation()
        let token = generation
        let drain = cancellationDrain
        state = .launching
        operation = Task { [weak self] in
            guard let self else { return }
            do {
                await drain?.value
                try Task.checkCancellation()
                guard self.generation == token else { throw CancellationError() }
                try configuration.validate()
                try await self.driver.openForUser(configuration: configuration)
                guard self.generation == token, !Task.isCancelled else { return }
                self.notice = configuration.source == .cloud
                    ? "播放器已移到控制屏；完成操作后点击启动/重试，自动恢复外屏无边框全屏。"
                    : "播放器已打开；完成登录或开启 Preview 后，点击启动/重试。"
            } catch {
                guard self.generation == token, !Task.isCancelled else { return }
                self.manualPlayerOpen = previousManualPlayerOpen
                self.notice = error.localizedDescription
            }
            self.state = previousState
            if self.activeSession != nil, self.wantsToRun { self.startMonitor() }
        }
    }

    func reportCaptureInterrupted(_ reason: String) {
        guard wantsToRun, !manuallyStopped else { return }
        notice = reason
        handleInterruptedSession()
    }

    /// Prepare an immutable playlist item without modifying draft/saved/lastSuccessful.
    /// Cancellation is also exposed synchronously so a late driver cannot steal focus
    /// after Esc, pause or the overall deadline.
    func prepareForPlayback(configuration: ProtoPieConfiguration, reload: Bool) async throws -> ProtoPieSession {
        let requestID = UUID()
        return try await withTaskCancellationHandler(operation: {
            try Task.checkCancellation()
            playbackManaged = true
            cancelOperation()
            playbackRequestID = requestID; playbackInterruptionReason = nil
            let token = generation
            manuallyStopped = false; wantsToRun = true
            manualPlayerOpen = false; outputPaused = false
            await cancellationDrain?.value
            try checkPlaybackRequest(requestID, token: token)
            try configuration.validate()
            guard targetDisplayID != nil else { throw ProtoPieError.unavailable("等待外接显示器后再开始播放计划。") }
            if reload { driver.requestFreshPreview() }
            state = .idle
            begin(configuration: configuration, resetRecovery: true)
            let preparationToken = generation
            let preparation = operation
            await preparation?.value
            try checkPlaybackRequest(requestID, token: preparationToken)
            guard state == .running, let session = activeSession,
                  session.configuration == configuration else {
                throw ProtoPieError.unavailable("播放来源未就绪。请检查链接、网络、登录和屏幕权限。")
            }
            return session
        }, onCancel: { [weak self] in
            Task { @MainActor [weak self] in
                guard let self, self.playbackRequestID == requestID else { return }
                self.cancelPlaybackPreparation()
            }
        })
    }

    private func checkPlaybackRequest(_ id: UUID, token: UUID) throws {
        try Task.checkCancellation()
        guard playbackRequestID == id else { throw CancellationError() }
        if let playbackInterruptionReason { throw ProtoPieError.unavailable(playbackInterruptionReason) }
        // A missing display is a recoverable preparation failure, not a silent
        // canceled script. The playlist supplies the bounded retry policy.
        guard targetDisplayID != nil else { throw ProtoPieError.unavailable("等待外接显示器后再开始播放计划。") }
        try requireCurrent(token)
    }

    func cancelPlaybackPreparation() {
        guard playbackManaged else { return }
        playbackRequestID = nil; playbackInterruptionReason = nil
        cancelOperation(); monitor?.cancel(); monitor = nil
        pendingConfiguration = nil; canvasRebuildPending = false
        manuallyStopped = true; wantsToRun = false
        // Keep the last valid image; do not resurrect a canceled candidate.
        state = activeSession == nil ? .idle : outputPaused ? .paused : .running
    }

    func finishPlaybackOwnership() {
        cancelPlaybackPreparation()
        playbackManaged = false
    }

    private func begin(configuration: ProtoPieConfiguration, resetRecovery: Bool) {
        guard !state.isBusy else { return }
        do { try configuration.validate() }
        catch { notice = error.localizedDescription; state = .failed(notice); return }
        pendingConfiguration = configuration
        guard let displayID = targetDisplayID else { state = .waitingForDisplay; return }
        if resetRecovery { recoveryAttempts = 0 }
        cancelOperation()
        monitor?.cancel(); monitor = nil
        let token = generation
        let drain = cancellationDrain
        let previous = activeSession
        let replacingLocal = previous?.configuration.source == .localFile && configuration != previous?.configuration
        let replacingCanvas = canvasRebuildPending
        notice = ""
        state = .launching
        if replacingLocal { onSuspendOutput?() }
        operation = Task { [weak self] in
            guard let self else { return }
            var candidate: ProtoPieSession?
            do {
                await drain?.value
                try self.requireCurrent(token)
                self.driver.setPresentationCanvas(self.presentationCanvas)
                let session = try await self.driver.prepare(configuration: configuration, displayID: displayID) { [weak self] message in
                    guard let self, self.generation == token else { return }
                    self.state = .waitingForPreview(message)
                }
                candidate = session
                try self.requireCurrent(token)
                guard let capture = self.onCapture else { throw ProtoPieError.unavailable("捕获服务尚未接通，请稍后重试。") }
                self.state = .capturing
                try await capture(session.windowID, session.processID)
                try self.requireCurrent(token)
                self.driver.presentationCaptured(session)
                self.activeSession = session
                if !self.playbackManaged {
                    self.lastSuccessful = configuration
                    self.persist(configuration, key: Self.lastSuccessfulKey)
                }
                self.pendingConfiguration = nil
                self.canvasRebuildPending = false
                if (replacingLocal || replacingCanvas) && !self.outputPaused { self.onResumeOutput?() }
                self.state = self.outputPaused ? .paused : .running
                if let previous, previous.windowID != session.windowID { await self.driver.release(previous) }
                self.startMonitor()
            } catch {
                guard self.generation == token, !Task.isCancelled else {
                    // A cooperative driver normally throws before returning. If
                    // a system API finishes late, dispose only its uncommitted
                    // candidate; preserve the current valid preview.
                    if let candidate, candidate.windowID != self.activeSession?.windowID {
                        await self.driver.release(candidate)
                    }
                    return
                }
                // The old window remains pinned during cloud preparation. Studio may have reused it,
                // so explicitly reopen the previous source before reporting retained output.
                var oldRestored = false
                if let previous {
                    do {
                        let old: ProtoPieSession
                        if replacingLocal {
                            old = try await self.driver.prepare(configuration: previous.configuration, displayID: displayID) { _ in }
                        } else { old = previous }
                        try self.requireCurrent(token)
                        let alive = await self.driver.isAlive(old)
                        var completePresentation = alive
                        if alive && replacingCanvas {
                            completePresentation = await self.driver.isPresentationReady(old, displayID: displayID)
                        }
                        try self.requireCurrent(token)
                        if alive, completePresentation, let capture = self.onCapture {
                            try await capture(old.windowID, old.processID)
                            try self.requireCurrent(token)
                            self.activeSession = old
                            oldRestored = true
                            if (replacingLocal || replacingCanvas) && !self.outputPaused { self.onResumeOutput?() }
                        }
                    } catch { /* Report the original failure plus rollback failure below. */ }
                }
                guard self.generation == token, !Task.isCancelled else { return }
                if let candidate, candidate.windowID != self.activeSession?.windowID { await self.driver.release(candidate) }
                self.canvasRebuildPending = false
                let suffix = oldRestored ? "\n已保留上一预览来源。" : (replacingCanvas
                    ? "\n完整高度尚未确认，已暂停校正输出，避免显示被裁切的旧画面。"
                    : (previous == nil ? "" : "\n旧来源也不可用，已恢复原始桌面。"))
                if previous != nil && !oldRestored { self.activeSession = nil; self.onStop?() }
                self.notice = error.localizedDescription + suffix
                self.state = .failed(self.notice)
                if oldRestored { self.pendingConfiguration = nil; self.startMonitor() }
                else if (error as? ProtoPieError)?.needsUserAction != true { self.scheduleRecovery(configuration: configuration) }
            }
        }
    }

    private func startMonitor() {
        monitor?.cancel()
        let interval = monitoringInterval
        let token = generation
        monitor = Task { [weak self] in
            var unstablePresentationSamples = 0
            while !Task.isCancelled {
                do { try await Task.sleep(nanoseconds: interval) } catch { return }
                guard let self, let session = self.activeSession, self.wantsToRun, !self.manuallyStopped else { return }
                let alive = await self.driver.isAlive(session)
                guard !Task.isCancelled, self.generation == token, self.activeSession?.id == session.id else { return }
                if !alive {
                    self.handleInterruptedSession()
                    return
                }
                guard let displayID = self.targetDisplayID, !self.state.isBusy,
                      !self.manualPlayerOpen, !self.outputPaused, (self.playbackManaged || self.saved.autoRecover) else {
                    unstablePresentationSamples = 0
                    continue
                }
                let ready = await self.driver.isPresentationReady(session, displayID: displayID)
                guard !Task.isCancelled, self.generation == token, self.activeSession?.id == session.id,
                      self.targetDisplayID == displayID else { return }
                guard !self.state.isBusy, !self.manualPlayerOpen, !self.outputPaused, (self.playbackManaged || self.saved.autoRecover) else {
                    unstablePresentationSamples = 0
                    continue
                }
                unstablePresentationSamples = ready ? 0 : unstablePresentationSamples + 1
                if ready { self.recoveryAttempts = 0 }
                if unstablePresentationSamples >= 2, self.playbackManaged {
                    self.handleInterruptedSession(reason: "播放窗口的全屏或布局连续两次未就绪。")
                    return
                }
                if unstablePresentationSamples >= 2, self.recoveryAttempts < 3 {
                    // Reuse the existing source and rebuild its capture only after fullscreen stabilizes.
                    self.recoveryAttempts += 1
                    self.begin(configuration: session.configuration, resetRecovery: false)
                    return
                }
            }
        }
    }

    private func handleInterruptedSession(reason: String = "预览窗口或捕获已中断。") {
        guard wantsToRun, !manuallyStopped else { return }
        if playbackManaged {
            playbackInterruptionReason = reason
            cancelOperation()
            pendingConfiguration = nil; canvasRebuildPending = false
        }
        let configuration = activeSession?.configuration ?? lastSuccessful ?? saved
        if let activeSession { driver.detach(activeSession) }
        activeSession = nil
        onStop?()
        state = .failed(reason)
        scheduleRecovery(configuration: configuration)
    }

    private func scheduleRecovery(configuration: ProtoPieConfiguration) {
        guard !playbackManaged, saved.autoRecover, wantsToRun, !manuallyStopped, !manualPlayerOpen,
              targetDisplayID != nil, recoveryAttempts < 3 else { return }
        recoveryAttempts += 1
        let attempt = recoveryAttempts
        let token = generation
        notice += "\n将自动重试（\(attempt)/3）；停止联动可取消。"
        notify()
        operation = Task { [weak self] in
            guard let self else { return }
            do { try await Task.sleep(nanoseconds: self.recoveryDelay * UInt64(attempt)) } catch { return }
            guard self.generation == token, self.wantsToRun, !self.manuallyStopped,
                  !self.manualPlayerOpen, self.saved.autoRecover else { return }
            self.begin(configuration: configuration, resetRecovery: false)
        }
    }

    private func cancelOperation() {
        let previousOperation = operation
        let previousLayout = layoutOperation
        let previousMonitor = monitor
        let previousDrain = cancellationDrain
        generation = UUID(); operation?.cancel(); operation = nil
        layoutOperation?.cancel(); layoutOperation = nil; pendingVerticalPosition = nil
        monitor?.cancel(); monitor = nil
        if playbackManaged, previousOperation != nil || previousLayout != nil || previousMonitor != nil {
            cancellationDrain = Task {
                await previousDrain?.value
                await previousOperation?.value
                await previousLayout?.value
                await previousMonitor?.value
            }
        }
    }
    private func requireCurrent(_ token: UUID) throws {
        try Task.checkCancellation()
        guard generation == token, targetDisplayID != nil, wantsToRun, !manuallyStopped else { throw CancellationError() }
    }
    private func notify() { onStateChange?(state); for observer in Array(observers.values) { observer() } }
    private func persist(_ value: ProtoPieConfiguration, key: String) {
        if let data = try? JSONEncoder().encode(value) { defaults.set(data, forKey: key) }
    }
    private static func read(_ defaults: UserDefaults, key: String) -> ProtoPieConfiguration? {
        defaults.data(forKey: key).flatMap { try? JSONDecoder().decode(ProtoPieConfiguration.self, from: $0) }
    }
}
