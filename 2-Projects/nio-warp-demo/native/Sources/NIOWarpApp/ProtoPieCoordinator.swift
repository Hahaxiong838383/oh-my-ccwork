import AppKit
import Foundation

@MainActor final class ProtoPieCoordinator {
    static let savedKey = "nioWarpProtoPie.configuration.v1"
    static let draftKey = "nioWarpProtoPie.draft.v1"
    static let lastSuccessfulKey = "nioWarpProtoPie.lastSuccessful.v1"

    var onCapture: ((CGWindowID, pid_t) async throws -> Void)?
    var onStop: (() -> Void)?
    var onStateChange: ((ProtoPieRuntimeState) -> Void)?
    /// Local Studio can reuse a Preview window while changing documents. Hide the output before that change.
    var onSuspendOutput: (() -> Void)?
    var onResumeOutput: (() -> Void)?
    var draft: ProtoPieConfiguration { didSet { persist(draft, key: Self.draftKey); notify() } }
    private(set) var saved: ProtoPieConfiguration
    private(set) var lastSuccessful: ProtoPieConfiguration?
    private(set) var state: ProtoPieRuntimeState = .idle { didSet { notify() } }
    private(set) var activeSession: ProtoPieSession?
    private(set) var targetDisplayID: CGDirectDisplayID?
    private(set) var notice = ""
    private let defaults: UserDefaults
    private let driver: ProtoPiePreviewDriving
    private var observers: [UUID: () -> Void] = [:]
    private var operation: Task<Void, Never>?
    private var monitor: Task<Void, Never>?
    private var generation = UUID()
    private var wantsToRun = false
    private var manuallyStopped = false
    private var outputPaused = false
    private var recoveryAttempts = 0
    private var pendingConfiguration: ProtoPieConfiguration?
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

    func setTargetDisplay(_ displayID: CGDirectDisplayID?) {
        guard targetDisplayID != displayID else { return }
        let changingActiveDisplay = targetDisplayID != nil && displayID != nil && wantsToRun
        targetDisplayID = displayID
        if changingActiveDisplay { cancelOperation(); state = .idle }
        if displayID == nil {
            suspendForDisplayChange()
        } else if wantsToRun && !manuallyStopped {
            begin(configuration: pendingConfiguration ?? activeSession?.configuration ?? lastSuccessful ?? saved, resetRecovery: false)
        } else { notify() }
    }

    func suspendForDisplayChange() {
        targetDisplayID = nil
        cancelOperation()
        monitor?.cancel(); monitor = nil
        if wantsToRun || activeSession != nil {
            state = .waitingForDisplay
            onStop?()
        }
    }

    func startIfConfigured() {
        guard saved.autoStart, !manuallyStopped, !wantsToRun else { return }
        wantsToRun = true
        begin(configuration: saved, resetRecovery: true)
    }

    func start() {
        manuallyStopped = false; wantsToRun = true
        begin(configuration: draft, resetRecovery: true)
    }

    func reload() {
        guard !state.isBusy else { return }
        driver.requestFreshPreview()
        manuallyStopped = false; wantsToRun = true
        begin(configuration: activeSession?.configuration ?? saved, resetRecovery: true)
    }

    func stop() {
        manuallyStopped = true; wantsToRun = false; pendingConfiguration = nil
        cancelOperation(); monitor?.cancel(); monitor = nil
        // Do not close player applications or discard any Studio changes.
        if let activeSession { driver.detach(activeSession) }
        activeSession = nil
        onStop?()
        state = .stopped
    }

    func shutdown() {
        wantsToRun = false; manuallyStopped = true
        cancelOperation(); monitor?.cancel(); monitor = nil
        if let activeSession { driver.detach(activeSession) }
        activeSession = nil
        onStop?()
    }

    func setOutputPaused(_ paused: Bool) {
        outputPaused = paused
        guard activeSession != nil, !state.isBusy, targetDisplayID != nil else { return }
        // Failure information stays visible until the user retries.
        if case .failed = state { notify(); return }
        state = paused ? .paused : .running
    }

    func openPlayer() {
        guard !state.isBusy else { return }
        let configuration = draft
        let previousState = state
        cancelOperation()
        let token = generation
        state = .launching
        operation = Task { [weak self] in
            guard let self else { return }
            do {
                try configuration.validate()
                try await self.driver.openForUser(configuration: configuration)
                guard self.generation == token, !Task.isCancelled else { return }
                self.notice = configuration.source == .cloud
                    ? "播放器已移到控制屏；完成操作后点击启动/重试，自动恢复外屏无边框全屏。"
                    : "播放器已打开；完成登录或开启 Preview 后，点击启动/重试。"
            } catch {
                guard self.generation == token, !Task.isCancelled else { return }
                self.notice = error.localizedDescription
            }
            self.state = previousState
        }
    }

    func reportCaptureInterrupted(_ reason: String) {
        guard wantsToRun, !manuallyStopped else { return }
        notice = reason
        handleInterruptedSession()
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
        let previous = activeSession
        let replacingLocal = previous?.configuration.source == .localFile && configuration != previous?.configuration
        notice = ""
        state = .launching
        if replacingLocal { onSuspendOutput?() }
        operation = Task { [weak self] in
            guard let self else { return }
            var candidate: ProtoPieSession?
            do {
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
                self.activeSession = session
                self.lastSuccessful = configuration
                self.persist(configuration, key: Self.lastSuccessfulKey)
                self.pendingConfiguration = nil
                if replacingLocal && !self.outputPaused { self.onResumeOutput?() }
                self.state = self.outputPaused ? .paused : .running
                if let previous, previous.windowID != session.windowID { await self.driver.release(previous) }
                self.startMonitor()
            } catch {
                guard self.generation == token, !Task.isCancelled else { return }
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
                        if await self.driver.isAlive(old), let capture = self.onCapture {
                            try await capture(old.windowID, old.processID)
                            try self.requireCurrent(token)
                            self.activeSession = old
                            oldRestored = true
                            if replacingLocal && !self.outputPaused { self.onResumeOutput?() }
                        }
                    } catch { /* Report the original failure plus rollback failure below. */ }
                }
                guard self.generation == token, !Task.isCancelled else { return }
                if let candidate, candidate.windowID != self.activeSession?.windowID { await self.driver.release(candidate) }
                let suffix = oldRestored ? "\n已保留上一预览来源。" : (previous == nil ? "" : "\n旧来源也不可用，已恢复原始桌面。")
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
        monitor = Task { [weak self] in
            while !Task.isCancelled {
                do { try await Task.sleep(nanoseconds: interval) } catch { return }
                guard let self, let session = self.activeSession, self.wantsToRun, !self.manuallyStopped else { return }
                if !(await self.driver.isAlive(session)) {
                    self.handleInterruptedSession()
                    return
                }
            }
        }
    }

    private func handleInterruptedSession() {
        guard wantsToRun, !manuallyStopped else { return }
        let configuration = activeSession?.configuration ?? lastSuccessful ?? saved
        if let activeSession { driver.detach(activeSession) }
        activeSession = nil
        onStop?()
        state = .failed("预览窗口或捕获已中断。")
        scheduleRecovery(configuration: configuration)
    }

    private func scheduleRecovery(configuration: ProtoPieConfiguration) {
        guard saved.autoRecover, wantsToRun, !manuallyStopped, targetDisplayID != nil, recoveryAttempts < 3 else { return }
        recoveryAttempts += 1
        let attempt = recoveryAttempts
        let token = generation
        notice += "\n将自动重试（\(attempt)/3）；停止联动可取消。"
        notify()
        operation = Task { [weak self] in
            guard let self else { return }
            do { try await Task.sleep(nanoseconds: self.recoveryDelay * UInt64(attempt)) } catch { return }
            guard self.generation == token, self.wantsToRun, !self.manuallyStopped else { return }
            self.begin(configuration: configuration, resetRecovery: false)
        }
    }

    private func cancelOperation() { generation = UUID(); operation?.cancel(); operation = nil }
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
