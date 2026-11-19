import AppKit
import Foundation

/// Bounded local evidence only: never record the private page URL, title, asset
/// URL, JavaScript result text, or raw CDP error description.
@MainActor enum ProtoPiePresentationDiagnostics {
    static let defaultsKey = "nioWarpProtoPie.presentationDiagnostic.v1"
    static let maximumRecords = 24
    enum Stage: String {
        case monitorStart, monitorWindow, monitorGeometry, monitorLayout, monitorComplete
        case prepareStart, prepareRestore, preparePlacement, prepareFullscreen, prepareGeometry, prepareLayout, prepareComplete
    }
    enum Issue: String {
        case outputUnavailable, sourceUnavailable, sourceSizeMismatch, windowUnavailable, invalidViewport
        case requestFailed, layoutNotReady, geometryNotReady, placementNotReady, timeout
    }

    static func timeoutMessage(geometryStable: Bool, layoutReady: Bool?) -> String {
        if geometryStable, layoutReady == false {
            return "播放器已无边框全屏，但内部画面布局尚未就绪，暂不切换捕获。请点击启动/重试。"
        }
        return "尚未确认播放器已无边框全屏，暂不切换捕获。请点击启动/重试。"
    }

    static func record(stage: Stage, sourceDisplayID: CGDirectDisplayID, outputDisplayID: CGDirectDisplayID? = nil,
                       processID: pid_t, windowID: CGWindowID? = nil, targetFrame: CGRect? = nil,
                       observation: ProtoPieFullscreenObservation? = nil, browserFrame: CGRect? = nil,
                       windowState: String? = nil, viewportPixels: CGSize? = nil,
                       geometryStable: Bool? = nil, layoutReady: Bool? = nil, issue: Issue? = nil,
                       defaults: UserDefaults = .standard) {
        func rect(_ value: CGRect) -> [Double]? {
            let values = [Double(value.minX), Double(value.minY), Double(value.width), Double(value.height)]
            return values.allSatisfy(\.isFinite) ? values : nil
        }
        var entry: [String: Any] = ["stage": stage.rawValue, "sourceDisplayID": sourceDisplayID,
            "processID": processID, "timestamp": Date().timeIntervalSince1970,
            "frontProcessID": NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0]
        if let outputDisplayID { entry["outputDisplayID"] = outputDisplayID }
        if let windowID = observation?.windowID ?? windowID { entry["windowID"] = windowID }
        if let targetFrame, let value = rect(targetFrame) { entry["targetFrame"] = value }
        if let observation, let value = rect(observation.frame) { entry["capturedFrame"] = value }
        if let frame = observation?.browserFrame ?? browserFrame, let value = rect(frame) { entry["browserFrame"] = value }
        if let state = observation?.windowState ?? windowState {
            entry["windowState"] = ["normal", "minimized", "maximized", "fullscreen"].contains(state) ? state : "unknown"
        }
        if let size = observation?.viewportPixels ?? viewportPixels, size.width.isFinite, size.height.isFinite {
            entry["viewportPixels"] = [Double(size.width), Double(size.height)]
        }
        if let observation, observation.displayScale.isFinite { entry["displayScale"] = observation.displayScale }
        if let observation, let targetFrame { entry["geometryReady"] = observation.isReady(for: targetFrame) }
        if let geometryStable { entry["geometryStable"] = geometryStable }
        if let layoutReady { entry["layoutReady"] = layoutReady }
        if let issue { entry["issue"] = issue.rawValue }
        var history = [[String: Any]]()
        if let data = defaults.data(forKey: defaultsKey),
           let previous = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let records = previous["recent"] as? [[String: Any]] {
            history = Array(records.suffix(maximumRecords - 1))
        }
        history.append(entry)
        guard let data = try? JSONSerialization.data(withJSONObject: ["current": entry, "recent": history], options: [.sortedKeys]) else { return }
        defaults.set(data, forKey: defaultsKey)
    }
}
