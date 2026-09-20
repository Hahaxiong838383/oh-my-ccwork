import Foundation

struct ProtoPiePlaybackRuntime: Equatable {
    enum State: String { case idle, preparing, running, paused, recovering, completed, failed }
    var state: State = .idle
    var runID: UUID?
    var itemID: UUID?
    var itemName = ""
    var stepIndex: Int?
    var loopCount = 0
    var remainingItemSeconds = 0.0
    var remainingTotalSeconds: Double?
    var notice = ""
    var isActive: Bool { [.preparing, .running, .paused, .recovering].contains(state) }
    var ownsPresentation: Bool { isActive }
}

/// Owns only the opt-in automation plan. The existing coordinator still owns
/// windows/capture; all real input is supplied by the application's input owner.
@MainActor final class ProtoPiePlaybackController {
    var prepare: ((ProtoPiePlaylistItem, Bool) async throws -> Void)?
    var cancelPreparation: (() -> Void)?
    var bindInput: (() async throws -> Void)?
    var performAction: ((ProtoPieScriptStep) async throws -> Void)?
    var releaseInput: (() async -> Void)?
    var stopPresentation: (() -> Void)?
    var healthSnapshot: (() -> [String: String])?

    let log: ProtoPiePlaybackLog
    var library: ProtoPiePlaybackLibrary { store.library }
    private(set) var runtime = ProtoPiePlaybackRuntime()
    private let store: ProtoPiePlaybackStore
    private let now: () -> Double
    private let sleep: (Double) async throws -> Void
    private let watchdogInterval: Double
    private let releaseTimeout: Double
    private var observers: [UUID: () -> Void] = [:]
    private var generation = UUID()
    private var operation: Task<Void, Never>?
    private var watchdog: Task<Void, Never>?
    private var cleanup: Task<Bool, Never>?
    private var releasePending = false
    private var items = [ProtoPiePlaylistItem]()
    private var plan = ProtoPiePlaybackPlan()
    private var itemIndex = 0
    private var failures = [UUID: Int]()
    private var singleStepCursors = [UUID: Int]()
    private var deadline: Double?
    private var stageDeadline: Double?
    private var stageName = ""
    private var lastTick = 0.0
    private var lastHealth = 0.0
    private var purpose: Purpose = .plan
    private var selectedStep: Int?
    private var runClosed = true
    private var hasReadyItemInRun = false

    private enum Purpose { case plan, preview, scriptOnce, singleStep }
    private struct RuntimeFailure: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    init(store: ProtoPiePlaybackStore, log: ProtoPiePlaybackLog,
         now: (() -> Double)? = nil,
         sleep: ((Double) async throws -> Void)? = nil,
         watchdogInterval: Double = 0.1, releaseTimeout: Double = 2) {
        self.store = store; self.log = log
        let origin = ContinuousClock.now
        self.now = now ?? {
            let value = origin.duration(to: .now).components
            return Double(value.seconds) + Double(value.attoseconds) / 1e18
        }
        self.sleep = sleep ?? { seconds in
            try await Task.sleep(nanoseconds: UInt64(max(0, min(seconds, 86_400)) * 1e9))
        }
        self.watchdogInterval = max(0.001, watchdogInterval)
        self.releaseTimeout = max(0.01, releaseTimeout)
    }

    @discardableResult func observe(_ callback: @escaping () -> Void) -> UUID {
        let id = UUID(); observers[id] = callback; callback(); return id
    }
    func removeObserver(_ id: UUID) { observers.removeValue(forKey: id) }
    func saveLibrary(_ value: ProtoPiePlaybackLibrary) throws {
        try store.save(value); notify()
    }
    func select(_ id: UUID) {
        guard library.items.contains(where: { $0.id == id }) else { return }
        var value = library; value.selectedItemID = id
        do { try saveLibrary(value) }
        catch { runtime.notice = error.localizedDescription; notify() }
    }

    func start() {
        let value = library
        let enabled = value.items.filter(\.enabled)
        let selected = enabled.first(where: { $0.id == value.selectedItemID }) ?? enabled.first
        let selectedItems = value.plan.mode == .single ? selected.map { [$0] } ?? [] : enabled
        begin(items: selectedItems, plan: value.plan, purpose: .plan)
    }

    func previewSelected() {
        guard let selected = selection() else { showFailure("请先选择一个预览来源。"); return }
        var previewPlan = library.plan; previewPlan.totalDurationSeconds = nil
        previewPlan.endAction = .keepPreview
        begin(items: [selected], plan: previewPlan, purpose: .preview)
    }

    func tryScript(singleStep: Bool = false, stepIndex: Int? = nil) {
        guard let selected = selection() else { showFailure("请先选择一个预览来源。"); return }
        let steps = selected.script.steps.isEmpty ? selected.script.initialization : selected.script.steps
        guard !singleStep || !steps.isEmpty else { showFailure("请先添加演示步骤。"); return }
        let index = singleStep ? stepIndex ?? singleStepCursors[selected.id, default: 0] % max(steps.count, 1) : nil
        guard index == nil || steps.indices.contains(index!) else { showFailure("所选步骤已不存在。"); return }
        var trialPlan = library.plan; trialPlan.endAction = .keepPreview
        begin(items: [selected], plan: trialPlan, purpose: singleStep ? .singleStep : .scriptOnce, step: index)
    }

    func pause(reason: String = "已暂停自动演示") {
        guard runtime.isActive, runtime.state != .paused else { return }
        updateTime(); invalidate()
        runtime.state = .paused; runtime.notice = reason; runtime.stepIndex = nil
        requestCleanup(); record("paused"); notify()
    }

    func resume() {
        guard runtime.state == .paused, items.indices.contains(itemIndex) else { return }
        if let deadline, now() >= deadline { finishAtDeadline(); return }
        guard failures[items[itemIndex].id, default: 0] <= plan.retryLimit else {
            runtime.notice = "当前计划的重试次数已用完，请重新开始计划。"; notify(); return
        }
        // A paused prototype can be changed by a person. Restart from a fresh
        // document and initialization, never continue an unknown middle step.
        launchItem(at: itemIndex, remaining: runtime.remainingItemSeconds, forceRefresh: true)
    }

    func stop(reason: String = "已停止自动演示", returnToWorkbench: Bool = false) {
        finish(state: .idle, reason: reason, returnToWorkbench: returnToWorkbench)
    }

    func next() { move(direction: 1) }
    func previous() { move(direction: -1) }

    func shutdown() {
        finish(state: .idle, reason: "应用主动退出", returnToWorkbench: false, logReason: "shutdown")
    }

    func reportInterruption(_ reason: String) {
        guard runtime.state == .running, items.indices.contains(itemIndex) else { return }
        updateTime(); invalidate()
        handleFailure(reason, for: itemIndex, errorKind: "interruption")
    }

    private func selection() -> ProtoPiePlaylistItem? {
        library.items.first(where: { $0.id == library.selectedItemID }) ?? library.items.first
    }

    private func begin(items candidates: [ProtoPiePlaylistItem], plan newPlan: ProtoPiePlaybackPlan,
                       purpose newPurpose: Purpose, step: Int? = nil) {
        guard !candidates.isEmpty else { showFailure("请添加并启用至少一个云端预览来源。"); return }
        do {
            for item in candidates {
                try item.validate()
                var source = ProtoPieConfiguration(); source.cloudURL = item.cloudURL
                _ = try source.playbackURL()
            }
            guard newPlan.retryLimit >= 0, newPlan.retryLimit <= 10,
                  newPlan.totalDurationSeconds.map({ $0.isFinite && $0 > 0 }) ?? true else {
                throw RuntimeFailure(message: "播放时长或重试次数无效。")
            }
        } catch { showFailure(error.localizedDescription); return }
        finish(state: .idle, reason: "切换播放计划", returnToWorkbench: false, logReason: "new_plan")
        items = candidates; plan = newPlan; purpose = newPurpose; selectedStep = step
        failures = [:]; itemIndex = 0
        let id = UUID(); let time = now()
        deadline = newPlan.totalDurationSeconds.map { time + $0 }
        lastTick = time; lastHealth = time
        runtime = ProtoPiePlaybackRuntime(state: .preparing, runID: id,
            remainingTotalSeconds: newPlan.totalDurationSeconds)
        runClosed = false; hasReadyItemInRun = false; log.beginRun(id)
        record("plan_started", details: ["itemCount": String(items.count), "mode": String(describing: newPurpose)])
        launchItem(at: 0)
        startWatchdog(runID: id)
    }

    private func move(direction: Int) {
        guard runtime.isActive, !items.isEmpty else { return }
        let next = (itemIndex + direction + items.count) % items.count
        if runtime.state == .paused {
            itemIndex = next; runtime.itemID = items[next].id; runtime.itemName = items[next].name
            runtime.remainingItemSeconds = items[next].durationSeconds; runtime.stepIndex = nil
            runtime.notice = "已选择来源，自动演示保持暂停。"; notify(); return
        }
        guard failures[items[next].id, default: 0] <= plan.retryLimit else {
            runtime.notice = "该来源重试次数已用完，请重新开始计划。"; notify(); return
        }
        launchItem(at: next)
    }

    private func launchItem(at index: Int, remaining: Double? = nil, forceRefresh: Bool = false, delay: Double = 0) {
        guard items.indices.contains(index), !runClosed else { return }
        updateTime(); invalidate(); itemIndex = index
        let token = generation; let item = items[index]
        runtime.itemID = item.id; runtime.itemName = item.name; runtime.stepIndex = nil; runtime.loopCount = 0
        runtime.remainingItemSeconds = remaining ?? item.durationSeconds
        runtime.state = delay > 0 ? .recovering : .preparing
        runtime.notice = delay > 0 ? "等待重试当前来源…" : "正在准备 \(item.name)…"
        requestCleanup(); notify()
        operation = Task { [weak self] in
            guard let self else { return }
            do {
                if let cleanup = self.cleanup, !(await cleanup.value) {
                    try self.requireCurrent(token)
                    self.pause(reason: "输入释放尚未完成，自动演示已暂停。"); return
                }
                try self.requireCurrent(token)
                if delay > 0 { try await self.sleep(delay); try self.requireCurrent(token) }
                try await self.prepareItem(item, refresh: forceRefresh, token: token)
                if self.purpose == .preview {
                    self.hasReadyItemInRun = true
                    self.complete(reason: "所选预览已就绪"); return
                }
                if self.purpose != .plan || item.script.enabled {
                    try await self.bind(token: token)
                }
                self.hasReadyItemInRun = true
                self.stageDeadline = nil; self.stageName = "running"; self.runtime.state = .running
                self.runtime.notice = "正在演示 \(item.name)"; self.lastTick = self.now()
                self.record("item_ready"); self.notify()
                if self.purpose == .singleStep {
                    let steps = item.script.steps.isEmpty ? item.script.initialization : item.script.steps
                    let selected = self.selectedStep ?? 0
                    guard steps.indices.contains(selected) else { throw RuntimeFailure(message: "所选步骤已不存在。") }
                    try await self.execute(steps[selected], index: selected, token: token)
                    self.singleStepCursors[item.id] = (selected + 1) % steps.count
                    self.complete(reason: "单步试播完成"); return
                }
                if self.purpose == .scriptOnce || item.script.enabled {
                    try await self.runScript(item, token: token)
                }
                try self.requireCurrent(token)
                if self.purpose == .scriptOnce { self.complete(reason: "脚本单次试播完成") }
                // A finite script finishing early holds the preview until dwell
                // expires. No reload, synthetic input, or busy loop is needed.
            } catch {
                guard self.isCurrent(token), !(error is CancellationError) else { return }
                self.handleFailure(error.localizedDescription, for: index, errorKind: Self.failureKind(error, stage: self.stageName))
            }
        }
    }

    private func prepareItem(_ item: ProtoPiePlaylistItem, refresh: Bool, token: UUID) async throws {
        try requireCurrent(token)
        guard let prepare else { throw RuntimeFailure(message: "播放器连接尚未就绪。") }
        runtime.state = .preparing; stageName = "prepare"; stageDeadline = now() + 60
        record("item_preparing"); notify()
        try await prepare(item, refresh)
        try requireCurrent(token)
        stageDeadline = nil
    }

    private func bind(token: UUID) async throws {
        try requireCurrent(token)
        guard let bindInput else { throw RuntimeFailure(message: "自动演示输入尚未接通。") }
        stageName = "input_bind"; stageDeadline = now() + 15
        try await bindInput(); try requireCurrent(token); stageDeadline = nil
    }

    private func runScript(_ item: ProtoPiePlaylistItem, token: UUID) async throws {
        let script = item.script
        for step in script.initialization { try await execute(step, index: nil, token: token) }
        guard !script.steps.isEmpty else { return }
        let limit = purpose == .scriptOnce ? 1 : script.repeatCount
        var loop = 0
        while limit == 0 || loop < limit {
            try requireCurrent(token)
            runtime.loopCount = loop + 1; record("script_loop_started"); notify()
            for (index, step) in script.steps.enumerated() { try await execute(step, index: index, token: token) }
            loop += 1; runtime.stepIndex = nil; record("script_loop_completed"); notify()
            guard limit == 0 || loop < limit else { return }
            // Even a zero-delay script yields; the watchdog and user's Stop must
            // always get a chance to cancel an unlimited loop.
            try await sleep(max(script.loopInterval, 0.01)); try requireCurrent(token)
            if script.reloadEachLoop {
                updateTime(); runtime.state = .preparing; requestCleanup()
                if let cleanup, !(await cleanup.value) { throw RuntimeFailure(message: "输入释放超时。") }
                try requireCurrent(token)
                try await prepareItem(item, refresh: true, token: token)
                try await bind(token: token)
                runtime.state = .running; lastTick = now(); notify()
                for step in script.initialization { try await execute(step, index: nil, token: token) }
            }
        }
    }

    private func execute(_ step: ProtoPieScriptStep, index: Int?, token: UUID) async throws {
        for _ in 0..<step.repeatCount {
            try requireCurrent(token)
            runtime.stepIndex = index; stageName = "script_action"
            stageDeadline = now() + max(step.duration, 0) + 15
            let started = now(); record("step_started", details: ["kind": step.kind.rawValue]); notify()
            if step.kind == .wait { try await sleep(step.duration) }
            else {
                guard let performAction else { throw RuntimeFailure(message: "自动演示动作尚未接通。") }
                try await performAction(step)
            }
            try requireCurrent(token)
            stageDeadline = nil
            record("step_completed", details: ["durationMs": String(Int(max(0, now() - started) * 1000))])
            if step.waitAfter > 0 { try await sleep(step.waitAfter); try requireCurrent(token) }
        }
    }

    private func handleFailure(_ reason: String, for index: Int, errorKind: String = "unavailable") {
        guard items.indices.contains(index), !runClosed else { return }
        updateTime(); invalidate(); requestCleanup()
        let item = items[index]
        failures[item.id, default: 0] += 1
        let count = failures[item.id, default: 0]
        runtime.notice = reason
        record("item_failed", level: "error", details: ["attempt": String(count), "stage": stageName, "errorKind": errorKind])
        if count <= plan.retryLimit {
            launchItem(at: index, remaining: runtime.remainingItemSeconds, forceRefresh: true,
                       delay: min(pow(2, Double(count - 1)), 8))
        } else if purpose == .plan, plan.mode == .sequence,
                  let candidate = nextEligible(after: index) {
            record("item_skipped", level: "warning")
            launchItem(at: candidate)
        } else {
            runtime.state = .paused
            runtime.notice = "可用来源已用完重试次数，已暂停。\(reason)"
            record("plan_exhausted", level: "error"); notify()
        }
    }

    private static func failureKind(_ error: Error, stage: String) -> String {
        if let input = error as? MouseInputTransportError {
            switch input {
            case .timeout: return "timeout"
            case .staleViewport: return "stale_viewport"
            case .disconnected: return "input_disconnected"
            case .closed: return "input_closed"
            case .invalidEvent: return "invalid_input"
            case .queueOverflow: return "input_queue_overflow"
            case .unavailable: return "input_unavailable"
            }
        }
        if let preview = error as? ProtoPieError {
            switch preview {
            case .permission: return "permission"
            case .waitingForUser: return "user_action_required"
            case .invalidSource: return "invalid_source"
            case .missingApplication: return "missing_application"
            case .unavailable: return stage == "prepare" ? "prepare" : "unavailable"
            }
        }
        if stage == "prepare" { return "prepare" }
        if stage == "input_bind" || stage == "script_action" { return "input" }
        return "unavailable"
    }

    private func nextEligible(after index: Int) -> Int? {
        for offset in 1...items.count {
            let candidate = (index + offset) % items.count
            if failures[items[candidate].id, default: 0] <= plan.retryLimit { return candidate }
        }
        return nil
    }

    private func startWatchdog(runID: UUID) {
        watchdog?.cancel()
        watchdog = Task { [weak self] in
            guard let self else { return }
            while !Task.isCancelled, self.runtime.runID == runID, !self.runClosed {
                do { try await self.sleep(self.watchdogInterval) } catch { return }
                guard !Task.isCancelled, self.runtime.runID == runID, !self.runClosed else { return }
                self.tick()
            }
        }
    }

    private func tick() {
        updateTime()
        if let deadline, now() >= deadline { finishAtDeadline(); return }
        if runtime.state != .paused, let stageDeadline, now() >= stageDeadline {
            handleFailure("\(stageName) 等待超时。", for: itemIndex, errorKind: "timeout"); return
        }
        if purpose == .plan, runtime.state == .running, runtime.remainingItemSeconds <= 0 {
            if plan.mode == .single { complete(reason: "当前来源播放完成"); return }
            guard let index = nextEligible(after: itemIndex) else { pause(reason: "没有可播放来源。"); return }
            launchItem(at: index); return
        }
        if now() - lastHealth >= 15 {
            lastHealth = now()
            // FPS/frame age are diagnostic observations only. A static native
            // preview can legitimately produce SCK idle/no new complete frames;
            // never reload a prototype based solely on unchanged pixels or FPS.
            var detail = healthSnapshot?() ?? [:]
            detail["state"] = runtime.state.rawValue
            detail["remainingSeconds"] = String(Int(max(0, runtime.remainingTotalSeconds ?? 0)))
            record("health", details: detail)
        }
        notify()
    }

    private func updateTime() {
        let time = now(); let delta = max(0, time - lastTick); lastTick = time
        if runtime.state == .running, purpose == .plan {
            runtime.remainingItemSeconds = max(0, runtime.remainingItemSeconds - delta)
        }
        runtime.remainingTotalSeconds = deadline.map { max(0, $0 - time) }
    }

    private func finishAtDeadline() {
        guard hasReadyItemInRun else {
            finish(state: .failed, reason: "已到总播放时长，但本轮没有任何预览来源就绪。",
                   returnToWorkbench: plan.endAction == .workbench, logReason: "all_items_failed")
            return
        }
        complete(reason: "已到总播放时长")
    }

    private func complete(reason: String) {
        finish(state: .completed, reason: reason, returnToWorkbench: plan.endAction == .workbench, logReason: "plan_complete")
    }

    private func finish(state: ProtoPiePlaybackRuntime.State, reason: String, returnToWorkbench: Bool, logReason: String = "user_stop") {
        updateTime(); invalidate(); watchdog?.cancel(); watchdog = nil
        requestCleanup()
        if !runClosed, let id = runtime.runID { log.endRun(id, reason: logReason) }
        runClosed = true; deadline = nil; stageDeadline = nil
        runtime.state = state; runtime.stepIndex = nil; runtime.notice = reason
        if returnToWorkbench { stopPresentation?() }
        notify()
    }

    private func showFailure(_ reason: String) {
        // Invalid edits must not cancel an already-running valid snapshot.
        runtime.notice = reason
        if !runtime.isActive { runtime.state = .failed }
        notify()
    }

    private func invalidate() {
        generation = UUID(); operation?.cancel(); operation = nil
        stageDeadline = nil; cancelPreparation?()
    }
    private func isCurrent(_ token: UUID) -> Bool {
        generation == token && !runClosed && runtime.state != .paused && !Task.isCancelled
    }
    private func requireCurrent(_ token: UUID) throws {
        guard isCurrent(token) else { throw CancellationError() }
        if let deadline, now() >= deadline { throw CancellationError() }
    }

    /// A release timeout stops new automation instead of allowing a late release
    /// to interfere with a new input owner. The release itself remains best-effort.
    private func requestCleanup() {
        guard !releasePending else { return }
        guard let releaseInput else { cleanup = nil; return }
        releasePending = true
        let releaseSleep = sleep; let timeout = releaseTimeout
        cleanup = Task { [weak self] in
            await withCheckedContinuation { continuation in
                let gate = CleanupGate(continuation)
                Task { @MainActor [weak self] in
                    await releaseInput()
                    self?.releasePending = false
                    gate.resolve(true)
                }
                Task { @MainActor [weak self] in
                    do { try await releaseSleep(timeout) } catch { return }
                    if gate.resolve(false) {
                        self?.record("input_release_timeout", level: "error")
                    }
                }
            }
        }
    }

    @MainActor private final class CleanupGate {
        private var continuation: CheckedContinuation<Bool, Never>?
        init(_ continuation: CheckedContinuation<Bool, Never>) { self.continuation = continuation }
        @discardableResult func resolve(_ value: Bool) -> Bool {
            guard let continuation else { return false }
            self.continuation = nil; continuation.resume(returning: value); return true
        }
    }

    private func record(_ event: String, level: String = "info", details: [String: String] = [:]) {
        log.record(event, level: level, runID: runtime.runID, itemID: runtime.itemID,
                   step: runtime.stepIndex, details: details)
    }
    private func notify() { for callback in Array(observers.values) { callback() } }
}
