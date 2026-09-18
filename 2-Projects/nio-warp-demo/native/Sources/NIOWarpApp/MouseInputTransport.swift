import AppKit
import Foundation

struct MouseInputViewport: Equatable {
    let bindingID: UUID
    let cssWidth: Double
    let cssHeight: Double
    let devicePixelRatio: Double
    let timeOrigin: Double
    let targetID: String
    let browserWindowID: Int
    let windowID: CGWindowID
    let processID: pid_t
    var pixelSize: CGSize { CGSize(width: cssWidth * devicePixelRatio, height: cssHeight * devicePixelRatio) }
}

struct MouseInputEvent: Equatable {
    enum Kind: String { case move = "mouseMoved", down = "mousePressed", up = "mouseReleased", wheel = "mouseWheel" }
    enum Button: String {
        case none, left, right, middle
        var mask: Int { switch self { case .none: return 0; case .left: return 1; case .right: return 2; case .middle: return 4 } }
    }
    var viewportID: UUID
    var kind: Kind
    var x: Double
    var y: Double
    var button: Button = .none
    var buttons: Int = 0
    /// CDP: Alt = 1, Control = 2, Meta = 4, Shift = 8.
    var modifiers: Int = 0
    var clickCount: Int = 1
    var deltaX: Double = 0
    var deltaY: Double = 0

    var parameters: [String: Any] {
        var result: [String: Any] = ["type": kind.rawValue, "x": x, "y": y, "button": button.rawValue,
                                     "buttons": buttons, "modifiers": modifiers,
                                     "clickCount": kind == .down || kind == .up ? clickCount : 0]
        if kind == .wheel { result["deltaX"] = deltaX; result["deltaY"] = deltaY }
        return result
    }
}

enum MouseInputTransportError: LocalizedError, Equatable {
    case unavailable(String), staleViewport, disconnected, timeout, closed, invalidEvent, queueOverflow
    var errorDescription: String? {
        switch self {
        case .unavailable(let message): return message
        case .staleViewport: return "播放器页面、全屏或视口已变化；鼠标映射已恢复普通输入，请重新进入。"
        case .disconnected: return "专用播放器连接已断开；鼠标映射已恢复普通输入。"
        case .timeout: return "播放器输入响应超时；鼠标映射已停止。"
        case .closed: return "鼠标输入会话已结束。"
        case .invalidEvent: return "鼠标事件不属于当前视口或按键顺序无效。"
        case .queueOverflow: return "播放器输入处理过慢；鼠标映射已停止，避免延迟点击。"
        }
    }
}

/// One browser socket, one flattened page session, and monotonically increasing request IDs.
/// Injectable at the protocol boundary so tests cannot touch the user's real Chrome or page.
@MainActor protocol MouseInputCDPConnection: AnyObject {
    var onEvent: ((String, [String: Any], String?) -> Void)? { get set }
    var onFailure: ((Error) -> Void)? { get set }
    func call(_ method: String, parameters: [String: Any], sessionID: String?) async throws -> [String: Any]
    func close()
}

@MainActor final class MouseInputTransport {
    typealias ConnectionFactory = (URL) -> MouseInputCDPConnection
    typealias WindowLookup = (CGWindowID, pid_t) -> CGRect?
    typealias CursorResourceLoader = (URL) async throws -> Data
    var onFailure: ((Error) -> Void)?
    private(set) var viewport: MouseInputViewport?
    var isConnected: Bool { acceptingEvents && viewport != nil }

    private let profileURL: URL
    private let makeConnection: ConnectionFactory
    private let findWindow: WindowLookup
    private let loadCursorResource: CursorResourceLoader
    private let monitorInterval: UInt64
    private var connection: MouseInputCDPConnection?
    private var session: ProtoPieSession?
    private var pageSessionID: String?
    private var acceptingEvents = false
    private var connecting = false
    private var closing = false
    private var originalPageInvalidated = false
    private var lifecycle = UUID()
    private var queuedButtons = 0
    private var queuedKeys: [UInt16: MouseKeyboardEvent] = [:]
    /// Set before dispatching down, so an acknowledgement timeout still attempts release.
    private var possiblyPressed = 0
    private var possiblyPressedKeys: [UInt16: MouseKeyboardEvent] = [:]
    private var lastPoint = CGPoint.zero
    private var queue: [Operation] = []
    private var worker: Task<Void, Never>?
    private var monitor: Task<Void, Never>?
    private var closeTask: Task<Void, Never>?
    private var cursorCache: [String: ProtoPieCursorStyle] = [:]
    private var pageFocusPossiblyEnabled = false
    private var workItem = "idle"
    private var cursorState = "idle"
    private var cursorCacheHits = 0
    private var cursorCacheMisses = 0
    private var nextDiagnosticRequestID = 1
    private var currentRequests: [Int: (method: String, started: TimeInterval)] = [:]
    private var lastRequest: [String: Any]?
    private var lastErrorKind: String?
    private var failureContext: [String: Any]?

    /// Fixed operation names and timing only: never include request parameters,
    /// page identifiers, URLs, JavaScript, response bodies or keyboard content.
    var diagnosticSnapshot: [String: Any] {
        let now = ProcessInfo.processInfo.systemUptime
        var value: [String: Any] = [
            "connected": isConnected, "closing": closing, "queueLength": queue.count,
            "workItem": workItem, "cursorState": cursorState,
            "cursorCacheHits": cursorCacheHits, "cursorCacheMisses": cursorCacheMisses,
            "currentRequests": currentRequests.keys.sorted().compactMap { id -> [String: Any]? in
                guard let request = currentRequests[id] else { return nil }
                return ["method": request.method, "elapsedMS": max(0, now - request.started) * 1000]
            }
        ]
        if let lastRequest { value["lastRequest"] = lastRequest }
        if let lastErrorKind { value["lastErrorKind"] = lastErrorKind }
        if let failureContext { value["failureContext"] = failureContext }
        return value
    }

    private static func diagnosticErrorKind(_ error: Error) -> String {
        if error is CancellationError { return "cancelled" }
        guard let error = error as? MouseInputTransportError else { return "other" }
        switch error {
        case .unavailable: return "unavailable"
        case .staleViewport: return "staleViewport"
        case .disconnected: return "disconnected"
        case .timeout: return "timeout"
        case .closed: return "closed"
        case .invalidEvent: return "invalidEvent"
        case .queueOverflow: return "queueOverflow"
        }
    }

    private func recordFailure(_ error: Error) {
        lastErrorKind = Self.diagnosticErrorKind(error)
        // Preserve the failure before close drains the queue or sends cleanup RPCs.
        if failureContext == nil { failureContext = diagnosticSnapshot }
    }

    private func trackedCall(_ connection: MouseInputCDPConnection, _ method: String,
                             parameters: [String: Any], sessionID: String?) async throws -> [String: Any] {
        let id = nextDiagnosticRequestID; nextDiagnosticRequestID += 1
        let started = ProcessInfo.processInfo.systemUptime, generation = lifecycle
        currentRequests[id] = (method, started)
        func finish(_ error: Error?) {
            guard lifecycle == generation else { return }
            currentRequests.removeValue(forKey: id)
            var result: [String: Any] = ["method": method,
                "elapsedMS": max(0, ProcessInfo.processInfo.systemUptime - started) * 1000,
                "result": error == nil ? "success" : "failure"]
            if let error { result["errorKind"] = Self.diagnosticErrorKind(error) }
            lastRequest = result
        }
        do {
            let result = try await connection.call(method, parameters: parameters, sessionID: sessionID)
            finish(nil)
            return result
        } catch {
            finish(error)
            throw error
        }
    }

    private enum Operation {
        case event(MouseInputEvent)
        case key(MouseKeyboardEvent)
        case refresh(CheckedContinuation<MouseInputViewport, Error>)
        case flush(CheckedContinuation<Void, Error>)
        case cursor(CGPoint, CheckedContinuation<ProtoPieCursorStyle, Error>)
        case focus(Bool, CheckedContinuation<Void, Error>)

        var diagnosticName: String {
            switch self {
            case .event(let event): return event.kind.rawValue
            case .key: return "keyboard"
            case .refresh: return "viewport"
            case .flush: return "flush"
            case .cursor: return "cursor"
            case .focus(let enabled, _): return enabled ? "focus.enable" : "focus.disable"
            }
        }
    }

    init(profileURL: URL? = nil, requestTimeout: TimeInterval = 2,
         monitorInterval: TimeInterval = 0.35,
         connectionFactory: ConnectionFactory? = nil,
         windowLookup: WindowLookup? = nil,
         cursorResourceLoader: CursorResourceLoader? = nil) {
        self.profileURL = profileURL ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("NIOWarp/ProtoPieChrome", isDirectory: true)
        self.makeConnection = connectionFactory ?? { MouseInputWebSocket(url: $0, timeout: requestTimeout) }
        self.findWindow = windowLookup ?? Self.capturedWindow
        self.loadCursorResource = cursorResourceLoader ?? { try await ProtoPieCursorResourceLoader.load($0) }
        self.monitorInterval = UInt64(max(0, monitorInterval) * 1_000_000_000)
    }

    func connect(session: ProtoPieSession) async throws -> MouseInputViewport {
        guard !connecting else { throw MouseInputTransportError.unavailable("正在绑定专用播放器，请等待本次连接完成。") }
        connecting = true
        defer { connecting = false }
        await releaseAllAndClose()
        guard session.configuration.source == .cloud, let targetID = session.cloudTargetID, !targetID.isEmpty else {
            throw MouseInputTransportError.unavailable("首版鼠标映射仅支持本应用专用的 ProtoPie Cloud 播放窗口。")
        }
        let socket = try Self.browserSocket(profileURL: profileURL)
        let expectedURL = try session.configuration.playbackURL()
        let connection = makeConnection(socket)
        let generation = UUID(); lifecycle = generation
        workItem = "idle"; cursorState = "idle"; cursorCacheHits = 0; cursorCacheMisses = 0
        currentRequests.removeAll(); lastRequest = nil; lastErrorKind = nil; failureContext = nil
        self.connection = connection; self.session = session; closing = false; originalPageInvalidated = false
        connection.onFailure = { [weak self] error in
            guard let self, self.lifecycle == generation else { return }
            self.fail(error, mayRelease: false)
        }
        connection.onEvent = { [weak self] method, parameters, id in
            guard let self, self.lifecycle == generation else { return }
            self.received(method, parameters: parameters, sessionID: id)
        }
        do {
            let process = try await trackedCall(connection, "SystemInfo.getProcessInfo", parameters: [:], sessionID: nil)
            guard let processes = process["processInfo"] as? [[String: Any]],
                  let browser = processes.first(where: { $0["type"] as? String == "browser" }),
                  (browser["id"] as? NSNumber)?.int32Value == session.processID else {
                throw MouseInputTransportError.unavailable("调试端口不属于当前捕获的专用 Chrome 进程。")
            }
            try await validateTarget(connection, targetID: targetID, expectedURL: expectedURL)
            let attachment = try await trackedCall(connection, "Target.attachToTarget",
                parameters: ["targetId": targetID, "flatten": true], sessionID: nil)
            guard let pageSession = attachment["sessionId"] as? String, !pageSession.isEmpty else {
                throw MouseInputTransportError.unavailable("无法绑定当前专用播放器页面。")
            }
            pageSessionID = pageSession
            _ = try await trackedCall(connection, "Page.enable", parameters: [:], sessionID: pageSession)
            _ = try await trackedCall(connection, "Runtime.enable", parameters: [:], sessionID: pageSession)
            let observed = try await observeViewport(bindingID: UUID())
            guard lifecycle == generation, !closing else { throw MouseInputTransportError.closed }
            viewport = observed; originalPageInvalidated = false; acceptingEvents = true
            startMonitor()
            return observed
        } catch {
            if lifecycle == generation { recordFailure(error); await releaseAllAndClose() }
            throw error
        }
    }

    /// Adjacent moves are coalesced; no press, release, wheel or barrier can be crossed.
    @discardableResult func send(_ event: MouseInputEvent) -> Bool {
        guard acceptingEvents, let viewport, event.viewportID == viewport.bindingID else { return false }
        guard isValid(event, viewport: viewport) else {
            fail(MouseInputTransportError.invalidEvent, mayRelease: true); return false
        }
        var expected = queuedButtons
        if event.kind == .down {
            guard expected & event.button.mask == 0 else { fail(MouseInputTransportError.invalidEvent, mayRelease: true); return false }
            expected |= event.button.mask
        } else if event.kind == .up {
            guard expected & event.button.mask != 0 else { fail(MouseInputTransportError.invalidEvent, mayRelease: true); return false }
            expected &= ~event.button.mask
        }
        guard expected == event.buttons else { fail(MouseInputTransportError.invalidEvent, mayRelease: true); return false }
        queuedButtons = expected
        if event.kind == .move, case .event(let prior) = queue.last, prior.kind == .move,
           prior.buttons == event.buttons, prior.modifiers == event.modifiers, prior.viewportID == event.viewportID {
            queue[queue.count - 1] = .event(event)
        } else {
            guard queue.count < 256 else { fail(MouseInputTransportError.queueOverflow, mayRelease: true); return false }
            queue.append(.event(event))
        }
        startWorker()
        return true
    }

    /// Keyboard business events use the same page binding and ordering as mouse
    /// input. Repeat never creates a second held key; releases cannot overtake down.
    @discardableResult func sendKey(_ event: MouseKeyboardEvent) -> Bool {
        guard acceptingEvents, let viewport, event.viewportID == viewport.bindingID else { return false }
        guard event.isValid else { return false }
        let code = event.input.keyCode, held = queuedKeys[code] != nil
        if event.input.kind == .down {
            guard event.input.isAutoRepeat ? held : !held else {
                fail(MouseInputTransportError.invalidEvent, mayRelease: true); return false
            }
        } else {
            guard held else { fail(MouseInputTransportError.invalidEvent, mayRelease: true); return false }
        }
        guard queue.count < 256 else { fail(MouseInputTransportError.queueOverflow, mayRelease: true); return false }
        if event.input.kind == .down { queuedKeys[code] = event } else { queuedKeys.removeValue(forKey: code) }
        queue.append(.key(event)); startWorker()
        return true
    }

    func flush() async throws {
        guard acceptingEvents else { throw MouseInputTransportError.closed }
        try await withCheckedThrowingContinuation { continuation in
            queue.append(.flush(continuation)); startWorker()
        }
    }

    /// A resize, reload or fullscreen exit invalidates the binding instead of rebasing queued clicks.
    func refreshViewport() async throws -> MouseInputViewport {
        guard acceptingEvents else { throw MouseInputTransportError.closed }
        return try await withCheckedThrowingContinuation { continuation in
            queue.append(.refresh(continuation)); startWorker()
        }
    }

    /// Ordered behind preceding mouse events, so :active/hover belongs to the
    /// same point and gesture. Only the already-bound page may supply artwork.
    func cursorStyle(at point: CGPoint) async throws -> ProtoPieCursorStyle {
        try Task.checkCancellation()
        guard acceptingEvents, let viewport else { throw MouseInputTransportError.closed }
        guard point.x.isFinite, point.y.isFinite, point.x >= 0, point.y >= 0,
              point.x < viewport.cssWidth, point.y < viewport.cssHeight else {
            throw MouseInputTransportError.invalidEvent
        }
        guard queue.count < 256 else { throw MouseInputTransportError.queueOverflow }
        let style = try await withCheckedThrowingContinuation { continuation in
            queue.append(.cursor(point, continuation)); startWorker()
        }
        try Task.checkCancellation()
        return style
    }

    /// The physical output owns macOS focus in the independent-source path.
    /// Scope emulation to this validated page and always undo it during close.
    func setPageFocusEmulation(_ enabled: Bool) async throws {
        try Task.checkCancellation()
        guard acceptingEvents else { throw MouseInputTransportError.closed }
        try await withCheckedThrowingContinuation { continuation in
            queue.append(.focus(enabled, continuation)); startWorker()
        }
        try Task.checkCancellation()
    }

    /// Bring forward only the page already validated for this input binding.
    /// Activating the Chrome process alone may select an older fullscreen window.
    func activateBoundTarget() async throws {
        guard acceptingEvents, !closing, !originalPageInvalidated,
              let current = viewport, let connection else { throw MouseInputTransportError.closed }
        let generation = lifecycle
        try Task.checkCancellation()
        _ = try await trackedCall(connection, "Target.activateTarget",
            parameters: ["targetId": current.targetID], sessionID: nil)
        guard lifecycle == generation, acceptingEvents, !closing, !originalPageInvalidated,
              viewport == current, self.connection === connection else { throw MouseInputTransportError.closed }
        try Task.checkCancellation()
    }

    func releaseAllAndClose() async {
        if let closeTask { await closeTask.value; return }
        beginClose(error: MouseInputTransportError.closed, mayRelease: true)
        await closeTask?.value
    }

    private func startWorker() {
        guard worker == nil, acceptingEvents else { return }
        let generation = lifecycle
        worker = Task { [weak self] in
            guard let self else { return }
            while self.acceptingEvents, self.lifecycle == generation, !self.queue.isEmpty {
                let next = self.queue.removeFirst()
                self.workItem = next.diagnosticName
                defer { if self.lifecycle == generation { self.workItem = "idle" } }
                do {
                    switch next {
                    case .event(let event):
                        guard let viewport = self.viewport, event.viewportID == viewport.bindingID,
                              let connection = self.connection, let pageSession = self.pageSessionID else {
                            throw MouseInputTransportError.closed
                        }
                        // Page lifecycle events catch navigation immediately; validate all business
                        // gestures as well, covering a silent fullscreen/zoom change between polls.
                        if event.kind != .move {
                            _ = try await self.validateCurrentViewport()
                        }
                        guard self.acceptingEvents, self.lifecycle == generation else { throw MouseInputTransportError.closed }
                        self.lastPoint = CGPoint(x: event.x, y: event.y)
                        if event.kind == .down { self.possiblyPressed |= event.button.mask }
                        _ = try await self.trackedCall(connection, "Input.dispatchMouseEvent", parameters: event.parameters, sessionID: pageSession)
                        if event.kind == .up { self.possiblyPressed &= ~event.button.mask }
                    case .key(let event):
                        guard let viewport = self.viewport, event.viewportID == viewport.bindingID,
                              let connection = self.connection, let pageSession = self.pageSessionID else {
                            throw MouseInputTransportError.closed
                        }
                        _ = try await self.validateCurrentViewport()
                        guard self.acceptingEvents, self.lifecycle == generation else { throw MouseInputTransportError.closed }
                        if event.input.kind == .down { self.possiblyPressedKeys[event.input.keyCode] = event }
                        _ = try await self.trackedCall(connection, "Input.dispatchKeyEvent", parameters: event.parameters, sessionID: pageSession)
                        if event.input.kind == .up { self.possiblyPressedKeys.removeValue(forKey: event.input.keyCode) }
                    case .refresh(let continuation):
                        do { continuation.resume(returning: try await self.validateCurrentViewport()) }
                        catch { continuation.resume(throwing: error); throw error }
                    case .flush(let continuation): continuation.resume()
                    case .cursor(let point, let continuation):
                        do { continuation.resume(returning: try await self.readCursorStyle(at: point)) }
                        catch { continuation.resume(throwing: error); throw error }
                    case .focus(let enabled, let continuation):
                        do {
                            guard let connection = self.connection, let pageSession = self.pageSessionID else {
                                throw MouseInputTransportError.closed
                            }
                            if enabled { self.pageFocusPossiblyEnabled = true }
                            _ = try await self.trackedCall(connection, "Emulation.setFocusEmulationEnabled",
                                parameters: ["enabled": enabled], sessionID: pageSession)
                            guard self.lifecycle == generation, self.acceptingEvents, !self.closing,
                                  !self.originalPageInvalidated else { throw MouseInputTransportError.closed }
                            if !enabled { self.pageFocusPossiblyEnabled = false }
                            continuation.resume()
                        } catch { continuation.resume(throwing: error); throw error }
                    }
                } catch {
                    self.fail(error, mayRelease: true)
                    break
                }
            }
            if self.lifecycle == generation { self.worker = nil }
        }
    }

    private func startMonitor() {
        guard monitorInterval > 0 else { return }
        let interval = monitorInterval
        monitor = Task { [weak self] in
            while !Task.isCancelled {
                do { try await Task.sleep(nanoseconds: interval) } catch { return }
                guard let self, self.acceptingEvents else { return }
                do { _ = try await self.refreshViewport() } catch { return }
            }
        }
    }

    private func validateCurrentViewport() async throws -> MouseInputViewport {
        guard let current = viewport else { throw MouseInputTransportError.closed }
        let fresh = try await observeViewport(bindingID: current.bindingID)
        guard acceptingEvents, viewport == current else { throw MouseInputTransportError.closed }
        guard fresh == current else { throw MouseInputTransportError.staleViewport }
        return fresh
    }

    private func validateTarget(_ connection: MouseInputCDPConnection, targetID: String, expectedURL: URL) async throws {
        let info = try await trackedCall(connection, "Target.getTargetInfo", parameters: ["targetId": targetID], sessionID: nil)
        guard let target = info["targetInfo"] as? [String: Any], target["targetId"] as? String == targetID,
              target["type"] as? String == "page", let text = target["url"] as? String,
              Self.matchesPage(text, expected: expectedURL) else { throw MouseInputTransportError.staleViewport }
    }

    private func observeViewport(bindingID: UUID) async throws -> MouseInputViewport {
        guard let connection, let session, let targetID = session.cloudTargetID, let pageSessionID else {
            throw MouseInputTransportError.closed
        }
        let expectedURL = try session.configuration.playbackURL()
        try await validateTarget(connection, targetID: targetID, expectedURL: expectedURL)
        let window = try await trackedCall(connection, "Browser.getWindowForTarget", parameters: ["targetId": targetID], sessionID: nil)
        guard let browserWindowID = window["windowId"] as? Int, let bounds = window["bounds"] as? [String: Any],
              bounds["windowState"] as? String == "fullscreen",
              let left = bounds["left"] as? NSNumber, let top = bounds["top"] as? NSNumber,
              let width = bounds["width"] as? NSNumber, let height = bounds["height"] as? NSNumber,
              let captured = findWindow(session.windowID, session.processID) else {
            throw MouseInputTransportError.staleViewport
        }
        let browserFrame = CGRect(x: left.doubleValue, y: top.doubleValue, width: width.doubleValue, height: height.doubleValue)
        guard [browserFrame.minX, browserFrame.minY, browserFrame.width, browserFrame.height].allSatisfy(\.isFinite),
              browserFrame.width > 0, browserFrame.height > 0,
              abs(captured.minX - browserFrame.minX) < 2, abs(captured.minY - browserFrame.minY) < 2,
              abs(captured.width - browserFrame.width) < 2, abs(captured.height - browserFrame.height) < 2 else {
            throw MouseInputTransportError.staleViewport
        }
        let value = try await runtimeViewport(connection, pageSessionID: pageSessionID)
        guard let url = value["url"] as? String, Self.matchesPage(url, expected: expectedURL),
              let w = value["width"] as? NSNumber, let h = value["height"] as? NSNumber,
              let dpr = value["dpr"] as? NSNumber, let epoch = value["timeOrigin"] as? NSNumber,
              let scale = value["visualScale"] as? NSNumber,
              let offsetX = value["visualOffsetX"] as? NSNumber, let offsetY = value["visualOffsetY"] as? NSNumber,
              value["ready"] as? Bool == true else { throw MouseInputTransportError.staleViewport }
        let numbers = [w.doubleValue, h.doubleValue, dpr.doubleValue, epoch.doubleValue, scale.doubleValue,
                       offsetX.doubleValue, offsetY.doubleValue]
        guard numbers.allSatisfy(\.isFinite), w.doubleValue > 0, h.doubleValue > 0, dpr.doubleValue > 0,
              epoch.doubleValue > 0, abs(scale.doubleValue - 1) < 0.0001,
              abs(offsetX.doubleValue) < 0.0001, abs(offsetY.doubleValue) < 0.0001 else {
            throw MouseInputTransportError.staleViewport
        }
        return MouseInputViewport(bindingID: bindingID, cssWidth: w.doubleValue, cssHeight: h.doubleValue,
            devicePixelRatio: dpr.doubleValue, timeOrigin: epoch.doubleValue, targetID: targetID,
            browserWindowID: browserWindowID, windowID: session.windowID, processID: session.processID)
    }

    private func runtimeViewport(_ connection: MouseInputCDPConnection, pageSessionID: String) async throws -> [String: Any] {
        let result = try await trackedCall(connection, "Runtime.evaluate", parameters: [
            "expression": "({url:location.href,width:innerWidth,height:innerHeight,dpr:devicePixelRatio,timeOrigin:performance.timeOrigin,ready:document.readyState==='complete',visualScale:visualViewport?visualViewport.scale:1,visualOffsetX:visualViewport?visualViewport.offsetLeft:0,visualOffsetY:visualViewport?visualViewport.offsetTop:0})",
            "returnByValue": true], sessionID: pageSessionID)
        guard result["exceptionDetails"] == nil,
              let value = (result["result"] as? [String: Any])?["value"] as? [String: Any] else {
            throw MouseInputTransportError.staleViewport
        }
        return value
    }

    private func readCursorStyle(at point: CGPoint) async throws -> ProtoPieCursorStyle {
        guard acceptingEvents, !closing, !originalPageInvalidated, let current = viewport,
              let connection, let pageSessionID else { throw MouseInputTransportError.closed }
        let generation = lifecycle
        func confirm() throws {
            guard lifecycle == generation, acceptingEvents, !closing, !originalPageInvalidated,
                  viewport == current, self.connection === connection else { throw MouseInputTransportError.closed }
        }
        func evaluate(_ expression: String) async throws -> [String: Any] {
            let result = try await trackedCall(connection, "Runtime.evaluate", parameters: [
                "expression": expression, "returnByValue": true, "awaitPromise": true], sessionID: pageSessionID)
            try confirm()
            guard result["exceptionDetails"] == nil,
                  let value = (result["result"] as? [String: Any])?["value"] as? [String: Any],
                  (value["timeOrigin"] as? NSNumber)?.doubleValue == current.timeOrigin else {
                throw MouseInputTransportError.staleViewport
            }
            return value
        }
        cursorState = "query"
        let observed = try await evaluate("""
        (()=>{const element=document.elementFromPoint(\(point.x),\(point.y))||document.getElementById('webplayer-root')||document.body;
        return {nioCursorStyle:true,timeOrigin:performance.timeOrigin,css:element?getComputedStyle(element).cursor:''};})()
        """)
        guard let css = observed["css"] as? String else { throw ProtoPieCursorStyle.invalid() }
        if let cached = cursorCache[css] {
            cursorCacheHits += 1; cursorState = "cacheHit"
            return cached
        }
        cursorCacheMisses += 1; cursorState = "parse"
        let definition = try ProtoPieCursorDefinition.parse(css)
        var imageData: Data?
        if let resource = definition.resource {
            cursorState = "browserResource"
            let encoded = String(decoding: try JSONSerialization.data(withJSONObject: [resource]), as: UTF8.self)
            let limit = ProtoPieCursorStyle.maximumResourceBytes
            let result = try await evaluate("""
            (async()=>{const result={nioCursorResource:true,timeOrigin:performance.timeOrigin,ok:false};
            const valid=url=>!url.username&&!url.password&&(url.protocol==='https:'||
              (url.protocol==='data:'&&/^data:image\\//i.test(url.href))||
              (url.origin===location.origin&&url.protocol===location.protocol));
            const abort=new AbortController(),timeout=setTimeout(()=>abort.abort(),1200);
            try {const url=new URL(\(encoded)[0],location.href);if(!valid(url))return result;
              const response=await fetch(url.href,{credentials:'same-origin',redirect:'error',signal:abort.signal});
              if(!response.ok||!valid(new URL(response.url||url.href))||!response.body)return result;
              if(Number(response.headers.get('content-length'))>\(limit))return result;
              const reader=response.body.getReader();let size=0;const chunks=[];
              for(;;){const item=await reader.read();if(item.done)break;size+=item.value.byteLength;
                if(size>\(limit)){await reader.cancel();return result;}chunks.push(item.value);}
              const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
              let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
              return {...result,ok:true,data:btoa(binary)};
            }catch{return result;}finally{clearTimeout(timeout);}})()
            """)
            if result["ok"] as? Bool == true {
                guard let encodedData = result["data"] as? String,
                      encodedData.utf8.count <= ((limit + 2) / 3) * 4,
                      let data = Data(base64Encoded: encodedData), data.count <= limit else { throw ProtoPieCursorStyle.invalid() }
                imageData = data
            } else {
                // The normal path keeps browser origin/CORS policy. Only the
                // player's fixed public asset host has a native fallback.
                cursorState = "nativeResourceEligibility"
                guard let url = ProtoPieCursorResourceLoader.permittedURL(resource) else { throw ProtoPieCursorStyle.invalid() }
                try confirm()
                cursorState = "nativeResource"
                do { imageData = try await loadCursorResource(url) }
                catch { try confirm(); throw ProtoPieCursorStyle.invalid() }
                try confirm()
                guard let data = imageData, !data.isEmpty, data.count <= limit else { throw ProtoPieCursorStyle.invalid() }
            }
        }
        try confirm()
        cursorState = "decode"
        let style = try ProtoPieCursorStyle.decode(definition, imageData: imageData)
        // Bound memory and retain no assets from a previous document/connection.
        if cursorCache.count >= 24 { cursorCache.removeAll() }
        cursorCache[css] = style
        cursorState = "ready"
        return style
    }

    private func received(_ method: String, parameters: [String: Any], sessionID: String?) {
        guard let session else { return }
        if method == "Target.detachedFromTarget", parameters["sessionId"] as? String == pageSessionID {
            originalPageInvalidated = true
            fail(MouseInputTransportError.disconnected, mayRelease: false)
        } else if method == "Target.targetDestroyed" || method == "Target.targetCrashed",
                  parameters["targetId"] as? String == session.cloudTargetID {
            originalPageInvalidated = true
            fail(MouseInputTransportError.disconnected, mayRelease: false)
        } else if sessionID == pageSessionID {
            if method == "Runtime.executionContextsCleared" || method == "Inspector.detached" {
                originalPageInvalidated = true
                guard acceptingEvents else { return }
                fail(MouseInputTransportError.staleViewport, mayRelease: false)
            } else if method == "Page.frameNavigated", let frame = parameters["frame"] as? [String: Any], frame["parentId"] == nil {
                originalPageInvalidated = true
                guard acceptingEvents else { return }
                fail(MouseInputTransportError.staleViewport, mayRelease: false)
            } else if method == "Page.frameResized", acceptingEvents {
                // A lid transition can emit this without changing the external viewport.
                // Confirm the size rather than treating a desktop-origin change as a new page.
                Task { [weak self] in _ = try? await self?.refreshViewport() }
            }
        }
    }

    private func isValid(_ event: MouseInputEvent, viewport: MouseInputViewport) -> Bool {
        guard [event.x, event.y, event.deltaX, event.deltaY].allSatisfy(\.isFinite),
              event.x >= 0, event.x < viewport.cssWidth, event.y >= 0, event.y < viewport.cssHeight,
              (0...7).contains(event.buttons), (0...15).contains(event.modifiers),
              event.clickCount >= 0, event.clickCount <= Int(Int32.max) else { return false }
        return event.kind != .down && event.kind != .up || event.button != .none && event.clickCount > 0
    }

    private func fail(_ error: Error, mayRelease: Bool) {
        guard !closing else { return }
        recordFailure(error)
        beginClose(error: error, mayRelease: mayRelease)
        onFailure?(error)
    }

    private func beginClose(error: Error, mayRelease: Bool) {
        guard closeTask == nil else { return }
        acceptingEvents = false; closing = true
        monitor?.cancel(); monitor = nil
        for operation in queue {
            switch operation {
            case .event: break
            case .key: break
            case .refresh(let continuation): continuation.resume(throwing: error)
            case .flush(let continuation): continuation.resume(throwing: error)
            case .cursor(_, let continuation): continuation.resume(throwing: error)
            case .focus(_, let continuation): continuation.resume(throwing: error)
            }
        }
        queue.removeAll(); queuedButtons = 0; queuedKeys.removeAll()
        let existingWorker = worker
        closeTask = Task { [weak self] in
            guard let self else { return }
            // The in-flight event finishes before cleanup; release cannot overtake its down.
            await existingWorker?.value
            if mayRelease { await self.releasePressedOnOriginalPage() }
            if self.pageFocusPossiblyEnabled, let connection = self.connection, let pageSessionID = self.pageSessionID {
                _ = try? await self.trackedCall(connection, "Emulation.setFocusEmulationEnabled",
                    parameters: ["enabled": false], sessionID: pageSessionID)
            }
            self.pageFocusPossiblyEnabled = false
            self.connection?.onEvent = nil; self.connection?.onFailure = nil
            self.connection?.close(); self.connection = nil
            self.pageSessionID = nil; self.session = nil; self.viewport = nil
            self.cursorCache.removeAll()
            self.possiblyPressed = 0; self.possiblyPressedKeys.removeAll(); self.worker = nil; self.closeTask = nil
        }
    }

    private func releasePressedOnOriginalPage() async {
        guard !originalPageInvalidated, (possiblyPressed != 0 || !possiblyPressedKeys.isEmpty),
              let connection, let pageSessionID, let viewport, let session,
              let value = try? await runtimeViewport(connection, pageSessionID: pageSessionID),
              !originalPageInvalidated,
              (value["timeOrigin"] as? NSNumber)?.doubleValue == viewport.timeOrigin,
              let url = value["url"] as? String, let expected = try? session.configuration.playbackURL(),
              Self.matchesPage(url, expected: expected) else { return }
        for button: MouseInputEvent.Button in [.left, .right, .middle] where possiblyPressed & button.mask != 0 {
            guard !originalPageInvalidated else { return }
            possiblyPressed &= ~button.mask
            let event = MouseInputEvent(viewportID: viewport.bindingID, kind: .up, x: lastPoint.x, y: lastPoint.y,
                                        button: button, buttons: possiblyPressed)
            _ = try? await trackedCall(connection, "Input.dispatchMouseEvent", parameters: event.parameters, sessionID: pageSessionID)
        }
        for code in possiblyPressedKeys.keys.sorted() {
            guard !originalPageInvalidated, let event = possiblyPressedKeys.removeValue(forKey: code) else { return }
            _ = try? await trackedCall(connection, "Input.dispatchKeyEvent", parameters: event.released().parameters, sessionID: pageSessionID)
        }
    }

    static func browserSocket(profileURL: URL) throws -> URL {
        guard let text = try? String(contentsOf: profileURL.appendingPathComponent("DevToolsActivePort"), encoding: .utf8) else {
            throw MouseInputTransportError.unavailable("未找到 NIO 专用播放器的动态调试端口，请先启动 ProtoPie 联动。")
        }
        let lines = text.split(whereSeparator: \.isNewline)
        guard lines.count >= 2, let port = Int(lines[0]), (1...65535).contains(port),
              lines[1].hasPrefix("/devtools/browser/"), !lines[1].contains("?"), !lines[1].contains("#"),
              let socket = URL(string: "ws://127.0.0.1:\(port)\(lines[1])"), socket.host == "127.0.0.1", socket.port == port else {
            throw MouseInputTransportError.unavailable("专用播放器调试端口无效，请重新启动 ProtoPie 联动。")
        }
        return socket
    }

    static func matchesPage(_ text: String, expected: URL) -> Bool {
        guard let actual = URLComponents(string: text), let wanted = URLComponents(url: expected, resolvingAgainstBaseURL: false),
              actual.scheme == "https", actual.host == "cloud.protopie.io", actual.user == nil, actual.password == nil,
              actual.port == nil, actual.percentEncodedPath == wanted.percentEncodedPath else { return false }
        // Scene navigation may alter the hash. Share credentials and player flags must still match.
        func query(_ url: URLComponents) -> [String] {
            (url.queryItems ?? []).map { "\($0.name.count):\($0.name)=\($0.value.map { "\($0.count):\($0)" } ?? "nil")" }.sorted()
        }
        return query(actual) == query(wanted)
    }

    private static func capturedWindow(id: CGWindowID, processID: pid_t) -> CGRect? {
        guard NSRunningApplication(processIdentifier: processID)?.bundleIdentifier == "com.google.Chrome",
              let windows = CGWindowListCopyWindowInfo([.optionIncludingWindow, .excludeDesktopElements], id) as? [[String: Any]],
              let window = windows.first(where: { ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value == id &&
                  ($0[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == processID }),
              let bounds = window[kCGWindowBounds as String] as? [String: Any] else { return nil }
        return CGRect(dictionaryRepresentation: bounds as CFDictionary)
    }
}

/// Responses are demultiplexed by request ID. A deadline expires only its own request;
/// the socket remains available for best-effort release after an uncertain down acknowledgement.
@MainActor protocol MouseInputWebSocketWire: AnyObject {
    func send(_ text: String) async throws
    func receive() async throws -> Data
    func close()
}

@MainActor private final class MouseInputURLSessionWire: MouseInputWebSocketWire {
    private let session: URLSession
    private let socket: URLSessionWebSocketTask
    init(url: URL) {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.connectionProxyDictionary = [:]
        session = URLSession(configuration: configuration)
        socket = session.webSocketTask(with: url)
        socket.resume()
    }
    func send(_ text: String) async throws { try await socket.send(.string(text)) }
    func receive() async throws -> Data {
        let message = try await socket.receive()
        switch message {
        case .data(let data): return data
        case .string(let text): return Data(text.utf8)
        @unknown default: throw MouseInputTransportError.disconnected
        }
    }
    func close() { socket.cancel(with: .normalClosure, reason: nil); session.invalidateAndCancel() }
}

@MainActor final class MouseInputWebSocket: MouseInputCDPConnection {
    var onEvent: ((String, [String: Any], String?) -> Void)?
    var onFailure: ((Error) -> Void)?
    private let wire: MouseInputWebSocketWire
    private let timeout: UInt64
    private var nextID = 1
    private var receiver: Task<Void, Never>?
    private var closed = false
    private struct Pending {
        let continuation: CheckedContinuation<[String: Any], Error>
        let timeout: Task<Void, Never>
    }
    private var pending: [Int: Pending] = [:]

    convenience init(url: URL, timeout: TimeInterval) {
        self.init(wire: MouseInputURLSessionWire(url: url), timeout: timeout)
    }

    init(wire: MouseInputWebSocketWire, timeout: TimeInterval) {
        self.wire = wire
        self.timeout = UInt64(max(0.05, timeout) * 1_000_000_000)
    }

    func call(_ method: String, parameters: [String: Any], sessionID: String?) async throws -> [String: Any] {
        try Task.checkCancellation()
        guard !closed else { throw MouseInputTransportError.disconnected }
        startReceiver()
        let id = nextID; nextID += 1
        var object: [String: Any] = ["id": id, "method": method, "params": parameters]
        if let sessionID { object["sessionId"] = sessionID }
        let data = try JSONSerialization.data(withJSONObject: object)
        return try await withTaskCancellationHandler(operation: {
            try await withCheckedThrowingContinuation { continuation in
                let timer = Task { [weak self] in
                    do { try await Task.sleep(nanoseconds: self?.timeout ?? 1) } catch { return }
                    self?.finish(id, result: .failure(MouseInputTransportError.timeout))
                }
                pending[id] = Pending(continuation: continuation, timeout: timer)
                Task { [weak self] in
                    guard let self, !self.closed, self.pending[id] != nil else { return }
                    do { try await self.wire.send(String(decoding: data, as: UTF8.self)) }
                    catch { self.failConnection(error) }
                }
            }
        }, onCancel: { Task { @MainActor [weak self] in self?.finish(id, result: .failure(CancellationError())) } })
    }

    func close() {
        guard !closed else { return }
        closed = true; receiver?.cancel(); receiver = nil
        wire.close()
        let requests = pending; pending.removeAll()
        for (_, request) in requests { request.timeout.cancel(); request.continuation.resume(throwing: MouseInputTransportError.closed) }
    }

    private func startReceiver() {
        guard receiver == nil else { return }
        receiver = Task { [weak self] in
            while !Task.isCancelled {
                guard let self, !self.closed else { return }
                do {
                    let data = try await self.wire.receive()
                    guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
                    if let id = object["id"] as? Int {
                        if object["error"] != nil {
                            // Do not surface browser error strings: they can include private source URLs.
                            self.finish(id, result: .failure(MouseInputTransportError.unavailable("专用播放器拒绝了鼠标控制请求。")))
                        } else { self.finish(id, result: .success(object["result"] as? [String: Any] ?? [:])) }
                    } else if let method = object["method"] as? String {
                        self.onEvent?(method, object["params"] as? [String: Any] ?? [:], object["sessionId"] as? String)
                    }
                } catch { self.failConnection(error); return }
            }
        }
    }

    private func finish(_ id: Int, result: Result<[String: Any], Error>) {
        guard let request = pending.removeValue(forKey: id) else { return }
        request.timeout.cancel(); request.continuation.resume(with: result)
    }

    private func failConnection(_ error: Error) {
        guard !closed else { return }
        close(); onFailure?(MouseInputTransportError.disconnected)
    }
}
