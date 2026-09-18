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
    private(set) var lastRawDelta: SIMD2<Double>?
    private(set) var lastCorrectedDelta: SIMD2<Double>?
    private(set) var lastWarpCorrection: SIMD2<Double>?
    private var warpDeltas = MouseWarpDeltaCompensator()
    private var tap: CFMachPort?
    private var runLoopSource: CFRunLoopSource?
    private var displayID: CGDirectDisplayID = 0
    private var processID: pid_t = 0
    private var targetWindow: CGWindowID = 0
    private var outputWindow: CGWindowID = 0
    private var ownedButtons = 0
    private var ownsEscape = false
    private var windows: [(CGWindowID, CGRect)] = []

    func begin(displayID: CGDirectDisplayID, processID: pid_t, targetWindow: CGWindowID, outputWindow: CGWindowID) throws {
        guard !isActive else { return }
        guard tap == nil else { throw MouseCaptureError("请先松开上次演示按住的 Esc 或鼠标按键，再启用校正。") }
        guard CGDisplayIsActive(displayID) != 0, CGDisplayIsAsleep(displayID) == 0 else {
            throw MouseCaptureError("演示外屏不可用，原鼠标保持正常。")
        }
        resetMovement()
        self.displayID = displayID; self.processID = processID
        self.targetWindow = targetWindow; self.outputWindow = outputWindow
        let types: [CGEventType] = [.mouseMoved, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged,
            .leftMouseDown, .leftMouseUp, .rightMouseDown, .rightMouseUp, .otherMouseDown, .otherMouseUp, .scrollWheel, .keyDown, .keyUp]
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
                  !Self.isSystemCursorWindow(entry),
                  (entry[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1 > 0,
                  let value = entry[kCGWindowBounds as String] as? [String: Any],
                  let rect = CGRect(dictionaryRepresentation: value as CFDictionary), !rect.isEmpty else { return nil }
            return (id, rect)
        }
        if engaged, let point = placement, !ownsSurface(at: point) { leaveSurface() }
    }

    /// WindowServer can expose the system cursor as a topmost, nonshareable
    /// window. It is not an interactive occluder. Keep other windows at the
    /// same level (including shareable status indicators) in the scope check.
    nonisolated static func isSystemCursorWindow(_ entry: [String: Any]) -> Bool {
        entry[kCGWindowOwnerName as String] as? String == "Window Server"
            && (entry[kCGWindowLayer as String] as? NSNumber)?.intValue == Int(CGWindowLevelForKey(.cursorWindow))
            && (entry[kCGWindowSharingState as String] as? NSNumber)?.intValue == 0
    }

    func adoptCurrentCursorIfInside() {
        guard let point = CGEvent(source: nil)?.location, ownsSurface(at: point), !engaged else { return }
        engaged = onEnter?(point, true) == true
    }

    func placeCursor(at point: CGPoint) -> Bool {
        guard isActive, point.x.isFinite, point.y.isFinite else { return false }
        guard let before = CGEvent(source: nil) else { return false }
        guard CGWarpMouseCursorPosition(point) == .success else { return false }
        guard let after = CGEvent(source: nil) else { resetMovement(); return false }
        warpDeltas.recordWarp(delta: SIMD2(Double(after.location.x - before.location.x),
                                          Double(after.location.y - before.location.y)),
                              timestamp: after.timestamp)
        placement = point
        return true
    }

    func stop() {
        isActive = false; engaged = false; placement = nil; windows.removeAll()
        resetMovement()
        // Keep each consumed gesture until its physical release: both a mouse up
        // and an Esc repeat/up must not leak to Chrome after mapping has stopped.
        if ownedButtons == 0 && !ownsEscape { destroyTap() }
    }

    private func destroyTap() {
        if let tap { CGEvent.tapEnable(tap: tap, enable: false); CFMachPortInvalidate(tap) }
        if let source = runLoopSource { CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes) }
        tap = nil; runLoopSource = nil
    }

    func scopeDiagnostic() -> [String: Any] {
        let point = placement ?? CGEvent(source: nil)?.location ?? .zero
        let bounds = CGDisplayBounds(displayID)
        let covering = windows.filter { $0.1.contains(point) }.prefix(4).map { $0.0 }
        let first = covering.first.flatMap { id in
            (CGWindowListCopyWindowInfo(.optionIncludingWindow, id) as? [[String: Any]])?.first
        }
        let keys = [kCGWindowNumber, kCGWindowOwnerName, kCGWindowLayer, kCGWindowSharingState, kCGWindowStoreType]
        let details = keys.reduce(into: [String: Any]()) { result, key in
            if let value = first?[key as String] { result[key as String] = value }
        }
        return ["firstWindowMetadata": details, "displayID": displayID, "insideDisplay": bounds.contains(point),
                "frontPID": NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0,
                "processID": processID, "targetWindow": targetWindow, "outputWindow": outputWindow,
                "coveringWindows": windows.filter { $0.1.contains(point) }.prefix(4).map { $0.0 },
                "point": [point.x, point.y]]
    }

    private func ownsSurface(at point: CGPoint) -> Bool {
        isActive && CGDisplayBounds(displayID).contains(point)
            && NSWorkspace.shared.frontmostApplication?.processIdentifier == processID
            && windows.first(where: { $0.1.contains(point) })?.0 == targetWindow
    }

    private func leaveSurface() {
        guard engaged || ownedButtons != 0 else { return }
        engaged = false; placement = nil
        resetMovement()
        onLeave?()
        // Keep consumed button ownership until its physical up, even after focus changes.
    }

    private func resetMovement() {
        warpDeltas.reset()
        lastRawDelta = nil; lastCorrectedDelta = nil; lastWarpCorrection = nil
    }

    private func receive(_ type: CGEventType, _ event: CGEvent) -> Unmanaged<CGEvent>? {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            let wasActive = isActive
            ownedButtons = 0; ownsEscape = false; stop()
            if wasActive { onExit?("原鼠标校正监听已停止，恢复普通输入。", false) }
            return Unmanaged.passUnretained(event)
        }
        if !isActive {
            if ownsEscape, (type == .keyDown || type == .keyUp),
               event.getIntegerValueField(.keyboardEventKeycode) == 53 {
                if type == .keyUp {
                    ownsEscape = false
                    if ownedButtons == 0 { destroyTap() }
                }
                return nil
            }
            let number = Int(event.getIntegerValueField(.mouseEventButtonNumber))
            let bit = number == 0 ? 1 : number == 1 ? 2 : number == 2 ? 4 : 0
            let owned = bit != 0 && ownedButtons & bit != 0
            if owned && [.leftMouseUp, .rightMouseUp, .otherMouseUp].contains(type) {
                ownedButtons &= ~bit
                if ownedButtons == 0 && !ownsEscape { destroyTap() }
                return nil
            }
            if owned && [.leftMouseDragged, .rightMouseDragged, .otherMouseDragged].contains(type) { return nil }
            return Unmanaged.passUnretained(event)
        }
        if type == .keyDown {
            let noCommand = event.flags.intersection([.maskCommand, .maskControl, .maskAlternate]).isEmpty
            if event.getIntegerValueField(.keyboardEventKeycode) == 53, noCommand {
                ownsEscape = true
                stop(); onExit?("已按 Esc 暂停原鼠标校正，返回工作台。", true); return nil
            }
            return Unmanaged.passUnretained(event)
        }
        // Only the Esc whose down was consumed above belongs to this capture.
        // All other key releases remain ordinary keyboard input.
        if type == .keyUp { return Unmanaged.passUnretained(event) }
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
        let movement = type == .mouseMoved || drag
        var corrected = SIMD2<Double>.zero
        if movement {
            let raw = SIMD2(event.getDoubleValueField(.mouseEventDeltaX), event.getDoubleValueField(.mouseEventDeltaY))
            let result = warpDeltas.compensate(raw: raw, timestamp: event.timestamp,
                isHardware: event.getIntegerValueField(.eventSourceUnixProcessID) == 0)
            lastRawDelta = raw; lastCorrectedDelta = result.corrected; lastWarpCorrection = result.correction
            corrected = result.corrected
        }
        if !engaged {
            // A move that enters the screen is already reflected in this position;
            // seed from it once instead of applying its delta twice or jumping to center.
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
            onEvent?(.move(dx: corrected.x, dy: corrected.y, modifiers: flags))
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
