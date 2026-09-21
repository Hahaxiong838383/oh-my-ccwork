import AppKit
import ApplicationServices
import Dispatch

/// Logical-point footprint of an original CSS cursor already verified by the
/// controller. No system-wide cursor image capture is involved.
struct NativeSystemCursorImage: Equatable {
    let size: CGSize
    let hotSpot: CGPoint

    init?(size: CGSize, hotSpot: CGPoint) {
        guard size.width.isFinite, size.height.isFinite, size.width > 0, size.height > 0,
              hotSpot.x.isFinite, hotSpot.y.isFinite,
              hotSpot.x >= 0, hotSpot.x < size.width,
              hotSpot.y >= 0, hotSpot.y < size.height else { return nil }
        self.size = size; self.hotSpot = hotSpot
    }

    func matches(bounds: CGRect, cursorPoint: CGPoint) -> Bool {
        guard !bounds.isInfinite, bounds.origin.x.isFinite, bounds.origin.y.isFinite,
              bounds.size.width.isFinite, bounds.size.height.isFinite,
              bounds.size.width > 0, bounds.size.height > 0,
              bounds.maxX.isFinite, bounds.maxY.isFinite,
              cursorPoint.x.isFinite, cursorPoint.y.isFinite else { return false }
        // WindowServer and Retina backing pixels can quantize each edge. Both
        // image dimensions and its origin must match within one logical point.
        return abs(bounds.width - size.width) <= 1 && abs(bounds.height - size.height) <= 1
            && abs(bounds.minX - (cursorPoint.x - hotSpot.x)) <= 1
            && abs(bounds.minY - (cursorPoint.y - hotSpot.y)) <= 1
    }
}

/// Filters only the bound external-screen input surface. The legacy path belongs
/// to Chrome; a virtual source instead uses NIO Warp's physical output window.
/// This capture never draws, hides, or disconnects the real system cursor.
@MainActor final class NativeMouseInputCapture {
    var onEvent: ((MouseCaptureEvent) -> Void)?
    /// Pointer activity is independent of mapped displacement. In particular,
    /// the first hardware move wakes the cursor even when its delta is primed.
    var onPointerActivity: ((MouseCaptureEvent) -> Void)?
    var onKeyboardEvent: ((MouseKeyboardInput) -> Void)?
    var onEnter: ((CGPoint, Bool) -> Bool)?
    var onLeave: (() -> Void)?
    var onCursorScopeChange: ((Bool) -> Void)?
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
    private var outputOwned = false
    private var cursorScopeOwned = false
    private var ownedButtons = 0
    private var ownsEscape = false
    private var keyboard = NativeKeyboardOwnership()
    private var windows: [(CGWindowID, CGRect)] = []
    private var knownSystemCursorWindowIDs = Set<CGWindowID>()
    private var cursorImages = [NativeSystemCursorImage]()
    private(set) var physicalInputSuspended = false

    /// A workbench password sheet owns physical input, while scripted CDP input
    /// may continue. Keep consumed gestures until their real releases arrive.
    func setPhysicalInputSuspended(_ suspended: Bool) {
        guard physicalInputSuspended != suspended else { return }
        physicalInputSuspended = suspended
        if suspended { leaveSurface() }
    }

    func begin(displayID: CGDirectDisplayID, processID: pid_t, targetWindow: CGWindowID,
               outputWindow: CGWindowID, outputOwned: Bool = false) throws {
        guard !isActive else { return }
        guard tap == nil else { throw MouseCaptureError("请先松开上次演示按住的键盘或鼠标按键，再启用校正。") }
        guard CGDisplayIsActive(displayID) != 0, CGDisplayIsAsleep(displayID) == 0 else {
            throw MouseCaptureError("演示外屏不可用，原鼠标保持正常。")
        }
        resetMovement()
        knownSystemCursorWindowIDs.removeAll()
        cursorImages.removeAll()
        registerCursorImage(.arrow)
        self.displayID = displayID; self.processID = processID
        self.targetWindow = targetWindow; self.outputWindow = outputWindow
        self.outputOwned = outputOwned
        let types: [CGEventType] = [.mouseMoved, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged,
            .leftMouseDown, .leftMouseUp, .rightMouseDown, .rightMouseUp, .otherMouseDown, .otherMouseUp, .scrollWheel, .keyDown, .keyUp, .flagsChanged]
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
        let cursorPoint = CGEvent(source: nil)?.location
        // IDs are diagnostic only: sharing metadata can differ by caller, so
        // each shareable image must independently match a registered footprint.
        knownSystemCursorWindowIDs.formUnion(Self.confirmedSystemCursorWindowIDs(in: entries,
            cursorImages: cursorImages, cursorPoint: cursorPoint))
        windows = Self.scopeWindows(entries, outputWindow: outputWindow, outputOwned: outputOwned,
            cursorImages: cursorImages, cursorPoint: cursorPoint)
        if engaged, let point = placement, !ownsSurface(at: point) { leaveSurface() }
        if keyboard.hasHeldKeys, !ownsCurrentSurface() { releaseKeyboard() }
    }

    /// Preserve WindowServer's front-to-back ordering. A transparent Warp overlay
    /// is ignored only when Chrome owns input; it is the target in output mode.
    nonisolated static func scopeWindows(_ entries: [[String: Any]], outputWindow: CGWindowID,
                                         outputOwned: Bool, cursorImages: [NativeSystemCursorImage] = [],
                                         cursorPoint: CGPoint? = nil) -> [(CGWindowID, CGRect)] {
        entries.compactMap { entry in
            guard let id = (entry[kCGWindowNumber as String] as? NSNumber)?.uint32Value,
                  outputOwned || id != outputWindow,
                  !Self.isSystemCursorWindow(entry, cursorImages: cursorImages, cursorPoint: cursorPoint),
                  (entry[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1 > 0,
                  let value = entry[kCGWindowBounds as String] as? [String: Any],
                  let rect = CGRect(dictionaryRepresentation: value as CFDictionary), !rect.isEmpty else { return nil }
            return (id, rect)
        }
    }

    nonisolated static func confirmedSystemCursorWindowIDs(in entries: [[String: Any]],
                                                          cursorImages: [NativeSystemCursorImage] = [],
                                                          cursorPoint: CGPoint? = nil) -> Set<CGWindowID> {
        Set(entries.compactMap { entry in
            guard Self.isSystemCursorWindow(entry, cursorImages: cursorImages, cursorPoint: cursorPoint),
                  let number = entry[kCGWindowNumber as String] as? NSNumber,
                  number.int64Value > 0, number.int64Value <= Int64(UInt32.max) else { return nil }
            return number.uint32Value
        })
    }

    /// Retain only current and previous original artwork while WindowServer
    /// finishes a hover/pressed image swap. The controller calls this before set().
    func registerCursorImage(_ cursor: NSCursor) {
        guard let image = NativeSystemCursorImage(size: cursor.image.size, hotSpot: cursor.hotSpot) else { return }
        cursorImages.removeAll { $0 == image }
        cursorImages.insert(image, at: 0)
        if cursorImages.count > 2 { cursorImages.removeLast(cursorImages.count - 2) }
    }

    /// Cursor sharing metadata can vary by caller during hide/unhide or pressed
    /// image updates. A read-only-shareable image must match our original CSS
    /// cursor dimensions AND its origin relative to the actual system hotspot.
    /// Other windows and explicit status indicators remain occluders.
    nonisolated static func isSystemCursorWindow(_ entry: [String: Any],
                                                cursorImages: [NativeSystemCursorImage] = [],
                                                cursorPoint: CGPoint? = nil) -> Bool {
        guard entry[kCGWindowOwnerName as String] as? String == "Window Server",
              (entry[kCGWindowLayer as String] as? NSNumber)?.intValue == Int(CGWindowLevelForKey(.cursorWindow)),
              let sharing = (entry[kCGWindowSharingState as String] as? NSNumber)?.intValue else { return false }
        if sharing == 0 { return true }
        guard sharing == 1,
              let number = entry[kCGWindowNumber as String] as? NSNumber,
              number.int64Value > 0, number.int64Value <= Int64(UInt32.max),
              entry[kCGWindowName as String] as? String != "StatusIndicator",
              (entry[kCGWindowStoreType as String] as? NSNumber)?.intValue == 2,
              let cursorPoint,
              let value = entry[kCGWindowBounds as String] as? [String: Any],
              let bounds = CGRect(dictionaryRepresentation: value as CFDictionary) else { return false }
        return cursorImages.contains { $0.matches(bounds: bounds, cursorPoint: cursorPoint) }
    }

    func adoptCurrentCursorIfInside() {
        guard let point = CGEvent(source: nil)?.location, ownsSurface(at: point), !engaged else { return }
        engaged = onEnter?(point, true) == true
        setCursorScopeOwned(engaged)
    }

    func placeCursor(at point: CGPoint) -> Bool {
        guard isActive, point.x.isFinite, point.y.isFinite else { return false }
        guard let before = CGEvent(source: nil) else { return false }
        guard CGWarpMouseCursorPosition(point) == .success else { return false }
        guard let after = CGEvent(source: nil) else { resetMovement(); return false }
        warpDeltas.recordWarp(delta: SIMD2(Double(after.location.x - before.location.x),
                                          Double(after.location.y - before.location.y)),
                              timestamp: Self.completedWarpTimestamp())
        placement = point
        return true
    }

    /// Bounds are the inclusive AA pixel-centre limits converted to global
    /// Quartz points. WindowServer may quantize a warp to whole points; reserve
    /// an integer-safe boundary while preserving every interior fraction.
    /// An already-in-bounds request moves by less than one point per axis.
    nonisolated static func confinedCursorPoint(_ requested: CGPoint, within bounds: CGRect) -> CGPoint? {
        guard requested.x.isFinite, requested.y.isFinite, !bounds.isInfinite,
              bounds.origin.x.isFinite, bounds.origin.y.isFinite,
              bounds.size.width.isFinite, bounds.size.height.isFinite,
              bounds.size.width >= 0, bounds.size.height >= 0,
              bounds.maxX.isFinite, bounds.maxY.isFinite else { return nil }
        let minimum = CGPoint(x: bounds.minX.rounded(.up), y: bounds.minY.rounded(.up))
        let maximum = CGPoint(x: bounds.maxX.rounded(.down), y: bounds.maxY.rounded(.down))
        // A sub-point AA interval may contain no representable whole point.
        // Do not invent a destination outside the caller's visible region.
        guard minimum.x <= maximum.x, minimum.y <= maximum.y else { return nil }
        return CGPoint(x: min(max(requested.x, minimum.x), maximum.x),
                       y: min(max(requested.y, minimum.y), maximum.y))
    }

    /// CGEvent(source: nil) is a position snapshot and has timestamp zero. CGEvent
    /// hardware timestamps use the same nanoseconds-since-boot clock as Dispatch.
    nonisolated static func completedWarpTimestamp() -> UInt64 {
        DispatchTime.now().uptimeNanoseconds
    }

    /// Priming suppresses mapped motion, but a real hand movement still wakes
    /// an idle cursor. Remove only the known warp contribution in that case.
    /// Pure warp feedback and zero/invalid input never reset the idle clock.
    nonisolated static func pointerActivityDelta(raw: SIMD2<Double>,
                                                compensation: MouseWarpDeltaCompensator.Result) -> SIMD2<Double>? {
        let delta = compensation.primed ? raw - compensation.correction : compensation.corrected
        guard delta.x.isFinite, delta.y.isFinite, delta != .zero else { return nil }
        return delta
    }

    func stop() {
        releaseKeyboard()
        isActive = false; engaged = false; placement = nil; windows.removeAll()
        knownSystemCursorWindowIDs.removeAll()
        cursorImages.removeAll()
        setCursorScopeOwned(false)
        resetMovement()
        // Keep each consumed gesture until its physical release: both a mouse up
        // and an Esc repeat/up must not leak to Chrome after mapping has stopped.
        if !hasOwnedReleases { destroyTap() }
    }

    private var hasOwnedReleases: Bool { ownedButtons != 0 || ownsEscape || keyboard.hasPendingReleases }

    private func releaseKeyboard() {
        keyboard.releaseAll().forEach { onKeyboardEvent?($0) }
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
        let keys = [kCGWindowNumber, kCGWindowOwnerName, kCGWindowLayer, kCGWindowSharingState, kCGWindowStoreType, kCGWindowBounds]
        let details = keys.reduce(into: [String: Any]()) { result, key in
            if let value = first?[key as String] { result[key as String] = value }
        }
        return ["firstWindowMetadata": details, "displayID": displayID, "insideDisplay": bounds.contains(point),
                "frontPID": NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0,
                "processID": processID, "targetWindow": targetWindow, "outputWindow": outputWindow,
                "outputOwned": outputOwned, "cursorScopeOwned": cursorScopeOwned,
                "heldKeyCount": keyboard.heldKeyCount, "drainingKeyCount": keyboard.drainingKeyCount,
                "knownSystemCursorWindowIDs": knownSystemCursorWindowIDs.sorted(),
                "registeredCursorImages": cursorImages.map { ["size": [$0.size.width, $0.size.height],
                    "hotSpot": [$0.hotSpot.x, $0.hotSpot.y]] },
                "outputWindowIsKey": NSApplication.shared.keyWindow?.windowNumber == Int(outputWindow),
                "coveringWindows": windows.filter { $0.1.contains(point) }.prefix(4).map { $0.0 },
                "point": [point.x, point.y]]
    }

    private func ownsSurface(at point: CGPoint) -> Bool {
        Self.surfaceIsOwned(isActive: isActive && !physicalInputSuspended, point: point, displayBounds: CGDisplayBounds(displayID),
            frontProcessID: NSWorkspace.shared.frontmostApplication?.processIdentifier,
            processID: processID, targetWindow: targetWindow, windows: windows,
            outputOwned: outputOwned, outputWindowIsKey: NSApplication.shared.keyWindow?.windowNumber == Int(outputWindow))
    }

    /// Recheck after an asynchronous page/cursor lookup. Never move the pointer
    /// or reuse the last corrected placement as proof that input is still ours.
    func ownsCurrentSurface() -> Bool {
        guard let point = CGEvent(source: nil)?.location else { return false }
        return ownsSurface(at: point)
    }

    nonisolated static func surfaceIsOwned(isActive: Bool, point: CGPoint, displayBounds: CGRect,
                                          frontProcessID: pid_t?, processID: pid_t, targetWindow: CGWindowID,
                                          windows: [(CGWindowID, CGRect)], outputOwned: Bool,
                                          outputWindowIsKey: Bool) -> Bool {
        isActive && displayBounds.contains(point) && frontProcessID == processID
            && (!outputOwned || outputWindowIsKey)
            && windows.first(where: { $0.1.contains(point) })?.0 == targetWindow
    }

    nonisolated static func shouldConsumeEscape(outputOwned: Bool, surfaceOwned: Bool,
                                               outputWindowIsKey: Bool) -> Bool {
        !outputOwned || (surfaceOwned && outputWindowIsKey)
    }

    nonisolated static func scopePoint(eventLocation: CGPoint, placement: CGPoint?, engaged: Bool,
                                      outputOwned: Bool, movement: Bool) -> CGPoint {
        engaged && (!outputOwned || movement) ? (placement ?? eventLocation) : eventLocation
    }

    private func setCursorScopeOwned(_ owned: Bool) {
        guard cursorScopeOwned != owned else { return }
        cursorScopeOwned = owned
        onCursorScopeChange?(owned)
    }

    private func leaveSurface() {
        releaseKeyboard()
        setCursorScopeOwned(false)
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
            // A disabled event tap cannot drain releases. Page key-ups were sent
            // by stop; avoid retaining an unusable capture indefinitely.
            keyboard = NativeKeyboardOwnership()
            destroyTap()
            if wasActive { onExit?("原鼠标校正监听已停止，恢复普通输入。", false) }
            return Unmanaged.passUnretained(event)
        }
        if !isActive {
            if ownsEscape, (type == .keyDown || type == .keyUp),
               event.getIntegerValueField(.keyboardEventKeycode) == 53 {
                if type == .keyUp {
                    ownsEscape = false
                    if !hasOwnedReleases { destroyTap() }
                }
                return nil
            }
            if let key = Self.keyboardInput(type, event) {
                let result = keyboard.receive(key, canCapture: false,
                    isSystemShortcut: !event.flags.intersection([.maskCommand, .maskControl]).isEmpty)
                result.forwarded.forEach { onKeyboardEvent?($0) }
                if !hasOwnedReleases { destroyTap() }
                return result.consumed ? nil : Unmanaged.passUnretained(event)
            }
            let number = Int(event.getIntegerValueField(.mouseEventButtonNumber))
            let bit = number == 0 ? 1 : number == 1 ? 2 : number == 2 ? 4 : 0
            let owned = bit != 0 && ownedButtons & bit != 0
            if owned && [.leftMouseUp, .rightMouseUp, .otherMouseUp].contains(type) {
                ownedButtons &= ~bit
                if !hasOwnedReleases { destroyTap() }
                return nil
            }
            if owned && [.leftMouseDragged, .rightMouseDragged, .otherMouseDragged].contains(type) { return nil }
            return Unmanaged.passUnretained(event)
        }
        if type == .keyDown {
            let noCommand = event.flags.intersection([.maskCommand, .maskControl, .maskAlternate]).isEmpty
            if event.getIntegerValueField(.keyboardEventKeycode) == 53, noCommand {
                // Check the real pointer and keyboard owner, not a remembered
                // output placement: ordinary desktop/text-field Esc passes through.
                let surfaceOwned = CGEvent(source: nil).map { ownsSurface(at: $0.location) } ?? false
                let outputWindowIsKey = NSApplication.shared.keyWindow?.windowNumber == Int(outputWindow)
                if !physicalInputSuspended, Self.shouldConsumeEscape(outputOwned: outputOwned, surfaceOwned: surfaceOwned,
                                            outputWindowIsKey: outputWindowIsKey) {
                    ownsEscape = true
                    stop(); onExit?("已按 Esc 暂停原鼠标校正，返回工作台。", true); return nil
                }
            }
            if outputOwned { return receiveKeyboard(type, event) }
            return Unmanaged.passUnretained(event)
        }
        // Only the Esc whose down was consumed above belongs to this capture.
        // All other key releases remain ordinary keyboard input.
        if type == .keyUp || type == .flagsChanged {
            if outputOwned { return receiveKeyboard(type, event) }
            return Unmanaged.passUnretained(event)
        }
        let up = [.leftMouseUp, .rightMouseUp, .otherMouseUp].contains(type)
        let number = Int(event.getIntegerValueField(.mouseEventButtonNumber))
        let bit = number == 0 ? 1 : number == 1 ? 2 : number == 2 ? 4 : 0
        let ownedUp = up && bit != 0 && ownedButtons & bit != 0
        let drag = [.leftMouseDragged, .rightMouseDragged, .otherMouseDragged].contains(type)
        let movement = type == .mouseMoved || drag
        if drag && ownedButtons == 0 { return Unmanaged.passUnretained(event) }
        // Raw event.location is the uncorrected candidate. At a mirrored edge it
        // may lie outside the screen while the corrected movement points inward.
        // Output-mode clicks/wheels must use their actual location so a desktop
        // click can change focus even before AppKit updates the key window.
        let point = Self.scopePoint(eventLocation: event.location, placement: placement,
            engaged: engaged, outputOwned: outputOwned, movement: movement)
        guard ownsSurface(at: point) else {
            leaveSurface()
            if ownedUp { ownedButtons &= ~bit; return nil }
            if drag && ownedButtons != 0 { return nil }
            return Unmanaged.passUnretained(event)
        }
        if up && !ownedUp { return Unmanaged.passUnretained(event) }
        var corrected = SIMD2<Double>.zero
        var pointerActivity: MouseCaptureEvent?
        let flags = Self.modifiers(event.flags)
        if movement {
            let raw = SIMD2(event.getDoubleValueField(.mouseEventDeltaX), event.getDoubleValueField(.mouseEventDeltaY))
            let result = warpDeltas.compensate(raw: raw, timestamp: event.timestamp,
                isHardware: event.getIntegerValueField(.eventSourceUnixProcessID) == 0)
            lastRawDelta = raw; lastCorrectedDelta = result.corrected; lastWarpCorrection = result.correction
            corrected = result.corrected
            if let delta = Self.pointerActivityDelta(raw: raw, compensation: result) {
                pointerActivity = .move(dx: delta.x, dy: delta.y, modifiers: flags)
            }
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
            setCursorScopeOwned(true)
            if type == .mouseMoved {
                if let pointerActivity { onPointerActivity?(pointerActivity) }
                return nil
            }
        }
        eventCount += 1
        switch type {
        case .mouseMoved, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged:
            if let pointerActivity { onPointerActivity?(pointerActivity) }
            onEvent?(.move(dx: corrected.x, dy: corrected.y, modifiers: flags))
        case .leftMouseDown, .rightMouseDown, .otherMouseDown:
            guard bit != 0 else { return Unmanaged.passUnretained(event) }
            ownedButtons |= bit
            let captured = MouseCaptureEvent.button(down: true, number: number,
                clickCount: Int(event.getIntegerValueField(.mouseEventClickState)), modifiers: flags)
            onPointerActivity?(captured)
            onEvent?(captured)
        case .leftMouseUp, .rightMouseUp, .otherMouseUp:
            ownedButtons &= ~bit
            let captured = MouseCaptureEvent.button(down: false, number: number,
                clickCount: Int(event.getIntegerValueField(.mouseEventClickState)), modifiers: flags)
            onPointerActivity?(captured)
            onEvent?(captured)
        case .scrollWheel:
            let continuous = event.getIntegerValueField(.scrollWheelEventIsContinuous) != 0
            let dx = continuous ? event.getDoubleValueField(.scrollWheelEventPointDeltaAxis2) : event.getDoubleValueField(.scrollWheelEventDeltaAxis2) * 40
            let dy = continuous ? event.getDoubleValueField(.scrollWheelEventPointDeltaAxis1) : event.getDoubleValueField(.scrollWheelEventDeltaAxis1) * 40
            let captured = MouseCaptureEvent.wheel(dx: -dx, dy: -dy, modifiers: flags)
            onPointerActivity?(captured)
            onEvent?(captured)
        default: return Unmanaged.passUnretained(event)
        }
        return nil
    }

    nonisolated static func modifiers(_ flags: CGEventFlags) -> Int {
        (flags.contains(.maskAlternate) ? 1 : 0) | (flags.contains(.maskControl) ? 2 : 0)
            | (flags.contains(.maskCommand) ? 4 : 0) | (flags.contains(.maskShift) ? 8 : 0)
    }

    private func receiveKeyboard(_ type: CGEventType, _ event: CGEvent) -> Unmanaged<CGEvent>? {
        let systemShortcut = !event.flags.intersection([.maskCommand, .maskControl]).isEmpty
        if type == .flagsChanged, systemShortcut { releaseKeyboard() }
        guard let key = Self.keyboardInput(type, event) else { return Unmanaged.passUnretained(event) }
        let result = keyboard.receive(key,
            canCapture: isActive && outputOwned && onKeyboardEvent != nil && ownsCurrentSurface()
                && MouseKeyboardEvent.isSupported(key),
            isSystemShortcut: systemShortcut)
        result.forwarded.forEach { onKeyboardEvent?($0) }
        return result.consumed ? nil : Unmanaged.passUnretained(event)
    }

    nonisolated static func keyboardInput(_ type: CGEventType, _ event: CGEvent) -> MouseKeyboardInput? {
        let code = UInt16(truncatingIfNeeded: event.getIntegerValueField(.keyboardEventKeycode))
        let down: Bool
        if type == .flagsChanged {
            // Command, Control, Caps Lock and Fn remain system-owned. Shift and
            // Option are ordinary page modifiers and may also be prototype keys.
            let flag: CGEventFlags
            switch code {
            case 56, 60: flag = .maskShift
            case 58, 61: flag = .maskAlternate
            default: return nil
            }
            down = event.flags.contains(flag)
        } else if type == .keyDown || type == .keyUp {
            down = type == .keyDown
        } else { return nil }
        let nsEvent = NSEvent(cgEvent: event)
        return MouseKeyboardInput(down: down, keyCode: code,
            text: down && type == .keyDown ? nsEvent?.characters ?? "" : "",
            unmodifiedText: type == .flagsChanged ? "" : nsEvent?.charactersIgnoringModifiers ?? "",
            modifiers: Self.modifiers(event.flags),
            isAutoRepeat: down && event.getIntegerValueField(.keyboardEventAutorepeat) != 0)
    }
}

/// Keeps page key ownership separate from the current focus. A focus loss sends
/// each page key-up once, then drains its remaining physical repeat/up gesture.
struct NativeKeyboardOwnership {
    struct Result {
        let consumed: Bool
        let forwarded: [MouseKeyboardInput]
    }
    private var held = [UInt16: MouseKeyboardInput]()
    private var draining = Set<UInt16>()
    var heldKeyCount: Int { held.count }
    var drainingKeyCount: Int { draining.count }
    var hasHeldKeys: Bool { !held.isEmpty }
    var hasPendingReleases: Bool { !held.isEmpty || !draining.isEmpty }

    mutating func receive(_ input: MouseKeyboardInput, canCapture: Bool, isSystemShortcut: Bool) -> Result {
        if input.kind == .up {
            if let original = held.removeValue(forKey: input.keyCode) {
                let release = MouseKeyboardInput(down: false, keyCode: input.keyCode, text: original.text,
                    unmodifiedText: original.unmodifiedText, modifiers: input.modifiers & ~(2 | 4), isAutoRepeat: false)
                return Result(consumed: true, forwarded: [release])
            }
            return Result(consumed: draining.remove(input.keyCode) != nil, forwarded: [])
        }
        if isSystemShortcut {
            let released = releaseAll()
            // This new shortcut down is delivered to macOS; its matching up now
            // belongs there too, even if this key was held before Cmd/Ctrl.
            draining.remove(input.keyCode)
            return Result(consumed: false, forwarded: released)
        }
        if draining.contains(input.keyCode) { return Result(consumed: true, forwarded: []) }
        guard canCapture else {
            let released = releaseAll()
            return Result(consumed: draining.contains(input.keyCode), forwarded: released)
        }
        // Do not steal a gesture whose physical down occurred on another surface.
        guard !input.isAutoRepeat || held[input.keyCode] != nil else {
            return Result(consumed: false, forwarded: [])
        }
        if held[input.keyCode] == nil { held[input.keyCode] = input }
        return Result(consumed: true, forwarded: [input])
    }

    mutating func releaseAll() -> [MouseKeyboardInput] {
        let released = held.keys.sorted().compactMap { key -> MouseKeyboardInput? in
            guard let input = held[key] else { return nil }
            return MouseKeyboardInput(down: false, keyCode: key, text: input.text, unmodifiedText: input.unmodifiedText,
                modifiers: 0, isAutoRepeat: false)
        }
        draining.formUnion(held.keys)
        held.removeAll()
        return released
    }
}
