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
