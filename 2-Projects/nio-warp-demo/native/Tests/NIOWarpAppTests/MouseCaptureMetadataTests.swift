import CoreGraphics
import CoreMedia
import CoreVideo
import Foundation
import ScreenCaptureKit
import XCTest
@testable import NIOWarpApp

final class MouseCaptureMetadataTests: XCTestCase {
    private func sampleBuffer() throws -> CMSampleBuffer {
        var image: CVPixelBuffer?
        XCTAssertEqual(CVPixelBufferCreate(kCFAllocatorDefault, 32, 16, kCVPixelFormatType_32BGRA, nil, &image), kCVReturnSuccess)
        let buffer = try XCTUnwrap(image)
        var description: CMVideoFormatDescription?
        XCTAssertEqual(CMVideoFormatDescriptionCreateForImageBuffer(allocator: kCFAllocatorDefault,
            imageBuffer: buffer, formatDescriptionOut: &description), noErr)
        var timing = CMSampleTimingInfo(duration: .invalid, presentationTimeStamp: .zero, decodeTimeStamp: .invalid)
        var sample: CMSampleBuffer?
        XCTAssertEqual(CMSampleBufferCreateReadyWithImageBuffer(allocator: kCFAllocatorDefault,
            imageBuffer: buffer, formatDescription: try XCTUnwrap(description), sampleTiming: &timing,
            sampleBufferOut: &sample), noErr)
        return try XCTUnwrap(sample)
    }

    private func setAttachments(_ values: [SCStreamFrameInfo: Any], on sample: CMSampleBuffer) throws {
        let array = try XCTUnwrap(CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: true))
        let first = unsafeBitCast(CFArrayGetValueAtIndex(array, 0), to: CFMutableDictionary.self)
        CFDictionaryRemoveAllValues(first)
        for (key, value) in values {
            let keyObject = key.rawValue as NSString
            let valueObject = value as AnyObject
            CFDictionarySetValue(first, Unmanaged.passUnretained(keyObject).toOpaque(), Unmanaged.passUnretained(valueObject).toOpaque())
        }
    }

    func testReadRequiresCompleteFrameAndAllCaptureMetadataTogether() throws {
        let sample = try sampleBuffer()
        XCTAssertNil(MouseCaptureMetadata.read(sample))
        var valid: [SCStreamFrameInfo: Any] = [
            .status: SCFrameStatus.complete.rawValue,
            .contentRect: CGRect(x: 0, y: 0, width: 16, height: 8).dictionaryRepresentation,
            .contentScale: 1.0, .scaleFactor: 2.0
        ]
        try setAttachments(valid, on: sample)
        let metadata = try XCTUnwrap(MouseCaptureMetadata.read(sample))
        XCTAssertEqual(metadata.contentRect, CGRect(x: 0, y: 0, width: 16, height: 8))
        XCTAssertEqual(metadata.pixelRect, CGRect(x: 0, y: 0, width: 32, height: 16))
        XCTAssertTrue(metadata.coversTexture(width: 32, height: 16))
        for status in [SCFrameStatus.idle, .blank, .suspended] {
            valid[.status] = status.rawValue
            try setAttachments(valid, on: sample)
            XCTAssertNil(MouseCaptureMetadata.read(sample))
        }
        valid[.status] = SCFrameStatus.complete.rawValue
        for key in [SCStreamFrameInfo.contentRect, .contentScale, .scaleFactor] {
            var missing = valid
            missing.removeValue(forKey: key)
            try setAttachments(missing, on: sample)
            XCTAssertNil(MouseCaptureMetadata.read(sample))
        }
    }

    func testDiagnosticRectsAreReadWithoutTreatingDesktopOriginAsTextureOffset() throws {
        let sample = try sampleBuffer()
        let screen = CGRect(x: -7680, y: -468, width: 3840, height: 468)
        let bounds = CGRect(x: 0, y: 0, width: 3840, height: 468)
        try setAttachments([
            .status: SCFrameStatus.complete.rawValue,
            .contentRect: bounds.dictionaryRepresentation,
            .contentScale: 1.0, .scaleFactor: 2.0,
            .screenRect: screen.dictionaryRepresentation,
            .boundingRect: bounds.dictionaryRepresentation
        ], on: sample)
        let metadata = try XCTUnwrap(MouseCaptureMetadata.read(sample))
        XCTAssertEqual(metadata.screenRect, screen)
        XCTAssertEqual(metadata.boundingRect, bounds)
        XCTAssertEqual(metadata.pixelRect, CGRect(x: 0, y: 0, width: 7680, height: 936))
        XCTAssertTrue(metadata.coversTexture(width: 7680, height: 936), "全局桌面负坐标不是捕获纹理中的留黑")
    }

    func testLidTopologyOriginChangesKeepMappingIncludingNegativeCoordinates() {
        let original = MouseCaptureMetadata(contentRect: CGRect(x: 0, y: 0, width: 7680, height: 936),
            contentScale: 1, scaleFactor: 1,
            screenRect: CGRect(x: 1512, y: 0, width: 7680, height: 936),
            boundingRect: CGRect(x: 0, y: 0, width: 7680, height: 936))
        for origin in [CGPoint.zero, CGPoint(x: -7680, y: -936), CGPoint(x: 0, y: -982)] {
            var changed = original
            changed.screenRect?.origin = origin
            XCTAssertNotEqual(changed, original, "保留诊断坐标变化，不能以完整 metadata == 作为输入映射版本判断")
            XCTAssertTrue(original.hasSameMapping(as: changed))
            XCTAssertTrue(changed.hasSameMapping(as: original))
            XCTAssertTrue(changed.coversTexture(width: 7680, height: 936))
        }
    }

    func testTrueMappingSizeScaleAndBoundsChangesInvalidateBinding() {
        let original = MouseCaptureMetadata(contentRect: CGRect(x: 0, y: 0, width: 7680, height: 936),
            contentScale: 1, scaleFactor: 1,
            screenRect: CGRect(x: 1512, y: 0, width: 7680, height: 936),
            boundingRect: CGRect(x: 0, y: 0, width: 7680, height: 936))
        var width = original; width.screenRect?.size.width = 3840
        var height = original; height.screenRect?.size.height = 968
        var missingScreen = original; missingScreen.screenRect = nil
        var boundsOffset = original; boundsOffset.boundingRect?.origin.y = 32
        var boundsSize = original; boundsSize.boundingRect?.size.height = 968
        var missingBounds = original; missingBounds.boundingRect = nil
        let contentOffset = MouseCaptureMetadata(contentRect: CGRect(x: 0, y: 1, width: 7680, height: 936),
            contentScale: 1, scaleFactor: 1, screenRect: original.screenRect, boundingRect: original.boundingRect)
        let contentScale = MouseCaptureMetadata(contentRect: original.contentRect,
            contentScale: 0.99, scaleFactor: 1, screenRect: original.screenRect, boundingRect: original.boundingRect)
        let pixelScale = MouseCaptureMetadata(contentRect: original.contentRect,
            contentScale: 1, scaleFactor: 2, screenRect: original.screenRect, boundingRect: original.boundingRect)
        for changed in [width, height, missingScreen, boundsOffset, boundsSize, missingBounds, contentOffset, contentScale, pixelScale] {
            XCTAssertFalse(original.hasSameMapping(as: changed))
            XCTAssertFalse(changed.hasSameMapping(as: original))
        }
        let absentDiagnostics = MouseCaptureMetadata(contentRect: original.contentRect, contentScale: 1, scaleFactor: 1)
        XCTAssertTrue(absentDiagnostics.hasSameMapping(as: absentDiagnostics))
    }

    func testHiddenChromeChildToolbarCaptureCannotRouteFullViewportInput() {
        // Live Cloud failure: a hidden 32 pt toolbar inflated the capture to 968 high,
        // so 936 output pixels letterboxed the 7680-wide viewport to approximately 7426.
        let includedChild = MouseCaptureMetadata(contentRect: CGRect(x: 0, y: 0, width: 7426, height: 936),
            contentScale: 936.0 / 968.0, scaleFactor: 1,
            screenRect: CGRect(x: 0, y: 0, width: 7680, height: 936),
            boundingRect: CGRect(x: 0, y: 0, width: 7680, height: 968))
        let pinnedPage = MouseCaptureMetadata(contentRect: CGRect(x: 0, y: 0, width: 7680, height: 936),
            contentScale: 1, scaleFactor: 1,
            screenRect: CGRect(x: 0, y: 0, width: 7680, height: 936),
            boundingRect: CGRect(x: 0, y: 0, width: 7680, height: 936))
        XCTAssertFalse(includedChild.coversTexture(width: 7680, height: 936))
        XCTAssertFalse(includedChild.hasSameMapping(as: pinnedPage))
        XCTAssertTrue(pinnedPage.coversTexture(width: 7680, height: 936))
    }

    func testRetinaPointRectIsConvertedOnceToTexturePixels() {
        let normal = MouseCaptureMetadata(contentRect: CGRect(x: 0, y: 0, width: 7680, height: 936), contentScale: 1, scaleFactor: 1)
        let retina = MouseCaptureMetadata(contentRect: CGRect(x: 0, y: 0, width: 3840, height: 468), contentScale: 1, scaleFactor: 2)
        XCTAssertTrue(normal.coversTexture(width: 7680, height: 936))
        XCTAssertTrue(retina.coversTexture(width: 7680, height: 936))
        XCTAssertEqual(retina.pixelRect, normal.pixelRect)
        XCTAssertFalse(retina.coversTexture(width: 3840, height: 468))
        let incorrectlyDoubled = MouseCaptureMetadata(contentRect: normal.contentRect, contentScale: 1, scaleFactor: 2)
        XCTAssertFalse(incorrectlyDoubled.coversTexture(width: 7680, height: 936))
    }

    func testLetterboxingCropOffsetScalingAndInvalidDimensionsFailClosed() {
        let valid = CGRect(x: 0, y: 0, width: 1200, height: 600)
        let cases: [MouseCaptureMetadata] = [
            .init(contentRect: CGRect(x: 0, y: 50, width: 1200, height: 550), contentScale: 1, scaleFactor: 1),
            .init(contentRect: CGRect(x: 1.1, y: 0, width: 1200, height: 600), contentScale: 1, scaleFactor: 1),
            .init(contentRect: CGRect(x: 0, y: 0, width: 1198, height: 600), contentScale: 1, scaleFactor: 1),
            .init(contentRect: valid, contentScale: 0.9, scaleFactor: 1),
            .init(contentRect: valid, contentScale: .nan, scaleFactor: 1),
            .init(contentRect: valid, contentScale: 1, scaleFactor: 0),
            .init(contentRect: valid, contentScale: 1, scaleFactor: -.infinity),
            .init(contentRect: CGRect(x: CGFloat.nan, y: 0, width: 1200, height: 600), contentScale: 1, scaleFactor: 1),
            .init(contentRect: CGRect(x: 0, y: 0, width: CGFloat.infinity, height: 600), contentScale: 1, scaleFactor: 1)
        ]
        for metadata in cases { XCTAssertFalse(metadata.coversTexture(width: 1200, height: 600)) }
        let empty = MouseCaptureMetadata(contentRect: .zero, contentScale: 1, scaleFactor: 1)
        XCTAssertFalse(empty.coversTexture(width: 0, height: 0))
        let metadata = MouseCaptureMetadata(contentRect: valid, contentScale: 1, scaleFactor: 1)
        XCTAssertFalse(metadata.coversTexture(width: -1200, height: 600))
        XCTAssertFalse(metadata.coversTexture(width: 1200, height: 0))
    }

    func testRevokingInputRetainsVisualFrameButRemovesSourceIdentityAndCanRecover() throws {
        let buffer = try XCTUnwrap(CMSampleBufferGetImageBuffer(try sampleBuffer()))
        let metadata = MouseCaptureMetadata(contentRect: CGRect(x: 0, y: 0, width: 32, height: 16), contentScale: 1, scaleFactor: 1)
        let source = MouseCaptureSource(generation: UUID(), windowID: 10, processID: 100, windowSize: CGSize(width: 32, height: 16), pointPixelScale: 1)
        let frames = LatestFrameStore()
        frames.revokeInput()
        XCTAssertNil(frames.snapshot())
        frames.update(buffer, metadata: metadata, source: source)
        frames.revokeInput()
        let frozen = try XCTUnwrap(frames.snapshot())
        XCTAssertTrue(frozen.pixelBuffer === buffer)
        XCTAssertTrue(frames.latest() === buffer)
        XCTAssertNil(frozen.metadata)
        XCTAssertNil(frozen.source, "旧视觉帧不能在捕获停止后仍用于发送点击")
        frames.update(buffer, metadata: metadata, source: source)
        XCTAssertEqual(frames.snapshot()?.source, source)
        XCTAssertEqual(frames.snapshot()?.metadata, metadata)
    }

    func testFrameStoreReplacesPixelsMetadataAndSourceGenerationAtomicallyAndClearsAll() throws {
        let firstBuffer = try XCTUnwrap(CMSampleBufferGetImageBuffer(try sampleBuffer()))
        let secondBuffer = try XCTUnwrap(CMSampleBufferGetImageBuffer(try sampleBuffer()))
        let metadata = MouseCaptureMetadata(contentRect: CGRect(x: 0, y: 0, width: 32, height: 16), contentScale: 1, scaleFactor: 1)
        let first = MouseCaptureSource(generation: UUID(), windowID: 10, processID: 100, windowSize: CGSize(width: 32, height: 16), pointPixelScale: 1)
        let second = MouseCaptureSource(generation: UUID(), windowID: 11, processID: 101, windowSize: CGSize(width: 32, height: 16), pointPixelScale: 1)
        let frames = LatestFrameStore()
        XCTAssertNil(frames.snapshot())
        frames.update(firstBuffer, metadata: metadata, source: first)
        XCTAssertEqual(frames.snapshot()?.source, first)
        frames.update(secondBuffer, metadata: metadata, source: second)
        let snapshot = try XCTUnwrap(frames.snapshot())
        XCTAssertTrue(snapshot.pixelBuffer === secondBuffer)
        XCTAssertEqual(snapshot.metadata, metadata)
        XCTAssertEqual(snapshot.source, second)
        frames.clear()
        XCTAssertNil(frames.snapshot())
        XCTAssertNil(frames.latest())
    }
}
