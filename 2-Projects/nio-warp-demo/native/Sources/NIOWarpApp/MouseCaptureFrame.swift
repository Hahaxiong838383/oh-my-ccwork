import CoreGraphics
import CoreMedia
import CoreVideo
import Foundation
import ScreenCaptureKit

struct MouseCaptureSource: Equatable {
    let generation: UUID
    let windowID: CGWindowID
    let processID: pid_t
    let windowSize: CGSize
    let pointPixelScale: Double
}

struct MouseCaptureMetadata: Equatable {
    let contentRect: CGRect
    let contentScale: Double
    let scaleFactor: Double
    var screenRect: CGRect?
    var boundingRect: CGRect?

    static func read(_ buffer: CMSampleBuffer) -> Self? {
        guard let attachments = CMSampleBufferGetSampleAttachmentsArray(buffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let first = attachments.first,
              (first[.status] as? NSNumber)?.intValue == SCFrameStatus.complete.rawValue,
              let rectValue = first[.contentRect] as? [String: Any],
              let rect = CGRect(dictionaryRepresentation: rectValue as CFDictionary),
              let contentScale = first[.contentScale] as? NSNumber,
              let scaleFactor = first[.scaleFactor] as? NSNumber else { return nil }
        func frameRect(_ key: SCStreamFrameInfo) -> CGRect? {
            guard let value = first[key] as? [String: Any] else { return nil }
            return CGRect(dictionaryRepresentation: value as CFDictionary)
        }
        return Self(contentRect: rect, contentScale: contentScale.doubleValue, scaleFactor: scaleFactor.doubleValue,
                    screenRect: frameRect(.screenRect), boundingRect: frameRect(.boundingRect))
    }

    // SCStreamFrameInfo.contentRect is expressed in points in the surface.
    var pixelRect: CGRect {
        CGRect(x: contentRect.minX * scaleFactor, y: contentRect.minY * scaleFactor,
               width: contentRect.width * scaleFactor, height: contentRect.height * scaleFactor)
    }

    func hasSameMapping(as other: Self) -> Bool {
        // Global desktop origin changes on lid/topology events without changing
        // the local texture-to-viewport mapping.
        contentRect == other.contentRect && contentScale == other.contentScale
            && scaleFactor == other.scaleFactor && boundingRect == other.boundingRect
            && screenRect?.size == other.screenRect?.size
    }

    /// Cloud input is enabled only for a full-viewport, unletterboxed capture.
    /// Other metadata arrangements continue rendering but cannot silently route input.
    func coversTexture(width: Int, height: Int) -> Bool {
        width > 0 && height > 0 && contentRect.width > 0 && contentRect.height > 0
            && contentRect.origin.x.isFinite && contentRect.origin.y.isFinite
            && contentRect.width.isFinite && contentRect.height.isFinite
            && abs(pixelRect.minX) <= 1 && abs(pixelRect.minY) <= 1
            && abs(pixelRect.width - Double(width)) <= 1
            && abs(pixelRect.height - Double(height)) <= 1
            && contentScale.isFinite && abs(contentScale - 1) <= 0.001
            && scaleFactor.isFinite && scaleFactor > 0
    }
}

struct MouseCapturedFrame {
    let pixelBuffer: CVPixelBuffer
    let metadata: MouseCaptureMetadata?
    let source: MouseCaptureSource?
}

struct MouseMappingRenderFrame {
    let mesh: GeneratedMesh
    let revision: Int
    let configuration: WarpConfiguration
    let sourceWidth: Int
    let sourceHeight: Int
    let source: MouseCaptureSource
    let metadata: MouseCaptureMetadata
}
