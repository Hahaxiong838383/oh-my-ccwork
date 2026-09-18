import AppKit
import ApplicationServices

/// Filters only the dedicated player's external-screen input. Chrome retains
/// ownership of the real system cursor (its CSS artwork, hotspot and pressed state).
/// No cursor is drawn, hidden, replaced, or disconnected from the mouse.
@MainActor final class NativeMouseInputCapture {
    var onEvent: ((MouseCaptureEvent) -> Void)?
    var onEnter: ((CGPoint, Bool) -> Bool)?
    var onLeave: (() -> Void)?
    var onExit: ((String, Bool) -> Void)?
    private(set) var isActive = false
    private(set) var engaged = false
    private(set) var placement: CGPoint?
    private(set) var eventCount = 0
    private var tap: CFMachPort?
    private var runLoopSource: CFRunLoopSource?
    private var displayID: CGDirectDisplayID = 0
    private var processID: pid_t = 0
    private var targetWindow: CGWindowID = 0
    private var outputWindow: CGWindowID = 0
    private var ownedButtons = 0
    private var windows: [(CGWindowID, CGRect)] = []

    func begin(displayID: CGDirectDisplayID, processID: pid_t, targetWindow: CGWindowID, outputWindow: CGWindowID) throws {
        guard !isActive else { return }
        guard tap == nil else { throw MouseCaptureError("请先松开上次演示按住的鼠标，再启用校正。") }
        guard CGDisplayIsActive(displayID) != 0, CGDisplayIsAsleep(displayID) == 0 else {
            throw MouseCaptureError("演示外屏不可用，原鼠标保持正常。")
        }
        self.displayID = displayID; self.processID = processID
        self.targetWindow = targetWindow; self.outputWindow = outputWindow
        let types: [CGEventType] = [.mouseMoved, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged,
            .leftMouseDown, .leftMouseUp, .rightMouseDown, .rightMouseUp, .otherMouseDown, .otherMouseUp, .scrollWheel, .keyDown]
        let mask = types.reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << $1.rawValue) }
        guard let tap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap,
            options: .defaultTap, eventsOfInterest: mask, callback: { _, type, event, context in
                guard let context else { return Unmanaged.passUnretained(event) }
                return MainActor.assumeIsolated {
                    Unmanaged<NativeMouseInputCapture>.fromOpaque(context).takeUnretainedValue().receive(type, event)
                }
            }, userInfo: Unmanaged.passUnretained(self).toOpaque()) else {
            throw MouseCaptureError("需要在系统设置 → 隐私与安全性 → 辅助功能中允许 NIO Warp，才能校正原有鼠标；当前仍是普通鼠标。")
        }
        self.tap = tap
        guard let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0) else {
            CFMachPortInvalidate(tap); self.tap = nil
            throw MouseCaptureError("无法监听原有鼠标，已保持普通输入。")
        }
        runLoopSource = source; isActive = true; eventCount = 0
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
        refreshScope()
    }

    /// Called by the controller timer, never by the event-tap callback.
    func refreshScope() {
        guard isActive else { return }
        let entries = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
        windows = entries.compactMap { entry in
            guard let id = (entry[kCGWindowNumber as String] as? NSNumber)?.uint32Value,
                  id != outputWindow,
                  (entry[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1 > 0,
                  let value = entry[kCGWindowBounds as String] as? [String: Any],
                  let rect = CGRect(dictionaryRepresentation: value as CFDictionary), !rect.isEmpty else { return nil }
            return (id, rect)
        }
        if engaged, let point = placement, !ownsSurface(at: point) { leaveSurface() }
    }

    func adoptCurrentCursorIfInside() {
        guard let point = CGEvent(source: nil)?.location, ownsSurface(at: point), !engaged else { return }
        engaged = onEnter?(point, true) == true
    }

    func placeCursor(at point: CGPoint) -> Bool {
        guard isActive, point.x.isFinite, point.y.isFinite else { return false }
        guard CGWarpMouseCursorPosition(point) == .success else { return false }
        placement = point
        return true
    }

    func stop() {
        isActive = false; engaged = false; placement = nil; windows.removeAll()
        // A down consumed by us must never leak its later physical up to Chrome
        // after the transport has already sent the compensating release.
        if ownedButtons == 0 { destroyTap() }
    }

    private func destroyTap() {
        if let tap { CGEvent.tapEnable(tap: tap, enable: false); CFMachPortInvalidate(tap) }
        if let source = runLoopSource { CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes) }
        tap = nil; runLoopSource = nil
    }

    private func ownsSurface(at point: CGPoint) -> Bool {
        isActive && CGDisplayBounds(displayID).contains(point)
            && NSWorkspace.shared.frontmostApplication?.processIdentifier == processID
            && windows.first(where: { $0.1.contains(point) })?.0 == targetWindow
    }

    private func leaveSurface() {
        guard engaged || ownedButtons != 0 else { return }
        engaged = false; placement = nil
        onLeave?()
        // Keep consumed button ownership until its physical up, even after focus changes.
    }

    private func receive(_ type: CGEventType, _ event: CGEvent) -> Unmanaged<CGEvent>? {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            let wasActive = isActive
            ownedButtons = 0; stop()
            if wasActive { onExit?("原鼠标校正监听已停止，恢复普通输入。", false) }
            return Unmanaged.passUnretained(event)
        }
        if !isActive {
            let number = Int(event.getIntegerValueField(.mouseEventButtonNumber))
            let bit = number == 0 ? 1 : number == 1 ? 2 : number == 2 ? 4 : 0
            let owned = bit != 0 && ownedButtons & bit != 0
            if owned && [.leftMouseUp, .rightMouseUp, .otherMouseUp].contains(type) {
                ownedButtons &= ~bit
                if ownedButtons == 0 { destroyTap() }
                return nil
            }
            if owned && [.leftMouseDragged, .rightMouseDragged, .otherMouseDragged].contains(type) { return nil }
            return Unmanaged.passUnretained(event)
        }
        if type == .keyDown {
            let noCommand = event.flags.intersection([.maskCommand, .maskControl, .maskAlternate]).isEmpty
            if event.getIntegerValueField(.keyboardEventKeycode) == 53, noCommand {
                stop(); onExit?("已按 Esc 暂停原鼠标校正，返回工作台。", true); return nil
            }
            return Unmanaged.passUnretained(event)
        }
        let up = [.leftMouseUp, .rightMouseUp, .otherMouseUp].contains(type)
        let number = Int(event.getIntegerValueField(.mouseEventButtonNumber))
        let bit = number == 0 ? 1 : number == 1 ? 2 : number == 2 ? 4 : 0
        let ownedUp = up && bit != 0 && ownedButtons & bit != 0
        let drag = [.leftMouseDragged, .rightMouseDragged, .otherMouseDragged].contains(type)
        if drag && ownedButtons == 0 { return Unmanaged.passUnretained(event) }
        // Raw event.location is the uncorrected candidate. At a mirrored edge it
        // may lie outside the screen while the corrected movement points inward.
        let point = engaged ? (placement ?? event.location) : event.location
        guard ownsSurface(at: point) else {
            leaveSurface()
            if ownedUp { ownedButtons &= ~bit; return nil }
            if drag && ownedButtons != 0 { return nil }
            return Unmanaged.passUnretained(event)
        }
        if up && !ownedUp { return Unmanaged.passUnretained(event) }
        if !engaged {
            // A move that enters the screen is already reflected in this position;
            // seed from it once instead of applying its delta twice or jumping to center.
            let movement = type == .mouseMoved || drag
            guard onEnter?(point, movement) == true else {
                // Outside the visible mesh, consume a click instead of snapping
                // it onto an edge control or leaking its uncorrected coordinates.
                if [.leftMouseDown, .rightMouseDown, .otherMouseDown].contains(type) { ownedButtons |= bit }
                if ownedUp { ownedButtons &= ~bit }
                return nil
            }
            engaged = true
            if type == .mouseMoved { return nil }
        }
        eventCount += 1
        let flags = Self.modifiers(event.flags)
        switch type {
        case .mouseMoved, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged:
            onEvent?(.move(dx: event.getDoubleValueField(.mouseEventDeltaX), dy: event.getDoubleValueField(.mouseEventDeltaY), modifiers: flags))
        case .leftMouseDown, .rightMouseDown, .otherMouseDown:
            guard bit != 0 else { return Unmanaged.passUnretained(event) }
            ownedButtons |= bit
            onEvent?(.button(down: true, number: number, clickCount: Int(event.getIntegerValueField(.mouseEventClickState)), modifiers: flags))
        case .leftMouseUp, .rightMouseUp, .otherMouseUp:
            ownedButtons &= ~bit
            onEvent?(.button(down: false, number: number, clickCount: Int(event.getIntegerValueField(.mouseEventClickState)), modifiers: flags))
        case .scrollWheel:
            let continuous = event.getIntegerValueField(.scrollWheelEventIsContinuous) != 0
            let dx = continuous ? event.getDoubleValueField(.scrollWheelEventPointDeltaAxis2) : event.getDoubleValueField(.scrollWheelEventDeltaAxis2) * 40
            let dy = continuous ? event.getDoubleValueField(.scrollWheelEventPointDeltaAxis1) : event.getDoubleValueField(.scrollWheelEventDeltaAxis1) * 40
            onEvent?(.wheel(dx: -dx, dy: -dy, modifiers: flags))
        default: return Unmanaged.passUnretained(event)
        }
        return nil
    }

    static func modifiers(_ flags: CGEventFlags) -> Int {
        (flags.contains(.maskAlternate) ? 1 : 0) | (flags.contains(.maskControl) ? 2 : 0)
            | (flags.contains(.maskCommand) ? 4 : 0) | (flags.contains(.maskShift) ? 8 : 0)
    }
}
