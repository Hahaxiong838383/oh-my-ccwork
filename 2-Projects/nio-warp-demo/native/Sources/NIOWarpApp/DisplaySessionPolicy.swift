import Foundation

struct WarpScreenCandidate: Equatable {
    var id: UInt32
    var isBuiltIn: Bool
    var area: Double
}

struct WarpScreenSelection: Equatable {
    var controlID: UInt32
    var outputID: UInt32
}

enum DisplaySessionPolicy {
    static func shouldTerminateAfterWindowClose(isReconfiguring: Bool, controlWindowVisible: Bool, controlWindowMiniaturized: Bool) -> Bool {
        !isReconfiguring && !controlWindowVisible && !controlWindowMiniaturized
    }

    static func selection(screens: [WarpScreenCandidate], preferredControlID: UInt32?) -> WarpScreenSelection? {
        guard screens.count >= 2 else { return nil }
        let control = screens.first(where: { $0.isBuiltIn })
            ?? screens.first(where: { $0.id == preferredControlID })
            ?? screens[0]
        guard let output = screens.filter({ !$0.isBuiltIn && $0.id != control.id }).max(by: { $0.area < $1.area }) else { return nil }
        return WarpScreenSelection(controlID: control.id, outputID: output.id)
    }

    static func waitingMessage(hasExternalScreen: Bool) -> String {
        hasExternalScreen
            ? "当前没有独立的控制屏和输出屏，先保持待机。请打开笔记本内屏或再连接一块显示器；不会接管唯一的操作屏幕。"
            : "未检测到外接屏幕，已进入待机。控制台可查看参数、预览和导出；连接外屏后会自动启用，当前不会捕获或覆盖笔记本内屏。"
    }
}
