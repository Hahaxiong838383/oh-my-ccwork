import AppKit
import Combine
import OSLog
import SwiftUI

@MainActor
final class MenuBarPanel: NSPanel {
    var onEscape: (() -> Void)?

    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }

    init() {
        super.init(
            contentRect: NSRect(x: 0, y: 0, width: 400, height: 560),
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        title = "CPA Menu"
        isReleasedWhenClosed = false
        isFloatingPanel = true
        hidesOnDeactivate = false
        becomesKeyOnlyIfNeeded = false
        level = .floating
        collectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary]
        isOpaque = false
        backgroundColor = .clear
        hasShadow = true
    }

    override func cancelOperation(_ sender: Any?) {
        onEscape?()
    }
}

@MainActor
private final class PanelHostingView<Content: View>: NSHostingView<Content> {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

enum PanelPlacement {
    static func frame(anchor: NSRect, visibleFrame: NSRect) -> NSRect {
        let inset: CGFloat = 8
        let bounds = visibleFrame.insetBy(dx: inset, dy: inset)
        let size = NSSize(width: min(400, bounds.width), height: min(560, bounds.height))
        let origin = NSPoint(
            x: min(max(anchor.maxX - size.width, bounds.minX), bounds.maxX - size.width),
            y: min(max(anchor.minY - size.height - inset, bounds.minY), bounds.maxY - size.height)
        )
        return NSRect(origin: origin, size: size)
    }
}

@MainActor
final class StatusPanelController: NSObject, NSWindowDelegate {
    private let model: AppModel
    private let presentation: MenuPresentation
    private let statusItem: NSStatusItem
    private let panel = MenuBarPanel()
    private var subscriptions: Set<AnyCancellable> = []
    private var localMonitor: Any?
    private var globalMonitor: Any?
    private var activationObserver: NSObjectProtocol?
    private let logger = Logger(subsystem: "com.hahaxiong.cpa-menubar", category: "window")

    init(model: AppModel, presentation: MenuPresentation) {
        self.model = model
        self.presentation = presentation
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        super.init()
        let hostingView = PanelHostingView(rootView: MenuContentView(model: model, presentation: presentation))
        hostingView.sizingOptions = []
        hostingView.wantsLayer = true
        hostingView.layer?.cornerRadius = 14
        hostingView.layer?.masksToBounds = true
        hostingView.layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
        panel.contentView = hostingView
        panel.delegate = self
        panel.onEscape = { [weak presentation] in presentation?.handleEscape() }
        statusItem.button?.target = self
        statusItem.button?.action = #selector(togglePanel)
        updateStatusItem()
        model.objectWillChange
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in self?.updateStatusItem() }
            .store(in: &subscriptions)
        presentation.$isVisible.removeDuplicates().sink { [weak self] visible in
            if visible { self?.showPanel() } else { self?.hidePanel() }
        }.store(in: &subscriptions)
        presentation.$focusRevision.dropFirst().sink { [weak self] _ in
            guard let self, self.presentation.isVisible else { return }
            self.activatePanel()
        }.store(in: &subscriptions)
        activationObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification,
            object: nil,
            queue: .main
        ) { [weak self] notification in
            guard let application = notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication,
                  application.processIdentifier != ProcessInfo.processInfo.processIdentifier
            else { return }
            MainActor.assumeIsolated { self?.presentation.handleOutsideInteraction() }
        }
    }

    func shutdown() {
        removeEventMonitors()
        if let activationObserver {
            NSWorkspace.shared.notificationCenter.removeObserver(activationObserver)
        }
        subscriptions.removeAll()
        panel.orderOut(nil)
        NSStatusBar.system.removeStatusItem(statusItem)
    }

    func reopen() {
        presentation.show()
    }

    @objc private func togglePanel() {
        presentation.toggle()
    }

    private func updateStatusItem() {
        guard let button = statusItem.button else { return }
        button.title = model.menuLabel
        button.image = NSImage(systemSymbolName: model.statusSymbol, accessibilityDescription: "CPA")
        button.imagePosition = .imageLeading
        button.font = .monospacedDigitSystemFont(ofSize: NSFont.systemFontSize, weight: .regular)
        button.toolTip = "CPA Menu \(AppRelease.label)"
        button.setAccessibilityLabel("CPA Menu，\(model.menuLabel)")
        presentation.hasInFlightAction = model.isAuthorizationActive || model.resettingAccountID != nil || model.removingAccountID != nil
    }

    private func showPanel() {
        guard let button = statusItem.button, let anchorWindow = button.window,
              let screen = anchorWindow.screen ?? NSScreen.main
        else { return }
        let anchor = anchorWindow.convertToScreen(button.convert(button.bounds, to: nil))
        panel.setFrame(PanelPlacement.frame(anchor: anchor, visibleFrame: screen.visibleFrame), display: true)
        installEventMonitors()
        activatePanel()
        logger.notice("panel_open version=\(AppRelease.version, privacy: .public) is_key=\(self.panel.isKeyWindow) app_active=\(NSApp.isActive)")
    }

    private func activatePanel() {
        NSApp.activate()
        panel.makeKeyAndOrderFront(nil)
    }

    private func hidePanel() {
        removeEventMonitors()
        panel.orderOut(nil)
    }

    private func installEventMonitors() {
        guard localMonitor == nil else { return }
        localMonitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] event in
            guard let self else { return event }
            if event.window !== self.panel && event.window !== self.statusItem.button?.window {
                self.presentation.handleOutsideInteraction()
            }
            return event
        }
        globalMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
            self?.presentation.handleOutsideInteraction()
        }
    }

    private func removeEventMonitors() {
        if let localMonitor { NSEvent.removeMonitor(localMonitor) }
        if let globalMonitor { NSEvent.removeMonitor(globalMonitor) }
        localMonitor = nil
        globalMonitor = nil
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        presentation.hide()
        return false
    }

    func windowDidBecomeKey(_ notification: Notification) {
        logger.notice("panel_focus_acquired")
    }
}

@MainActor
final class MenuBarAppDelegate: NSObject, NSApplicationDelegate {
    private var controller: StatusPanelController?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        controller = StatusPanelController(model: AppModel(), presentation: MenuPresentation())
        if ProcessInfo.processInfo.arguments.contains("--show-panel") { controller?.reopen() }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        controller?.reopen()
        return true
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationWillTerminate(_ notification: Notification) {
        controller?.shutdown()
    }
}
