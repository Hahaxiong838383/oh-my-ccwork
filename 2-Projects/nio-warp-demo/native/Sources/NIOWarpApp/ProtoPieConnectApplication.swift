import AppKit
import Foundation

/// Explicit user action only. Connect's login, account and lifecycle remain its own.
@MainActor enum ProtoPieConnectApplication {
    static func open() async throws {
        let directories = [FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Applications"),
                           URL(fileURLWithPath: "/Applications", isDirectory: true)]
        guard let app = directories.map({ $0.appendingPathComponent("ProtoPie Connect.app", isDirectory: true) })
            .first(where: { FileManager.default.fileExists(atPath: $0.appendingPathComponent("Contents/Info.plist").path) }) else {
            throw ProtoPieError.missingApplication("未找到 ProtoPie Connect，请先安装并在其中登录、加载原型。")
        }
        let options = NSWorkspace.OpenConfiguration()
        options.activates = true
        options.createsNewApplicationInstance = false
        _ = try await NSWorkspace.shared.openApplication(at: app, configuration: options)
    }
}
