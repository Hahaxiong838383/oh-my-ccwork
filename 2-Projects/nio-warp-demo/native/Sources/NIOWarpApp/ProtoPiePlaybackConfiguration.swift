import Foundation

enum ProtoPiePlaybackValidationError: LocalizedError, Equatable {
    case invalid(String)
    var errorDescription: String? { if case let .invalid(message) = self { return message }; return nil }
}

struct ProtoPiePlaybackLibrary: Codable, Equatable {
    var schemaVersion = 1
    var items: [ProtoPiePlaylistItem] = []
    var selectedItemID: UUID?
    var plan = ProtoPiePlaybackPlan()

    func validate() throws {
        guard schemaVersion == 1 else { throw ProtoPiePlaybackValidationError.invalid("播放计划版本暂不支持，请保留原数据。") }
        guard items.count <= 100 else { throw ProtoPiePlaybackValidationError.invalid("播放列表最多支持 100 个来源。") }
        guard Set(items.map(\.id)).count == items.count else { throw ProtoPiePlaybackValidationError.invalid("播放列表含重复标识。") }
        if let selectedItemID, !items.contains(where: { $0.id == selectedItemID }) {
            throw ProtoPiePlaybackValidationError.invalid("当前选中的播放来源已不存在。")
        }
        try plan.validate()
        for item in items { try item.validate() }
    }
}

struct ProtoPiePlaylistItem: Codable, Equatable, Identifiable {
    var id = UUID()
    var name = "新演示"
    var cloudURL = ""
    var enabled = true
    var durationSeconds = 300.0
    var script = ProtoPieAutomationScript()
    var fillWidth: Bool?
    var verticalPosition: Double?

    func validate() throws {
        try ProtoPiePlaybackValidation.name(name, field: "演示名称")
        try ProtoPiePlaybackValidation.number(durationSeconds, in: 1...604_800, field: "单链接播放时长（1 秒至 7 天）")
        if let verticalPosition { try ProtoPiePlaybackValidation.number(verticalPosition, in: -1...1, field: "画面上下位置") }
        guard cloudURL.utf8.count <= 16_384 else { throw ProtoPiePlaybackValidationError.invalid("预览链接过长。") }
        // Disabled, empty entries can be saved as drafts, without making them runnable.
        if enabled || !cloudURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            var configuration = ProtoPieConfiguration(); configuration.cloudURL = cloudURL
            _ = try configuration.playbackURL()
        }
        try script.validate()
    }

    func configuration(inheriting previous: ProtoPieConfiguration) throws -> ProtoPieConfiguration {
        try validate()
        var result = previous
        result.source = .cloud
        result.cloudURL = cloudURL.trimmingCharacters(in: .whitespacesAndNewlines)
        if let fillWidth { result.fillWidth = fillWidth }
        if let verticalPosition { result.widthFitVerticalPosition = verticalPosition }
        _ = try result.playbackURL()
        return result
    }
}

struct ProtoPieAutomationScript: Codable, Equatable {
    var name = "自动演示"
    var enabled = false
    var initialization: [ProtoPieScriptStep] = []
    var steps: [ProtoPieScriptStep] = []
    /// Zero repeats until the item's dwell timer expires.
    var repeatCount = 0
    var loopInterval = 5.0
    var reloadEachLoop = false

    func validate() throws {
        try ProtoPiePlaybackValidation.name(name, field: "脚本名称")
        guard (0...10_000).contains(repeatCount) else { throw ProtoPiePlaybackValidationError.invalid("脚本循环次数应为 0～10000，0 表示驻留期间循环。") }
        try ProtoPiePlaybackValidation.number(loopInterval, in: 0.1...86_400, field: "循环间隔（至少 0.1 秒）")
        guard initialization.count <= 1_000, steps.count <= 1_000 else { throw ProtoPiePlaybackValidationError.invalid("初始化及演示脚本分别最多支持 1000 步。") }
        let all = initialization + steps
        guard Set(all.map(\.id)).count == all.count else { throw ProtoPiePlaybackValidationError.invalid("脚本含重复步骤标识。") }
        for step in all { try step.validate() }
    }
}

struct ProtoPieScriptStep: Codable, Equatable, Identifiable {
    enum Kind: String, Codable, CaseIterable {
        case wait, keyPress, keyHold, mouseMove, mouseClick, mouseDoubleClick, mouseHold, mouseDrag, scroll
    }
    enum Button: String, Codable, CaseIterable { case left, right, middle }
    var id = UUID()
    var kind: Kind = .keyPress
    var key = "Numpad2"
    var duration = 0.1
    var waitAfter = 3.0
    var x = 0.5
    var y = 0.5
    var endX = 0.7
    var endY = 0.5
    var button: Button = .left
    var deltaX = 0.0
    var deltaY = 240.0
    var repeatCount = 1

    static let supportedKeys: Set<String> = {
        var keys: Set<String> = ["Enter", "Tab", "Backspace", "Delete", "Space", "Home", "End", "PageUp", "PageDown",
            "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Equal", "Minus", "BracketLeft", "BracketRight",
            "Quote", "Semicolon", "Backslash", "Comma", "Slash", "Period", "Backquote", "NumpadDecimal",
            "NumpadMultiply", "NumpadAdd", "NumpadDivide", "NumpadSubtract", "NumpadEqual", "NumpadEnter",
            "ShiftLeft", "ShiftRight", "AltLeft", "AltRight"]
        for value in 0...9 { keys.insert("Digit\(value)"); keys.insert("Numpad\(value)") }
        for value in 1...20 { keys.insert("F\(value)") }
        for scalar in UnicodeScalar("A").value...UnicodeScalar("Z").value { keys.insert("Key\(UnicodeScalar(scalar)!)") }
        return keys
    }()

    func validate() throws {
        if kind == .keyPress || kind == .keyHold {
            guard Self.supportedKeys.contains(key) else {
                throw ProtoPiePlaybackValidationError.invalid("按键不支持。请使用 KeyA、Digit1、Numpad2 等键名；Esc、Cmd、Ctrl 不用于自动演示。")
            }
        }
        guard key.utf8.count <= 64 else { throw ProtoPiePlaybackValidationError.invalid("按键名称过长。") }
        try ProtoPiePlaybackValidation.number(duration, in: 0.01...86_400, field: "动作时长")
        try ProtoPiePlaybackValidation.number(waitAfter, in: 0...86_400, field: "动作后等待")
        for value in [x, y, endX, endY] { try ProtoPiePlaybackValidation.number(value, in: 0...1, field: "鼠标位置（0～1）") }
        for value in [deltaX, deltaY] { try ProtoPiePlaybackValidation.number(value, in: -100_000...100_000, field: "滚动距离") }
        guard (1...1_000).contains(repeatCount) else { throw ProtoPiePlaybackValidationError.invalid("步骤重复次数应为 1～1000。") }
    }
}

struct ProtoPiePlaybackPlan: Codable, Equatable {
    enum Mode: String, Codable, CaseIterable { case single, sequence }
    enum EndAction: String, Codable, CaseIterable { case keepPreview, workbench }
    var mode: Mode = .sequence
    var totalDurationSeconds: Double? = 7200
    var endAction: EndAction = .keepPreview
    var retryLimit = 3

    func validate() throws {
        if let totalDurationSeconds { try ProtoPiePlaybackValidation.number(totalDurationSeconds, in: 1...31_536_000, field: "总播放时长（1 秒至 365 天）") }
        guard (0...10).contains(retryLimit) else { throw ProtoPiePlaybackValidationError.invalid("失败重试次数应为 0～10。") }
    }
}

private enum ProtoPiePlaybackValidation {
    static func name(_ value: String, field: String) throws {
        guard !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, value.count <= 120,
              !value.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else {
            throw ProtoPiePlaybackValidationError.invalid("\(field)应为 1～120 个字符，不包含换行或控制字符。")
        }
    }
    static func number(_ value: Double, in range: ClosedRange<Double>, field: String) throws {
        guard value.isFinite, range.contains(value) else { throw ProtoPiePlaybackValidationError.invalid("\(field)数值超出允许范围。") }
    }
}

/// The playback library never overwrites the existing single-source configuration.
@MainActor final class ProtoPiePlaybackStore {
    static let storageKey = "nioWarpProtoPie.playbackLibrary.v1"
    static let unreadableBackupKey = "nioWarpProtoPie.playbackLibrary.unreadableBackup.v1"
    private let defaults: UserDefaults
    private var unreadableOriginal: Any?
    private(set) var library = ProtoPiePlaybackLibrary()
    private(set) var warning: String?

    init(defaults: UserDefaults = .standard, legacy: ProtoPieConfiguration) {
        self.defaults = defaults
        if let original = defaults.object(forKey: Self.storageKey) {
            do {
                guard let data = original as? Data, data.count <= 16_777_216 else { throw ProtoPiePlaybackValidationError.invalid("播放计划数据格式或大小无效。") }
                let decoded = try JSONDecoder().decode(ProtoPiePlaybackLibrary.self, from: data)
                try decoded.validate()
                library = decoded
            } catch {
                unreadableOriginal = original
                warning = "播放计划无法读取，原数据已保留。保存新计划时会另存原数据备份。"
            }
            return
        }
        if legacy.source == .cloud, (try? legacy.playbackURL()) != nil {
            var item = ProtoPiePlaylistItem()
            item.name = "当前预览"
            item.cloudURL = legacy.cloudURL
            library.items = [item]
            library.selectedItemID = item.id
        }
        do { try save(library) }
        catch { warning = "播放计划初始化保存失败，原预览配置未改变。" }
    }

    func save(_ next: ProtoPiePlaybackLibrary) throws {
        try next.validate()
        let data = try JSONEncoder().encode(next)
        guard data.count <= 16_777_216 else { throw ProtoPiePlaybackValidationError.invalid("播放计划超过 16 MB，无法保存。") }
        if let unreadableOriginal {
            // Preserve the last unreadable payload before an explicit replacement.
            defaults.set(unreadableOriginal, forKey: Self.unreadableBackupKey)
            warning = "无法读取的旧播放计划已另存备份，新计划已保存。"
            self.unreadableOriginal = nil
        }
        defaults.set(data, forKey: Self.storageKey)
        library = next
    }
}
