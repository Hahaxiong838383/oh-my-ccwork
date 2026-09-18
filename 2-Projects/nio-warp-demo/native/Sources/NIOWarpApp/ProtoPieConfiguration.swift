import AppKit
import Foundation

// Deliberately independent of WarpConfiguration, presets and geometry undo history.
struct ProtoPieConfiguration: Codable, Equatable {
    enum Source: String, Codable, CaseIterable { case cloud, localFile }
    var source: Source = .cloud
    var cloudURL = ""
    var fileBookmark: Data?
    var filePath = ""
    var autoStart = false
    var autoRecover = true
    var scaleToFit = true
    var hidePlayerUI = true
    var fillWidth = false
    var widthFitVerticalPosition = 0.0 {
        didSet { widthFitVerticalPosition = Self.clampedVerticalPosition(widthFitVerticalPosition) }
    }

    init() {}

    private enum CodingKeys: String, CodingKey {
        case source, cloudURL, fileBookmark, filePath, autoStart, autoRecover, scaleToFit, hidePlayerUI, fillWidth
        case widthFitVerticalPosition
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        source = try values.decode(Source.self, forKey: .source)
        cloudURL = try values.decode(String.self, forKey: .cloudURL)
        fileBookmark = try values.decodeIfPresent(Data.self, forKey: .fileBookmark)
        filePath = try values.decode(String.self, forKey: .filePath)
        autoStart = try values.decode(Bool.self, forKey: .autoStart)
        autoRecover = try values.decode(Bool.self, forKey: .autoRecover)
        scaleToFit = try values.decode(Bool.self, forKey: .scaleToFit)
        hidePlayerUI = try values.decode(Bool.self, forKey: .hidePlayerUI)
        fillWidth = try values.decodeIfPresent(Bool.self, forKey: .fillWidth) ?? false
        widthFitVerticalPosition = Self.clampedVerticalPosition(
            try values.decodeIfPresent(Double.self, forKey: .widthFitVerticalPosition) ?? 0)
    }

    private static func clampedVerticalPosition(_ value: Double) -> Double {
        value.isFinite ? min(max(value, -1), 1) : 0
    }

    var sourceLabel: String {
        if source == .localFile { return URL(fileURLWithPath: filePath).lastPathComponent }
        let path = URLComponents(string: cloudURL.trimmingCharacters(in: .whitespacesAndNewlines))?.path ?? ""
        return path.isEmpty ? "ProtoPie Cloud" : "Cloud · \(path)"
    }

    func playbackURL() throws -> URL {
        let text = cloudURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard var components = URLComponents(string: text), components.scheme?.lowercased() == "https",
              components.host?.lowercased() == "cloud.protopie.io", components.user == nil,
              components.password == nil, components.port == nil,
              components.path.hasPrefix("/p/"), components.path.split(separator: "/").count >= 2 else {
            throw ProtoPieError.invalidSource("请输入 https://cloud.protopie.io/p/ 开头的预览链接。")
        }
        var items = components.queryItems ?? []
        items.removeAll { ["ui", "scaleToFit", "bgColor"].contains($0.name) }
        items += [URLQueryItem(name: "ui", value: hidePlayerUI ? "false" : "true"),
                  URLQueryItem(name: "scaleToFit", value: scaleToFit || fillWidth ? "true" : "false"),
                  URLQueryItem(name: "bgColor", value: "#000000")]
        components.queryItems = items
        guard let result = components.url else { throw ProtoPieError.invalidSource("预览链接格式无效。") }
        return result
    }

    mutating func selectFile(_ url: URL) throws {
        guard url.isFileURL, url.pathExtension.lowercased() == "pie" else {
            throw ProtoPieError.invalidSource("请选择本地 .pie 文件。")
        }
        fileBookmark = try url.bookmarkData(options: [.withSecurityScope], includingResourceValuesForKeys: nil, relativeTo: nil)
        filePath = url.path
        source = .localFile
    }

    func resolvedFile() throws -> URL {
        guard let bookmark = fileBookmark else { throw ProtoPieError.invalidSource("请先选择 .pie 文件。") }
        var stale = false
        let url: URL
        do {
            url = try URL(resolvingBookmarkData: bookmark, options: [.withSecurityScope, .withoutUI], relativeTo: nil, bookmarkDataIsStale: &stale)
        } catch { throw ProtoPieError.invalidSource("文件引用已失效，请重新选择 .pie 文件。") }
        guard !stale, url.pathExtension.lowercased() == "pie" else {
            throw ProtoPieError.invalidSource("文件已移动或引用过期，请重新选择 .pie 文件。")
        }
        let access = url.startAccessingSecurityScopedResource()
        defer { if access { url.stopAccessingSecurityScopedResource() } }
        guard FileManager.default.isReadableFile(atPath: url.path) else {
            throw ProtoPieError.invalidSource("无法读取 .pie 文件，请检查文件位置后重新选择。")
        }
        return url
    }

    func validate() throws {
        switch source {
        case .cloud: _ = try playbackURL()
        case .localFile: _ = try resolvedFile()
        }
    }
}

enum ProtoPieError: LocalizedError, Equatable {
    case invalidSource(String), missingApplication(String), permission(String), waitingForUser(String), unavailable(String)
    var errorDescription: String? {
        switch self {
        case let .invalidSource(s), let .missingApplication(s), let .permission(s), let .waitingForUser(s), let .unavailable(s): return s
        }
    }
    var needsUserAction: Bool {
        switch self { case .invalidSource, .missingApplication, .permission, .waitingForUser: return true; case .unavailable: return false }
    }
}

enum ProtoPieRuntimeState: Equatable {
    case idle, waitingForDisplay, launching, waitingForPreview(String), capturing, running, paused, stopped, failed(String)
    var summary: String {
        switch self {
        case .idle: return "尚未启动联动"
        case .waitingForDisplay: return "等待目标外屏 · 配置可继续编辑"
        case .launching: return "正在打开预览来源…"
        case .waitingForPreview(let reason): return reason
        case .capturing: return "已识别预览窗口 · 正在等待首帧…"
        case .running: return "预览与 Warp 捕获已接通"
        case .paused: return "预览保持运行 · Warp 输出已暂停"
        case .stopped: return "联动已停止 · 本次自动恢复已取消"
        case .failed(let reason): return reason
        }
    }
    var isBusy: Bool {
        switch self { case .launching, .capturing, .waitingForPreview: return true; default: return false }
    }
}

struct ProtoPieSession: Equatable {
    var id = UUID()
    var windowID: CGWindowID
    var processID: pid_t
    var configuration: ProtoPieConfiguration
    var cloudTargetID: String?
    var title: String
    /// The complete-height source may live on an app-owned display; Warp still
    /// renders to the separately selected physical output display.
    var presentationDisplayID: CGDirectDisplayID? = nil
}

@MainActor protocol ProtoPiePreviewDriving: AnyObject {
    func setPresentationCanvas(_ canvas: CanvasConfiguration?)
    func shutdownPresentation()
    func presentationCaptured(_ session: ProtoPieSession)
    func prepare(configuration: ProtoPieConfiguration, displayID: CGDirectDisplayID,
                 progress: @escaping (String) -> Void) async throws -> ProtoPieSession
    func isAlive(_ session: ProtoPieSession) async -> Bool
    func isPresentationReady(_ session: ProtoPieSession, displayID: CGDirectDisplayID) async -> Bool
    func updatePresentationLayout(_ session: ProtoPieSession) async throws
    func release(_ session: ProtoPieSession) async
    func detach(_ session: ProtoPieSession)
    func requestFreshPreview()
    func openForUser(configuration: ProtoPieConfiguration) async throws
}

@MainActor extension ProtoPiePreviewDriving {
    func setPresentationCanvas(_ canvas: CanvasConfiguration?) { }
    func shutdownPresentation() { }
    func presentationCaptured(_ session: ProtoPieSession) { }
    func updatePresentationLayout(_ session: ProtoPieSession) async throws {
        throw ProtoPieError.unavailable("当前播放器不支持实时位置调节。")
    }
    func isPresentationReady(_ session: ProtoPieSession, displayID: CGDirectDisplayID) async -> Bool { true }
    func detach(_ session: ProtoPieSession) { }
    func requestFreshPreview() { }
}
