import AppKit
import ApplicationServices
import Foundation

/// Only owns dedicated Chrome targets and file-access scopes. Never terminates Chrome or Studio.
@MainActor final class ProtoPieSystemDriver: ProtoPiePreviewDriving {
    private let workspace = NSWorkspace.shared
    private let profileURL: URL
    private var browserSocket: URL?
    private var cloudTargets: [String: ProtoPieConfiguration] = [:]
    private var fileScopes: [UUID: URL] = [:]
    private var freshPreviewRequested = false

    deinit { for url in fileScopes.values { url.stopAccessingSecurityScopedResource() } }

    func detach(_ session: ProtoPieSession) {
        if let url = fileScopes.removeValue(forKey: session.id) { url.stopAccessingSecurityScopedResource() }
    }
    func requestFreshPreview() { freshPreviewRequested = true }

    init(profileURL: URL? = nil) {
        self.profileURL = profileURL ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("NIOWarp/ProtoPieChrome", isDirectory: true)
    }

    func prepare(configuration: ProtoPieConfiguration, displayID: CGDirectDisplayID,
                 progress: @escaping (String) -> Void) async throws -> ProtoPieSession {
        try configuration.validate()
        switch configuration.source {
        case .cloud: return try await prepareCloud(configuration, displayID: displayID, progress: progress)
        case .localFile: return try await prepareStudio(configuration, displayID: displayID, progress: progress)
        }
    }

    func isAlive(_ session: ProtoPieSession) async -> Bool {
        guard NSRunningApplication(processIdentifier: session.processID)?.isTerminated == false,
              Self.windows().contains(where: { $0.id == session.windowID && $0.pid == session.processID }) else { return false }
        if let target = session.cloudTargetID {
            guard let socket = browserSocket,
                  let result = try? await ProtoPieCDP.call(socket, method: "Target.getTargetInfo", parameters: ["targetId": target]),
                  let info = result["targetInfo"] as? [String: Any], let url = info["url"] as? String,
                  let actual = URLComponents(string: url), let expected = try? session.configuration.playbackURL() else { return false }
            return actual.host == expected.host && actual.path == expected.path
        }
        return true
    }

    func isPresentationReady(_ session: ProtoPieSession, displayID: CGDirectDisplayID) async -> Bool {
        guard let target = session.cloudTargetID else { return true }
        guard CGDisplayIsActive(displayID) != 0, let socket = browserSocket,
              let captured = Self.windows().first(where: { $0.id == session.windowID && $0.pid == session.processID }) else { return false }
        do {
            let window = try await ProtoPieCDP.call(socket, method: "Browser.getWindowForTarget", parameters: ["targetId": target])
            guard let windowID = window["windowId"] as? Int else { return false }
            let bounds = try await cloudWindowBounds(socket: socket, windowID: windowID)
            let page = try await pageSocket(target: target, browserSocket: socket)
            guard try await ensureCloudContentLayout(page: page, configuration: session.configuration) else { return false }
            let evaluation = try await ProtoPieCDP.call(page, method: "Runtime.evaluate", parameters: [
                "expression": "({width: innerWidth * devicePixelRatio, height: innerHeight * devicePixelRatio})",
                "returnByValue": true])
            guard let value = (evaluation["result"] as? [String: Any])?["value"] as? [String: Any],
                  let width = value["width"] as? NSNumber, let height = value["height"] as? NSNumber else { return false }
            let scale = NSScreen.screens.first {
                ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value == displayID
            }?.backingScaleFactor ?? 1
            return ProtoPieFullscreenObservation(windowID: captured.id, frame: captured.frame,
                browserFrame: bounds.frame, windowState: bounds.state,
                viewportPixels: CGSize(width: width.doubleValue, height: height.doubleValue), displayScale: scale)
                .isReady(for: Self.targetRect(displayID))
        } catch { return false }
    }

    func release(_ session: ProtoPieSession) async {
        detach(session)
        if let target = session.cloudTargetID, cloudTargets.removeValue(forKey: target) != nil, let socket = browserSocket {
            _ = try? await ProtoPieCDP.call(socket, method: "Target.closeTarget", parameters: ["targetId": target])
        }
    }

    func openForUser(configuration: ProtoPieConfiguration) async throws {
        switch configuration.source {
        case .cloud:
            let (socket, target) = try await cloudTarget(configuration)
            try Task.checkCancellation()
            // This is an explicit user action. Automatic launch/recovery never steals focus
            // or moves a source back onto the control screen.
            let window = try await ProtoPieCDP.call(socket, method: "Browser.getWindowForTarget", parameters: ["targetId": target])
            guard let windowID = window["windowId"] as? Int else {
                throw ProtoPieError.unavailable("未找到本次专用播放器窗口。")
            }
            let controlScreen = NSScreen.screens.first { screen in
                guard let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber else { return false }
                return CGDisplayIsBuiltin(number.uint32Value) != 0
            } ?? NSApp.keyWindow?.screen ?? NSScreen.main ?? NSScreen.screens.first
            if let controlScreen {
                let rect = Self.manualPreviewBounds(visibleFrame: controlScreen.visibleFrame,
                                                    primaryTop: NSScreen.screens.first?.frame.maxY ?? controlScreen.frame.maxY)
                try await restoreCloudWindow(socket: socket, windowID: windowID)
                _ = try await ProtoPieCDP.call(socket, method: "Browser.setWindowBounds", parameters: [
                    "windowId": windowID, "bounds": ["left": Int(rect.minX), "top": Int(rect.minY),
                                                      "width": Int(rect.width), "height": Int(rect.height)]])
            }
            let info = try await ProtoPieCDP.call(socket, method: "SystemInfo.getProcessInfo")
            guard let processes = info["processInfo"] as? [[String: Any]],
                  let processID = processes.first(where: { $0["type"] as? String == "browser" })?["id"] as? NSNumber,
                  let browser = NSRunningApplication(processIdentifier: processID.int32Value) else {
                throw ProtoPieError.unavailable("无法激活本次专用播放器进程，请重试。")
            }
            try Task.checkCancellation()
            NSApp.yieldActivation(to: browser)
            browser.activate(from: NSRunningApplication.current, options: [])
            _ = try await ProtoPieCDP.call(socket, method: "Target.activateTarget", parameters: ["targetId": target])
        case .localFile:
            let file = try configuration.resolvedFile()
            let scoped = file.startAccessingSecurityScopedResource()
            defer { if scoped { file.stopAccessingSecurityScopedResource() } }
            _ = try await openStudio(file: file, activates: true)
        }
    }

    private func prepareCloud(_ configuration: ProtoPieConfiguration, displayID: CGDirectDisplayID,
                              progress: @escaping (String) -> Void) async throws -> ProtoPieSession {
        progress("正在打开专用 ProtoPie Cloud 播放窗口…")
        let (socket, target) = try await cloudTarget(configuration)
        let info = try await ProtoPieCDP.call(socket, method: "SystemInfo.getProcessInfo")
        guard let processes = info["processInfo"] as? [[String: Any]],
              let pidNumber = processes.first(where: { $0["type"] as? String == "browser" })?["id"] as? NSNumber else {
            throw ProtoPieError.unavailable("无法识别专用播放器进程；请重试。")
        }
        let pid = pid_t(pidNumber.int32Value)
        let window = try await ProtoPieCDP.call(socket, method: "Browser.getWindowForTarget", parameters: ["targetId": target])
        guard let browserWindowID = window["windowId"] as? Int else { throw ProtoPieError.unavailable("播放器没有可捕获窗口。") }
        let pageSocket = try await pageSocket(target: target, browserSocket: socket)
        let expected = try configuration.playbackURL()
        let marker = "NIO Warp Preview · \(UUID().uuidString.prefix(8))"
        let expression = Self.cloudReadinessExpression(expectedURL: expected, marker: marker)
        var previousProblem = ""
        var problemSamples = 0
        for _ in 0..<60 {
            try Task.checkCancellation()
            let evaluation = try await ProtoPieCDP.call(pageSocket, method: "Runtime.evaluate", parameters: ["expression": expression, "returnByValue": true])
            let value = (evaluation["result"] as? [String: Any])?["value"] as? [String: Any] ?? [:]
            if let problem = value["problem"] as? String, !problem.isEmpty {
                // Login redirects can appear briefly while a new Cloud window restores its session.
                problemSamples = problem == previousProblem ? problemSamples + 1 : 1
                previousProblem = problem
                if problemSamples >= 3 { throw ProtoPieError.waitingForUser(problem) }
            } else {
                previousProblem = ""; problemSamples = 0
            }
            if value["ready"] as? Bool == true {
                progress("正在进入外屏无边框全屏，等待画面尺寸稳定…")
                let captured = try await prepareCloudFullscreen(socket: socket, pageSocket: pageSocket,
                    windowID: browserWindowID, processID: pid, marker: marker, displayID: displayID,
                    configuration: configuration)
                return ProtoPieSession(windowID: captured.id, processID: pid, configuration: configuration,
                                       cloudTargetID: target, title: "ProtoPie Cloud · 无边框全屏")
            }
            progress("等待云端预览加载；如需登录，请在专用播放器中完成。")
            try await Task.sleep(nanoseconds: 500_000_000)
        }
        throw ProtoPieError.waitingForUser("尚未识别到已加载的 ProtoPie 预览。请打开播放器检查登录、链接权限或网络后重试。")
    }

    private func cloudWindowBounds(socket: URL, windowID: Int) async throws -> (frame: CGRect, state: String) {
        let result = try await ProtoPieCDP.call(socket, method: "Browser.getWindowBounds", parameters: ["windowId": windowID])
        guard let bounds = result["bounds"] as? [String: Any],
              let x = bounds["left"] as? NSNumber, let y = bounds["top"] as? NSNumber,
              let width = bounds["width"] as? NSNumber, let height = bounds["height"] as? NSNumber,
              let state = bounds["windowState"] as? String else {
            throw ProtoPieError.unavailable("无法读取专用播放器的窗口状态。")
        }
        return (CGRect(x: x.doubleValue, y: y.doubleValue, width: width.doubleValue, height: height.doubleValue), state)
    }

    /// macOS fullscreen transitions are asynchronous, even after CDP acknowledges the command.
    private func restoreCloudWindow(socket: URL, windowID: Int) async throws {
        try Task.checkCancellation()
        _ = try await ProtoPieCDP.call(socket, method: "Browser.setWindowBounds", parameters: [
            "windowId": windowID, "bounds": ["windowState": "normal"]])
        var readiness = ProtoPieWindowRestoreReadiness()
        let deadline = ProcessInfo.processInfo.systemUptime + 10
        while ProcessInfo.processInfo.systemUptime < deadline {
            try Task.checkCancellation()
            let bounds = try await cloudWindowBounds(socket: socket, windowID: windowID)
            try Task.checkCancellation()
            guard ProcessInfo.processInfo.systemUptime < deadline else { break }
            switch readiness.observe(frame: bounds.frame, state: bounds.state) {
            case .ready: return
            case .requestNormal:
                // Fullscreen may have exited to a restored maximized window. Unmaximize only
                // after three matching samples, once per restore attempt, within the same deadline.
                _ = try await ProtoPieCDP.call(socket, method: "Browser.setWindowBounds", parameters: [
                    "windowId": windowID, "bounds": ["windowState": "normal"]])
            case .waiting: break
            }
            try await Task.sleep(nanoseconds: 150_000_000)
        }
        throw ProtoPieError.unavailable("播放器退出全屏尚未完成，请重试。")
    }

    func updatePresentationLayout(_ session: ProtoPieSession) async throws {
        guard let target = session.cloudTargetID, let socket = browserSocket,
              session.configuration.source == .cloud, session.configuration.fillWidth else {
            throw ProtoPieError.unavailable("请先启动横向顶满的 Cloud 预览。")
        }
        let page = try await pageSocket(target: target, browserSocket: socket)
        for _ in 0..<10 {
            try Task.checkCancellation()
            if try await ensureCloudContentLayout(page: page, configuration: session.configuration) { return }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        throw ProtoPieError.unavailable("画面位置尚未更新，请等待预览加载后再调整。")
    }

    private func ensureCloudContentLayout(page: URL, configuration: ProtoPieConfiguration) async throws -> Bool {
        try Task.checkCancellation()
        let expression = ProtoPieWidthFit.expression(enabled: configuration.fillWidth,
            verticalPosition: configuration.widthFitVerticalPosition, expectedURL: try configuration.playbackURL())
        let evaluation = try await ProtoPieCDP.call(page, method: "Runtime.evaluate", parameters: [
            "expression": expression, "returnByValue": true])
        return ((evaluation["result"] as? [String: Any])?["value"] as? [String: Any])?["ready"] as? Bool == true
    }

    private func prepareCloudFullscreen(socket: URL, pageSocket: URL, windowID: Int, processID: pid_t,
                                        marker: String, displayID: CGDirectDisplayID,
                                        configuration: ProtoPieConfiguration) async throws -> WindowRecord {
        guard CGDisplayIsActive(displayID) != 0 else { throw ProtoPieError.unavailable("目标外屏不可用。") }
        let target = Self.targetRect(displayID)
        let displayScale = NSScreen.screens.first {
            ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value == displayID
        }?.backingScaleFactor ?? 1
        let bounds = try await cloudWindowBounds(socket: socket, windowID: windowID)
        // Reuse an already-fullscreen source without leaving its Space or flashing a title bar.
        if bounds.state != "fullscreen" || !ProtoPieFullscreenObservation.matches(bounds.frame, target) {
            try await restoreCloudWindow(socket: socket, windowID: windowID)
            _ = try await ProtoPieCDP.call(socket, method: "Browser.setWindowBounds", parameters: [
                "windowId": windowID, "bounds": ["left": Int(target.minX), "top": Int(target.minY),
                                                  "width": Int(target.width), "height": Int(target.height)]])
            // The normal window may be constrained by the menu bar/Dock. Its centre must first
            // reach the chosen display, otherwise macOS can enter fullscreen on the control screen.
            let placementDeadline = ProcessInfo.processInfo.systemUptime + 10
            var placed = false
            while ProcessInfo.processInfo.systemUptime < placementDeadline {
                try Task.checkCancellation()
                let moved = try await cloudWindowBounds(socket: socket, windowID: windowID)
                if moved.state != "fullscreen", target.contains(CGPoint(x: moved.frame.midX, y: moved.frame.midY)) {
                    placed = true; break
                }
                try await Task.sleep(nanoseconds: 150_000_000)
            }
            guard placed else { throw ProtoPieError.unavailable("播放器尚未移到目标外屏，请重试。") }
            _ = try await ProtoPieCDP.call(socket, method: "Browser.setWindowBounds", parameters: [
                "windowId": windowID, "bounds": ["windowState": "fullscreen"]])
        }
        var readiness = ProtoPieFullscreenReadiness()
        let deadline = ProcessInfo.processInfo.systemUptime + 12
        while ProcessInfo.processInfo.systemUptime < deadline {
            try Task.checkCancellation()
            let actual = try await cloudWindowBounds(socket: socket, windowID: windowID)
            let evaluation = try await ProtoPieCDP.call(pageSocket, method: "Runtime.evaluate", parameters: [
                "expression": "({width: innerWidth * devicePixelRatio, height: innerHeight * devicePixelRatio})",
                "returnByValue": true])
            let value = (evaluation["result"] as? [String: Any])?["value"] as? [String: Any]
            let captured = Self.windows().first { $0.pid == processID && $0.title.contains(marker) }
            var observation: ProtoPieFullscreenObservation?
            if let captured, let width = value?["width"] as? NSNumber, let height = value?["height"] as? NSNumber {
                observation = ProtoPieFullscreenObservation(windowID: captured.id, frame: captured.frame,
                    browserFrame: actual.frame, windowState: actual.state,
                    viewportPixels: CGSize(width: width.doubleValue, height: height.doubleValue), displayScale: displayScale)
            }
            if readiness.observe(observation, targetFrame: target), let captured,
               try await ensureCloudContentLayout(page: pageSocket, configuration: configuration) { return captured }
            try await Task.sleep(nanoseconds: 150_000_000)
        }
        throw ProtoPieError.unavailable("尚未确认播放器已无边框全屏，暂不切换捕获。请点击启动/重试。")
    }

    private func cloudTarget(_ configuration: ProtoPieConfiguration) async throws -> (URL, String) {
        let url = try configuration.playbackURL()
        let fresh = freshPreviewRequested; freshPreviewRequested = false
        if let socket = await existingBrowserSocket() {
            browserSocket = socket
            if !fresh, let targets = try? await targets(socket) {
                // Reuse a source we created, including a login page awaiting the user's action.
                if let reused = cloudTargets.first(where: { pair in
                    pair.value == configuration && targets.contains(where: { $0["targetId"] as? String == pair.key })
                }) { return (socket, reused.key) }
                // After an app restart, the dedicated profile can still have its playback window.
                if let restored = targets.first(where: { $0["type"] as? String == "page" && $0["url"] as? String == url.absoluteString }),
                   let id = restored["targetId"] as? String {
                    cloudTargets[id] = configuration; return (socket, id)
                }
            }
        }
        guard let chrome = applicationURL(bundleIdentifiers: ["com.google.Chrome"], names: ["Google Chrome.app"]) else {
            throw ProtoPieError.missingApplication("未找到 Google Chrome。请安装后重试；云端联动使用独立的播放器配置。")
        }
        try FileManager.default.createDirectory(at: profileURL, withIntermediateDirectories: true)
        let knownTargets: Set<String>
        if let socket = browserSocket, let targets = try? await targets(socket) {
            knownTargets = Set(targets.compactMap { $0["targetId"] as? String })
        } else { knownTargets = [] }
        let config = NSWorkspace.OpenConfiguration()
        config.createsNewApplicationInstance = true
        config.activates = false
        config.arguments = ["--user-data-dir=\(profileURL.path)", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0",
                            "--no-first-run", "--no-default-browser-check", "--disable-background-timer-throttling",
                            "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows", "--app=\(url.absoluteString)"]
        _ = try await workspace.openApplication(at: chrome, configuration: config)
        for _ in 0..<40 {
            try Task.checkCancellation()
            if let socket = await existingBrowserSocket(), let targets = try? await targets(socket),
               let target = Self.newCloudTarget(targets, excluding: knownTargets, expectedURL: url),
               let id = target["targetId"] as? String {
                browserSocket = socket; cloudTargets[id] = configuration; return (socket, id)
            }
            try await Task.sleep(nanoseconds: 250_000_000)
        }
        throw ProtoPieError.unavailable("专用 Chrome 调试连接未就绪，请打开播放器后重试。")
    }

    nonisolated static func newCloudTarget(_ targets: [[String: Any]], excluding known: Set<String>, expectedURL: URL) -> [String: Any]? {
        let newPages = targets.filter { target in
            guard let id = target["targetId"] as? String else { return false }
            return !known.contains(id) && target["type"] as? String == "page"
        }
        if let exact = newPages.first(where: { $0["url"] as? String == expectedURL.absoluteString }) { return exact }
        // A login redirect can happen before target enumeration. Only bind an unambiguous
        // newly-created page in our isolated profile; readiness still verifies the actual source.
        if newPages.count == 1, let text = newPages[0]["url"] as? String, let current = URL(string: text),
           current.host == "cloud.protopie.io" || current.host == "accounts.protopie.io" { return newPages[0] }
        return nil
    }

    private func existingBrowserSocket() async -> URL? {
        guard let text = try? String(contentsOf: profileURL.appendingPathComponent("DevToolsActivePort"), encoding: .utf8) else { return nil }
        let lines = text.split(whereSeparator: \.isNewline)
        guard lines.count >= 2, let port = Int(lines[0]), (1...65535).contains(port), lines[1].hasPrefix("/devtools/browser/"),
              let socket = URL(string: "ws://127.0.0.1:\(port)\(lines[1])"),
              (try? await ProtoPieCDP.call(socket, method: "Browser.getVersion")) != nil else { return nil }
        return socket
    }

    private func targets(_ socket: URL) async throws -> [[String: Any]] {
        let result = try await ProtoPieCDP.call(socket, method: "Target.getTargets")
        return result["targetInfos"] as? [[String: Any]] ?? []
    }

    private func pageSocket(target: String, browserSocket: URL) async throws -> URL {
        guard let port = browserSocket.port, let url = URL(string: "http://127.0.0.1:\(port)/json/list") else {
            throw ProtoPieError.unavailable("专用播放器连接无效。")
        }
        var request = URLRequest(url: url); request.timeoutInterval = 5
        let (data, _) = try await URLSession.shared.data(for: request)
        guard let pages = try JSONSerialization.jsonObject(with: data) as? [[String: Any]],
              let text = pages.first(where: { $0["id"] as? String == target })?["webSocketDebuggerUrl"] as? String,
              let socket = URL(string: text), socket.host == "127.0.0.1" || socket.host == "localhost",
              socket.port == port else { throw ProtoPieError.unavailable("无法连接本次预览页面。") }
        return socket
    }

    nonisolated static func cloudReadinessExpression(expectedURL: URL, marker: String) -> String {
        // JSON serialization keeps user-provided URL/query text out of executable JavaScript.
        let arguments = (try? JSONSerialization.data(withJSONObject: [expectedURL.path, marker])).flatMap { String(data: $0, encoding: .utf8) } ?? "[]"
        return """
        (() => {
          const [expectedPath, marker] = \(arguments);
          if (location.href === 'about:blank' || document.readyState === 'loading') return {ready:false};
          const problem = message => document.readyState === 'complete' ? {problem:message} : {ready:false};
          const visible = e => { const r=e.getBoundingClientRect(); return r.width>8 && r.height>8 && getComputedStyle(e).visibility!=='hidden'; };
          const text=(document.body?.innerText || '').slice(0,12000);
          if (location.hostname !== 'cloud.protopie.io' || /\\/(login|signin|sign-in|auth)(\\/|$)/i.test(location.pathname))
            return problem('播放器需要登录，请在专用窗口完成登录后重试。');
          if ([...document.querySelectorAll('input[type=password]')].some(visible))
            return problem('预览需要登录或访问密码，请在专用窗口完成后重试。');
          if (/prototype (was |is )?(not found|deleted)|you (do not|don.t) have (access|permission)|access denied/i.test(text))
            return problem('该预览不存在或当前账号无权访问，请检查链接。');
          const canvases=[...document.querySelectorAll('canvas')].filter(e=>visible(e)&&e.width>16&&e.height>16);
          const videos=[...document.querySelectorAll('video')].filter(e=>visible(e)&&e.readyState>=2);
          const player=document.querySelector('[data-testid="player"], [data-testid="prototype-player"], #player, .prototype-player, [class*="PiePlayer"], [class*="pie-player"]');
          // The current DOM player can occupy only a third of an ultrawide viewport.
          // Recognize its rendered layers without treating an empty mount as ready.
          const webPlayer=document.querySelector('#webplayer-root');
          const renderedWebPlayer=webPlayer && visible(webPlayer) &&
            [...webPlayer.querySelectorAll('[class*="ContainerLayer"], [class*="TextLayer"]')].some(visible);
          const layerImages=[...document.querySelectorAll('img')].filter(e=>visible(e)&&e.complete&&e.naturalWidth>16&&e.naturalHeight>16&&!/logo|avatar|icon/i.test(e.alt+' '+e.className+' '+e.src));
          const viewportArea=Math.max(1,innerWidth*innerHeight);
          const substantialImage=layerImages.some(e=>{ const r=e.getBoundingClientRect();
            return r.width>=innerWidth*.45 && r.height>=innerHeight*.06 && r.width*r.height>=viewportArea*.06; });
          // A playable prototype can precede window.load while unrelated Cloud resources are pending.
          const ready=location.pathname===expectedPath && ['interactive','complete'].includes(document.readyState) &&
            (canvases.length>0 || videos.length>0 || (player && visible(player)) || renderedWebPlayer || substantialImage);
          if(ready) document.title=marker;
          return {ready:!!ready};
        })()
        """
    }

    private func prepareStudio(_ configuration: ProtoPieConfiguration, displayID: CGDirectDisplayID,
                               progress: @escaping (String) -> Void) async throws -> ProtoPieSession {
        guard AXIsProcessTrusted() else {
            throw ProtoPieError.permission("本地预览需要 NIO Warp 的辅助功能权限。请点击“辅助功能权限”，授权后重试。")
        }
        let file = try configuration.resolvedFile()
        let scoped = file.startAccessingSecurityScopedResource()
        var retained = false
        defer { if scoped && !retained { file.stopAccessingSecurityScopedResource() } }
        progress("正在用 ProtoPie Studio 打开文件…")
        let app = try await openStudio(file: file, activates: false)
        let pid = app.processIdentifier
        let axApp = AXUIElementCreateApplication(pid)
        let filename = file.deletingPathExtension().lastPathComponent
        var previewPressed = false
        for tick in 0..<60 {
            try Task.checkCancellation()
            let windows = Self.axChildren(axApp, attribute: kAXWindowsAttribute)
            let document = windows.first { window in
                let title = Self.axString(window, kAXTitleAttribute)
                let documentURL = Self.axString(window, kAXDocumentAttribute)
                return documentURL == file.absoluteString || (!Self.isPreviewTitle(title) && title.localizedCaseInsensitiveContains(filename))
            }
            let previews = windows.filter { Self.isPreviewTitle(Self.axString($0, kAXTitleAttribute)) }
            // Only accept a preview whose title identifies this document. A generic preview must
            // be the sole preview, and this document must be Studio's focused document.
            let focusedDocument = Self.axElement(axApp, kAXFocusedWindowAttribute).map {
                Self.axString($0, kAXDocumentAttribute) == file.absoluteString || Self.axString($0, kAXTitleAttribute).localizedCaseInsensitiveContains(filename)
            } ?? false
            let preview = previews.first { Self.axString($0, kAXTitleAttribute).localizedCaseInsensitiveContains(filename) }
                ?? (previews.count == 1 && document != nil && focusedDocument ? previews.first : nil)
            if let preview {
                let rect = Self.targetRect(displayID)
                Self.position(preview, rect: rect)
                try await Task.sleep(nanoseconds: 200_000_000)
                let title = Self.axString(preview, kAXTitleAttribute)
                let actualRect = Self.axRect(preview)
                let matches = Self.windows().filter { $0.pid == pid && $0.title == title && Self.matches($0.frame, actualRect) }
                if matches.count == 1, let match = matches.first {
                    let session = ProtoPieSession(windowID: match.id, processID: pid, configuration: configuration, title: title)
                    if scoped { fileScopes[session.id] = file; retained = true }
                    return session
                }
            }
            if tick >= 4, previews.isEmpty, let document, !previewPressed {
                // AXPress the menu item; do not send global keystrokes into another app.
                AXUIElementSetAttributeValue(document, kAXMainAttribute as CFString, kCFBooleanTrue)
                if let menu = Self.axValue(axApp, kAXMenuBarAttribute) {
                    previewPressed = Self.pressPreviewMenu(unsafeBitCast(menu, to: AXUIElement.self), depth: 0)
                }
            }
            progress("等待当前文件的 Preview 窗口；可在 Studio 中按 ⌘P 开启预览。")
            try await Task.sleep(nanoseconds: 500_000_000)
        }
        throw ProtoPieError.waitingForUser("未能确认当前 .pie 文件的 Preview 窗口。请在 Studio 打开该文件并按 ⌘P，再点击重试；不会捕获编辑器窗口。")
    }

    private func openStudio(file: URL, activates: Bool) async throws -> NSRunningApplication {
        guard let studio = applicationURL(bundleIdentifiers: ["io.protopie", "io.protopie.ProtoPie", "com.studioxid.ProtoPie", "com.studioxid.protopie"], names: ["ProtoPie.app"]) else {
            throw ProtoPieError.missingApplication("未找到 ProtoPie Studio，请安装并登录后重试。")
        }
        let configuration = NSWorkspace.OpenConfiguration(); configuration.activates = activates
        return try await workspace.open([file], withApplicationAt: studio, configuration: configuration)
    }

    private func applicationURL(bundleIdentifiers: [String], names: [String]) -> URL? {
        for id in bundleIdentifiers { if let url = workspace.urlForApplication(withBundleIdentifier: id) { return url } }
        for directory in [URL(fileURLWithPath: "/Applications"), FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Applications")] {
            for name in names { let url = directory.appendingPathComponent(name); if FileManager.default.fileExists(atPath: url.path) { return url } }
        }
        return nil
    }

    nonisolated static func manualPreviewBounds(visibleFrame: CGRect, primaryTop: CGFloat) -> CGRect {
        let margin: CGFloat = 20
        let width = min(1200, max(1, visibleFrame.width - margin * 2))
        let height = min(800, max(1, visibleFrame.height - margin * 2))
        return CGRect(x: visibleFrame.midX - width / 2,
                      y: primaryTop - visibleFrame.midY - height / 2, width: width, height: height)
    }

    static func targetRect(_ displayID: CGDirectDisplayID) -> CGRect {
        // CG display bounds and AX/CDP use the desktop's top-left origin, including negative coordinates.
        let bounds = CGDisplayBounds(displayID)
        return bounds.isEmpty ? CGRect(x: 0, y: 0, width: 1280, height: 720) : bounds
    }

    struct WindowRecord { let id: CGWindowID; let pid: pid_t; let title: String; let frame: CGRect }
    static func windows() -> [WindowRecord] {
        let info = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
        return info.compactMap { value in
            guard let id = value[kCGWindowNumber as String] as? NSNumber, let pid = value[kCGWindowOwnerPID as String] as? NSNumber,
                  (value[kCGWindowLayer as String] as? Int ?? 0) == 0,
                  let frame = value[kCGWindowBounds as String] as? NSDictionary,
                  let rect = CGRect(dictionaryRepresentation: frame as CFDictionary), rect.width > 10, rect.height > 10 else { return nil }
            return WindowRecord(id: id.uint32Value, pid: pid.int32Value, title: value[kCGWindowName as String] as? String ?? "", frame: rect)
        }
    }
    nonisolated static func isPreviewTitle(_ title: String) -> Bool {
        title.localizedCaseInsensitiveContains("preview") || title.contains("预览")
    }
    private static func axValue(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
        var result: CFTypeRef?; guard AXUIElementCopyAttributeValue(element, attribute as CFString, &result) == .success else { return nil }; return result
    }
    private static func axElement(_ element: AXUIElement, _ attribute: String) -> AXUIElement? {
        guard let value = axValue(element, attribute), CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
        return unsafeBitCast(value, to: AXUIElement.self)
    }
    private static func axString(_ element: AXUIElement, _ attribute: String) -> String { axValue(element, attribute) as? String ?? "" }
    private static func axChildren(_ element: AXUIElement, attribute: String = kAXChildrenAttribute) -> [AXUIElement] { axValue(element, attribute) as? [AXUIElement] ?? [] }
    private static func axRect(_ element: AXUIElement) -> CGRect {
        var point = CGPoint.zero, size = CGSize.zero
        if let value = axValue(element, kAXPositionAttribute), CFGetTypeID(value) == AXValueGetTypeID() { AXValueGetValue(unsafeBitCast(value, to: AXValue.self), .cgPoint, &point) }
        if let value = axValue(element, kAXSizeAttribute), CFGetTypeID(value) == AXValueGetTypeID() { AXValueGetValue(unsafeBitCast(value, to: AXValue.self), .cgSize, &size) }
        return CGRect(origin: point, size: size)
    }
    private static func position(_ element: AXUIElement, rect: CGRect) {
        var point = rect.origin, size = rect.size
        if let value = AXValueCreate(.cgPoint, &point) { AXUIElementSetAttributeValue(element, kAXPositionAttribute as CFString, value) }
        if let value = AXValueCreate(.cgSize, &size) { AXUIElementSetAttributeValue(element, kAXSizeAttribute as CFString, value) }
    }
    private static func matches(_ lhs: CGRect, _ rhs: CGRect) -> Bool {
        abs(lhs.minX-rhs.minX)<4 && abs(lhs.minY-rhs.minY)<4 && abs(lhs.width-rhs.width)<4 && abs(lhs.height-rhs.height)<4
    }
    private static func pressPreviewMenu(_ element: AXUIElement, depth: Int) -> Bool {
        guard depth < 5 else { return false }
        let title = axString(element, kAXTitleAttribute)
        if ["Show Preview", "Show Preview Window", "Preview", "显示预览", "显示预览窗口", "预览"].contains(title),
           axString(element, kAXRoleAttribute) == kAXMenuItemRole {
            return AXUIElementPerformAction(element, kAXPressAction as CFString) == .success
        }
        return axChildren(element).contains { pressPreviewMenu($0, depth: depth + 1) }
    }
}

private enum ProtoPieCDP {
    static func call(_ socket: URL, method: String, parameters: [String: Any] = [:]) async throws -> [String: Any] {
        try Task.checkCancellation()
        let data = try JSONSerialization.data(withJSONObject: ["id": 1, "method": method, "params": parameters])
        let task = URLSession.shared.webSocketTask(with: socket)
        task.resume()
        let deadline = Task { try? await Task.sleep(nanoseconds: 6_000_000_000); if !Task.isCancelled { task.cancel(with: .goingAway, reason: nil) } }
        defer { deadline.cancel(); task.cancel(with: .normalClosure, reason: nil) }
        return try await withTaskCancellationHandler(operation: {
            try await task.send(.string(String(decoding: data, as: UTF8.self)))
            while true {
                let message = try await task.receive()
                let bytes: Data
                switch message { case .data(let data): bytes = data; case .string(let string): bytes = Data(string.utf8); @unknown default: continue }
                guard let response = try JSONSerialization.jsonObject(with: bytes) as? [String: Any], response["id"] as? Int == 1 else { continue }
                if let error = response["error"] as? [String: Any] {
                    throw ProtoPieError.unavailable("播放器控制失败：\(error["message"] as? String ?? method)")
                }
                return response["result"] as? [String: Any] ?? [:]
            }
        }, onCancel: { task.cancel(with: .goingAway, reason: nil) })
    }
}
