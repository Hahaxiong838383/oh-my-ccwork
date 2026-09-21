import CoreGraphics
import Foundation
import NIOVirtualDisplay

private final class OwnedPresentationDisplayResource {
    private(set) var handle: NIOVirtualDisplayRef?
    let width: Int
    let height: Int
    let displayID: CGDirectDisplayID
    var placementBaseline: PresentationDisplayPlacement.Snapshot

    init(handle: NIOVirtualDisplayRef, width: Int, height: Int, placementBaseline: PresentationDisplayPlacement.Snapshot) {
        self.handle = handle; self.width = width; self.height = height
        self.placementBaseline = placementBaseline
        displayID = NIOVirtualDisplayGetDisplayID(handle)
    }

    func release() {
        if let handle { self.handle = nil; NIOVirtualDisplayDestroy(handle) }
    }

    deinit { release() }
}

/// Owns a source-only virtual screen. The physical Warp output must exclude
/// these displays when choosing an output, including after an app restart.
@MainActor final class OwnedPresentationDisplay {
    private var current: OwnedPresentationDisplayResource?
    /// Preserve the source being captured until a verified replacement frame
    /// has been accepted; a display mode being ready is not a capture handoff.
    private var captured: OwnedPresentationDisplayResource?
    // A cancelled handoff can already have switched SCK while awaiting the old
    // stream's stop callback. Keep such sources until the next confirmed handoff.
    private var retired = [OwnedPresentationDisplayResource]()
    private var pending: OwnedPresentationDisplayResource?
    private var generation = UUID()
    private var placementTask: Task<Void, Never>?
    private var releasedDisplayIDs = Set<CGDirectDisplayID>()
    private var unsettledPlacementBaseline: PresentationDisplayPlacement.Snapshot?
    private var verifiedSourceModes = [CGDirectDisplayID: PresentationDisplayPlacement.Screen]()
    static let placementDiagnosticKey = "nioWarpPresentationDisplay.placementDiagnostic.v1"

    private func persistPlacementDiagnostics(_ entries: [[String: Any]]) {
        guard !entries.isEmpty else { return }
        let defaults = UserDefaults.standard
        var history = [[String: Any]]()
        if let data = defaults.data(forKey: Self.placementDiagnosticKey),
           let previous = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let records = previous["recent"] as? [[String: Any]] {
            history = Array(records.suffix(48))
        }
        history = Array((history + entries).suffix(48))
        guard let data = try? JSONSerialization.data(withJSONObject: ["current": entries.last!, "recent": history],
                                                    options: [.sortedKeys]) else { return }
        // Write once at the end of a bounded placement attempt, not at 20 Hz.
        defaults.set(data, forKey: Self.placementDiagnosticKey)
    }

    private func placementScreens() throws -> [PresentationDisplayPlacement.Screen] {
        let activeIDs = try PresentationDisplayPlacementRuntime.activeDisplayIDs()
        releasedDisplayIDs.formIntersection(activeIDs)
        releasedDisplayIDs = Set(releasedDisplayIDs.filter {
            Self.isOwnedDisplay($0) || (CGDisplayVendorNumber($0) == 0 && CGDisplayModelNumber($0) == 0)
        })
        let heldIDs = Set(ownedDisplayIDs)
        verifiedSourceModes = verifiedSourceModes.filter { heldIDs.contains($0.key) }
        // Creating a smaller CGVirtualDisplay can make the old larger source's
        // mode temporarily unreadable. Never extend this exception to a new
        // candidate, an unowned NIO screen, or a physical/third-party display.
        let fallbacks = verifiedSourceModes.filter { $0.key != pending?.displayID && Self.isOwnedDisplay($0.key) }
        let screens = try PresentationDisplayPlacementRuntime.screens(displayIDs: activeIDs,
            verifiedSourceModes: fallbacks, excludingIDs: releasedDisplayIDs)
        for screen in screens where heldIDs.contains(screen.id) && !screen.modeFallback {
            let resource = ([captured, current, pending].compactMap { $0 } + retired)
                .first { $0.handle != nil && $0.displayID == screen.id }
            if let resource, screen.modeWidth == resource.width, screen.modeHeight == resource.height,
               screen.pixelWidth == resource.width, screen.pixelHeight == resource.height {
                verifiedSourceModes[screen.id] = screen
            } else { verifiedSourceModes.removeValue(forKey: screen.id) }
        }
        // WindowServer may retain a destroyed source briefly. It is neither an
        // anchor nor a movable resource after this owner has released its handle.
        return screens
    }

    private func release(_ resource: OwnedPresentationDisplayResource?) {
        guard let resource, resource.handle != nil else { return }
        releasedDisplayIDs.insert(resource.displayID)
        verifiedSourceModes.removeValue(forKey: resource.displayID)
        resource.release()
    }

    private var ownedDisplayIDs: [CGDirectDisplayID] {
        var result = [CGDirectDisplayID]()
        for resource in [captured, current, pending].compactMap({ $0 }) + retired {
            if resource.handle != nil, !result.contains(resource.displayID) { result.append(resource.displayID) }
        }
        return result
    }

    private func placementSnapshot() throws -> PresentationDisplayPlacement.Snapshot {
        PresentationDisplayPlacement.snapshot(try placementScreens(), movableIDs: ownedDisplayIDs)
    }

    /// Bounded settling only around our own resource changes, never a layout watchdog.
    private func restorePlacement(_ baseline: PresentationDisplayPlacement.Snapshot, token: UUID) async throws {
        try Task.checkCancellation()
        guard generation == token else { throw CancellationError() }
        unsettledPlacementBaseline = baseline
        var stable = 0
        var applications = 0
        var iteration = 0
        var lastStage = "begin"
        var lastScreens = [PresentationDisplayPlacement.Screen]()
        var lastMoves = [PresentationDisplayPlacement.Move]()
        var samplingError: String?
        var entries = [[String: Any]]()
        let attemptID = UUID().uuidString
        func bounds(_ screens: [PresentationDisplayPlacement.Screen]) -> [[String: Any]] {
            screens.map { screen in
                ["id": screen.id, "bounds": [screen.bounds.minX, screen.bounds.minY, screen.bounds.width, screen.bounds.height],
                 "main": screen.isMain, "mirror": screen.mirror, "modeID": screen.modeID,
                 "pixels": [screen.pixelWidth, screen.pixelHeight], "modeFallback": screen.modeFallback]
            }
        }
        func record(_ stage: String, restoredSnapshot: Bool? = nil) {
            lastStage = stage
            var entry: [String: Any] = ["attemptID": attemptID, "timestamp": Date().timeIntervalSince1970,
                "processID": ProcessInfo.processInfo.processIdentifier, "iteration": iteration, "stage": stage,
                "stable": stable, "applications": applications, "owned": ownedDisplayIDs,
                "released": releasedDisplayIDs.sorted(), "screens": bounds(lastScreens),
                "moves": lastMoves.map { ["id": $0.id, "origin": [$0.origin.x, $0.origin.y]] },
                "generationMatches": generation == token]
            if let leading = pending, leading.handle != nil { entry["leading"] = leading.displayID }
            if let current { entry["currentSourceID"] = current.displayID }
            if let captured { entry["capturedSourceID"] = captured.displayID }
            if let restoredSnapshot { entry["restoredSnapshot"] = restoredSnapshot }
            if let samplingError { entry["samplingError"] = samplingError }
            if stage == "begin" { entry["baselineAnchors"] = bounds(baseline.anchors); entry["baselineSources"] = bounds(baseline.sources) }
            entries.append(entry)
        }
        defer { persistPlacementDiagnostics(entries) }
        record("begin")
        for index in 0..<12 {
            iteration = index + 1
            if Task.isCancelled || generation != token { record("cancelled") }
            try Task.checkCancellation()
            guard generation == token else { throw CancellationError() }
            let screens: [PresentationDisplayPlacement.Screen]
            samplingError = nil
            do { screens = try placementScreens() }
            catch {
                // A just-released display can still be enumerated while its
                // display mode has already disappeared. Retry only this bounded
                // sampling phase; transaction errors remain explicit failures.
                stable = 0
                samplingError = error.localizedDescription
                record("samplingUnavailable")
                try await Task.sleep(nanoseconds: 50_000_000)
                continue
            }
            lastScreens = screens; lastMoves = []
            let preservingIDs = Set(([captured, current].compactMap { $0 } + retired).filter { $0.handle != nil }.map(\.displayID))
            let leadingID = pending?.handle != nil ? pending?.displayID : nil
            guard let plan = PresentationDisplayPlacement.plan(baseline: baseline,
                current: screens, movableIDs: ownedDisplayIDs, preservingIDs: preservingIDs, leadingID: leadingID)
                ?? PresentationDisplayPlacement.planRestoringBaselineMain(baseline: baseline,
                    current: screens, movableIDs: ownedDisplayIDs, preservingIDs: preservingIDs, leadingID: leadingID) else {
                record("unsafePlan")
                throw ProtoPieError.unavailable("当前主屏或镜像排列不允许安全放置内容屏（阶段 \(lastStage)，事务 \(applications)）。")
            }
            lastMoves = plan.moves
            if let restoredMain = plan.restoredMainDisplayID {
                record("restoringBaselineMain", restoredSnapshot: plan.restoredSnapshot)
                entries[entries.count - 1]["restoredMainDisplayID"] = restoredMain
            }
            if plan.moves.isEmpty {
                stable = releasedDisplayIDs.isEmpty ? stable + 1 : 0
                record(releasedDisplayIDs.isEmpty ? "settling" : "waitingReleased", restoredSnapshot: plan.restoredSnapshot)
                if stable >= 3 { unsettledPlacementBaseline = nil; record("ready"); return }
            } else {
                guard applications < 3 else { record("applicationLimit", restoredSnapshot: plan.restoredSnapshot); break }
                do { try PresentationDisplayPlacementRuntime.apply(plan) }
                catch {
                    record("transactionFailed", restoredSnapshot: plan.restoredSnapshot)
                    throw ProtoPieError.unavailable("内容屏排列事务失败（阶段 \(lastStage)，已完成事务 \(applications)）。\(error.localizedDescription)")
                }
                applications += 1; stable = 0
                record("applied", restoredSnapshot: plan.restoredSnapshot)
            }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        let reason = lastStage
        record("failedAfter_\(reason)")
        throw ProtoPieError.unavailable("内容屏排列尚未稳定（阶段 \(reason)，事务 \(applications)，待注销 \(releasedDisplayIDs.count)），请等待显示器配置完成后重试。")
    }

    private func schedulePlacementRestore(_ baseline: PresentationDisplayPlacement.Snapshot) {
        placementTask?.cancel()
        let token = generation
        placementTask = Task { [weak self] in
            guard let self else { return }
            do {
                try await Task.sleep(nanoseconds: 100_000_000)
                try await self.restorePlacement(baseline, token: token)
            }
            catch is CancellationError { }
            catch { NSLog("NIO content display placement: %@", error.localizedDescription) }
        }
    }

    var displayID: CGDirectDisplayID? { current?.displayID }

    nonisolated static func isOwnedDisplay(_ displayID: CGDirectDisplayID) -> Bool {
        NIOVirtualDisplayIsOwnedDisplay(displayID)
    }

    func ensure(width: Int, height: Int) async throws -> CGDirectDisplayID {
        guard (1...16384).contains(width), (1...16384).contains(height),
              Int64(width) * Int64(height) <= 67_108_864 else {
            throw ProtoPieError.unavailable("内容显示尺寸须在 1～16384 之间，且总像素不得超过 67108864。")
        }
        try Task.checkCancellation()
        // Finish our previous release transaction before taking the next baseline.
        await placementTask?.value
        try Task.checkCancellation()
        placementTask = nil
        if let baseline = unsettledPlacementBaseline { try await restorePlacement(baseline, token: generation) }
        if let captured, captured.width == width, captured.height == height, Self.isReady(captured) {
            generation = UUID()
            let baseline = pending?.placementBaseline
            let released = releaseUnused(pending)
            pending = nil
            if current !== captured {
                if let current { retired.append(current) }
                current = captured
            }
            if released, let baseline { try await restorePlacement(baseline, token: generation) }
            return captured.displayID
        }
        if let current, current.width == width, current.height == height, Self.isReady(current) {
            // A newer request for the existing size cancels any obsolete resize.
            generation = UUID()
            let baseline = pending?.placementBaseline
            let released = releaseUnused(pending)
            pending = nil
            if released, let baseline { try await restorePlacement(baseline, token: generation) }
            return current.displayID
        }
        generation = UUID()
        let token = generation
        let baseline: PresentationDisplayPlacement.Snapshot
        if let pending, pending.handle != nil { baseline = pending.placementBaseline }
        else { baseline = try placementSnapshot() }
        var message = [CChar](repeating: 0, count: 1024)
        let candidate: OwnedPresentationDisplayResource
        if let current, current.width == width, current.height == height, current.handle != nil {
            releaseUnused(pending)
            candidate = current
            candidate.placementBaseline = baseline
        } else if let pending, pending.width == width, pending.height == height, pending.handle != nil {
            // A newer caller adopts the same pending resource. The older waiter
            // is invalidated by generation, but must not release its successor.
            candidate = pending
        } else if let reusable = retired.first(where: { $0.width == width && $0.height == height && $0.handle != nil }) {
            releaseUnused(pending)
            candidate = reusable
            candidate.placementBaseline = baseline
        } else {
            releaseUnused(pending)
            pending = nil
            guard let handle = NIOVirtualDisplayCreate(UInt32(width), UInt32(height), &message, message.count) else {
                schedulePlacementRestore(baseline)
                throw ProtoPieError.unavailable(Self.errorText(message, fallback: "无法创建内容虚拟显示器。"))
            }
            candidate = OwnedPresentationDisplayResource(handle: handle, width: width, height: height, placementBaseline: baseline)
            releasedDisplayIDs.remove(candidate.displayID)
        }
        pending = candidate
        do {
            let deadline = ProcessInfo.processInfo.systemUptime + 6
            var selected = false
            var stableSamples = 0
            var lastError = "等待系统完成内容显示器配置。"
            while ProcessInfo.processInfo.systemUptime < deadline {
                try Task.checkCancellation()
                guard generation == token, let handle = candidate.handle else { throw CancellationError() }
                if !selected {
                    let result = NIOVirtualDisplaySelectExactMode(handle, &message, message.count)
                    lastError = Self.errorText(message, fallback: lastError)
                    if result < 0 { throw ProtoPieError.unavailable(lastError) }
                    selected = result == 1
                }
                stableSamples = selected && Self.isReady(candidate) ? stableSamples + 1 : 0
                if stableSamples >= 3 {
                    try await restorePlacement(candidate.placementBaseline, token: token)
                    try Task.checkCancellation()
                    guard generation == token else { throw CancellationError() }
                    guard Self.isReady(candidate) else { throw ProtoPieError.unavailable("内容显示模式在排列调整期间发生变化，请重试。") }
                    let previous = current
                    current = candidate; pending = nil
                    if let previous, previous !== candidate, previous !== captured { retired.append(previous) }
                    return candidate.displayID
                }
                try await Task.sleep(nanoseconds: 50_000_000)
            }
            throw ProtoPieError.unavailable("内容显示器未稳定到 \(width)×\(height)（1×）。\(lastError)")
        } catch {
            if generation == token { pending = nil }
            if current !== candidate, pending !== candidate, captured !== candidate,
               !retired.contains(where: { $0 === candidate }) { release(candidate) }
            if generation == token { schedulePlacementRestore(candidate.placementBaseline) }
            throw error
        }
    }

    @discardableResult private func releaseUnused(_ resource: OwnedPresentationDisplayResource?) -> Bool {
        guard let resource, resource !== current, resource !== captured,
              !retired.contains(where: { $0 === resource }), resource.handle != nil else { return false }
        release(resource)
        return true
    }

    func captureDidSwitch(to displayID: CGDirectDisplayID) async throws {
        try Task.checkCancellation()
        guard let current, current.displayID == displayID else { throw CancellationError() }
        let token = generation
        let baseline = try placementSnapshot()
        let previous = captured
        captured = current
        var released = false
        if previous !== current, previous?.handle != nil { release(previous); released = true }
        for resource in retired where resource !== current && resource.handle != nil { release(resource); released = true }
        retired.removeAll()
        if released { try await restorePlacement(baseline, token: token) }
    }

    private func releaseAll() {
        generation = UUID()
        placementTask?.cancel(); placementTask = nil
        release(pending); pending = nil
        release(current); current = nil
        release(captured); captured = nil
        retired.forEach { release($0) }; retired.removeAll()
    }

    func shutdownAfterCapture() async throws {
        try Task.checkCancellation()
        guard !ownedDisplayIDs.isEmpty || unsettledPlacementBaseline != nil else { return }
        let baseline = try unsettledPlacementBaseline ?? placementSnapshot()
        releaseAll()
        try await restorePlacement(baseline, token: generation)
    }

    func shutdown() {
        let hasResources = !ownedDisplayIDs.isEmpty
        let baseline = unsettledPlacementBaseline ?? (hasResources ? try? placementSnapshot() : nil)
        releaseAll()
        if let baseline { schedulePlacementRestore(baseline) }
    }

    deinit { placementTask?.cancel(); pending?.release(); current?.release(); captured?.release(); retired.forEach { $0.release() } }

    private static func isReady(_ resource: OwnedPresentationDisplayResource) -> Bool {
        guard resource.handle != nil, CGDisplayIsActive(resource.displayID) != 0,
              isOwnedDisplay(resource.displayID),
              let mode = CGDisplayCopyDisplayMode(resource.displayID) else { return false }
        let bounds = CGDisplayBounds(resource.displayID)
        return mode.width == resource.width && mode.height == resource.height
            && mode.pixelWidth == resource.width && mode.pixelHeight == resource.height
            && abs(bounds.width - Double(resource.width)) < 1 && abs(bounds.height - Double(resource.height)) < 1
    }

    private static func errorText(_ buffer: [CChar], fallback: String) -> String {
        let text = String(cString: buffer)
        return text.isEmpty ? fallback : text
    }
}
