import AppKit
import CoreGraphics

enum MouseCaptureEvent {
    case move(dx: Double, dy: Double, modifiers: Int)
    case button(down: Bool, number: Int, clickCount: Int, modifiers: Int)
    case wheel(dx: Double, dy: Double, modifiers: Int)
}

/// Owns relative input only while this application's output window has focus.
/// It never posts a system mouse event. Source events are consumed before AppKit
/// can deliver an uncorrected click, and every exit balances cursor ownership.
@MainActor final class MouseInputCapture {
    var onEvent: ((MouseCaptureEvent) -> Void)?
    var onExit: ((String, Bool) -> Void)?
    private(set) var isActive = false
    private weak var window: NSWindow?
    private var monitor: Any?
    private var observers = [NSObjectProtocol]()
    private var originalCursor: CGPoint?
    private var disconnected = false
    private var hidden = false
    private var previousAcceptsMovement = false

    func begin(window: NSWindow, displayID: CGDirectDisplayID) throws {
        guard !isActive else { return }
        guard NSApp.isActive, window.isKeyWindow, window.isVisible,
              CGDisplayIsActive(displayID) != 0, CGDisplayIsAsleep(displayID) == 0 else {
            throw MouseCaptureError("演示输入窗口尚未取得焦点，请重新进入鼠标控制。")
        }
        self.window = window
        originalCursor = CGEvent(source: nil)?.location
        previousAcceptsMovement = window.acceptsMouseMovedEvents
        window.acceptsMouseMovedEvents = true
        let associated = CGAssociateMouseAndMouseCursorPosition(0)
        guard associated == .success else {
            window.acceptsMouseMovedEvents = previousAcceptsMovement
            throw MouseCaptureError("无法接管相对鼠标（\(associated.rawValue)），已保留普通鼠标。")
        }
        disconnected = true
        let bounds = CGDisplayBounds(displayID)
        guard CGWarpMouseCursorPosition(CGPoint(x: bounds.midX, y: bounds.midY)) == .success else {
            restore()
            throw MouseCaptureError("无法定位演示输入，已恢复普通鼠标。")
        }
        let result = CGDisplayHideCursor(kCGNullDirectDisplay)
        guard result == .success else {
            restore()
            throw MouseCaptureError("无法隐藏系统光标（\(result.rawValue)），已恢复普通鼠标。")
        }
        hidden = true
        isActive = true
        let mask: NSEvent.EventTypeMask = [.mouseMoved, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged,
            .leftMouseDown, .leftMouseUp, .rightMouseDown, .rightMouseUp, .otherMouseDown, .otherMouseUp,
            .scrollWheel, .keyDown]
        monitor = NSEvent.addLocalMonitorForEvents(matching: mask) { [weak self] event in
            guard let self, self.isActive else { return event }
            if event.type == .keyDown {
                if event.keyCode == 53 && event.modifierFlags.intersection([.command, .control, .option]).isEmpty {
                    self.leave("已按 Esc 返回普通鼠标。", returnToWorkbench: true)
                    return nil
                }
                return event
            }
            guard NSApp.isActive, self.window?.isKeyWindow == true, self.window?.isVisible == true,
                  event.window == nil || event.window === self.window else {
                self.leave("已切回工作台或其他窗口，恢复普通鼠标。")
                return event
            }
            let flags = Self.modifiers(event.modifierFlags)
            switch event.type {
            case .mouseMoved, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged:
                self.onEvent?(.move(dx: Double(event.deltaX), dy: Double(event.deltaY), modifiers: flags))
            case .leftMouseDown, .rightMouseDown, .otherMouseDown:
                self.onEvent?(.button(down: true, number: event.buttonNumber, clickCount: event.clickCount, modifiers: flags))
            case .leftMouseUp, .rightMouseUp, .otherMouseUp:
                self.onEvent?(.button(down: false, number: event.buttonNumber, clickCount: event.clickCount, modifiers: flags))
            case .scrollWheel:
                let scale = event.hasPreciseScrollingDeltas ? 1.0 : 40.0
                // AppKit scrolling deltas describe content movement; CDP wheel
                // deltas describe viewport scrolling and use the opposite sign.
                self.onEvent?(.wheel(dx: -Double(event.scrollingDeltaX) * scale,
                                    dy: -Double(event.scrollingDeltaY) * scale, modifiers: flags))
            default: break
            }
            return nil
        }
        guard monitor != nil else {
            restore()
            throw MouseCaptureError("无法建立输入监听，已恢复普通鼠标。")
        }
        let center = NotificationCenter.default
        for name in [NSApplication.didResignActiveNotification, NSWindow.didResignKeyNotification,
                     NSWindow.willCloseNotification] {
            observers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] note in
                MainActor.assumeIsolated {
                    guard let self, self.isActive else { return }
                    if name == NSApplication.didResignActiveNotification || (note.object as? NSWindow) === self.window {
                        self.leave("演示输入已失去焦点，恢复普通鼠标。")
                    }
                }
            })
        }
    }

    func stop() { restore() }

    private func leave(_ reason: String, returnToWorkbench: Bool = false) {
        restore()
        onExit?(reason, returnToWorkbench)
    }

    private func restore() {
        isActive = false
        if let monitor { NSEvent.removeMonitor(monitor); self.monitor = nil }
        observers.forEach { NotificationCenter.default.removeObserver($0) }
        observers.removeAll()
        if disconnected { CGAssociateMouseAndMouseCursorPosition(1); disconnected = false }
        if hidden { CGDisplayShowCursor(kCGNullDirectDisplay); hidden = false }
        if let originalCursor {
            var screens = [CGDirectDisplayID](repeating: 0, count: 16)
            var count: UInt32 = 0
            CGGetActiveDisplayList(16, &screens, &count)
            let bounds = screens.prefix(Int(count)).map { CGDisplayBounds($0) }
            if bounds.contains(where: { $0.contains(originalCursor) }) { CGWarpMouseCursorPosition(originalCursor) }
            else if let frame = bounds.first { CGWarpMouseCursorPosition(CGPoint(x: frame.midX, y: frame.midY)) }
        }
        originalCursor = nil
        window?.acceptsMouseMovedEvents = previousAcceptsMovement
        window = nil
    }

    nonisolated static func modifiers(_ flags: NSEvent.ModifierFlags) -> Int {
        (flags.contains(.option) ? 1 : 0) | (flags.contains(.control) ? 2 : 0)
            | (flags.contains(.command) ? 4 : 0) | (flags.contains(.shift) ? 8 : 0)
    }
}

struct MouseCaptureError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

/// The cursor hotspot can reach the last usable physical pixel. Its drawing is
/// allowed to clip at the screen edge instead of shrinking the clickable area.
final class MouseCursorOverlay: NSView {
    var receivesInput = false
    var physicalPoint: SIMD2<Float>? { didSet { needsDisplay = true } }
    var physicalSize = SIMD2<Float>(1, 1)
    var diameter: Double = 28 { didSet { needsDisplay = true } }
    var previewOnly = true { didSet { needsDisplay = true } }
    override var isFlipped: Bool { true }
    override var isOpaque: Bool { false }
    override var acceptsFirstResponder: Bool { receivesInput }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { receivesInput }
    override func hitTest(_ point: NSPoint) -> NSView? { receivesInput ? super.hitTest(point) : nil }

    override func draw(_ dirtyRect: NSRect) {
        guard let point = physicalPoint else { return }
        let sx = bounds.width / CGFloat(max(physicalSize.x, 1))
        let sy = bounds.height / CGFloat(max(physicalSize.y, 1))
        let center = CGPoint(x: CGFloat(point.x) * sx, y: CGFloat(point.y) * sy)
        let r = CGFloat(diameter) * 0.5
        let ring = NSBezierPath(ovalIn: CGRect(x: center.x-r*sx, y: center.y-r*sy, width:2*r*sx, height:2*r*sy))
        NSColor.black.withAlphaComponent(0.95).setStroke(); ring.lineWidth = max(4*sx, 1); ring.stroke()
        (previewOnly ? NSColor.systemYellow : NSColor.systemCyan).setStroke(); ring.lineWidth = max(2*sx, 0.7); ring.stroke()
        let cross = NSBezierPath()
        cross.move(to: CGPoint(x:center.x-5*sx,y:center.y));cross.line(to:CGPoint(x:center.x+5*sx,y:center.y))
        cross.move(to: CGPoint(x:center.x,y:center.y-5*sy));cross.line(to:CGPoint(x:center.x,y:center.y+5*sy))
        NSColor.black.setStroke();cross.lineWidth=max(4*sx,1);cross.stroke()
        NSColor.white.setStroke();cross.lineWidth=max(1.5*sx,0.7);cross.stroke()
    }
}
