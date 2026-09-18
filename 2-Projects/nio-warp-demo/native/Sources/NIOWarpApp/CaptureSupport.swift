import AppKit
import CoreGraphics
import Foundation

struct CaptureWindowDescriptor: Equatable {
    var windowID: CGWindowID
    var frame: CGRect
    var applicationName: String
    var title: String
    var isActive: Bool
}

struct CaptureWindowCandidate: Equatable {
    var descriptor: CaptureWindowDescriptor
    var displayCoverage: Double
}

enum AutomaticWindowSelector {
    static func bestCandidate(
        from windows: [CaptureWindowDescriptor],
        displayFrame: CGRect,
        minimumCoverage: Double
    ) -> CaptureWindowCandidate? {
        let displayArea = max(displayFrame.width * displayFrame.height, 1)
        return windows.compactMap { window -> CaptureWindowCandidate? in
            let intersection = window.frame.intersection(displayFrame)
            guard !intersection.isNull, !intersection.isEmpty else { return nil }
            let coverage = intersection.width * intersection.height / displayArea
            guard coverage >= minimumCoverage else { return nil }
            return CaptureWindowCandidate(descriptor: window, displayCoverage: coverage)
        }.max { lhs, rhs in
            if lhs.descriptor.isActive != rhs.descriptor.isActive {
                return !lhs.descriptor.isActive && rhs.descriptor.isActive
            }
            if abs(lhs.displayCoverage - rhs.displayCoverage) > 0.000_001 {
                return lhs.displayCoverage < rhs.displayCoverage
            }
            return lhs.descriptor.windowID > rhs.descriptor.windowID
        }
    }
}

enum CapturePresentation: Equatable {
    case entireDisplay(width: Int, height: Int)
    case waitingForFullscreenWindow
    case fullscreenWindow(applicationName: String, title: String, width: Int, height: Int)

    var summary: String {
        switch self {
        case let .entireDisplay(width, height):
            return "当前捕获：整个外接屏幕 · \(width)×\(height)"
        case .waitingForFullscreenWindow:
            return "当前捕获：整个外接屏幕（等待播放器进入全屏）"
        case let .fullscreenWindow(applicationName, title, width, height):
            let windowName = title.isEmpty ? applicationName : "\(applicationName) · \(title)"
            return "当前捕获：\(windowName) · \(width)×\(height)"
        }
    }
}

enum OutputWindowBehavior {
    static let crossApplicationFullscreen: NSWindow.CollectionBehavior = [
        .canJoinAllSpaces,
        .canJoinAllApplications,
        .stationary,
        .ignoresCycle,
    ]
}

enum AppPresentationPolicy {
    static let activationPolicy = NSApplication.ActivationPolicy.accessory
    static let diagnosticsKey = "nioWarpApp.activationPolicyDiagnostic.v1"
    static let maximumDiagnosticRecords = 12

    enum Reason: String {
        case startup, outputPresentation, applicationActivation
    }

    struct Attempt {
        let previous: NSApplication.ActivationPolicy
        let observed: NSApplication.ActivationPolicy
        let setterAccepted: Bool

        var succeeded: Bool { setterAccepted && observed == activationPolicy }
    }

    /// Keep presentation eligible for other applications' fullscreen Spaces.
    /// A successful request alone is insufficient: verify the effective policy.
    @MainActor @discardableResult
    static func ensureAccessoryPolicy(reason: Reason = .outputPresentation, defaults: UserDefaults = .standard) -> Bool {
        reconcile(
            readPolicy: { NSApplication.shared.activationPolicy() },
            setPolicy: { NSApplication.shared.setActivationPolicy($0) },
            recordAttempt: { record($0, reason: reason, defaults: defaults) }
        )
    }

    /// Inject AppKit access so regression tests never change the test host's policy.
    @discardableResult
    static func reconcile(
        readPolicy: () -> NSApplication.ActivationPolicy,
        setPolicy: (NSApplication.ActivationPolicy) -> Bool,
        recordAttempt: (Attempt) -> Void
    ) -> Bool {
        let previous = readPolicy()
        guard previous != activationPolicy else { return true }
        let accepted = setPolicy(activationPolicy)
        let attempt = Attempt(previous: previous, observed: readPolicy(), setterAccepted: accepted)
        recordAttempt(attempt)
        return attempt.succeeded
    }

    /// Bounded local evidence: only enum values, outcomes and timestamps.
    static func record(_ attempt: Attempt, reason: Reason, defaults: UserDefaults, now: Date = Date()) {
        let entry: [String: Any] = [
            "timestamp": now.timeIntervalSince1970,
            "reason": reason.rawValue,
            "previousPolicy": attempt.previous.rawValue,
            "requestedPolicy": activationPolicy.rawValue,
            "observedPolicy": attempt.observed.rawValue,
            "setterAccepted": attempt.setterAccepted,
            "succeeded": attempt.succeeded,
        ]
        var recent = [[String: Any]]()
        if let data = defaults.data(forKey: diagnosticsKey),
           let previous = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let records = previous["recent"] as? [[String: Any]] {
            recent = Array(records.suffix(maximumDiagnosticRecords - 1))
        }
        recent.append(entry)
        guard let data = try? JSONSerialization.data(withJSONObject: ["current": entry, "recent": recent], options: [.sortedKeys]) else { return }
        defaults.set(data, forKey: diagnosticsKey)
    }
}

enum AABoundaryOverlayGeometry {
    static func borderRect(
        in bounds: CGRect,
        aaRect: NormalizedRect,
        lineWidth: CGFloat
    ) -> CGRect {
        let aa = aaRect.sanitized()
        let physicalRect = CGRect(
            x: bounds.minX + bounds.width * aa.x,
            y: bounds.minY + bounds.height * aa.y,
            width: bounds.width * aa.width,
            height: bounds.height * aa.height
        )
        let inset = max(lineWidth, 0) * 0.5
        return physicalRect.insetBy(dx: inset, dy: inset)
    }
}

enum WarpBoundaryOverlayGeometry {
    static func points(
        in bounds: CGRect,
        configuration: WarpConfiguration,
        samplesPerEdge: Int = 96
    ) -> [CGPoint] {
        let aa = configuration.aaRect.sanitized()
        let footprint = NormalizedRect.full
        let samples = max(samplesPerEdge, 2)
        var canvasPoints = [SIMD2<Float>]()
        canvasPoints.reserveCapacity(samples * 4 + 1)

        for index in 0...samples {
            let progress = Float(index) / Float(samples)
            canvasPoints.append(SIMD2<Float>(Float(footprint.x) + progress * Float(footprint.width), Float(footprint.y)))
        }
        for index in 1...samples {
            let progress = Float(index) / Float(samples)
            canvasPoints.append(SIMD2<Float>(Float(footprint.x + footprint.width), Float(footprint.y) + progress * Float(footprint.height)))
        }
        for index in 1...samples {
            let progress = Float(index) / Float(samples)
            canvasPoints.append(SIMD2<Float>(Float(footprint.x + footprint.width) - progress * Float(footprint.width), Float(footprint.y + footprint.height)))
        }
        for index in 1...samples {
            let progress = Float(index) / Float(samples)
            canvasPoints.append(SIMD2<Float>(Float(footprint.x), Float(footprint.y + footprint.height) - progress * Float(footprint.height)))
        }

        let physicalPoints = WarpMath.localPhysicalPoints(canvasPoints: canvasPoints, configuration: configuration)
        return physicalPoints.map { local in
            return CGPoint(
                x: bounds.minX + bounds.width * (aa.x + Double(local.x) * aa.width),
                y: bounds.minY + bounds.height * (aa.y + Double(local.y) * aa.height)
            )
        }
    }
}
