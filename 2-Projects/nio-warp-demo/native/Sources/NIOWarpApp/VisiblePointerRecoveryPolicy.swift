import AppKit
import CoreGraphics

/// Chooses a visible desktop destination without moving the mouse or changing
/// focus. AppKit frames and Quartz bounds are points, not backing pixels.
enum VisiblePointerRecoveryPolicy {
    struct Screen: Equatable {
        let id: CGDirectDisplayID
        let frame: CGRect
        let visibleFrame: CGRect
        let quartzBounds: CGRect
        let isBuiltIn: Bool
        let isActive: Bool
        let isAsleep: Bool
        let isOwned: Bool
    }

    static func physicalScreens(_ screens: [Screen]) -> [Screen] {
        screens.filter {
            $0.isActive && !$0.isAsleep && !$0.isOwned
                && usable($0.frame) && usable($0.quartzBounds)
        }
    }

    static func preferredScreen(in screens: [Screen], windowScreenID: CGDirectDisplayID?) -> Screen? {
        let physical = physicalScreens(screens)
        return physical.first(where: \.isBuiltIn)
            ?? physical.first(where: { $0.id == windowScreenID })
            ?? physical.first
    }

    /// Use the visible part of the workbench. If it is still on an unavailable
    /// display, use the chosen physical screen's available desktop instead.
    static func destination(workbenchFrame: CGRect?, screen: Screen) -> CGPoint? {
        guard !physicalScreens([screen]).isEmpty else { return nil }
        let intersection = screen.visibleFrame.intersection(screen.frame)
        let available = usable(intersection) ? intersection : screen.frame
        let visibleWindow = workbenchFrame.flatMap { usable($0) ? $0.intersection(available) : nil }
        let target = visibleWindow.flatMap { usable($0) ? $0 : nil } ?? available
        let appKitPoint = CGPoint(x: target.midX, y: target.midY)
        let x = (appKitPoint.x - screen.frame.minX) / screen.frame.width
        let y = (screen.frame.maxY - appKitPoint.y) / screen.frame.height
        let quartz = CGPoint(x: screen.quartzBounds.minX + x * screen.quartzBounds.width,
                             y: screen.quartzBounds.minY + y * screen.quartzBounds.height)
        return finite(quartz) && screen.quartzBounds.contains(quartz) ? quartz : nil
    }

    /// A source-only display is never a safe destination, even if stale display
    /// metadata temporarily overlaps it with a physical screen.
    static func needsRecovery(point: CGPoint, screens: [Screen]) -> Bool {
        guard finite(point) else { return true }
        if screens.contains(where: { $0.isOwned && $0.isActive && usable($0.quartzBounds) && $0.quartzBounds.contains(point) }) {
            return true
        }
        return !physicalScreens(screens).contains(where: { $0.quartzBounds.contains(point) })
    }

    static func recoveryDestination(currentPoint: CGPoint, screens: [Screen], workbenchFrame: CGRect?,
                                    windowScreenID: CGDirectDisplayID?, lastVisiblePoint: CGPoint?,
                                    forceWorkbench: Bool = false) -> CGPoint? {
        guard forceWorkbench || needsRecovery(point: currentPoint, screens: screens),
              let screen = preferredScreen(in: screens, windowScreenID: windowScreenID) else { return nil }
        if !forceWorkbench, let lastVisiblePoint, !needsRecovery(point: lastVisiblePoint, screens: screens) {
            return lastVisiblePoint
        }
        let ordered = [screen] + physicalScreens(screens).filter { $0.id != screen.id }
        return ordered.lazy.compactMap { destination(workbenchFrame: workbenchFrame, screen: $0) }
            .first { !needsRecovery(point: $0, screens: screens) }
    }

    private static func finite(_ point: CGPoint) -> Bool { point.x.isFinite && point.y.isFinite }
    private static func usable(_ rect: CGRect) -> Bool {
        !rect.isNull && !rect.isInfinite && !rect.isEmpty
            && rect.origin.x.isFinite && rect.origin.y.isFinite
            && rect.width.isFinite && rect.height.isFinite && rect.width > 0 && rect.height > 0
    }
}

/// Read-only adapter. The caller owns stopping capture, showing the workbench,
/// and applying a returned point with CGWarpMouseCursorPosition.
@MainActor enum VisiblePointerRecoveryRuntime {
    static func screens() -> [VisiblePointerRecoveryPolicy.Screen] {
        NSScreen.screens.compactMap { screen in
            guard let id = (screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value else { return nil }
            return VisiblePointerRecoveryPolicy.Screen(id: id, frame: screen.frame, visibleFrame: screen.visibleFrame,
                quartzBounds: CGDisplayBounds(id), isBuiltIn: CGDisplayIsBuiltin(id) != 0,
                isActive: CGDisplayIsActive(id) != 0, isAsleep: CGDisplayIsAsleep(id) != 0,
                isOwned: OwnedPresentationDisplay.isOwnedDisplay(id))
        }
    }

    static func recoveryDestination(window: NSWindow?, lastVisiblePoint: CGPoint?, forceWorkbench: Bool = false) -> CGPoint? {
        guard let currentPoint = CGEvent(source: nil)?.location else { return nil }
        let screenID = (window?.screen?.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value
        return VisiblePointerRecoveryPolicy.recoveryDestination(currentPoint: currentPoint, screens: screens(),
            workbenchFrame: window?.frame, windowScreenID: screenID, lastVisiblePoint: lastVisiblePoint,
            forceWorkbench: forceWorkbench)
    }
}
