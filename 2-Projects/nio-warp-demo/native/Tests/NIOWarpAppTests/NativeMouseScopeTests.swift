import AppKit
import XCTest
@testable import NIOWarpApp

final class NativeMouseScopeTests: XCTestCase {
    private let outputBounds = CGRect(x: -7680, y: -936, width: 7680, height: 936)

    private func window(owner: String = "Window Server", layer: Int = Int(CGWindowLevelForKey(.cursorWindow)),
                        sharing: Int = 0) -> [String: Any] {
        [kCGWindowOwnerName as String: owner,
         kCGWindowLayer as String: NSNumber(value: layer),
         kCGWindowSharingState as String: NSNumber(value: sharing)]
    }

    func testNonshareableWindowServerCursorIsNotAnOccluder() {
        XCTAssertTrue(NativeMouseInputCapture.isSystemCursorWindow(window()))
    }

    func testChromeAndMenusRemainOccluders() {
        XCTAssertFalse(NativeMouseInputCapture.isSystemCursorWindow(window(owner: "Google Chrome", layer: 0)))
        XCTAssertFalse(NativeMouseInputCapture.isSystemCursorWindow(window(layer: 24)))
    }

    func testShareableStatusIndicatorAtCursorLevelRemainsAnOccluder() {
        XCTAssertFalse(NativeMouseInputCapture.isSystemCursorWindow(window(sharing: 1)))
        XCTAssertFalse(NativeMouseInputCapture.isSystemCursorWindow(window(sharing: 2)))
    }

    func testOtherOwnersAtCursorLevelAreNotMistakenForSystemCursor() {
        for owner in ["Google Chrome", "NIOWarpApp", "Dock", "StatusIndicator", ""] {
            XCTAssertFalse(NativeMouseInputCapture.isSystemCursorWindow(window(owner: owner)), owner)
        }
    }

    func testIncompleteOrMalformedMetadataDoesNotHideAnOccluder() {
        for key in [kCGWindowOwnerName, kCGWindowLayer, kCGWindowSharingState] {
            var incomplete = window()
            incomplete.removeValue(forKey: key as String)
            XCTAssertFalse(NativeMouseInputCapture.isSystemCursorWindow(incomplete))
            var malformed = window()
            malformed[key as String] = ["unexpected": "value"]
            XCTAssertFalse(NativeMouseInputCapture.isSystemCursorWindow(malformed))
        }
    }

    private func cursorWindow(_ id: CGWindowID = 6, sharing: Int = 1, store: Int = 2,
                              bounds: CGRect = CGRect(x: -3866, y: -494, width: 53, height: 53)) -> [String: Any] {
        var result = window(sharing: sharing)
        result[kCGWindowNumber as String] = NSNumber(value: id)
        result[kCGWindowStoreType as String] = NSNumber(value: store)
        result[kCGWindowBounds as String] = bounds.dictionaryRepresentation
        return result
    }

    private var originalCursorImages: [NativeSystemCursorImage] {
        [NativeSystemCursorImage(size: CGSize(width: 53, height: 53), hotSpot: CGPoint(x: 26, y: 26))!,
         NativeSystemCursorImage(size: CGSize(width: 50, height: 50), hotSpot: CGPoint(x: 25, y: 25))!]
    }

    func testUnregisteredCursorUsesOnlyOriginalStrictIdentification() {
        var otherOwner = cursorWindow(7, sharing: 0)
        otherOwner[kCGWindowOwnerName as String] = "StatusIndicator"
        var otherLevel = cursorWindow(8, sharing: 0)
        otherLevel[kCGWindowLayer as String] = NSNumber(value: 24)
        let entries = [cursorWindow(6, sharing: 0), cursorWindow(9, sharing: 1),
                       cursorWindow(10, sharing: 2), cursorWindow(0, sharing: 0), otherOwner, otherLevel]
        XCTAssertEqual(NativeMouseInputCapture.confirmedSystemCursorWindowIDs(in: entries), [6])
    }

    func testRegisteredImageIdentifiesShareableCursorWithoutEarlierNonshareableSample() {
        let pointer = CGPoint(x: -3840, y: -468)
        XCTAssertTrue(NativeMouseInputCapture.isSystemCursorWindow(cursorWindow(),
            cursorImages: originalCursorImages, cursorPoint: pointer))
        let entries = [cursorWindow(), surfaceWindow(101)]
        let windows = NativeMouseInputCapture.scopeWindows(entries, outputWindow: 101, outputOwned: true,
            cursorImages: originalCursorImages, cursorPoint: pointer)
        XCTAssertEqual(windows.map { $0.0 }, [101])
        XCTAssertTrue(owns(windows, target: 101, point: pointer))
        XCTAssertEqual(NativeMouseInputCapture.confirmedSystemCursorWindowIDs(in: entries,
            cursorImages: originalCursorImages, cursorPoint: pointer), [6])
        let pressed = cursorWindow(bounds: CGRect(x: -3865, y: -493, width: 50, height: 50))
        XCTAssertTrue(NativeMouseInputCapture.isSystemCursorWindow(pressed,
            cursorImages: originalCursorImages, cursorPoint: pointer))
    }

    func testUnregisteredOrDifferentImageCannotIgnoreShareableWindow() {
        let pointer = CGPoint(x: -3840, y: -468)
        let other = NativeSystemCursorImage(size: CGSize(width: 20, height: 24), hotSpot: CGPoint(x: 3, y: 2))!
        for images: [NativeSystemCursorImage] in [[], [other]] {
            XCTAssertFalse(NativeMouseInputCapture.isSystemCursorWindow(cursorWindow(),
                cursorImages: images, cursorPoint: pointer))
            let windows = NativeMouseInputCapture.scopeWindows([cursorWindow(), surfaceWindow(101)],
                outputWindow: 101, outputOwned: true, cursorImages: images, cursorPoint: pointer)
            XCTAssertEqual(windows.map { $0.0 }, [6, 101])
            XCTAssertFalse(owns(windows, target: 101, point: pointer))
        }
    }

    func testMatchingImageStillRequiresCursorOwnerLevelStoreAndNotStatusIndicator() {
        let pointer = CGPoint(x: -3840, y: -468)
        for (key, value): (String, Any) in [
            (kCGWindowOwnerName as String, "StatusIndicator"),
            (kCGWindowName as String, "StatusIndicator"),
            (kCGWindowLayer as String, NSNumber(value: 24)),
            (kCGWindowStoreType as String, NSNumber(value: 1)),
            (kCGWindowSharingState as String, NSNumber(value: 2))] {
            var changed = cursorWindow()
            changed[key] = value
            XCTAssertFalse(NativeMouseInputCapture.isSystemCursorWindow(changed,
                cursorImages: originalCursorImages, cursorPoint: pointer), key)
        }
        // The real shareable Window Server status indicator uses store 1.
        let status = cursorWindow(store: 1)
        let windows = NativeMouseInputCapture.scopeWindows([status, surfaceWindow(101)],
            outputWindow: 101, outputOwned: true, cursorImages: originalCursorImages, cursorPoint: pointer)
        XCTAssertEqual(windows.map { $0.0 }, [6, 101])
        XCTAssertFalse(owns(windows, target: 101, point: pointer))
    }

    func testImageMatchRequiresFiniteBoundsAtActualHotspot() {
        for pointer: CGPoint? in [nil, CGPoint(x: -4000, y: -468), CGPoint(x: CGFloat.nan, y: -468),
                                 CGPoint(x: -3840, y: CGFloat.infinity)] {
            XCTAssertFalse(NativeMouseInputCapture.isSystemCursorWindow(cursorWindow(),
                cursorImages: originalCursorImages, cursorPoint: pointer))
        }
        for bounds in [CGRect.null, CGRect.infinite, CGRect(x: CGFloat.nan, y: -494, width: 53, height: 53),
                       CGRect(x: -3866, y: -494, width: -53, height: 53),
                       CGRect(x: -3866, y: -494, width: 53, height: 0)] {
            XCTAssertFalse(NativeMouseInputCapture.isSystemCursorWindow(cursorWindow(bounds: bounds),
                cursorImages: originalCursorImages, cursorPoint: CGPoint(x: -3840, y: -468)))
        }
    }

    func testSharedCursorMissingOrMalformedMetadataStaysAnOccluder() {
        for key in [kCGWindowNumber, kCGWindowOwnerName, kCGWindowLayer, kCGWindowSharingState,
                    kCGWindowStoreType, kCGWindowBounds] {
            var missing = cursorWindow()
            missing.removeValue(forKey: key as String)
            XCTAssertFalse(NativeMouseInputCapture.isSystemCursorWindow(missing,
                cursorImages: originalCursorImages, cursorPoint: CGPoint(x: -3840, y: -468)))
            var malformed = cursorWindow()
            malformed[key as String] = ["unexpected": "value"]
            XCTAssertFalse(NativeMouseInputCapture.isSystemCursorWindow(malformed,
                cursorImages: originalCursorImages, cursorPoint: CGPoint(x: -3840, y: -468)))
        }
    }

    func testRetinaAndNegativeFractionalCursorFootprintUsesLogicalPoints() {
        for image in originalCursorImages {
            for point in [CGPoint(x: 1074, y: -1013), CGPoint(x: -3840.5, y: -468.25), CGPoint(x: 0.25, y: 1.75)] {
                let expected = CGRect(x: point.x - image.hotSpot.x, y: point.y - image.hotSpot.y,
                    width: image.size.width, height: image.size.height)
                for delta in [CGFloat(-1), -0.5, 0, 0.5, 1] {
                    let quantized = CGRect(x: expected.minX + delta, y: expected.minY - delta,
                        width: expected.width + delta, height: expected.height - delta)
                    XCTAssertTrue(image.matches(bounds: quantized, cursorPoint: point))
                }
                let doublePixels = CGRect(origin: expected.origin,
                    size: CGSize(width: image.size.width * 2, height: image.size.height * 2))
                XCTAssertFalse(image.matches(bounds: doublePixels, cursorPoint: point), "Retina 不得重复乘二")
            }
        }
    }

    func testSameSizeWindowAtWrongOriginIsStillAnOccluder() {
        let point = CGPoint(x: -3840, y: -468)
        for offset in [CGFloat(-2), -1.01, 1.01, 2, 20] {
            let wrong = cursorWindow(bounds: CGRect(x: -3866 + offset, y: -494, width: 53, height: 53))
            XCTAssertFalse(NativeMouseInputCapture.isSystemCursorWindow(wrong,
                cursorImages: originalCursorImages, cursorPoint: point))
            let windows = NativeMouseInputCapture.scopeWindows([wrong, surfaceWindow(101)],
                outputWindow: 101, outputOwned: true, cursorImages: originalCursorImages, cursorPoint: point)
            XCTAssertEqual(windows.map { $0.0 }, [6, 101])
        }
    }

    func testCursorFootprintRejectsInvalidSizesAndHotspots() {
        for size in [CGSize(width: 0, height: 53), CGSize(width: -1, height: 53),
                     CGSize(width: CGFloat.nan, height: 53), CGSize(width: 53, height: CGFloat.infinity)] {
            XCTAssertNil(NativeSystemCursorImage(size: size, hotSpot: CGPoint(x: 26, y: 26)))
        }
        for point in [CGPoint(x: -1, y: 26), CGPoint(x: 53, y: 26), CGPoint(x: 26, y: 53),
                      CGPoint(x: CGFloat.nan, y: 26), CGPoint(x: 26, y: CGFloat.infinity)] {
            XCTAssertNil(NativeSystemCursorImage(size: CGSize(width: 53, height: 53), hotSpot: point))
        }
    }

    private func surfaceWindow(_ id: CGWindowID, owner: String = "NIOWarpApp", alpha: Double = 1,
                               bounds: CGRect? = nil) -> [String: Any] {
        [kCGWindowNumber as String: NSNumber(value: id),
         kCGWindowOwnerName as String: owner,
         kCGWindowLayer as String: NSNumber(value: 0),
         kCGWindowSharingState as String: NSNumber(value: 1),
         kCGWindowAlpha as String: NSNumber(value: alpha),
         kCGWindowBounds as String: (bounds ?? outputBounds).dictionaryRepresentation]
    }

    private func owns(_ windows: [(CGWindowID, CGRect)], target: CGWindowID,
                      point: CGPoint = CGPoint(x: -3840, y: -468), frontPID: pid_t? = 42,
                      active: Bool = true, outputOwned: Bool = true, outputWindowIsKey: Bool = true) -> Bool {
        NativeMouseInputCapture.surfaceIsOwned(isActive: active, point: point, displayBounds: outputBounds,
            frontProcessID: frontPID, processID: 42, targetWindow: target, windows: windows,
            outputOwned: outputOwned, outputWindowIsKey: outputWindowIsKey)
    }

    func testLegacyOverlayPassesThroughToChromeButOutputModeOwnsTheTopWindow() {
        let entries = [surfaceWindow(101), surfaceWindow(202, owner: "Google Chrome")]
        let legacy = NativeMouseInputCapture.scopeWindows(entries, outputWindow: 101, outputOwned: false)
        XCTAssertEqual(legacy.map { $0.0 }, [202])
        XCTAssertTrue(owns(legacy, target: 202, outputOwned: false, outputWindowIsKey: false))
        let output = NativeMouseInputCapture.scopeWindows(entries, outputWindow: 101, outputOwned: true)
        XCTAssertEqual(output.map { $0.0 }, [101, 202])
        XCTAssertTrue(owns(output, target: 101))
        XCTAssertFalse(owns(output, target: 202))
    }

    func testOutputScopeCannotOwnAnotherApplicationOrOrdinaryInternalScreen() {
        let windows = NativeMouseInputCapture.scopeWindows([surfaceWindow(101)], outputWindow: 101, outputOwned: true)
        XCTAssertFalse(owns(windows, target: 101, frontPID: 43))
        XCTAssertFalse(owns(windows, target: 101, frontPID: nil))
        XCTAssertFalse(owns(windows, target: 101, point: CGPoint(x: 200, y: 200)))
        XCTAssertFalse(owns(windows, target: 101, active: false))
    }

    func testOutputScopeDoesNotReachThroughAnOverlappingWindow() {
        let entries = [surfaceWindow(303, owner: "Other App"), surfaceWindow(101)]
        let windows = NativeMouseInputCapture.scopeWindows(entries, outputWindow: 101, outputOwned: true)
        XCTAssertEqual(windows.map { $0.0 }, [303, 101])
        XCTAssertFalse(owns(windows, target: 101))
    }

    func testInternalWorkbenchKeyboardFocusCannotKeepAStaleOutputPlacementEngaged() {
        let windows = NativeMouseInputCapture.scopeWindows([surfaceWindow(101)], outputWindow: 101, outputOwned: true)
        // Same frontmost NIO process and remembered output point, but its internal
        // workbench now owns keyboard focus: do not consume its clicks or keys.
        XCTAssertFalse(owns(windows, target: 101, outputWindowIsKey: false))
        XCTAssertTrue(owns(windows, target: 101, outputWindowIsKey: true))
    }

    func testFirstDesktopClickOrWheelEscapesBeforeTheKeyWindowChanges() {
        let outputPoint = CGPoint(x: -3840, y: -468)
        let desktopPoint = CGPoint(x: 200, y: 200)
        let windows = NativeMouseInputCapture.scopeWindows([surfaceWindow(101)], outputWindow: 101, outputOwned: true)
        let point = NativeMouseInputCapture.scopePoint(eventLocation: desktopPoint, placement: outputPoint,
            engaged: true, outputOwned: true, movement: false)
        XCTAssertEqual(point, desktopPoint)
        XCTAssertFalse(owns(windows, target: 101, point: point, outputWindowIsKey: true))
    }

    func testMirroredMovementStillUsesCorrectedPlacementWithoutChangingLegacyClicks() {
        let corrected = CGPoint(x: -1, y: -468)
        let rawPastEdge = CGPoint(x: 2, y: -468)
        XCTAssertEqual(NativeMouseInputCapture.scopePoint(eventLocation: rawPastEdge, placement: corrected,
            engaged: true, outputOwned: true, movement: true), corrected)
        XCTAssertEqual(NativeMouseInputCapture.scopePoint(eventLocation: rawPastEdge, placement: corrected,
            engaged: true, outputOwned: false, movement: false), corrected)
        XCTAssertEqual(NativeMouseInputCapture.scopePoint(eventLocation: rawPastEdge, placement: corrected,
            engaged: false, outputOwned: true, movement: true), rawPastEdge)
    }

    func testSystemCursorAndInvisibleWindowsDoNotMaskTheOutputTarget() {
        var cursor = window()
        cursor[kCGWindowNumber as String] = NSNumber(value: 404)
        cursor[kCGWindowBounds as String] = outputBounds.dictionaryRepresentation
        let entries = [cursor, surfaceWindow(303, alpha: 0), surfaceWindow(101)]
        let windows = NativeMouseInputCapture.scopeWindows(entries, outputWindow: 101, outputOwned: true)
        XCTAssertEqual(windows.map { $0.0 }, [101])
        XCTAssertTrue(owns(windows, target: 101))
    }

    func testOutputEscapeBelongsOnlyToTheCurrentlyOwnedSurface() {
        let windows = NativeMouseInputCapture.scopeWindows([surfaceWindow(101)], outputWindow: 101, outputOwned: true)
        XCTAssertTrue(NativeMouseInputCapture.shouldConsumeEscape(outputOwned: true,
            surfaceOwned: owns(windows, target: 101), outputWindowIsKey: true))
        XCTAssertFalse(NativeMouseInputCapture.shouldConsumeEscape(outputOwned: true,
            surfaceOwned: owns(windows, target: 101, point: CGPoint(x: 100, y: 100)), outputWindowIsKey: true))
        XCTAssertFalse(NativeMouseInputCapture.shouldConsumeEscape(outputOwned: true,
            surfaceOwned: owns(windows, target: 101, frontPID: 43), outputWindowIsKey: true))
        XCTAssertFalse(NativeMouseInputCapture.shouldConsumeEscape(outputOwned: true,
            surfaceOwned: owns(windows, target: 101), outputWindowIsKey: false))
        XCTAssertTrue(NativeMouseInputCapture.shouldConsumeEscape(outputOwned: false, surfaceOwned: false,
            outputWindowIsKey: false))
    }

    func testRetinaAABottomEdgeStaysInsideAfterWindowServerQuantization() throws {
        // Physical AA [0.5,0.5 ... 3839.5,799.5] on the live display
        // Quartz rect (-221,-1200,1920,1200), at two pixels per point.
        let bounds = CGRect(x: -220.75, y: -1199.75, width: 1919.5, height: 399.5)
        let requested = CGPoint(x: 800.375, y: -800.24997)
        let confined = try XCTUnwrap(NativeMouseInputCapture.confinedCursorPoint(requested, within: bounds))
        XCTAssertEqual(confined, CGPoint(x: 800.375, y: -801))
        for quantizedY in [confined.y.rounded(.down), confined.y.rounded(.up), confined.y.rounded(.towardZero), confined.y.rounded()] {
            let physicalY = (quantizedY + 1200) * 2
            XCTAssertGreaterThanOrEqual(physicalY, 0.5)
            XCTAssertLessThanOrEqual(physicalY, 799.5)
        }
    }

    func testConfinementHandlesAllCornersAcrossPositiveAndNegativeOrigins() throws {
        for origin in [CGPoint(x: 100.25, y: 200.25), CGPoint(x: -100.75, y: -200.75), CGPoint(x: -100.75, y: 200.25)] {
            let bounds = CGRect(origin: origin, size: CGSize(width: 30.5, height: 20.5))
            for x in [bounds.minX, bounds.maxX] {
                for y in [bounds.minY, bounds.maxY] {
                    let point = try XCTUnwrap(NativeMouseInputCapture.confinedCursorPoint(CGPoint(x: x, y: y), within: bounds))
                    XCTAssertEqual(point.x, x == bounds.minX ? bounds.minX.rounded(.up) : bounds.maxX.rounded(.down))
                    XCTAssertEqual(point.y, y == bounds.minY ? bounds.minY.rounded(.up) : bounds.maxY.rounded(.down))
                    XCTAssertLessThan(abs(point.x - x), 1)
                    XCTAssertLessThan(abs(point.y - y), 1)
                }
            }
        }
    }

    func testConfinementPreservesInteriorFractionsAndIntegralEdges() throws {
        let bounds = CGRect(x: -200, y: -100, width: 500, height: 300)
        for point in [CGPoint(x: -199.875, y: -99.625), CGPoint(x: -0.75, y: 0.125),
                      CGPoint(x: 299.875, y: 199.625), CGPoint(x: -200, y: -100), CGPoint(x: 300, y: 200)] {
            XCTAssertEqual(try XCTUnwrap(NativeMouseInputCapture.confinedCursorPoint(point, within: bounds)), point)
        }
    }

    func testFarOutsideCandidatesClampWithoutCreatingAnOutsideHotspot() throws {
        let bounds = CGRect(x: -2.75, y: 10.25, width: 6.5, height: 5.5)
        XCTAssertEqual(try XCTUnwrap(NativeMouseInputCapture.confinedCursorPoint(CGPoint(x: -1_000_000, y: 1_000_000), within: bounds)),
                       CGPoint(x: -2, y: 15))
        XCTAssertEqual(try XCTUnwrap(NativeMouseInputCapture.confinedCursorPoint(CGPoint(x: 1_000_000, y: -1_000_000), within: bounds)),
                       CGPoint(x: 3, y: 11))
    }

    func testSubPointBoundsRequireAnIntegerDestinationOnBothAxes() throws {
        XCTAssertNil(NativeMouseInputCapture.confinedCursorPoint(.zero, within: CGRect(x: 0.1, y: 0, width: 0.8, height: 10)))
        XCTAssertNil(NativeMouseInputCapture.confinedCursorPoint(.zero, within: CGRect(x: 0, y: -0.9, width: 10, height: 0.8)))
        XCTAssertEqual(try XCTUnwrap(NativeMouseInputCapture.confinedCursorPoint(CGPoint(x: 0.9, y: -1.1),
            within: CGRect(x: 0.75, y: -1.25, width: 0.5, height: 0.5))), CGPoint(x: 1, y: -1))
        // Inclusive limits can describe exactly one physical pixel centre.
        XCTAssertEqual(try XCTUnwrap(NativeMouseInputCapture.confinedCursorPoint(.zero,
            within: CGRect(x: 2, y: -3, width: 0, height: 0))), CGPoint(x: 2, y: -3))
    }

    func testConfinementRejectsNonfiniteAndMalformedBounds() {
        let bounds = CGRect(x: 0, y: 0, width: 10, height: 10)
        XCTAssertNil(NativeMouseInputCapture.confinedCursorPoint(CGPoint(x: CGFloat.nan, y: 1), within: bounds))
        XCTAssertNil(NativeMouseInputCapture.confinedCursorPoint(CGPoint(x: 1, y: CGFloat.infinity), within: bounds))
        for invalid in [CGRect.null, CGRect.infinite, CGRect(x: CGFloat.nan, y: 0, width: 10, height: 10),
                        CGRect(x: 0, y: 0, width: -1, height: 10), CGRect(x: 0, y: 0, width: 10, height: -1)] {
            XCTAssertNil(NativeMouseInputCapture.confinedCursorPoint(.zero, within: invalid))
        }
    }
}
