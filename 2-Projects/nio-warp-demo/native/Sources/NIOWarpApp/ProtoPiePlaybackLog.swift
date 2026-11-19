import Foundation

/// Redacted session diagnostics. Filesystem and archive work never run on the UI thread.
@MainActor final class ProtoPiePlaybackLog {
    struct Entry: Codable, Equatable, Sendable {
        var timestamp: Date
        var level: String
        var event: String
        var runID: UUID?
        var itemID: UUID?
        var step: Int?
        var details: [String: String]
    }
    struct Policy: Sendable {
        var maximumBytes = 200 * 1_024 * 1_024
        var maximumFileBytes = 4 * 1_024 * 1_024
        var maximumAge: TimeInterval = 7 * 24 * 60 * 60
        var pendingLimit = 512
    }

    private(set) var entries: [Entry] = []
    private(set) var warning: String?
    let directory: URL
    private let writer: ProtoPiePlaybackLogWriter
    private let now: () -> Date
    private var dropped = 0

    init(directory: URL? = nil, policy: Policy = Policy(), now: @escaping () -> Date = Date.init) {
        self.directory = directory ?? FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Logs/NIOWarp/Playback", isDirectory: true)
        self.now = now
        self.writer = ProtoPiePlaybackLogWriter(directory: self.directory, policy: policy)
        let startedAt = now()
        writer.bootstrap(at: startedAt) { [weak self] result in
            Task { @MainActor [weak self] in
                guard let self else { return }
                switch result {
                case .success(let result):
                    self.entries = Array((result.entries + self.entries).sorted { $0.timestamp < $1.timestamp }.suffix(200))
                    if result.unclosed { self.warning = "发现上次播放计划没有正常结束，已记录中断信息；不会自动重新演示。" }
                case .failure: self.warning = "播放日志目录无法读取或写入，请检查磁盘空间和权限。"
                }
            }
        }
    }

    func record(_ event: String, level: String = "info", runID: UUID? = nil, itemID: UUID? = nil,
                step: Int? = nil, details: [String: String] = [:]) {
        let entry = Entry(timestamp: now(), level: ["info", "warning", "error", "debug"].contains(level) ? level : "info",
                          event: Self.redactedEvent(event), runID: runID, itemID: itemID,
                          step: step.flatMap { $0 >= 0 && $0 <= 1_000 ? $0 : nil }, details: Self.redactedDetails(details))
        appendRecent(entry)
        if dropped > 0 {
            let omitted = Entry(timestamp: now(), level: "warning", event: "records_dropped", runID: runID,
                                itemID: itemID, step: nil, details: ["count": String(dropped)])
            if writer.append(omitted, onFailure: failureHandler) { dropped = 0 }
        }
        if !writer.append(entry, onFailure: failureHandler) {
            dropped += 1
            warning = "日志写入队列繁忙，已限制内存占用；部分高频记录被省略（\(dropped) 条）。"
        }
    }

    func beginRun(_ id: UUID) {
        record("run_started", runID: id)
        writer.beginRun(id, at: now(), onFailure: failureHandler)
    }

    func endRun(_ id: UUID, reason: String) {
        record("run_ended", runID: id, details: ["reason": reason])
        writer.endRun(id, onFailure: failureHandler)
    }

    /// Writes a ZIP containing only diagnostic logs, never cloud URLs or saved scripts.
    func export(to destination: URL) async throws {
        guard destination.isFileURL else { throw ProtoPiePlaybackValidationError.invalid("请选择本地日志导出位置。") }
        try await withCheckedThrowingContinuation { continuation in
            writer.export(to: destination) { continuation.resume(with: $0) }
        }
    }

    func flush() async {
        await withCheckedContinuation { continuation in writer.flush { continuation.resume() } }
    }

    private func appendRecent(_ entry: Entry) {
        entries.append(entry)
        if entries.count > 200 { entries.removeFirst(entries.count - 200) }
    }

    private var failureHandler: @Sendable () -> Void {
        { [weak self] in
            Task { @MainActor [weak self] in self?.warning = "播放日志写入失败，请检查磁盘空间和权限；内存中仍保留最近记录。" }
        }
    }

    nonisolated static func redactedEvent(_ event: String) -> String {
        guard !event.isEmpty, event.utf8.count <= 80,
              event.range(of: #"^[a-z][a-z0-9_.-]*$"#, options: .regularExpression) != nil else { return "diagnostic_event" }
        return event
    }

    nonisolated static func redactedDetails(_ details: [String: String]) -> [String: String] {
        // Accept numerical measurements and fixed classifications, not free-form
        // exception descriptions (which can contain private share links or text).
        let numbers: Set<String> = ["attempt", "retry", "retryLimit", "loopCount", "durationSeconds", "elapsedSeconds",
            "remainingSeconds", "queueLength", "framesCaptured", "framesRendered", "fps", "memoryMB", "latencyMS",
            "count", "dropped", "itemCount", "stepCount", "width", "height", "displayScale", "errorCode", "totalSeconds", "durationMs",
            "inputQueue", "captureFrames", "displayID", "canvasWidth", "canvasHeight"]
        let booleans: Set<String> = ["connected", "frameAvailable", "sourceMatches", "captureReady", "renderReady",
            "geometryReady", "layoutReady", "isVisible", "isActive", "fullscreen", "fresh", "reload", "enabled", "inputConnected", "captureActive"]
        let classifications: Set<String> = ["state", "stage", "reason", "errorKind", "action", "status", "mode", "kind", "inputOwner", "inputError"]
        let tokens: Set<String> = ["idle", "preparing", "running", "paused", "recovering", "completed", "failed", "stopped",
            "ready", "loading", "interactive", "complete", "unknown", "start", "stop", "pause", "resume", "next", "previous",
            "wait", "keyPress", "keyHold", "mouseMove", "mouseClick", "mouseDoubleClick", "mouseHold", "mouseDrag", "scroll",
            "initialization", "script", "loop", "single", "sequence", "keepPreview", "workbench", "user", "escape",
            "plan", "preview", "scriptOnce", "singleStep", "prepare", "input_bind", "script_action", "new_plan",
            "user_stop", "user_pause", "user_interruption", "manual_takeover", "shutdown", "timeout", "deadline", "total_deadline",
            "item_complete", "plan_complete", "cancelled", "canceled", "preparation_failed", "input_failed", "health_failed",
            "all_items_failed", "retry_exhausted", "script_failed", "transport_failed", "unclean_shutdown", "unexpected_exit",
            "viewport_changed", "stale_viewport", "staleViewport", "disconnected", "permission", "unavailable", "invalidSource", "other",
            "none", "manual", "human", "automation", "native", "automatic", "transport", "backpressure", "script", "closed",
            "queueOverflow", "invalidEvent"]
        var result: [String: String] = [:]
        for (key, value) in details {
            if numbers.contains(key), value.utf8.count <= 40, let number = Double(value), number.isFinite {
                result[key] = value
            } else if booleans.contains(key), ["true", "false", "0", "1"].contains(value) {
                result[key] = value
            } else if classifications.contains(key) {
                result[key] = tokens.contains(value) ? value : "other"
            } else if key == "previousRunID", let id = UUID(uuidString: value) {
                result[key] = id.uuidString
            } else if key == "appVersion", value.utf8.count <= 32,
                      value.range(of: #"^[0-9]+(\.[0-9]+){1,3}(\([0-9]+\))?$"#, options: .regularExpression) != nil {
                result[key] = value
            }
        }
        return result
    }
}

private final class ProtoPiePlaybackLogWriter: @unchecked Sendable {
    typealias Entry = ProtoPiePlaybackLog.Entry
    private struct Marker: Codable { var runID: UUID; var startedAt: Date }
    struct BootstrapResult { var entries: [Entry]; var unclosed: Bool }
    private let directory: URL
    private let policy: ProtoPiePlaybackLog.Policy
    private let queue = DispatchQueue(label: "cn.nio-warp.playback-log", qos: .utility)
    private let archiveQueue = DispatchQueue(label: "cn.nio-warp.playback-log-export", qos: .utility)
    private let lock = NSLock()
    private var pending = 0
    private let manager = FileManager.default
    private var activeFile: URL?
    private var activeDay: String?
    private let encoder: JSONEncoder = { let value = JSONEncoder(); value.dateEncodingStrategy = .iso8601; value.outputFormatting = [.sortedKeys]; return value }()
    private let decoder: JSONDecoder = { let value = JSONDecoder(); value.dateDecodingStrategy = .iso8601; return value }()

    init(directory: URL, policy: ProtoPiePlaybackLog.Policy) {
        self.directory = directory
        var bounded = policy
        bounded.maximumBytes = max(1_024, bounded.maximumBytes)
        bounded.maximumFileBytes = min(bounded.maximumBytes, max(512, bounded.maximumFileBytes))
        bounded.maximumAge = max(1, bounded.maximumAge)
        bounded.pendingLimit = max(1, bounded.pendingLimit)
        self.policy = bounded
    }

    private var markerURL: URL { directory.appendingPathComponent("active-run.json") }

    func bootstrap(at date: Date, completion: @escaping @Sendable (Result<BootstrapResult, Error>) -> Void) {
        queue.async {
            do {
                try self.prepareDirectory()
                try self.prune(at: date)
                var unclosed = false
                if self.manager.fileExists(atPath: self.markerURL.path) {
                    if let data = try? Data(contentsOf: self.markerURL),
                       let marker = try? self.decoder.decode(Marker.self, from: data) {
                        let entry = Entry(timestamp: date, level: "warning", event: "previous_run_unclosed", runID: marker.runID,
                                          itemID: nil, step: nil, details: ["reason": "unclean_shutdown"])
                        try self.write(entry)
                    } else {
                        try self.write(Entry(timestamp: date, level: "warning", event: "run_marker_unreadable", runID: nil,
                                             itemID: nil, step: nil, details: [:]))
                    }
                    unclosed = true
                    try self.manager.removeItem(at: self.markerURL)
                }
                completion(.success(BootstrapResult(entries: try self.readRecent(), unclosed: unclosed)))
            } catch { completion(.failure(error)) }
        }
    }

    func append(_ entry: Entry, onFailure: @escaping @Sendable () -> Void) -> Bool {
        lock.lock()
        guard pending < policy.pendingLimit else { lock.unlock(); return false }
        pending += 1
        lock.unlock()
        queue.async {
            defer { self.lock.lock(); self.pending -= 1; self.lock.unlock() }
            do { try self.write(entry) } catch { onFailure() }
        }
        return true
    }

    func beginRun(_ id: UUID, at date: Date, onFailure: @escaping @Sendable () -> Void) {
        queue.async {
            do {
                try self.prepareDirectory()
                let data = try self.encoder.encode(Marker(runID: id, startedAt: date))
                try data.write(to: self.markerURL, options: [.atomic])
                try self.manager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: self.markerURL.path)
            } catch { onFailure() }
        }
    }

    func endRun(_ id: UUID, onFailure: @escaping @Sendable () -> Void) {
        queue.async {
            do {
                guard self.manager.fileExists(atPath: self.markerURL.path) else { return }
                let marker = try self.decoder.decode(Marker.self, from: Data(contentsOf: self.markerURL))
                // A late cancellation cannot close a newer run's marker.
                if marker.runID == id { try self.manager.removeItem(at: self.markerURL) }
            } catch { onFailure() }
        }
    }

    func flush(_ completion: @escaping @Sendable () -> Void) { queue.async(execute: completion) }

    func export(to destination: URL, completion: @escaping @Sendable (Result<Void, Error>) -> Void) {
        queue.async {
            let staging = self.manager.temporaryDirectory.appendingPathComponent("nio-playback-logs-" + UUID().uuidString, isDirectory: true)
            let partial = destination.deletingLastPathComponent().appendingPathComponent(".nio-playback-" + UUID().uuidString + ".zip")
            do {
                try self.prepareDirectory()
                try self.manager.createDirectory(at: staging, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
                for file in try self.logFiles() { try self.manager.copyItem(at: file, to: staging.appendingPathComponent(file.lastPathComponent)) }
                if self.manager.fileExists(atPath: self.markerURL.path) {
                    try self.manager.copyItem(at: self.markerURL, to: staging.appendingPathComponent("active-run.json"))
                }
                let manifest = "NIO Warp 自动演示诊断日志\n日志保留最多 7 天 / 200 MB。\n不包含云端链接、分享口令、按键内容、脚本或校正参数。\n未闭合运行表示未记录正常结束，不能单凭此判断为崩溃。\n"
                try Data(manifest.utf8).write(to: staging.appendingPathComponent("说明.txt"))
                // Compression runs on a second queue: a large export cannot delay
                // new session markers or block the bounded live log writer.
                self.archiveQueue.async {
                    defer { try? self.manager.removeItem(at: staging); try? self.manager.removeItem(at: partial) }
                    do {
                        let process = Process()
                        process.executableURL = URL(fileURLWithPath: "/usr/bin/ditto")
                        process.arguments = ["-c", "-k", "--sequesterRsrc", "--keepParent", staging.path, partial.path]
                        process.standardOutput = FileHandle.nullDevice; process.standardError = FileHandle.nullDevice
                        try process.run(); process.waitUntilExit()
                        guard process.terminationStatus == 0 else { throw ProtoPiePlaybackValidationError.invalid("日志归档失败，请检查目标目录空间。") }
                        if self.manager.fileExists(atPath: destination.path) {
                            _ = try self.manager.replaceItemAt(destination, withItemAt: partial)
                        } else { try self.manager.moveItem(at: partial, to: destination) }
                        try self.manager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: destination.path)
                        completion(.success(()))
                    } catch { completion(.failure(error)) }
                }
            } catch {
                try? self.manager.removeItem(at: staging)
                completion(.failure(error))
            }
        }
    }

    private func prepareDirectory() throws {
        try manager.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    }

    private func write(_ entry: Entry) throws {
        try prepareDirectory()
        var data = try encoder.encode(entry); data.append(0x0a)
        let formatter = DateFormatter(); formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0); formatter.dateFormat = "yyyyMMdd"
        let day = formatter.string(from: entry.timestamp)
        let size = activeFile.flatMap { try? manager.attributesOfItem(atPath: $0.path)[.size] as? NSNumber }?.intValue ?? 0
        if activeFile == nil || activeDay != day || size + data.count > policy.maximumFileBytes {
            let millis = String(format: "%013.0f", entry.timestamp.timeIntervalSince1970 * 1_000)
            activeFile = directory.appendingPathComponent("playback-\(day)-\(millis)-\(UUID().uuidString.prefix(8)).jsonl")
            activeDay = day
        }
        guard let file = activeFile else { return }
        if !manager.fileExists(atPath: file.path) {
            guard manager.createFile(atPath: file.path, contents: nil, attributes: [.posixPermissions: 0o600]) else {
                throw ProtoPiePlaybackValidationError.invalid("无法创建播放日志文件。")
            }
        }
        let handle = try FileHandle(forWritingTo: file)
        defer { try? handle.close() }
        try handle.seekToEnd(); try handle.write(contentsOf: data)
        // Close commits each small batch to the kernel; flush() orders all writes.
        // Critical lifecycle markers use atomic file replacement above.
        try prune(at: entry.timestamp)
    }

    private func logFiles() throws -> [URL] {
        try manager.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.isRegularFileKey, .contentModificationDateKey, .fileSizeKey])
            .filter { url in
                url.lastPathComponent.hasPrefix("playback-") && url.pathExtension == "jsonl"
                    && ((try? url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true)
            }.sorted { $0.lastPathComponent < $1.lastPathComponent }
    }

    private func prune(at date: Date) throws {
        var files: [(URL, Int)] = []
        for file in try logFiles() {
            let attributes = try file.resourceValues(forKeys: [.contentModificationDateKey, .fileSizeKey])
            if file != activeFile, let modified = attributes.contentModificationDate,
               date.timeIntervalSince(modified) > policy.maximumAge {
                try manager.removeItem(at: file)
            } else { files.append((file, attributes.fileSize ?? 0)) }
        }
        var total = files.reduce(0) { $0 + $1.1 }
        for (file, size) in files where total > policy.maximumBytes && file != activeFile {
            try manager.removeItem(at: file); total -= size
        }
    }

    private func readRecent() throws -> [Entry] {
        var result: [Entry] = []
        for file in try logFiles().reversed() {
            // Generated files are bounded; never load a foreign oversized log.
            let size = (try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
            guard size <= max(policy.maximumFileBytes * 2, 16_384) else { continue }
            let data = try Data(contentsOf: file)
            let decoded = data.split(separator: 0x0a).suffix(200).compactMap { try? decoder.decode(Entry.self, from: Data($0)) }
            result.insert(contentsOf: decoded, at: 0)
            if result.count >= 200 { break }
        }
        return Array(result.suffix(200))
    }
}
