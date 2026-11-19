import AppKit
import ApplicationServices

/// A presentation can remain visible after mouse mapping has stopped. Keep its
/// ordinary-Esc exit independent, without capturing any other keyboard input.
@MainActor final class PresentationExitCapture {
    var shouldExit: (() -> Bool)?
    var onExit: (() -> Void)?
    private(set) var isRunning = false
    private var ownership = PresentationEscapeOwnership()
    private var tap: CFMachPort?
    private var runLoopSource: CFRunLoopSource?
    private var generation = UUID()

    /// Failure is optional-capability failure: it must not stop mouse mapping or
    /// disable the existing emergency shortcut.
    @discardableResult func start() -> Bool {
        if isRunning { return true }
        // An earlier consumed Escape still needs its physical release. Reusing
        // that gesture as a new session's Escape could unexpectedly exit it.
        guard tap == nil else { return false }
        let mask = (CGEventMask(1) << CGEventType.keyDown.rawValue)
            | (CGEventMask(1) << CGEventType.keyUp.rawValue)
        guard let tap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap,
            options: .defaultTap, eventsOfInterest: mask, callback: { _, type, event, context in
                guard let context else { return Unmanaged.passUnretained(event) }
                return MainActor.assumeIsolated {
                    Unmanaged<PresentationExitCapture>.fromOpaque(context).takeUnretainedValue().receive(type, event)
                }
            }, userInfo: Unmanaged.passUnretained(self).toOpaque()) else { return false }
        guard let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0) else {
            CFMachPortInvalidate(tap)
            return false
        }
        self.tap = tap; runLoopSource = source
        ownership = PresentationEscapeOwnership(); generation = UUID(); isRunning = true
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
        return true
    }

    func stop() {
        isRunning = false; generation = UUID()
        // Consume the rest of a gesture whose key-down we already consumed,
        // even if the exit callback stopped the listener or hid the presentation.
        if !ownership.ownsEscape { destroyTap() }
    }

    private func destroyTap() {
        if let tap { CGEvent.tapEnable(tap: tap, enable: false); CFMachPortInvalidate(tap) }
        if let source = runLoopSource { CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes) }
        tap = nil; runLoopSource = nil
    }

    deinit {
        if let tap { CGEvent.tapEnable(tap: tap, enable: false); CFMachPortInvalidate(tap) }
        if let source = runLoopSource { CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes) }
    }

    private func receive(_ type: CGEventType, _ event: CGEvent) -> Unmanaged<CGEvent>? {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            // A disabled listener cannot drain a release. Tear down only this
            // optional listener; the mouse mapping/emergency shortcut is separate.
            ownership = PresentationEscapeOwnership()
            stop()
            return Unmanaged.passUnretained(event)
        }
        guard type == .keyDown || type == .keyUp,
              event.getIntegerValueField(.keyboardEventKeycode) == 53 else {
            return Unmanaged.passUnretained(event)
        }
        // Do not evaluate the presentation provider for unrelated keys, releases,
        // owned repeats or system shortcuts.
        let allowExit = isRunning && !ownership.ownsEscape && type == .keyDown
            && PresentationEscapeOwnership.isOrdinaryEscape(event.flags) && shouldExit?() == true
        let action = ownership.receive(type: type,
            keyCode: event.getIntegerValueField(.keyboardEventKeycode), flags: event.flags, allowExit: allowExit)
        if action.requestsExit {
            let token = generation
            DispatchQueue.main.async { [weak self] in
                guard let self, self.isRunning, self.generation == token else { return }
                self.onExit?()
            }
        }
        if !isRunning, !ownership.ownsEscape { destroyTap() }
        return action.consumed ? nil : Unmanaged.passUnretained(event)
    }
}

/// Pure gesture ownership: once its down is consumed, repeat/up cannot leak into
/// the workbench merely because the presentation provider has changed to false.
struct PresentationEscapeOwnership {
    struct Action: Equatable {
        let consumed: Bool
        let requestsExit: Bool
    }
    private(set) var ownsEscape = false

    static func isOrdinaryEscape(_ flags: CGEventFlags) -> Bool {
        flags.intersection([.maskCommand, .maskControl, .maskAlternate, .maskShift, .maskSecondaryFn]).isEmpty
    }

    mutating func receive(type: CGEventType, keyCode: Int64, flags: CGEventFlags, allowExit: Bool) -> Action {
        guard keyCode == 53, type == .keyDown || type == .keyUp else {
            return Action(consumed: false, requestsExit: false)
        }
        if ownsEscape {
            if type == .keyUp { ownsEscape = false }
            return Action(consumed: true, requestsExit: false)
        }
        guard type == .keyDown, allowExit, Self.isOrdinaryEscape(flags) else {
            return Action(consumed: false, requestsExit: false)
        }
        ownsEscape = true
        return Action(consumed: true, requestsExit: true)
    }
}
