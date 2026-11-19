import Foundation

struct WarpScreenCandidate: Equatable {
    var id: UInt32
    var isBuiltIn: Bool
    var area: Double
}

struct WarpScreenSelection: Equatable {
    var controlID: UInt32?
    var outputID: UInt32
}

/// An external screen changing its desktop origin does not change its output
/// resources. Only the display identity, pixel mode and backing scale do.
struct WarpOutputDisplayState: Equatable {
    var id: UInt32
    var pixelWidth: Int
    var pixelHeight: Int
    var scale: Double
}

enum DisplaySessionPolicy {
    static func shouldTerminateAfterWindowClose(isReconfiguring: Bool, controlWindowVisible: Bool, controlWindowMiniaturized: Bool) -> Bool {
        !isReconfiguring && !controlWindowVisible && !controlWindowMiniaturized
    }

    static func selection(screens: [WarpScreenCandidate], preferredControlID: UInt32?, preferredOutputID: UInt32? = nil) -> WarpScreenSelection? {
        if let output = screens.first(where: { !$0.isBuiltIn && $0.id == preferredOutputID }) {
            let controls = screens.filter { $0.id != output.id }
            let control = controls.first(where: { $0.isBuiltIn })
                ?? controls.first(where: { $0.id == preferredControlID })
                ?? controls.first
            return WarpScreenSelection(controlID: control?.id, outputID: output.id)
        }
        if screens.count == 1, let output = screens.first, !output.isBuiltIn {
            return WarpScreenSelection(controlID: nil, outputID: output.id)
        }
        guard screens.count >= 2 else { return nil }
        let control = screens.first(where: { $0.isBuiltIn })
            ?? screens.first(where: { $0.id == preferredControlID })
            ?? screens[0]
        guard let output = screens.filter({ !$0.isBuiltIn && $0.id != control.id }).max(by: { $0.area < $1.area }) else { return nil }
        return WarpScreenSelection(controlID: control.id, outputID: output.id)
    }

    static func canPreserveOutput(current: WarpOutputDisplayState?, next: WarpOutputDisplayState?, isActive: Bool, isAsleep: Bool) -> Bool {
        guard let current, let next, isActive, !isAsleep,
              next.pixelWidth > 0, next.pixelHeight > 0, next.scale.isFinite, next.scale > 0 else { return false }
        return current == next
    }

    static func waitingMessage(hasExternalScreen: Bool) -> String {
        hasExternalScreen
            ? "外接屏幕正在准备，暂时待机；显示器信息就绪后会自动恢复输出，合盖也可继续运行。"
            : "未检测到外接屏幕，已进入待机。控制台可查看参数、预览和导出；连接外屏后会自动启用，当前不会捕获或覆盖笔记本内屏。"
    }
}
