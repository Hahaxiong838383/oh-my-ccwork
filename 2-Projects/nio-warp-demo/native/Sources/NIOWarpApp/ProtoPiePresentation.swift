import CoreGraphics
import Foundation

/// Native fullscreen is complete only when the window and web content fill the target display.
/// Web viewport sizes are converted to physical pixels so browser zoom does not look like chrome.
struct ProtoPieFullscreenObservation: Equatable {
    let windowID: CGWindowID
    let frame: CGRect
    let browserFrame: CGRect
    let windowState: String
    let viewportPixels: CGSize
    let displayScale: CGFloat

    static func matches(_ lhs: CGRect, _ rhs: CGRect) -> Bool {
        abs(lhs.minX - rhs.minX) < 2 && abs(lhs.minY - rhs.minY) < 2 &&
        abs(lhs.width - rhs.width) < 2 && abs(lhs.height - rhs.height) < 2
    }

    func isReady(for targetFrame: CGRect) -> Bool {
        let values = [frame.minX, frame.minY, frame.width, frame.height,
                      browserFrame.minX, browserFrame.minY, browserFrame.width, browserFrame.height,
                      targetFrame.minX, targetFrame.minY, targetFrame.width, targetFrame.height,
                      viewportPixels.width, viewportPixels.height, displayScale]
        guard values.allSatisfy(\.isFinite), windowState == "fullscreen", windowID != 0,
              displayScale > 0, frame.width > 0, frame.height > 0,
              targetFrame.width > 0, targetFrame.height > 0,
              viewportPixels.width > 0, viewportPixels.height > 0 else { return false }
        return Self.matches(frame, targetFrame) && Self.matches(browserFrame, targetFrame) &&
            abs(viewportPixels.width - frame.width * displayScale) <= 2 * displayScale &&
            abs(viewportPixels.height - frame.height * displayScale) <= 2 * displayScale
    }
}

struct ProtoPieFullscreenReadiness {
    private var previous: ProtoPieFullscreenObservation?
    private var consecutive = 0

    mutating func observe(_ observation: ProtoPieFullscreenObservation?, targetFrame: CGRect) -> Bool {
        guard let observation, observation.isReady(for: targetFrame) else {
            previous = nil; consecutive = 0
            return false
        }
        consecutive = observation == previous ? consecutive + 1 : 1
        previous = observation
        return consecutive >= 3
    }
}
