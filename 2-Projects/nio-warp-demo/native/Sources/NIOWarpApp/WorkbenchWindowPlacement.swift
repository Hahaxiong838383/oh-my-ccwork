import Foundation

/// Window frames and visibleFrame use AppKit points, including negative origins.
enum WorkbenchWindowPlacement {
    static let margin: CGFloat = 8
    static let preferredMinimumContentSize = CGSize(width: 1040, height: 650)

    static func availableFrame(in visibleFrame: CGRect) -> CGRect {
        let insetX = min(margin, max(0, (visibleFrame.width - 1) / 2))
        let insetY = min(margin, max(0, (visibleFrame.height - 1) / 2))
        return visibleFrame.insetBy(dx: insetX, dy: insetY)
    }

    static func containedFrame(_ frame: CGRect, in visibleFrame: CGRect) -> CGRect {
        let available = availableFrame(in: visibleFrame)
        let width = min(frame.width, available.width)
        let height = min(frame.height, available.height)
        return CGRect(
            x: min(max(frame.minX, available.minX), available.maxX - width),
            y: min(max(frame.minY, available.minY), available.maxY - height),
            width: width,
            height: height
        )
    }

    static func minimumContentSize(in visibleFrame: CGRect, frameDecoration: CGSize) -> CGSize {
        let available = availableFrame(in: visibleFrame)
        return CGSize(
            width: min(preferredMinimumContentSize.width, max(1, available.width - frameDecoration.width)),
            height: min(preferredMinimumContentSize.height, max(1, available.height - frameDecoration.height))
        )
    }
}
