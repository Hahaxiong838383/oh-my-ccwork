import CoreGraphics
import Foundation
import NIOVirtualDisplay

private final class OwnedPresentationDisplayResource {
    private(set) var handle: NIOVirtualDisplayRef?
    let width: Int
    let height: Int
    let displayID: CGDirectDisplayID

    init(handle: NIOVirtualDisplayRef, width: Int, height: Int) {
        self.handle = handle; self.width = width; self.height = height
        displayID = NIOVirtualDisplayGetDisplayID(handle)
    }

    func release() {
        if let handle { self.handle = nil; NIOVirtualDisplayDestroy(handle) }
    }

    deinit { release() }
}

/// Owns a source-only virtual screen. The physical Warp output must exclude
/// these displays when choosing an output, including after an app restart.
@MainActor final class OwnedPresentationDisplay {
    private var current: OwnedPresentationDisplayResource?
    /// Preserve the source being captured until a verified replacement frame
    /// has been accepted; a display mode being ready is not a capture handoff.
    private var captured: OwnedPresentationDisplayResource?
    // A cancelled handoff can already have switched SCK while awaiting the old
    // stream's stop callback. Keep such sources until the next confirmed handoff.
    private var retired = [OwnedPresentationDisplayResource]()
    private var pending: OwnedPresentationDisplayResource?
    private var generation = UUID()

    var displayID: CGDirectDisplayID? { current?.displayID }

    nonisolated static func isOwnedDisplay(_ displayID: CGDirectDisplayID) -> Bool {
        NIOVirtualDisplayIsOwnedDisplay(displayID)
    }

    func ensure(width: Int, height: Int) async throws -> CGDirectDisplayID {
        guard (1...16384).contains(width), (1...16384).contains(height),
              Int64(width) * Int64(height) <= 67_108_864 else {
            throw ProtoPieError.unavailable("内容显示尺寸须在 1～16384 之间，且总像素不得超过 67108864。")
        }
        try Task.checkCancellation()
        if let captured, captured.width == width, captured.height == height, Self.isReady(captured) {
            generation = UUID()
            releaseUnused(pending)
            pending = nil
            if current !== captured {
                if let current { retired.append(current) }
                current = captured
            }
            return captured.displayID
        }
        if let current, current.width == width, current.height == height, Self.isReady(current) {
            // A newer request for the existing size cancels any obsolete resize.
            generation = UUID()
            releaseUnused(pending)
            pending = nil
            return current.displayID
        }
        generation = UUID()
        let token = generation
        var message = [CChar](repeating: 0, count: 1024)
        let candidate: OwnedPresentationDisplayResource
        if let current, current.width == width, current.height == height, current.handle != nil {
            releaseUnused(pending)
            candidate = current
        } else if let pending, pending.width == width, pending.height == height, pending.handle != nil {
            // A newer caller adopts the same pending resource. The older waiter
            // is invalidated by generation, but must not release its successor.
            candidate = pending
        } else if let reusable = retired.first(where: { $0.width == width && $0.height == height && $0.handle != nil }) {
            releaseUnused(pending)
            candidate = reusable
        } else {
            releaseUnused(pending)
            pending = nil
            guard let handle = NIOVirtualDisplayCreate(UInt32(width), UInt32(height), &message, message.count) else {
                throw ProtoPieError.unavailable(Self.errorText(message, fallback: "无法创建内容虚拟显示器。"))
            }
            candidate = OwnedPresentationDisplayResource(handle: handle, width: width, height: height)
        }
        pending = candidate
        do {
            let deadline = ProcessInfo.processInfo.systemUptime + 6
            var selected = false
            var stableSamples = 0
            var lastError = "等待系统完成内容显示器配置。"
            while ProcessInfo.processInfo.systemUptime < deadline {
                try Task.checkCancellation()
                guard generation == token, let handle = candidate.handle else { throw CancellationError() }
                if !selected {
                    let result = NIOVirtualDisplaySelectExactMode(handle, &message, message.count)
                    lastError = Self.errorText(message, fallback: lastError)
                    if result < 0 { throw ProtoPieError.unavailable(lastError) }
                    selected = result == 1
                }
                stableSamples = selected && Self.isReady(candidate) ? stableSamples + 1 : 0
                if stableSamples >= 3 {
                    let previous = current
                    current = candidate; pending = nil
                    if let previous, previous !== candidate, previous !== captured { retired.append(previous) }
                    return candidate.displayID
                }
                try await Task.sleep(nanoseconds: 50_000_000)
            }
            throw ProtoPieError.unavailable("内容显示器未稳定到 \(width)×\(height)（1×）。\(lastError)")
        } catch {
            if generation == token { pending = nil }
            if current !== candidate, pending !== candidate, captured !== candidate,
               !retired.contains(where: { $0 === candidate }) { candidate.release() }
            throw error
        }
    }

    private func releaseUnused(_ resource: OwnedPresentationDisplayResource?) {
        guard let resource, resource !== current, resource !== captured,
              !retired.contains(where: { $0 === resource }) else { return }
        resource.release()
    }

    func captureDidSwitch(to displayID: CGDirectDisplayID) {
        guard let current, current.displayID == displayID else { return }
        let previous = captured
        captured = current
        if previous !== current { previous?.release() }
        for resource in retired where resource !== current { resource.release() }
        retired.removeAll()
    }

    func shutdown() {
        generation = UUID()
        pending?.release(); pending = nil
        current?.release(); current = nil
        captured?.release(); captured = nil
        retired.forEach { $0.release() }; retired.removeAll()
    }

    deinit { pending?.release(); current?.release(); captured?.release(); retired.forEach { $0.release() } }

    private static func isReady(_ resource: OwnedPresentationDisplayResource) -> Bool {
        guard resource.handle != nil, CGDisplayIsActive(resource.displayID) != 0,
              isOwnedDisplay(resource.displayID),
              let mode = CGDisplayCopyDisplayMode(resource.displayID) else { return false }
        let bounds = CGDisplayBounds(resource.displayID)
        return mode.width == resource.width && mode.height == resource.height
            && mode.pixelWidth == resource.width && mode.pixelHeight == resource.height
            && abs(bounds.width - Double(resource.width)) < 1 && abs(bounds.height - Double(resource.height)) < 1
    }

    private static func errorText(_ buffer: [CChar], fallback: String) -> String {
        let text = String(cString: buffer)
        return text.isEmpty ? fallback : text
    }
}
