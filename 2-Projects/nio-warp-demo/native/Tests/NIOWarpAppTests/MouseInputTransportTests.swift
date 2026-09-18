import AppKit
import XCTest
@testable import NIOWarpApp

final class MouseInputTransportTests: XCTestCase {
    @MainActor func testRawVisibleSourceEndpointReproducesCursorQueryRejection() async throws {
        let fixture = try MouseTransportFixture(); defer { fixture.remove() }
        let viewport = try await fixture.transport.connect(session: fixture.session)
        // UV 1 is legal on a rendered mesh edge. The former cursor-query path
        // multiplied it directly by the viewport width/height and then stopped
        // the whole controller when this strict transport rejected the point.
        for point in [CGPoint(x: viewport.cssWidth, y: 0), CGPoint(x: 0, y: viewport.cssHeight),
                      CGPoint(x: viewport.cssWidth, y: viewport.cssHeight)] {
            do { _ = try await fixture.transport.cursorStyle(at: point); XCTFail("Raw closed edge must remain invalid to the browser transport") }
            catch { XCTAssertEqual(error as? MouseInputTransportError, .invalidEvent) }
        }
        XCTAssertTrue(fixture.transport.isConnected)
        XCTAssertTrue(fixture.fake.inputs.isEmpty)
        await fixture.transport.releaseAllAndClose()
    }

    @MainActor func testVisibleSourceCornersAndFloatRoundingUseOneLegalPointForCursorAndInput() async throws {
        let fixture = try MouseTransportFixture(); defer { fixture.remove() }
        let viewport = try await fixture.transport.connect(session: fixture.session)
        let low = Float.zero.nextDown, high = Float(1).nextUp
        let cases: [(SIMD2<Float>, CGPoint)] = [
            (SIMD2(0, 0), .zero),
            (SIMD2(1, 0), CGPoint(x: viewport.cssWidth.nextDown, y: 0)),
            (SIMD2(0, 1), CGPoint(x: 0, y: viewport.cssHeight.nextDown)),
            (SIMD2(1, 1), CGPoint(x: viewport.cssWidth.nextDown, y: viewport.cssHeight.nextDown)),
            (SIMD2(low, high), CGPoint(x: 0, y: viewport.cssHeight.nextDown)),
            (SIMD2(high, low), CGPoint(x: viewport.cssWidth.nextDown, y: 0)),
            (SIMD2(0.25, 0.75), CGPoint(x: viewport.cssWidth * 0.25, y: viewport.cssHeight * 0.75))
        ]
        for (uv, expected) in cases {
            let point = try XCTUnwrap(viewport.point(forVisibleSourceUV: uv))
            XCTAssertEqual(point, expected)
            XCTAssertTrue(point.x >= 0 && point.x < viewport.cssWidth)
            XCTAssertTrue(point.y >= 0 && point.y < viewport.cssHeight)
            let event = MouseInputEvent(viewportID: viewport.bindingID, kind: .move, x: point.x, y: point.y)
            XCTAssertTrue(fixture.transport.send(event))
            _ = try await fixture.transport.cursorStyle(at: point)
            XCTAssertEqual(fixture.fake.inputs.last?.parameters["x"] as? Double, Double(point.x))
            XCTAssertEqual(fixture.fake.inputs.last?.parameters["y"] as? Double, Double(point.y))
            XCTAssertTrue(fixture.transport.isConnected)
        }
        XCTAssertTrue(fixture.failures.isEmpty)
        await fixture.transport.releaseAllAndClose()
    }

    @MainActor func testVisibleSourcePointRejectsNonfiniteCoordinates() async throws {
        let fixture = try MouseTransportFixture(); defer { fixture.remove() }
        let viewport = try await fixture.transport.connect(session: fixture.session)
        for uv in [SIMD2<Float>(.nan, 0), SIMD2<Float>(0, .nan),
                   SIMD2<Float>(.infinity, 1), SIMD2<Float>(1, -.infinity)] {
            XCTAssertNil(viewport.point(forVisibleSourceUV: uv))
        }
        XCTAssertTrue(fixture.fake.inputs.isEmpty)
        XCTAssertTrue(fixture.transport.isConnected)
        await fixture.transport.releaseAllAndClose()
    }

    @MainActor func testBindsDedicatedDynamicSocketAndReturnsCSSViewportWithoutMutatingPage() async throws {
        let fixture = try MouseTransportFixture(); defer { fixture.remove() }
        let viewport = try await fixture.transport.connect(session: fixture.session)
        XCTAssertEqual(viewport.cssWidth, 1920)
        XCTAssertEqual(viewport.cssHeight, 1080)
        XCTAssertEqual(viewport.devicePixelRatio, 2)
        XCTAssertEqual(viewport.pixelSize, CGSize(width: 3840, height: 2160))
        XCTAssertEqual(viewport.timeOrigin, 12345)
        XCTAssertEqual(viewport.targetID, fixture.fake.targetID)
        XCTAssertEqual(viewport.windowID, 42)
        XCTAssertEqual(fixture.connectedURL?.host, "127.0.0.1")
        XCTAssertEqual(fixture.connectedURL?.port, 18765)
        XCTAssertEqual(fixture.fake.calls.filter { $0.method == "Target.attachToTarget" }.count, 1)
        XCTAssertFalse(fixture.fake.calls.contains { ["Target.createTarget", "Browser.setWindowBounds", "Page.navigate"].contains($0.method) })
        XCTAssertTrue(fixture.fake.calls.filter { $0.method == "Runtime.evaluate" }.allSatisfy { $0.sessionID == fixture.fake.pageSessionID })
        await fixture.transport.releaseAllAndClose()
        XCTAssertTrue(fixture.fake.closed)
    }

    @MainActor func testInteractiveDocumentAcceptsFirstPressAndCompleteDoesNotChangeBinding() async throws {
        let fixture = try MouseTransportFixture(); defer { fixture.remove() }
        fixture.fake.readyState = "interactive"
        let viewport = try await fixture.transport.connect(session: fixture.session)
        XCTAssertTrue(fixture.transport.isConnected)
        let expression = try XCTUnwrap(fixture.fake.calls.last(where: { $0.method == "Runtime.evaluate" })?.parameters["expression"] as? String)
        XCTAssertTrue(expression.contains("readyState:document.readyState"))
        XCTAssertFalse(expression.contains("ready:document.readyState==='complete'"))
        XCTAssertTrue(fixture.transport.send(fixture.event(viewport, .down, button: .left, buttons: 1)))
        try await fixture.transport.flush()
        fixture.fake.readyState = "complete"
        let refreshed = try await fixture.transport.refreshViewport()
        XCTAssertEqual(refreshed, viewport, "同一文档完成后台加载不能释放已有按下状态")
        XCTAssertTrue(fixture.transport.isConnected)
        XCTAssertTrue(fixture.transport.send(fixture.event(viewport, .up, button: .left)))
        try await fixture.transport.flush()
        XCTAssertEqual(fixture.fake.inputs.compactMap { $0.parameters["type"] as? String }, ["mousePressed", "mouseReleased"])
        XCTAssertTrue(fixture.failures.isEmpty)
        await fixture.transport.releaseAllAndClose()
    }

    @MainActor func testLoadingMissingOrUnknownDocumentReadinessRejectsBeforeInputAndHasSafeDiagnosis() async throws {
        let unexpected = "https://private.invalid/readiness?token=synthetic-private"
        for state: String? in ["loading", nil, unexpected] {
            let fixture = try MouseTransportFixture(); defer { fixture.remove() }
            fixture.fake.readyState = state
            do { _ = try await fixture.transport.connect(session: fixture.session); XCTFail("Unready document must not bind") }
            catch { XCTAssertEqual(error as? MouseInputTransportError, .staleViewport) }
            XCTAssertFalse(fixture.transport.isConnected)
            XCTAssertTrue(fixture.fake.inputs.isEmpty)
            let snapshot = fixture.transport.diagnosticSnapshot
            let failure = try XCTUnwrap(snapshot["failureContext"] as? [String: Any])
            let observation = try XCTUnwrap(failure["viewportObservation"] as? [String: Any])
            XCTAssertEqual(observation["stage"] as? String, "documentReadiness")
            XCTAssertEqual(observation["readyState"] as? String, state == "loading" ? "loading" : state == nil ? "missing" : "invalid")
            XCTAssertEqual(observation["rejected"] as? Bool, true)
            XCTAssertEqual(observation["urlMatches"] as? Bool, true)
            XCTAssertEqual(observation["width"] as? Double, 1920)
            XCTAssertEqual(observation["documentEpochValid"] as? Bool, true)
            XCTAssertNil(observation["timeOrigin"])
            let json = String(decoding: try JSONSerialization.data(withJSONObject: snapshot), as: UTF8.self)
            for privateValue in [unexpected, fixture.fake.url, fixture.fake.targetID, fixture.fake.pageSessionID] {
                XCTAssertFalse(json.contains(privateValue))
            }
            await fixture.transport.releaseAllAndClose()
        }
    }

    @MainActor func testInteractiveDocumentStillInvalidatesOnActualBindingOrGeometryChange() async throws {
        for change in ["width", "dpr", "epoch", "visualScale", "url", "fullscreen"] {
            let fixture = try MouseTransportFixture(); defer { fixture.remove() }
            fixture.fake.readyState = "interactive"
            let viewport = try await fixture.transport.connect(session: fixture.session)
            switch change {
            case "width": fixture.fake.width -= 10
            case "dpr": fixture.fake.dpr = 1.5
            case "epoch": fixture.fake.timeOrigin += 1
            case "visualScale": fixture.fake.visualScale = 2
            case "url": fixture.fake.url = "https://cloud.protopie.io/p/unrelated?ui=false"
            default: fixture.fake.windowState = "normal"
            }
            do { _ = try await fixture.transport.refreshViewport(); XCTFail("Changed \(change) must invalidate binding") }
            catch { XCTAssertEqual(error as? MouseInputTransportError, .staleViewport) }
            XCTAssertFalse(fixture.transport.isConnected)
            XCTAssertFalse(fixture.transport.send(fixture.event(viewport, .down, button: .left, buttons: 1)))
            XCTAssertTrue(fixture.fake.inputs.isEmpty)
            XCTAssertEqual(fixture.failures.count, 1)
            let failure = try XCTUnwrap(fixture.transport.diagnosticSnapshot["failureContext"] as? [String: Any])
            let observation = try XCTUnwrap(failure["viewportObservation"] as? [String: Any])
            let expectedStage = ["width": "bindingIdentity", "dpr": "bindingIdentity", "epoch": "bindingIdentity",
                                 "visualScale": "runtimeGeometry", "url": "target", "fullscreen": "browserWindow"][change]
            XCTAssertEqual(observation["stage"] as? String, expectedStage)
            await fixture.transport.releaseAllAndClose()
        }
    }

    @MainActor func testNonfiniteViewportDiagnosticRemainsJSONSerializable() async throws {
        let fixture = try MouseTransportFixture(); defer { fixture.remove() }
        fixture.fake.readyState = "interactive"
        fixture.fake.visualScale = .nan
        do { _ = try await fixture.transport.connect(session: fixture.session); XCTFail("Invalid geometry must not bind") }
        catch { XCTAssertEqual(error as? MouseInputTransportError, .staleViewport) }
        let snapshot = fixture.transport.diagnosticSnapshot
        let failure = try XCTUnwrap(snapshot["failureContext"] as? [String: Any])
        let observation = try XCTUnwrap(failure["viewportObservation"] as? [String: Any])
        XCTAssertEqual(observation["stage"] as? String, "runtimeGeometry")
        XCTAssertEqual(observation["visualScale"] as? String, "invalid")
        XCTAssertFalse(try JSONSerialization.data(withJSONObject: snapshot).isEmpty)
        XCTAssertTrue(fixture.fake.inputs.isEmpty)
        await fixture.transport.releaseAllAndClose()
    }

    @MainActor func testRejectsStudioBeforeOpeningAnyConnection() async throws {
        let fixture = try MouseTransportFixture(); defer { fixture.remove() }
        var session = fixture.session; session.configuration.source = .localFile; session.cloudTargetID = nil
        do { _ = try await fixture.transport.connect(session: session); XCTFail("Studio must not receive Cloud input") }
        catch { XCTAssertTrue(error.localizedDescription.contains("Cloud")) }
        XCTAssertNil(fixture.connectedURL)
    }

    @MainActor func testActivatesOnlyBoundTargetOnBrowserConnectionWithoutNavigating() async throws {
        let fixture = try MouseTransportFixture(); defer { fixture.remove() }
        let viewport = try await fixture.transport.connect(session: fixture.session)
        let before = fixture.fake.calls.count
        try await fixture.transport.activateBoundTarget()
        let activation = fixture.fake.calls.dropFirst(before)
        XCTAssertEqual(activation.count, 1)
        let call = try XCTUnwrap(activation.first)
        XCTAssertEqual(call.method, "Target.activateTarget")
        XCTAssertEqual(call.parameters as NSDictionary, ["targetId": viewport.targetID] as NSDictionary)
        XCTAssertNil(call.sessionID, "Target.activateTarget 必须发给绑定浏览器连接，而非任意 page session")
        XCTAssertEqual(fixture.transport.viewport, viewport)
        XCTAssertTrue(fixture.transport.isConnected)
        await fixture.transport.releaseAllAndClose()
    }

    @MainActor func testActivationRejectsUnconnectedAndClosedTransportWithoutSending() async throws {
        let fixture = try MouseTransportFixture(); defer { fixture.remove() }
        do { try await fixture.transport.activateBoundTarget(); XCTFail("未绑定不能唤起播放器") }
        catch { XCTAssertEqual(error as? MouseInputTransportError, .closed) }
        XCTAssertTrue(fixture.fake.calls.isEmpty)
        _ = try await fixture.transport.connect(session: fixture.session)
        await fixture.transport.releaseAllAndClose()
        let count = fixture.fake.calls.count
        do { try await fixture.transport.activateBoundTarget(); XCTFail("已关闭不能唤起旧播放器") }
        catch { XCTAssertEqual(error as? MouseInputTransportError, .closed) }
        XCTAssertEqual(fixture.fake.calls.count, count)
        XCTAssertFalse(fixture.transport.isConnected)
    }

    @MainActor func testActivationRejectsLateAcknowledgementAfterConcurrentClose() async throws {
        let fixture = try MouseTransportFixture(); defer { fixture.remove() }
        _ = try await fixture.transport.connect(session: fixture.session)
        fixture.fake.blockNextActivation = true
        let activation = Task { try await fixture.transport.activateBoundTarget() }
        await fixture.fake.waitForBlockedActivation()
        await fixture.transport.releaseAllAndClose()
        fixture.fake.unblockActivation()
        do { try await activation.value; XCTFail("关闭后的激活回执不能恢复输入接管") }
        catch { XCTAssertEqual(error as? MouseInputTransportError, .closed) }
        XCTAssertFalse(fixture.transport.isConnected)
        XCTAssertNil(fixture.transport.viewport)
        XCTAssertEqual(fixture.fake.calls.filter { $0.method == "Target.activateTarget" }.count, 1)
    }

    @MainActor func testActivationFromPreviousBindingCannotCompleteAfterReconnect() async throws {
        let fixture = try MouseTransportFixture(); defer { fixture.remove() }
        let previous = try await fixture.transport.connect(session: fixture.session)
        fixture.fake.blockNextActivation = true
        let activation = Task { try await fixture.transport.activateBoundTarget() }
        await fixture.fake.waitForBlockedActivation()
        await fixture.transport.releaseAllAndClose()
        fixture.fake.closed = false
        let current = try await fixture.transport.connect(session: fixture.session)
        fixture.fake.unblockActivation()
        do { try await activation.value; XCTFail("旧连接的激活回执不能被当作新连接的成功结果") }
        catch { XCTAssertEqual(error as? MouseInputTransportError, .closed) }
        XCTAssertNotEqual(previous.bindingID, current.bindingID)
        XCTAssertEqual(fixture.transport.viewport, current)
        XCTAssertTrue(fixture.transport.isConnected)
        await fixture.transport.releaseAllAndClose()
    }

    @MainActor func testRejectsWrongProcessTargetURLOrWindowBeforeEnablingInput() async throws {
        for failure in ["pid", "target", "url", "window", "fullscreen", "visualViewport"] {
            let fixture = try MouseTransportFixture(); defer { fixture.remove() }
            switch failure {
            case "pid": fixture.fake.processID = 999
            case "target": fixture.fake.targetID = "different-target"
            case "url": fixture.fake.url = "https://cloud.protopie.io/p/unrelated?ui=false"
            case "window": fixture.fake.frame.size.width -= 100
            case "fullscreen": fixture.fake.windowState = "normal"
            default: fixture.fake.visualScale = 2
            }
            do { _ = try await fixture.transport.connect(session: fixture.session); XCTFail("Unexpected bind for \(failure)") }
            catch { XCTAssertFalse(fixture.transport.isConnected) }
            XCTAssertTrue(fixture.fake.inputs.isEmpty)
        }
    }

    @MainActor func testMoveCoalescingCannotCrossButtonsWheelOrFlushAndMaintainsOrder() async throws {
        let fixture = try MouseTransportFixture(); defer { fixture.remove() }
        let viewport = try await fixture.transport.connect(session: fixture.session)
        fixture.fake.blockNextInput = true
        XCTAssertTrue(fixture.transport.send(fixture.event(viewport, .move, x: 1)))
        await fixture.fake.waitForBlockedInput()
        XCTAssertTrue(fixture.transport.send(fixture.event(viewport, .move, x: 2)))
        XCTAssertTrue(fixture.transport.send(fixture.event(viewport, .move, x: 3)))
        XCTAssertTrue(fixture.transport.send(fixture.event(viewport, .down, x: 3, button: .left, buttons: 1)))
        XCTAssertTrue(fixture.transport.send(fixture.event(viewport, .move, x: 4, buttons: 1)))
        XCTAssertTrue(fixture.transport.send(fixture.event(viewport, .move, x: 5, buttons: 1)))
        XCTAssertTrue(fixture.transport.send(fixture.event(viewport, .up, x: 5, button: .left)))
        var wheel = fixture.event(viewport, .wheel, x: 5); wheel.deltaY = 40
        XCTAssertTrue(fixture.transport.send(wheel))
        let flushed = Task { try await fixture.transport.flush() }
        fixture.fake.unblockInput()
        try await flushed.value
        XCTAssertEqual(fixture.fake.inputs.compactMap { $0.parameters["type"] as? String },
                       ["mouseMoved", "mouseMoved", "mousePressed", "mouseMoved", "mouseReleased", "mouseWheel"])
        XCTAssertEqual(fixture.fake.inputs.compactMap { $0.parameters["x"] as? Double }, [1, 3, 3, 5, 5, 5])
        XCTAssertTrue(fixture.fake.inputs.allSatisfy { $0.sessionID == fixture.fake.pageSessionID })
        await fixture.transport.releaseAllAndClose()
    }

    @MainActor func testReleaseWaitsForInflightDownAndDiscardsPendingBusinessEvents() async throws {
        let fixture = try MouseTransportFixture(); defer { fixture.remove() }
        let viewport = try await fixture.transport.connect(session: fixture.session)
        fixture.fake.blockNextInput = true
        XCTAssertTrue(fixture.transport.send(fixture.event(viewport, .down, button: .left, buttons: 1)))
        await fixture.fake.waitForBlockedInput()
        XCTAssertTrue(fixture.transport.send(fixture.event(viewport, .move, x: 400, buttons: 1)))
        let close = Task { await fixture.transport.releaseAllAndClose() }
        await Task.yield(); await Task.yield()
        XCTAssertEqual(fixture.fake.inputs.count, 1)
        fixture.fake.unblockInput()
        await close.value
        XCTAssertEqual(fixture.fake.inputs.compactMap { $0.parameters["type"] as? String }, ["mousePressed", "mouseReleased"])
        XCTAssertEqual(fixture.fake.inputs.last?.parameters["x"] as? Double, 100)
        XCTAssertEqual(fixture.fake.inputs.last?.parameters["buttons"] as? Int, 0)
        XCTAssertTrue(fixture.fake.closed)
    }

    @MainActor func testDiagnosticShowsInflightRequestAndQueueWithoutPageContent() async throws {
        let fixture = try MouseTransportFixture(); defer { fixture.remove() }
        let viewport = try await fixture.transport.connect(session: fixture.session)
        fixture.fake.blockNextInput = true
        XCTAssertTrue(fixture.transport.send(fixture.event(viewport, .down, button: .left, buttons: 1)))
        await fixture.fake.waitForBlockedInput()
        XCTAssertTrue(fixture.transport.send(fixture.event(viewport, .move, x: 400, buttons: 1)))
        let snapshot = fixture.transport.diagnosticSnapshot
        XCTAssertEqual(snapshot["workItem"] as? String, "mousePressed")
        XCTAssertEqual(snapshot["queueLength"] as? Int, 1)
        let requests = try XCTUnwrap(snapshot["currentRequests"] as? [[String: Any]])
        XCTAssertEqual(requests.count, 1)
        XCTAssertEqual(requests.first?["method"] as? String, "Input.dispatchMouseEvent")
        XCTAssertGreaterThanOrEqual(try XCTUnwrap(requests.first?["elapsedMS"] as? Double), 0)
        let json = String(decoding: try JSONSerialization.data(withJSONObject: snapshot), as: UTF8.self)
        for privateValue in [fixture.fake.url, fixture.fake.targetID, fixture.fake.pageSessionID,
                             "expression", "parameters", "location.href"] {
            XCTAssertFalse(json.contains(privateValue))
        }
        fixture.fake.unblockInput()
        try await fixture.transport.flush()
        await fixture.transport.releaseAllAndClose()
    }

    @MainActor func testReleaseClearsAllPressedButtonsOnSamePage() async throws {
        let fixture = try MouseTransportFixture(); defer { fixture.remove() }
        let viewport = try await fixture.transport.connect(session: fixture.session)
        XCTAssertTrue(fixture.transport.send(fixture.event(viewport, .down, button: .left, buttons: 1)))
        XCTAssertTrue(fixture.transport.send(fixture.event(viewport, .down, button: .right, buttons: 3)))
        try await fixture.transport.flush()
        await fixture.transport.releaseAllAndClose()
        XCTAssertEqual(fixture.fake.inputs.compactMap { $0.parameters["buttons"] as? Int }, [1, 3, 2, 0])
        XCTAssertEqual(fixture.fake.inputs.suffix(2).compactMap { $0.parameters["button"] as? String }, ["left", "right"])
    }

    @MainActor func testReloadInvalidatesBindingAndNeverSendsOldReleaseToNewDocument() async throws {
        let fixture = try MouseTransportFixture(); defer { fixture.remove() }
        let viewport = try await fixture.transport.connect(session: fixture.session)
        XCTAssertTrue(fixture.transport.send(fixture.event(viewport, .down, button: .left, buttons: 1)))
        try await fixture.transport.flush()
        fixture.fake.timeOrigin += 1
        fixture.fake.onEvent?("Runtime.executionContextsCleared", [:], fixture.fake.pageSessionID)
        XCTAssertFalse(fixture.transport.send(fixture.event(viewport, .up, button: .left)))
        await fixture.transport.releaseAllAndClose()
        XCTAssertEqual(fixture.failures.count, 1)
        XCTAssertEqual(fixture.fake.inputs.count, 1)
    }

    @MainActor func testRefreshRejectsSilentPageEpochChangeBeforeBusinessClick() async throws {
        let fixture = try MouseTransportFixture(); defer { fixture.remove() }
        let viewport = try await fixture.transport.connect(session: fixture.session)
        fixture.fake.timeOrigin += 1
        XCTAssertTrue(fixture.transport.send(fixture.event(viewport, .down, button: .left, buttons: 1)))
        do { try await fixture.transport.flush(); XCTFail("Stale click must not flush") } catch { }
        await fixture.transport.releaseAllAndClose()
        XCTAssertTrue(fixture.fake.inputs.isEmpty)
        XCTAssertEqual(fixture.failures.count, 1)
    }

    @MainActor func testFullscreenExitInvalidatesAndReleasesExistingDragWithoutTogglingFullscreen() async throws {
        let fixture = try MouseTransportFixture(); defer { fixture.remove() }
        let viewport = try await fixture.transport.connect(session: fixture.session)
        XCTAssertTrue(fixture.transport.send(fixture.event(viewport, .down, button: .left, buttons: 1)))
        try await fixture.transport.flush()
        fixture.fake.windowState = "normal"
        do { _ = try await fixture.transport.refreshViewport(); XCTFail("Windowed input must fail") } catch { }
        await fixture.transport.releaseAllAndClose()
        XCTAssertEqual(fixture.fake.inputs.count, 2)
        XCTAssertEqual(fixture.fake.inputs.last?.parameters["type"] as? String, "mouseReleased")
        XCTAssertFalse(fixture.fake.calls.contains { $0.method == "Browser.setWindowBounds" })
    }

    @MainActor func testDesktopOriginChangesPreserveBindingWhenCapturedWindowMovesWithBrowser() async throws {
        let fixture = try MouseTransportFixture(); defer { fixture.remove() }
        let viewport = try await fixture.transport.connect(session: fixture.session)
        fixture.fake.frame.origin = CGPoint(x: -1920, y: 300)
        fixture.capturedFrame = fixture.fake.frame
        let refreshed = try await fixture.transport.refreshViewport()
        XCTAssertEqual(refreshed, viewport)
        XCTAssertTrue(fixture.transport.isConnected)
        await fixture.transport.releaseAllAndClose()
    }

    @MainActor func testViewportResizeAndZoomInvalidateGeneration() async throws {
        for changesDPR in [false, true] {
            let fixture = try MouseTransportFixture(); defer { fixture.remove() }
            let viewport = try await fixture.transport.connect(session: fixture.session)
            if changesDPR { fixture.fake.dpr = 1.5 } else { fixture.fake.width -= 10 }
            do { _ = try await fixture.transport.refreshViewport(); XCTFail("Mapping dimensions changed") } catch { }
            XCTAssertFalse(fixture.transport.send(fixture.event(viewport, .move)))
            await fixture.transport.releaseAllAndClose()
        }
    }

    @MainActor func testTimeoutAfterDownAttemptsReleaseBeforeClosingSameSocket() async throws {
        let fixture = try MouseTransportFixture(); defer { fixture.remove() }
        let viewport = try await fixture.transport.connect(session: fixture.session)
        var failureSnapshot: [String: Any]?
        fixture.transport.onFailure = { [unowned fixture] error in
            fixture.failures.append(error)
            failureSnapshot = fixture.transport.diagnosticSnapshot
        }
        fixture.fake.timeoutNextInput = true
        XCTAssertTrue(fixture.transport.send(fixture.event(viewport, .down, button: .left, buttons: 1)))
        do { try await fixture.transport.flush(); XCTFail("Timeout must reject pending barrier") } catch { }
        await fixture.transport.releaseAllAndClose()
        XCTAssertEqual(fixture.fake.inputs.compactMap { $0.parameters["type"] as? String }, ["mousePressed", "mouseReleased"])
        XCTAssertEqual(fixture.failures.count, 1)
        XCTAssertTrue(fixture.fake.closed)
        let failure = try XCTUnwrap(failureSnapshot?["failureContext"] as? [String: Any])
        XCTAssertEqual(failure["lastErrorKind"] as? String, "timeout")
        XCTAssertEqual(failure["workItem"] as? String, "mousePressed")
        let request = try XCTUnwrap(failure["lastRequest"] as? [String: Any])
        XCTAssertEqual(request["method"] as? String, "Input.dispatchMouseEvent")
        XCTAssertEqual(request["result"] as? String, "failure")
        XCTAssertEqual(request["errorKind"] as? String, "timeout")
        XCTAssertGreaterThanOrEqual(try XCTUnwrap(request["elapsedMS"] as? Double), 0)
        let retained = try XCTUnwrap(fixture.transport.diagnosticSnapshot["failureContext"] as? [String: Any])
        XCTAssertEqual(failure as NSDictionary, retained as NSDictionary,
                       "Cleanup requests must not overwrite the request that caused the failure")
    }

    @MainActor func testDisconnectedTargetClearsQueueWithoutRetargetingRelease() async throws {
        let fixture = try MouseTransportFixture(); defer { fixture.remove() }
        let viewport = try await fixture.transport.connect(session: fixture.session)
        XCTAssertTrue(fixture.transport.send(fixture.event(viewport, .down, button: .left, buttons: 1)))
        try await fixture.transport.flush()
        fixture.fake.onEvent?("Target.detachedFromTarget", ["sessionId": fixture.fake.pageSessionID], nil)
        await fixture.transport.releaseAllAndClose()
        XCTAssertEqual(fixture.fake.inputs.count, 1)
        XCTAssertEqual(fixture.failures.count, 1)
        XCTAssertFalse(fixture.transport.isConnected)
    }

    @MainActor func testOldBindingCannotSendToNewConnectionAndOutOfViewportIsNeverClamped() async throws {
        let fixture = try MouseTransportFixture(); defer { fixture.remove() }
        let first = try await fixture.transport.connect(session: fixture.session)
        await fixture.transport.releaseAllAndClose()
        fixture.fake.closed = false
        let next = try await fixture.transport.connect(session: fixture.session)
        XCTAssertNotEqual(first.bindingID, next.bindingID)
        XCTAssertFalse(fixture.transport.send(fixture.event(first, .move)))
        XCTAssertTrue(fixture.transport.isConnected)
        XCTAssertFalse(fixture.transport.send(fixture.event(next, .down, x: next.cssWidth, button: .left, buttons: 1)))
        await fixture.transport.releaseAllAndClose()
        XCTAssertTrue(fixture.fake.inputs.isEmpty)
    }

    @MainActor func testURLMatchingRetainsPrivateShareQueryAndAllowsOnlySceneHashChange() throws {
        var configuration = ProtoPieConfiguration()
        configuration.cloudURL = "https://cloud.protopie.io/p/synthetic?shareKey=synthetic-test#scene-one"
        let expected = try configuration.playbackURL()
        XCTAssertTrue(MouseInputTransport.matchesPage(expected.absoluteString.replacingOccurrences(of: "scene-one", with: "scene-two"), expected: expected))
        XCTAssertFalse(MouseInputTransport.matchesPage(expected.absoluteString.replacingOccurrences(of: "synthetic-test", with: "different-test"), expected: expected))
        XCTAssertFalse(MouseInputTransport.matchesPage(expected.absoluteString.replacingOccurrences(of: "cloud.protopie.io", with: "cloud.protopie.io.example"), expected: expected))
        XCTAssertFalse(MouseInputTransport.matchesPage(expected.absoluteString.replacingOccurrences(of: "https:", with: "http:"), expected: expected))
    }

    @MainActor func testMalformedDynamicPortNeverFallsBackToSharedChromePort() throws {
        let fixture = try MouseTransportFixture(); defer { fixture.remove() }
        for text in ["9222", "0\n/devtools/browser/test", "65536\n/devtools/browser/test", "1234\nws://evil.example/page", "1234\n/devtools/page/test", "1234\n/devtools/browser/test?redirect=bad"] {
            try text.write(to: fixture.profile.appendingPathComponent("DevToolsActivePort"), atomically: true, encoding: .utf8)
            XCTAssertThrowsError(try MouseInputTransport.browserSocket(profileURL: fixture.profile))
        }
    }

    @MainActor func testSocketMatchesOutOfOrderRepliesToMonotonicRequestIDsOnOneWire() async throws {
        let wire = FakeMouseSocketWire()
        let socket = MouseInputWebSocket(wire: wire, timeout: 1)
        let first = Task { try await socket.call("Runtime.evaluate", parameters: ["test": "first"], sessionID: "synthetic-fixed") }
        let second = Task { try await socket.call("Input.dispatchMouseEvent", parameters: ["test": "second"], sessionID: "synthetic-fixed") }
        await wire.waitForSends(2)
        XCTAssertEqual(wire.sent.compactMap { $0["id"] as? Int }, [1, 2])
        XCTAssertTrue(wire.sent.allSatisfy { $0["sessionId"] as? String == "synthetic-fixed" })
        try wire.push(["id": 2, "result": ["reply": "second"]])
        try wire.push(["id": 1, "result": ["reply": "first"]])
        let firstReply = try await first.value, secondReply = try await second.value
        XCTAssertEqual(firstReply["reply"] as? String, "first")
        XCTAssertEqual(secondReply["reply"] as? String, "second")
        socket.close()
        XCTAssertTrue(wire.closed)
    }

    @MainActor func testSocketTimeoutDropsLateReplyAndKeepsWireForCleanupRequest() async throws {
        let wire = FakeMouseSocketWire()
        let socket = MouseInputWebSocket(wire: wire, timeout: 0.05)
        do { _ = try await socket.call("Input.dispatchMouseEvent", parameters: [:], sessionID: "synthetic-fixed"); XCTFail("Expected actual deadline") }
        catch { XCTAssertEqual(error as? MouseInputTransportError, .timeout) }
        XCTAssertFalse(wire.closed)
        let cleanup = Task { try await socket.call("Runtime.evaluate", parameters: [:], sessionID: "synthetic-fixed") }
        await wire.waitForSends(2)
        try wire.push(["id": 1, "result": ["late": true]])
        try wire.push(["id": 2, "result": ["cleanup": true]])
        let result = try await cleanup.value
        XCTAssertEqual(result["cleanup"] as? Bool, true)
        XCTAssertNil(result["late"])
        socket.close()
    }

    @MainActor func testSocketDisconnectResumesPendingAndDeliversFailureOnlyOnce() async throws {
        let wire = FakeMouseSocketWire()
        let socket = MouseInputWebSocket(wire: wire, timeout: 1)
        var failures = 0
        socket.onFailure = { _ in failures += 1 }
        let pending = Task { try await socket.call("Runtime.evaluate", parameters: [:], sessionID: "synthetic-fixed") }
        await wire.waitForSends(1)
        wire.close()
        do { _ = try await pending.value; XCTFail("Disconnected request must complete with failure") } catch { }
        XCTAssertEqual(failures, 1)
        socket.close()
        XCTAssertEqual(failures, 1)
    }
}

@MainActor private final class MouseTransportFixture {
    let profile: URL
    let fake = FakeMouseCDPConnection()
    let session: ProtoPieSession
    var connectedURL: URL?
    var capturedFrame = CGRect(x: 0, y: 0, width: 1920, height: 1080)
    var failures: [Error] = []
    lazy var transport: MouseInputTransport = {
        let result = MouseInputTransport(profileURL: profile, monitorInterval: 0, connectionFactory: { [unowned self] url in
            self.connectedURL = url; return self.fake
        }, windowLookup: { [unowned self] id, pid in id == 42 && pid == 123 ? self.capturedFrame : nil })
        result.onFailure = { [unowned self] in self.failures.append($0) }
        return result
    }()

    init() throws {
        profile = FileManager.default.temporaryDirectory.appendingPathComponent("NIOWarpMouseTest-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: profile, withIntermediateDirectories: true)
        try "18765\n/devtools/browser/synthetic-test".write(to: profile.appendingPathComponent("DevToolsActivePort"), atomically: true, encoding: .utf8)
        var configuration = ProtoPieConfiguration(); configuration.cloudURL = "https://cloud.protopie.io/p/mouse-input-test"
        session = ProtoPieSession(windowID: 42, processID: 123, configuration: configuration,
                                cloudTargetID: fake.targetID, title: "Synthetic fixture")
        fake.url = try configuration.playbackURL().absoluteString
    }
    func remove() { try? FileManager.default.removeItem(at: profile) }
    func event(_ viewport: MouseInputViewport, _ kind: MouseInputEvent.Kind, x: Double = 100,
               button: MouseInputEvent.Button = .none, buttons: Int = 0) -> MouseInputEvent {
        MouseInputEvent(viewportID: viewport.bindingID, kind: kind, x: x, y: 100, button: button, buttons: buttons)
    }
}

@MainActor private final class FakeMouseCDPConnection: MouseInputCDPConnection {
    struct Call { let method: String; let parameters: [String: Any]; let sessionID: String? }
    var onEvent: ((String, [String: Any], String?) -> Void)?
    var onFailure: ((Error) -> Void)?
    var calls: [Call] = []
    var inputs: [Call] { calls.filter { $0.method == "Input.dispatchMouseEvent" } }
    var closed = false
    var targetID = "synthetic-page-target"
    let pageSessionID = "synthetic-flat-session"
    var processID = 123
    var url = ""
    var frame = CGRect(x: 0, y: 0, width: 1920, height: 1080)
    var windowState = "fullscreen"
    var width: Double = 1920
    var height: Double = 1080
    var dpr: Double = 2
    var timeOrigin: Double = 12345
    var visualScale: Double = 1
    var readyState: String? = "complete"
    var blockNextInput = false
    var timeoutNextInput = false
    var blockNextActivation = false
    private var blockedInput: CheckedContinuation<Void, Never>?
    private var blockedActivation: CheckedContinuation<Void, Never>?

    func call(_ method: String, parameters: [String: Any], sessionID: String?) async throws -> [String: Any] {
        guard !closed else { throw MouseInputTransportError.disconnected }
        calls.append(Call(method: method, parameters: parameters, sessionID: sessionID))
        switch method {
        case "SystemInfo.getProcessInfo": return ["processInfo": [["type": "browser", "id": processID]]]
        case "Target.getTargetInfo": return ["targetInfo": ["targetId": targetID, "type": "page", "url": url]]
        case "Target.attachToTarget": return ["sessionId": pageSessionID]
        case "Target.activateTarget":
            if blockNextActivation { blockNextActivation = false; await withCheckedContinuation { blockedActivation = $0 } }
            return [:]
        case "Browser.getWindowForTarget":
            return ["windowId": 88, "bounds": ["left": frame.minX, "top": frame.minY, "width": frame.width,
                                             "height": frame.height, "windowState": windowState]]
        case "Runtime.evaluate":
            if (parameters["expression"] as? String)?.contains("nioCursorStyle:true") == true {
                return ["result": ["value": ["nioCursorStyle": true, "timeOrigin": timeOrigin, "css": "crosshair"]]]
            }
            var value: [String: Any] = ["url": url, "width": width, "height": height, "dpr": dpr, "timeOrigin": timeOrigin,
                                       "visualScale": visualScale, "visualOffsetX": 0, "visualOffsetY": 0]
            if let readyState { value["readyState"] = readyState }
            return ["result": ["value": value]]
        case "Input.dispatchMouseEvent":
            if blockNextInput { blockNextInput = false; await withCheckedContinuation { blockedInput = $0 } }
            if timeoutNextInput { timeoutNextInput = false; throw MouseInputTransportError.timeout }
            return [:]
        default: return [:]
        }
    }
    func waitForBlockedInput() async {
        for _ in 0..<1000 { if blockedInput != nil { return }; await Task.yield() }
        XCTFail("Input worker did not reach the expected dispatch")
    }
    func unblockInput() { blockedInput?.resume(); blockedInput = nil }
    func waitForBlockedActivation() async {
        for _ in 0..<1000 { if blockedActivation != nil { return }; await Task.yield() }
        XCTFail("Target activation did not reach the expected request")
    }
    func unblockActivation() { blockedActivation?.resume(); blockedActivation = nil }
    func close() { closed = true }
}

@MainActor private final class FakeMouseSocketWire: MouseInputWebSocketWire {
    var sent: [[String: Any]] = []
    var closed = false
    private var incoming: [Data] = []
    private var receiver: CheckedContinuation<Data, Error>?
    func send(_ text: String) async throws {
        guard !closed else { throw MouseInputTransportError.disconnected }
        sent.append(try JSONSerialization.jsonObject(with: Data(text.utf8)) as! [String: Any])
    }
    func receive() async throws -> Data {
        guard !closed else { throw MouseInputTransportError.disconnected }
        if !incoming.isEmpty { return incoming.removeFirst() }
        return try await withCheckedThrowingContinuation { receiver = $0 }
    }
    func push(_ object: [String: Any]) throws {
        let data = try JSONSerialization.data(withJSONObject: object)
        if let receiver { self.receiver = nil; receiver.resume(returning: data) }
        else { incoming.append(data) }
    }
    func waitForSends(_ count: Int) async {
        for _ in 0..<1000 { if sent.count >= count { return }; await Task.yield() }
        XCTFail("Socket did not reach the expected sends")
    }
    func close() {
        closed = true
        receiver?.resume(throwing: MouseInputTransportError.disconnected); receiver = nil
    }
}
