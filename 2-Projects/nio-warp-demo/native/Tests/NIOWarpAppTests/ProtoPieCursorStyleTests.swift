import AppKit
import XCTest
@testable import NIOWarpApp

@MainActor final class ProtoPieCursorStyleTests: XCTestCase {
    func testParsesOriginalNormalAndPressedCSSWithoutChangingHotspot() throws {
        for (name, size, hotspot) in [("Default", 53, 26), ("Active", 50, 25)] {
            let css = "url(\"https://example.test/TouchPoint_\(name).png\") \(hotspot) \(hotspot), auto"
            let definition = try ProtoPieCursorDefinition.parse(css)
            let style = try ProtoPieCursorStyle.decode(definition, imageData: Self.png(width: size, height: size))
            XCTAssertEqual(style.imageSize, CGSize(width: size, height: size))
            XCTAssertEqual(style.hotSpot, CGPoint(x: hotspot, y: hotspot))
            XCTAssertEqual(style.cursor?.hotSpot, style.hotSpot)
            XCTAssertFalse(style.isHidden)
            XCTAssertTrue(style.identifier.hasPrefix("css-image-sha256:"))
            XCTAssertFalse(style.identifier.contains("example.test"))
            XCTAssertFalse(style.identifier.contains("TouchPoint"))
        }
    }

    func testUnquotedAndSingleQuotedAssetsDefaultMissingHotspotToZero() throws {
        for css in ["url(https://example.test/cursor.png), pointer", "url('https://example.test/cursor.png') 0 0, default"] {
            let definition = try ProtoPieCursorDefinition.parse(css)
            XCTAssertEqual(definition.resource, "https://example.test/cursor.png")
            XCTAssertEqual(definition.hotSpot, .zero)
        }
    }

    func testRealComputedImageSetPrefersOneDppxRegardlessOfEntryOrder() throws {
        for function in ["image-set", "-webkit-image-set"] {
            for unit in ["dppx", "x"] {
                for reversed in [false, true] {
                    let assets = ["url(\"https://example.test/TouchPoint_Default.png\") 1\(unit)",
                                  "url(\"https://example.test/Retina_TouchPoint_Default.png\") 2\(unit)"]
                    let css = function + "(" + (reversed ? assets.reversed() : assets).joined(separator: ", ") + ") 26 26, auto"
                    let definition = try ProtoPieCursorDefinition.parse(css)
                    XCTAssertEqual(definition.resource, "https://example.test/TouchPoint_Default.png")
                    XCTAssertEqual(definition.density, 1)
                    XCTAssertEqual(definition.hotSpot, CGPoint(x: 26, y: 26))
                    let style = try ProtoPieCursorStyle.decode(definition, imageData: Self.png(width: 53, height: 53))
                    XCTAssertEqual(style.imageSize, CGSize(width: 53, height: 53))
                }
            }
        }
    }

    func testRetinaOnlyAssetUsesLogicalSizeAndCSSHotspot() throws {
        for (size, hotspot) in [(106, 26), (100, 25), (256, 64)] {
            let definition = try ProtoPieCursorDefinition.parse("image-set(url('https://example.test/Retina.png') 2dppx) \(hotspot) \(hotspot), auto")
            XCTAssertEqual(definition.density, 2)
            let style = try ProtoPieCursorStyle.decode(definition, imageData: Self.png(width: size, height: size))
            XCTAssertEqual(style.imageSize, CGSize(width: size / 2, height: size / 2))
            XCTAssertEqual(style.cursor?.image.size, style.imageSize)
            XCTAssertEqual(style.hotSpot, CGPoint(x: hotspot, y: hotspot))
            XCTAssertEqual(style.cursor?.hotSpot, style.hotSpot)
        }
    }

    func testImageSetRejectsInvalidDensityAndRetinaLimits() throws {
        for css in ["image-set(url('x') 0dppx) 0 0, auto", "image-set(url('x') -2x), auto",
                    "image-set(url('x') NaNdppx), auto", "image-set(url('x') 2), auto",
                    "image-set(url('x') 1dppx,), auto", "image-set() 0 0, auto",
                    "image-set(url('x') 1dppx) -1 0, auto"] {
            XCTAssertThrowsError(try ProtoPieCursorDefinition.parse(css))
        }
        let two = try ProtoPieCursorDefinition.parse("image-set(url('x') 2dppx) 0 0, auto")
        XCTAssertThrowsError(try ProtoPieCursorStyle.decode(two, imageData: Self.png(width: 257, height: 53)))
        let half = try ProtoPieCursorDefinition.parse("image-set(url('x') .5dppx) 0 0, auto")
        XCTAssertThrowsError(try ProtoPieCursorStyle.decode(half, imageData: Self.png(width: 65, height: 53)))
        let outOfLogicalBounds = try ProtoPieCursorDefinition.parse("image-set(url('x') 2dppx) 53 0, auto")
        XCTAssertThrowsError(try ProtoPieCursorStyle.decode(outOfLogicalBounds, imageData: Self.png(width: 106, height: 106)))
    }

    func testImageSetDataURLCommaRemainsPartOfAsset() throws {
        let definition = try ProtoPieCursorDefinition.parse("image-set(url(\"data:image/png;base64,YWJj\") 1dppx, url('retina.png') 2dppx), auto")
        XCTAssertEqual(definition.resource, "data:image/png;base64,YWJj")
        XCTAssertEqual(definition.hotSpot, .zero)
        XCTAssertEqual(definition.density, 1)
    }

    func testMalformedCSSDoesNotSilentlyInventACircle() throws {
        for css in ["", "url(https://example.test/cursor.png)", "url('x') NaN 2, auto", "url('x') -1 0, auto",
                    "url('x') 1, auto", "url('x') 1 1, mystery", "circle", "url(\"a\\\"b\"), auto"] {
            XCTAssertThrowsError(try ProtoPieCursorDefinition.parse(css), css)
        }
    }

    func testBuiltinCSSUsesSystemCursorAndNoneDoesNotDrawAnImage() throws {
        _ = NSApplication.shared
        for keyword in ["auto", "default", "pointer", "text", "crosshair", "grabbing", "ew-resize"] {
            let style = try ProtoPieCursorStyle.decode(ProtoPieCursorDefinition.parse(keyword))
            XCTAssertNotNil(style.cursor)
            XCTAssertFalse(style.isHidden)
            XCTAssertEqual(style.identifier, "css:\(keyword)")
        }
        let hidden = try ProtoPieCursorStyle.decode(ProtoPieCursorDefinition.parse("none"))
        XCTAssertTrue(hidden.isHidden); XCTAssertNil(hidden.cursor); XCTAssertEqual(hidden.imageSize, .zero)
    }

    func testRejectsOversizedCorruptMissingAndOutOfBoundsImages() throws {
        let definition = try ProtoPieCursorDefinition.parse("url('cursor.png') 26 26, auto")
        for data: Data? in [nil, Data(), Data("not an image".utf8), Data(repeating: 0, count: 131073),
                           try Self.png(width: 129, height: 53), try Self.png(width: 20, height: 20)] {
            XCTAssertThrowsError(try ProtoPieCursorStyle.decode(definition, imageData: data))
        }
        let edge = try ProtoPieCursorDefinition.parse("url('cursor.png') 53 0, auto")
        XCTAssertThrowsError(try ProtoPieCursorStyle.decode(edge, imageData: Self.png(width: 53, height: 53)))
    }

    func testCursorRequestIsOrderedAfterPressAndCachesOnlyIdenticalCSS() async throws {
        let fixture = try CursorTransportFixture(); defer { fixture.remove() }
        let viewport = try await fixture.transport.connect(session: fixture.session)
        let normal = try await fixture.transport.cursorStyle(at: CGPoint(x: 10, y: 20))
        XCTAssertEqual(normal.imageSize, CGSize(width: 53, height: 53))
        XCTAssertEqual(fixture.transport.diagnosticSnapshot["cursorCacheMisses"] as? Int, 1)
        _ = try await fixture.transport.cursorStyle(at: CGPoint(x: 11, y: 20))
        XCTAssertEqual(fixture.wire.resourceCount, 1)
        XCTAssertEqual(fixture.transport.diagnosticSnapshot["cursorCacheHits"] as? Int, 1)
        XCTAssertEqual(fixture.transport.diagnosticSnapshot["cursorState"] as? String, "cacheHit")
        XCTAssertTrue(fixture.transport.send(MouseInputEvent(viewportID: viewport.bindingID, kind: .down,
            x: 11, y: 20, button: .left, buttons: 1)))
        let pressed = try await fixture.transport.cursorStyle(at: CGPoint(x: 11, y: 20))
        XCTAssertEqual(pressed.imageSize, CGSize(width: 50, height: 50))
        XCTAssertEqual(pressed.hotSpot, CGPoint(x: 25, y: 25))
        XCTAssertNotEqual(normal.identifier, pressed.identifier)
        XCTAssertEqual(fixture.wire.resourceCount, 2)
        XCTAssertEqual(fixture.transport.diagnosticSnapshot["cursorCacheMisses"] as? Int, 2)
        XCTAssertEqual(fixture.wire.events.suffix(3), ["mousePressed", "cursor", "resource"])
        XCTAssertTrue(fixture.wire.cursorSessions.allSatisfy { $0 == "cursor-session" })
        await fixture.transport.releaseAllAndClose()
    }

    func testRejectsCursorOutsideViewportBeforeQueryingPage() async throws {
        let fixture = try CursorTransportFixture(); defer { fixture.remove() }
        _ = try await fixture.transport.connect(session: fixture.session)
        for point in [CGPoint(x: -1, y: 0), CGPoint(x: 1920, y: 0), CGPoint(x: 0, y: 1080), CGPoint(x: CGFloat.nan, y: 0)] {
            do { _ = try await fixture.transport.cursorStyle(at: point); XCTFail("Invalid point must fail") }
            catch { XCTAssertEqual(error as? MouseInputTransportError, .invalidEvent) }
        }
        XCTAssertEqual(fixture.wire.cursorSessions.count, 0)
        await fixture.transport.releaseAllAndClose()
    }

    func testUnavailableResourceFailsWithoutReturningItsURL() async throws {
        let fixture = try CursorTransportFixture(); defer { fixture.remove() }
        let viewport = try await fixture.transport.connect(session: fixture.session)
        var failures = 0
        fixture.transport.onFailure = { _ in failures += 1 }
        XCTAssertTrue(fixture.transport.send(MouseInputEvent(viewportID: viewport.bindingID, kind: .down,
            x: 10, y: 20, button: .left, buttons: 1)))
        fixture.wire.resourceUnavailable = true
        do { _ = try await fixture.transport.cursorStyle(at: .zero); XCTFail("Missing original asset must fail") }
        catch {
            XCTAssertEqual(error as? ProtoPieCursorArtworkError, .resourceUnavailable)
            XCTAssertFalse(error.localizedDescription.contains("example.test"))
        }
        XCTAssertTrue(fixture.transport.isConnected)
        XCTAssertEqual(failures, 0)
        XCTAssertTrue(fixture.transport.send(MouseInputEvent(viewportID: viewport.bindingID, kind: .up,
            x: 10, y: 20, button: .left)))
        try await fixture.transport.flush()
        XCTAssertEqual(fixture.wire.events.filter { $0.hasPrefix("mouse") }, ["mousePressed", "mouseReleased"])
        let snapshot = fixture.transport.diagnosticSnapshot
        XCTAssertNil(snapshot["failureContext"])
        XCTAssertEqual(snapshot["cursorState"] as? String, "nativeResourceEligibility")
        XCTAssertEqual(snapshot["lastErrorKind"] as? String, "artwork.resourceUnavailable")
        let json = String(decoding: try JSONSerialization.data(withJSONObject: snapshot), as: UTF8.self)
        XCTAssertFalse(json.contains("example.test"))
        await fixture.transport.releaseAllAndClose()
    }

    func testLoadedRetinaCandidateKeepsOriginalLogicalSizeAndHotspotWithoutNetwork() async throws {
        for (name, size, hotspot) in [("Default", 53, 26), ("Active", 50, 25)] {
            let fixture = try CursorTransportFixture(); defer { fixture.remove() }
            let normal = "https://static.protopie.io/TouchPoint_\(name).png"
            let retina = "https://static.protopie.io/Retina_TouchPoint_\(name).png"
            fixture.wire.computedCSS = "image-set(url('\(normal)') 1dppx, url('\(retina)') 2dppx) \(hotspot) \(hotspot), auto"
            fixture.wire.cachedResources[retina] = try Self.png(width: size * 2, height: size * 2)
            fixture.wire.resourceUnavailable = true; fixture.loaderThrows = true
            _ = try await fixture.transport.connect(session: fixture.session)
            let style = try await fixture.transport.cursorStyle(at: .zero)
            XCTAssertEqual(style.imageSize, CGSize(width: size, height: size))
            XCTAssertEqual(style.hotSpot, CGPoint(x: hotspot, y: hotspot))
            XCTAssertTrue(style.identifier.contains("density=2.0"))
            XCTAssertEqual(fixture.wire.cacheRequestedURLs, [retina])
            XCTAssertEqual(fixture.wire.cacheSessions, ["cursor-session"])
            XCTAssertEqual(fixture.wire.resourceCount, 0)
            XCTAssertTrue(fixture.loadedResources.isEmpty)
            XCTAssertEqual(fixture.transport.diagnosticSnapshot["cursorResourceOrigin"] as? String, "page-cache")
            XCTAssertEqual(fixture.transport.diagnosticSnapshot["cursorResourceDensity"] as? Double, 2)
            _ = try await fixture.transport.cursorStyle(at: CGPoint(x: 10, y: 20))
            XCTAssertEqual(fixture.wire.cacheRequestedURLs.count, 1)
            await fixture.transport.releaseAllAndClose()
        }
    }

    func testPageCacheRequiresExactDeclaredURLAndReevaluatesDensityAndHotspot() async throws {
        let fixture = try CursorTransportFixture(); defer { fixture.remove() }
        let resource = "https://example.test/Retina_TouchPoint_Default.png"
        fixture.wire.computedCSS = "image-set(url('\(resource)') 2dppx) 26 26, auto"
        fixture.wire.cachedResources[resource + "?other"] = try Self.png(width: 106, height: 106)
        fixture.wire.resourceUnavailable = true
        _ = try await fixture.transport.connect(session: fixture.session)
        do { _ = try await fixture.transport.cursorStyle(at: .zero); XCTFail("An unrelated cached URL cannot supply original artwork") }
        catch { XCTAssertEqual(error as? ProtoPieCursorArtworkError, .resourceUnavailable) }
        XCTAssertTrue(fixture.wire.cacheRequestedURLs.isEmpty)
        fixture.wire.cachedResources[resource] = try Self.png(width: 106, height: 106)
        let first = try await fixture.transport.cursorStyle(at: .zero)
        XCTAssertEqual(first.imageSize, CGSize(width: 53, height: 53))
        fixture.wire.computedCSS = "image-set(url('\(resource)') 4dppx) 13 13, auto"
        let second = try await fixture.transport.cursorStyle(at: .zero)
        XCTAssertEqual(second.imageSize, CGSize(width: 26.5, height: 26.5))
        XCTAssertEqual(second.hotSpot, CGPoint(x: 13, y: 13))
        XCTAssertNotEqual(first.identifier, second.identifier)
        XCTAssertEqual(fixture.wire.cacheRequestedURLs, [resource, resource])
        await fixture.transport.releaseAllAndClose()
    }

    func testMissingCachedBodyFallsBackButCDPTimeoutStillClosesInput() async throws {
        for error in [MouseInputTransportError.unavailable("No resource body"), .timeout] {
            let fixture = try CursorTransportFixture(); defer { fixture.remove() }
            fixture.wire.cachedResources["https://example.test/TouchPoint_Default.png"] = try Self.png(width: 53, height: 53)
            fixture.wire.cacheContentError = error
            _ = try await fixture.transport.connect(session: fixture.session)
            if error == .timeout {
                do { _ = try await fixture.transport.cursorStyle(at: .zero); XCTFail("CDP timeout must remain fatal") }
                catch { XCTAssertEqual(error as? MouseInputTransportError, .timeout) }
                XCTAssertFalse(fixture.transport.isConnected)
                XCTAssertEqual(fixture.wire.resourceCount, 0)
            } else {
                let style = try await fixture.transport.cursorStyle(at: .zero)
                XCTAssertEqual(style.imageSize, CGSize(width: 53, height: 53))
                XCTAssertTrue(fixture.transport.isConnected)
                XCTAssertEqual(fixture.wire.resourceCount, 1)
            }
            await fixture.transport.releaseAllAndClose()
        }
    }

    func testNativeResourceWaitDoesNotBlockReleaseOrViewportCheck() async throws {
        let fixture = try CursorTransportFixture(); defer { fixture.remove() }
        fixture.wire.assetHost = "static.protopie.io"; fixture.wire.resourceUnavailable = true
        fixture.blockLoader = true; fixture.loaderThrows = true
        let viewport = try await fixture.transport.connect(session: fixture.session)
        XCTAssertTrue(fixture.transport.send(MouseInputEvent(viewportID: viewport.bindingID, kind: .down,
            x: 10, y: 20, button: .left, buttons: 1)))
        let reading = Task { try await fixture.transport.cursorStyle(at: .zero) }
        await fixture.waitForBlockedLoader()
        XCTAssertTrue(fixture.transport.send(MouseInputEvent(viewportID: viewport.bindingID, kind: .up,
            x: 10, y: 20, button: .left)))
        var refreshed: MouseInputViewport?
        let refreshing = Task { refreshed = try await fixture.transport.refreshViewport() }
        for _ in 0..<1000 where !fixture.wire.events.contains("mouseReleased") { await Task.yield() }
        XCTAssertTrue(fixture.wire.events.contains("mouseReleased"), "mouseUp must arrive before the resource loader is resumed")
        for _ in 0..<1000 where refreshed == nil { await Task.yield() }
        XCTAssertEqual(refreshed, viewport, "Viewport check must finish while artwork remains blocked")
        XCTAssertEqual(fixture.transport.diagnosticSnapshot["queueLength"] as? Int, 0)
        fixture.unblockLoader()
        do { _ = try await reading.value; XCTFail("Unavailable image must not be invented") }
        catch { XCTAssertEqual(error as? ProtoPieCursorArtworkError, .resourceUnavailable) }
        try await refreshing.value
        XCTAssertTrue(fixture.transport.isConnected)
        await fixture.transport.releaseAllAndClose()
    }

    func testPublicAssetFallbackAllowsOnlyExactHTTPSHostWithoutCredentials() throws {
        XCTAssertNotNil(ProtoPieCursorResourceLoader.permittedURL("https://static.protopie.io/assets/TouchPoint_Default.png"))
        XCTAssertNotNil(ProtoPieCursorResourceLoader.permittedURL("https://static.protopie.io:443/assets/cursor.png"))
        for value in ["http://static.protopie.io/cursor.png", "https://static.protopie.io.example/cursor.png",
                      "https://cloud.protopie.io/cursor.png", "https://127.0.0.1/cursor.png",
                      "https://user@static.protopie.io/cursor.png", "https://static.protopie.io:123/cursor.png",
                      "file:///cursor.png", "data:image/png;base64,YWJj", "/cursor.png"] {
            XCTAssertNil(ProtoPieCursorResourceLoader.permittedURL(value))
        }
    }

    func testPageFetchSuccessNeverUsesNativeFallback() async throws {
        let fixture = try CursorTransportFixture(); defer { fixture.remove() }
        fixture.wire.assetHost = "static.protopie.io"
        _ = try await fixture.transport.connect(session: fixture.session)
        _ = try await fixture.transport.cursorStyle(at: .zero)
        XCTAssertEqual(fixture.loadedResources.count, 0)
        await fixture.transport.releaseAllAndClose()
    }

    func testBlockedPageFetchLoadsOnlyBoundOriginalAssetAndCachesIt() async throws {
        let fixture = try CursorTransportFixture(); defer { fixture.remove() }
        fixture.wire.assetHost = "static.protopie.io"; fixture.wire.resourceUnavailable = true
        _ = try await fixture.transport.connect(session: fixture.session)
        let style = try await fixture.transport.cursorStyle(at: .zero)
        XCTAssertEqual(style.imageSize, CGSize(width: 53, height: 53))
        XCTAssertEqual(fixture.loadedResources.map(\.absoluteString), ["https://static.protopie.io/TouchPoint_Default.png"])
        _ = try await fixture.transport.cursorStyle(at: CGPoint(x: 20, y: 20))
        XCTAssertEqual(fixture.loadedResources.count, 1)
        XCTAssertEqual(fixture.wire.resourceCount, 1)
        XCTAssertFalse(style.identifier.contains("static.protopie.io"))
        await fixture.transport.releaseAllAndClose()
    }

    func testBlockedPageFetchFromOtherHostNeverInvokesNativeLoader() async throws {
        let fixture = try CursorTransportFixture(); defer { fixture.remove() }
        fixture.wire.resourceUnavailable = true
        _ = try await fixture.transport.connect(session: fixture.session)
        do { _ = try await fixture.transport.cursorStyle(at: .zero); XCTFail("Other hosts must not use native fetch") } catch { }
        XCTAssertTrue(fixture.loadedResources.isEmpty)
        await fixture.transport.releaseAllAndClose()
    }

    func testNativeFallbackRejectsOversizedDataAndSuppressesURLBearingErrors() async throws {
        for throwsError in [true, false] {
            let fixture = try CursorTransportFixture(); defer { fixture.remove() }
            fixture.wire.assetHost = "static.protopie.io"; fixture.wire.resourceUnavailable = true
            fixture.loaderThrows = throwsError
            fixture.loadedData = Data(repeating: 0, count: 131073)
            _ = try await fixture.transport.connect(session: fixture.session)
            do { _ = try await fixture.transport.cursorStyle(at: .zero); XCTFail("Unsafe response must fail") }
            catch { XCTAssertFalse(error.localizedDescription.contains("private-query")) }
            await fixture.transport.releaseAllAndClose()
            XCTAssertEqual(fixture.loadedResources.count, 1)
        }
    }

    func testClosingOrNavigationDuringNativeLoadCannotInstallLateCursor() async throws {
        for navigate in [false, true] {
            let fixture = try CursorTransportFixture(); defer { fixture.remove() }
            fixture.wire.assetHost = "static.protopie.io"; fixture.wire.resourceUnavailable = true; fixture.blockLoader = true
            _ = try await fixture.transport.connect(session: fixture.session)
            let reading = Task { try await fixture.transport.cursorStyle(at: .zero) }
            await fixture.waitForBlockedLoader()
            if navigate { fixture.wire.onEvent?("Runtime.executionContextsCleared", [:], "cursor-session") }
            let closing = Task { await fixture.transport.releaseAllAndClose() }
            for _ in 0..<20 where fixture.transport.isConnected { await Task.yield() }
            fixture.unblockLoader()
            do { _ = try await reading.value; XCTFail("Late native response must not reinstall") }
            catch { XCTAssertEqual(error as? MouseInputTransportError, .closed) }
            await closing.value
            XCTAssertFalse(fixture.transport.isConnected)
        }
    }

    func testCloseRejectsLateCursorAndClearsCachedOriginalAsset() async throws {
        let fixture = try CursorTransportFixture(); defer { fixture.remove() }
        _ = try await fixture.transport.connect(session: fixture.session)
        _ = try await fixture.transport.cursorStyle(at: .zero)
        fixture.wire.blockNextCursor = true
        let reading = Task { try await fixture.transport.cursorStyle(at: .zero) }
        await fixture.wire.waitForBlockedCall()
        let closing = Task { await fixture.transport.releaseAllAndClose() }
        for _ in 0..<20 where fixture.transport.isConnected { await Task.yield() }
        fixture.wire.unblock()
        do { _ = try await reading.value; XCTFail("Late cursor must not reinstall after exit") }
        catch { XCTAssertEqual(error as? MouseInputTransportError, .closed) }
        await closing.value
        _ = try await fixture.transport.connect(session: fixture.session)
        _ = try await fixture.transport.cursorStyle(at: .zero)
        XCTAssertEqual(fixture.wire.resourceCount, 2)
        await fixture.transport.releaseAllAndClose()
    }

    func testReconnectDuringNativeLoadCannotCacheOldArtworkOrCloseNewBinding() async throws {
        let fixture = try CursorTransportFixture(); defer { fixture.remove() }
        fixture.wire.assetHost = "static.protopie.io"; fixture.wire.resourceUnavailable = true; fixture.blockLoader = true
        let previous = try await fixture.transport.connect(session: fixture.session)
        let reading = Task { try await fixture.transport.cursorStyle(at: .zero) }
        await fixture.waitForBlockedLoader()
        var closed = false
        let closing = Task { await fixture.transport.releaseAllAndClose(); closed = true }
        for _ in 0..<1000 where !closed { await Task.yield() }
        XCTAssertTrue(closed, "Closing input must not wait for a decorative image load")
        if !closed {
            fixture.unblockLoader(); await closing.value; _ = try? await reading.value
            return
        }
        await closing.value
        fixture.blockLoader = false; fixture.wire.resourceUnavailable = false
        let current = try await fixture.transport.connect(session: fixture.session)
        XCTAssertNotEqual(previous.bindingID, current.bindingID)
        _ = try await fixture.transport.cursorStyle(at: .zero)
        fixture.unblockLoader()
        do { _ = try await reading.value; XCTFail("Old loading result must not enter the new cache") }
        catch { XCTAssertEqual(error as? MouseInputTransportError, .closed) }
        XCTAssertTrue(fixture.transport.isConnected)
        XCTAssertEqual(fixture.transport.diagnosticSnapshot["cursorResourceOrigin"] as? String, "page-fetch")
        XCTAssertEqual(fixture.transport.diagnosticSnapshot["cursorCacheMisses"] as? Int, 1)
        XCTAssertNil(fixture.transport.diagnosticSnapshot["failureContext"])
        await fixture.transport.releaseAllAndClose()
    }

    func testNavigationRejectsLateCursorWithoutReadingAssetFromNewPage() async throws {
        let fixture = try CursorTransportFixture(); defer { fixture.remove() }
        _ = try await fixture.transport.connect(session: fixture.session)
        fixture.wire.blockNextCursor = true
        let reading = Task { try await fixture.transport.cursorStyle(at: .zero) }
        await fixture.wire.waitForBlockedCall()
        fixture.wire.onEvent?("Runtime.executionContextsCleared", [:], "cursor-session")
        fixture.wire.unblock()
        do { _ = try await reading.value; XCTFail("Navigated page must not return cursor") } catch { }
        await fixture.transport.releaseAllAndClose()
        XCTAssertEqual(fixture.wire.resourceCount, 0)
    }

    func testFocusEmulationIsScopedAndAlwaysRestoredOnClose() async throws {
        let fixture = try CursorTransportFixture(); defer { fixture.remove() }
        _ = try await fixture.transport.connect(session: fixture.session)
        try await fixture.transport.setPageFocusEmulation(true)
        fixture.wire.onEvent?("Runtime.executionContextsCleared", [:], "cursor-session")
        await fixture.transport.releaseAllAndClose()
        XCTAssertEqual(fixture.wire.focusRequests, [true, false])
        XCTAssertTrue(fixture.wire.focusSessions.allSatisfy { $0 == "cursor-session" })
    }

    func testCloseDuringFocusAcknowledgementRejectsSuccessAndStillDisables() async throws {
        let fixture = try CursorTransportFixture(); defer { fixture.remove() }
        _ = try await fixture.transport.connect(session: fixture.session)
        fixture.wire.blockNextFocus = true
        let enabling = Task { try await fixture.transport.setPageFocusEmulation(true) }
        await fixture.wire.waitForBlockedCall()
        let closing = Task { await fixture.transport.releaseAllAndClose() }
        for _ in 0..<20 where fixture.transport.isConnected { await Task.yield() }
        fixture.wire.unblock()
        do { try await enabling.value; XCTFail("Closed binding must reject late focus success") } catch { }
        await closing.value
        XCTAssertEqual(fixture.wire.focusRequests, [true, false])
    }

    fileprivate static func png(width: Int, height: Int) throws -> Data {
        let bitmap = try XCTUnwrap(NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height,
            bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
            bytesPerRow: width * 4, bitsPerPixel: 32))
        if let pixels = bitmap.bitmapData { memset(pixels, 128, width * height * 4) }
        return try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
    }
}

@MainActor private final class CursorTransportFixture {
    let wire = CursorTestWire()
    let profile: URL
    let session: ProtoPieSession
    var loadedResources = [URL]()
    var loadedData: Data?
    var loaderThrows = false, blockLoader = false
    private var blockedLoader: CheckedContinuation<Void, Never>?
    lazy var transport = MouseInputTransport(profileURL: profile, monitorInterval: 0,
        connectionFactory: { [unowned self] _ in self.wire },
        windowLookup: { _, _ in CGRect(x: 0, y: 0, width: 1920, height: 1080) },
        cursorResourceLoader: { [unowned self] url in
            self.loadedResources.append(url)
            if self.blockLoader { await withCheckedContinuation { self.blockedLoader = $0 } }
            if self.loaderThrows { throw NSError(domain: "https://static.protopie.io/private-query", code: 1) }
            return try self.loadedData ?? ProtoPieCursorStyleTests.png(width: 53, height: 53)
        })
    init() throws {
        profile = FileManager.default.temporaryDirectory.appendingPathComponent("CursorTest-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: profile, withIntermediateDirectories: true)
        try "18765\n/devtools/browser/cursor-test".write(to: profile.appendingPathComponent("DevToolsActivePort"), atomically: true, encoding: .utf8)
        var configuration = ProtoPieConfiguration(); configuration.cloudURL = "https://cloud.protopie.io/p/cursor-test"
        session = ProtoPieSession(windowID: 42, processID: 123, configuration: configuration,
            cloudTargetID: "cursor-target", title: "Cursor fixture")
        wire.url = try configuration.playbackURL().absoluteString
    }
    func remove() { try? FileManager.default.removeItem(at: profile) }
    func waitForBlockedLoader() async {
        for _ in 0..<1000 { if blockedLoader != nil { return }; await Task.yield() }
        XCTFail("Native cursor loader did not reach expected request")
    }
    func unblockLoader() { blockedLoader?.resume(); blockedLoader = nil }
}

@MainActor private final class CursorTestWire: MouseInputCDPConnection {
    var onEvent: ((String, [String: Any], String?) -> Void)?
    var onFailure: ((Error) -> Void)?
    var url = ""
    var assetHost = "example.test"
    var events = [String](), cursorSessions = [String](), focusSessions = [String]()
    var focusRequests = [Bool]()
    var computedCSS: String?
    var cachedResources = [String: Data]()
    var cacheRequestedURLs = [String](), cacheSessions = [String]()
    var cacheContentError: MouseInputTransportError?
    var resourceCount = 0
    var pressed = false, resourceUnavailable = false, blockNextCursor = false, blockNextFocus = false
    private var blocked: CheckedContinuation<Void, Never>?
    func call(_ method: String, parameters: [String: Any], sessionID: String?) async throws -> [String: Any] {
        switch method {
        case "SystemInfo.getProcessInfo": return ["processInfo": [["type": "browser", "id": 123]]]
        case "Target.getTargetInfo": return ["targetInfo": ["targetId": "cursor-target", "type": "page", "url": url]]
        case "Target.attachToTarget": return ["sessionId": "cursor-session"]
        case "Page.getResourceTree":
            return ["frameTree": ["frame": ["id": "cursor-frame", "url": url],
                "resources": cachedResources.keys.sorted().map { ["url": $0, "type": "Image"] }]]
        case "Page.getResourceContent":
            let url = parameters["url"] as? String ?? ""
            cacheRequestedURLs.append(url); cacheSessions.append(sessionID ?? "")
            if let cacheContentError { throw cacheContentError }
            guard parameters["frameId"] as? String == "cursor-frame", let data = cachedResources[url] else {
                throw MouseInputTransportError.unavailable("No cached resource")
            }
            return ["base64Encoded": true, "content": data.base64EncodedString()]
        case "Browser.getWindowForTarget": return ["windowId": 88, "bounds": ["left": 0, "top": 0, "width": 1920, "height": 1080, "windowState": "fullscreen"]]
        case "Input.dispatchMouseEvent":
            let type = parameters["type"] as? String ?? "unknown"; events.append(type)
            if type == "mousePressed" { pressed = true }; if type == "mouseReleased" { pressed = false }
            return [:]
        case "Emulation.setFocusEmulationEnabled":
            focusRequests.append(parameters["enabled"] as? Bool ?? false); focusSessions.append(sessionID ?? "")
            if blockNextFocus { blockNextFocus = false; await withCheckedContinuation { blocked = $0 } }
            return [:]
        case "Runtime.evaluate":
            let expression = parameters["expression"] as? String ?? ""
            if expression.contains("nioCursorStyle:true") {
                events.append("cursor"); cursorSessions.append(sessionID ?? "")
                if blockNextCursor { blockNextCursor = false; await withCheckedContinuation { blocked = $0 } }
                let name = pressed ? "Active" : "Default", hotspot = pressed ? 25 : 26
                return ["result": ["value": ["timeOrigin": 12345, "css": computedCSS ?? "url(\"https://\(assetHost)/TouchPoint_\(name).png\") \(hotspot) \(hotspot), auto"]]]
            }
            if expression.contains("nioCursorResource:true") {
                events.append("resource"); cursorSessions.append(sessionID ?? ""); resourceCount += 1
                let size = expression.contains("TouchPoint_Active.png") ? 50 : 53
                return ["result": ["value": ["timeOrigin": 12345, "ok": !resourceUnavailable,
                    "data": try ProtoPieCursorStyleTests.png(width: size, height: size).base64EncodedString()]]]
            }
            return ["result": ["value": ["url": url, "width": 1920, "height": 1080, "dpr": 1, "timeOrigin": 12345,
                "readyState": "complete", "visualScale": 1, "visualOffsetX": 0, "visualOffsetY": 0]]]
        default: return [:]
        }
    }
    func waitForBlockedCall() async {
        for _ in 0..<1000 { if blocked != nil { return }; await Task.yield() }
        XCTFail("Cursor worker did not reach expected request")
    }
    func unblock() { blocked?.resume(); blocked = nil }
    func close() {}
}
