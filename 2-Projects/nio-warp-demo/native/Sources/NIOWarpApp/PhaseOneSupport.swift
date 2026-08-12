import Carbon
import Foundation

struct WarpPreset: Codable, Equatable, Identifiable {
    var id: UUID
    var name: String
    var createdAt: Date
    var configuration: WarpConfiguration
}

final class PresetStore {
    private let key = "nioWarpPresets.v1"
    private let defaults: UserDefaults
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    func all() -> [WarpPreset] {
        guard let data = defaults.data(forKey: key),
              let presets = try? decoder.decode([WarpPreset].self, from: data) else { return [] }
        return presets.sorted { $0.createdAt < $1.createdAt }
    }

    @discardableResult
    func save(name: String, configuration: WarpConfiguration, now: Date = Date()) throws -> WarpPreset {
        let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedName.isEmpty else {
            throw NSError(domain: "NIOWarp.Preset", code: 1, userInfo: [NSLocalizedDescriptionKey: "预设名称不能为空"])
        }
        var presets = all()
        let preset = WarpPreset(id: UUID(), name: trimmedName, createdAt: now, configuration: configuration)
        presets.removeAll { $0.name.caseInsensitiveCompare(trimmedName) == .orderedSame }
        presets.append(preset)
        try persist(presets)
        return preset
    }

    func delete(id: UUID) throws {
        try persist(all().filter { $0.id != id })
    }

    private func persist(_ presets: [WarpPreset]) throws {
        defaults.set(try encoder.encode(presets), forKey: key)
    }
}

struct ConfigurationRevision: Codable, Equatable {
    var createdAt: Date
    var reason: String
    var configuration: WarpConfiguration
}

final class ConfigurationHistoryStore {
    private let key = "nioWarpConfigurationHistory.v1"
    private let defaults: UserDefaults
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()
    private let maximumCount: Int
    private let minimumInterval: TimeInterval
    private var lastRecordedAt: Date?

    init(
        defaults: UserDefaults = .standard,
        maximumCount: Int = 30,
        minimumInterval: TimeInterval = 0.75
    ) {
        self.defaults = defaults
        self.maximumCount = maximumCount
        self.minimumInterval = minimumInterval
    }

    func all() -> [ConfigurationRevision] {
        guard let data = defaults.data(forKey: key),
              let revisions = try? decoder.decode([ConfigurationRevision].self, from: data) else { return [] }
        return revisions
    }

    @discardableResult
    func record(
        _ configuration: WarpConfiguration,
        reason: String,
        now: Date = Date(),
        force: Bool = false
    ) -> Bool {
        if !force, let lastRecordedAt, now.timeIntervalSince(lastRecordedAt) < minimumInterval { return false }
        var revisions = all()
        if revisions.last?.configuration == configuration { return false }
        revisions.append(ConfigurationRevision(createdAt: now, reason: reason, configuration: configuration))
        if revisions.count > maximumCount {
            revisions.removeFirst(revisions.count - maximumCount)
        }
        guard let data = try? encoder.encode(revisions) else { return false }
        defaults.set(data, forKey: key)
        lastRecordedAt = now
        return true
    }

    func popLatest() -> ConfigurationRevision? {
        var revisions = all()
        guard let revision = revisions.popLast(), let data = try? encoder.encode(revisions) else { return nil }
        defaults.set(data, forKey: key)
        lastRecordedAt = nil
        return revision
    }

    var count: Int { all().count }
}

struct PerformanceSnapshot: Equatable {
    var framesPerSecond: Double
    var averageGPUTimeMilliseconds: Double
    var p95GPUTimeMilliseconds: Double
    var sampleCount: Int
}

final class RollingPerformanceMonitor {
    private let lock = NSLock()
    private var frameTimes = [TimeInterval]()
    private var gpuTimes = [Double]()
    private let windowDuration: TimeInterval

    init(windowDuration: TimeInterval = 3) {
        self.windowDuration = windowDuration
    }

    func recordFrame(at timestamp: TimeInterval) {
        lock.lock()
        frameTimes.append(timestamp)
        prune(now: timestamp)
        lock.unlock()
    }

    func recordGPUTime(seconds: Double, at timestamp: TimeInterval) {
        guard seconds.isFinite, seconds >= 0 else { return }
        lock.lock()
        gpuTimes.append(seconds * 1_000)
        if gpuTimes.count > 240 { gpuTimes.removeFirst(gpuTimes.count - 240) }
        prune(now: timestamp)
        lock.unlock()
    }

    func snapshot(now: TimeInterval) -> PerformanceSnapshot {
        lock.lock()
        defer { lock.unlock() }
        prune(now: now)
        let duration = max((frameTimes.last ?? now) - (frameTimes.first ?? now), 0.001)
        let fps = frameTimes.count > 1 ? Double(frameTimes.count - 1) / duration : 0
        let sortedGPU = gpuTimes.sorted()
        let average = sortedGPU.isEmpty ? 0 : sortedGPU.reduce(0, +) / Double(sortedGPU.count)
        let p95Index = sortedGPU.isEmpty ? 0 : min(Int((Double(sortedGPU.count - 1) * 0.95).rounded(.up)), sortedGPU.count - 1)
        let p95 = sortedGPU.isEmpty ? 0 : sortedGPU[p95Index]
        return PerformanceSnapshot(
            framesPerSecond: fps,
            averageGPUTimeMilliseconds: average,
            p95GPUTimeMilliseconds: p95,
            sampleCount: min(frameTimes.count, gpuTimes.count)
        )
    }

    private func prune(now: TimeInterval) {
        let cutoff = now - windowDuration
        frameTimes.removeAll { $0 < cutoff }
    }
}

enum PerformancePolicy {
    static func shouldFallback(
        snapshot: PerformanceSnapshot,
        antiAliasingEnabled: Bool = true,
        currentMode: AntiAliasingMode
    ) -> Bool {
        guard antiAliasingEnabled, currentMode == .quality, snapshot.sampleCount >= 60 else { return false }
        return snapshot.framesPerSecond < 55 || snapshot.p95GPUTimeMilliseconds > 14
    }
}

private func globalHotKeyHandler(
    _ nextHandler: EventHandlerCallRef?,
    _ event: EventRef?,
    _ userData: UnsafeMutableRawPointer?
) -> OSStatus {
    guard let userData else { return noErr }
    Unmanaged<GlobalHotKey>.fromOpaque(userData).takeUnretainedValue().invoke()
    return noErr
}

final class GlobalHotKey {
    private var hotKeyRef: EventHotKeyRef?
    private var handlerRef: EventHandlerRef?
    private let callback: () -> Void

    init?(keyCode: UInt32, modifiers: UInt32, callback: @escaping () -> Void) {
        self.callback = callback
        var eventType = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        let status = InstallEventHandler(
            GetApplicationEventTarget(),
            globalHotKeyHandler,
            1,
            &eventType,
            Unmanaged.passUnretained(self).toOpaque(),
            &handlerRef
        )
        guard status == noErr else { return nil }
        let identifier = EventHotKeyID(signature: OSType(0x4E494F57), id: 1)
        guard RegisterEventHotKey(keyCode, modifiers, identifier, GetApplicationEventTarget(), 0, &hotKeyRef) == noErr else {
            if let handlerRef { RemoveEventHandler(handlerRef) }
            return nil
        }
    }

    deinit {
        if let hotKeyRef { UnregisterEventHotKey(hotKeyRef) }
        if let handlerRef { RemoveEventHandler(handlerRef) }
    }

    fileprivate func invoke() {
        DispatchQueue.main.async(execute: callback)
    }
}
