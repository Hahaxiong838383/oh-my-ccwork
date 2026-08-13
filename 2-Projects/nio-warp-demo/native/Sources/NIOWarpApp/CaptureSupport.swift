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
