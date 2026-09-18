import AppKit
import XCTest
import JavaScriptCore
@testable import NIOWarpApp

final class ProtoPieFullscreenTests: XCTestCase {
    private let target = CGRect(x: 1512, y: 0, width: 7680, height: 936)

    private func observation(windowID: CGWindowID = 42, frame: CGRect? = nil,
                             browserFrame: CGRect? = nil, state: String = "fullscreen",
                             viewport: CGSize? = nil, scale: CGFloat = 1) -> ProtoPieFullscreenObservation {
        let actual = frame ?? target
        return ProtoPieFullscreenObservation(windowID: windowID, frame: actual,
            browserFrame: browserFrame ?? actual, windowState: state,
            viewportPixels: viewport ?? CGSize(width: actual.width * scale, height: actual.height * scale),
            displayScale: scale)
    }

    func testNormalAndMaximizedWindowsAreNotBorderlessFullscreen() {
        for state in ["normal", "maximized", "minimized", ""] {
            XCTAssertFalse(observation(state: state).isReady(for: target), state)
        }
        XCTAssertTrue(observation().isReady(for: target))
    }

    func testFullscreenStateDoesNotHideMissingThirtyTwoPixelViewportStrip() {
        XCTAssertFalse(observation(viewport: CGSize(width: 7680, height: 904)).isReady(for: target))
        XCTAssertFalse(observation(viewport: CGSize(width: 15360, height: 1808), scale: 2).isReady(for: target))
        XCTAssertTrue(observation(viewport: CGSize(width: 7680, height: 936)).isReady(for: target))
    }

    func testWindowAndBrowserMustBothBeOnTargetDisplay() {
        let wrong = CGRect(x: 0, y: 0, width: target.width, height: target.height)
        XCTAssertFalse(observation(frame: wrong).isReady(for: target))
        XCTAssertFalse(observation(browserFrame: wrong).isReady(for: target))
        let short = CGRect(x: target.minX, y: target.minY, width: target.width, height: target.height - 30)
        XCTAssertFalse(observation(frame: short).isReady(for: target))
        XCTAssertFalse(observation(browserFrame: short).isReady(for: target))
    }

    func testNegativeDisplayCoordinatesAndRetinaPhysicalViewportAreAccepted() {
        let negative = CGRect(x: -2560, y: -1440, width: 2560, height: 1440)
        XCTAssertTrue(observation(frame: negative, scale: 2).isReady(for: negative))
        // At 125% page zoom, a 2048 x 1152 CSS viewport times DPR 2.5
        // still covers the 5120 x 2880 physical pixels of this Retina window.
        let physical = CGSize(width: 2048 * 2.5, height: 1152 * 2.5)
        XCTAssertTrue(observation(frame: negative, viewport: physical, scale: 2).isReady(for: negative))
    }

    func testSmallWindowRoundingIsAllowedButTwoPointDisplacementIsRejected() {
        let rounded = CGRect(x: target.minX + 1.5, y: target.minY + 1.5,
                             width: target.width - 1.5, height: target.height - 1.5)
        XCTAssertTrue(observation(frame: rounded).isReady(for: target))
        let shifted = target.offsetBy(dx: 2, dy: 0)
        XCTAssertFalse(observation(frame: shifted).isReady(for: target))
        XCTAssertFalse(observation(browserFrame: shifted).isReady(for: target))
    }

    func testViewportRoundingToleranceScalesWithDisplayDensity() {
        XCTAssertTrue(observation(viewport: CGSize(width: 15363, height: 1875), scale: 2).isReady(for: target))
        XCTAssertFalse(observation(viewport: CGSize(width: 15365, height: 1872), scale: 2).isReady(for: target))
        XCTAssertFalse(observation(viewport: CGSize(width: 7680, height: 939)).isReady(for: target))
    }

    func testInvalidDisplayScalesAndViewportNumbersAreRejected() {
        for scale in [CGFloat.zero, -1, .nan, .infinity] {
            XCTAssertFalse(observation(viewport: target.size, scale: scale).isReady(for: target))
        }
        for viewport in [CGSize.zero, CGSize(width: -1, height: 936),
                         CGSize(width: CGFloat.nan, height: 936), CGSize(width: 7680, height: CGFloat.infinity)] {
            XCTAssertFalse(observation(viewport: viewport).isReady(for: target))
        }
    }

    func testInvalidWindowAndTargetGeometryIsRejected() {
        for invalid in [CGRect.zero, CGRect(x: CGFloat.nan, y: 0, width: 7680, height: 936),
                        CGRect(x: 1512, y: 0, width: CGFloat.infinity, height: 936),
                        CGRect(x: 1512, y: 0, width: 7680, height: -936)] {
            XCTAssertFalse(observation(frame: invalid, viewport: target.size).isReady(for: target))
            XCTAssertFalse(observation(browserFrame: invalid).isReady(for: target))
            XCTAssertFalse(observation().isReady(for: invalid))
        }
    }

    func testReadinessRequiresThreeConsecutiveIdenticalObservations() {
        var readiness = ProtoPieFullscreenReadiness()
        let valid = observation()
        XCTAssertFalse(readiness.observe(valid, targetFrame: target))
        XCTAssertFalse(readiness.observe(valid, targetFrame: target))
        XCTAssertTrue(readiness.observe(valid, targetFrame: target))
        XCTAssertTrue(readiness.observe(valid, targetFrame: target))
    }

    func testNilAndInvalidObservationsResetReadiness() {
        for interruption in [nil, observation(state: "normal"),
                             observation(viewport: CGSize(width: 7680, height: 904))] {
            var readiness = ProtoPieFullscreenReadiness()
            let valid = observation()
            XCTAssertFalse(readiness.observe(valid, targetFrame: target))
            XCTAssertFalse(readiness.observe(valid, targetFrame: target))
            XCTAssertFalse(readiness.observe(interruption, targetFrame: target))
            XCTAssertFalse(readiness.observe(valid, targetFrame: target))
            XCTAssertFalse(readiness.observe(valid, targetFrame: target))
            XCTAssertTrue(readiness.observe(valid, targetFrame: target))
        }
    }

    func testWindowIdentityAndValidAnimationChangesRestartStabilityCount() {
        let animated = target.offsetBy(dx: 1, dy: 0)
        let variants = [observation(windowID: 43), observation(frame: animated),
                        observation(browserFrame: animated),
                        observation(viewport: CGSize(width: 7681, height: 936))]
        for changed in variants {
            var readiness = ProtoPieFullscreenReadiness()
            XCTAssertTrue(changed.isReady(for: target))
            XCTAssertFalse(readiness.observe(observation(), targetFrame: target))
            XCTAssertFalse(readiness.observe(observation(), targetFrame: target))
            XCTAssertFalse(readiness.observe(changed, targetFrame: target))
            XCTAssertFalse(readiness.observe(changed, targetFrame: target))
            XCTAssertTrue(readiness.observe(changed, targetFrame: target))
        }
    }

    private func cloudContext(host: String = "cloud.protopie.io", path: String = "/p/example",
                              href: String = "https://cloud.protopie.io/p/example",
                              state: String = "complete") throws -> JSContext {
        let context = try XCTUnwrap(JSContext())
        let arguments = String(data: try JSONSerialization.data(withJSONObject: [host, path, href, state]), encoding: .utf8)!
        context.evaluateScript("""
        var [testHost,testPath,testHref,testState]=\(arguments);
        var innerWidth=7680, innerHeight=936;
        var location={hostname:testHost,pathname:testPath,href:testHref};
        var getComputedStyle=()=>({visibility:'visible'});
        var password=false;
        var contentImage={complete:true,naturalWidth:7680,naturalHeight:936,alt:'',className:'layer',src:'asset.png',
          getBoundingClientRect:()=>({width:7680,height:936})};
        var document={readyState:testState,title:'unmarked-source',body:{innerText:''},querySelector:()=>null,
          querySelectorAll:s=>s==='img'?[contentImage]:(s==='input[type=password]'&&password?[contentImage]:[])};
        """)
        XCTAssertNil(context.exception)
        return context
    }

    private func cloudEvaluation(_ context: JSContext) throws -> [AnyHashable: Any] {
        let expression = ProtoPieSystemDriver.cloudReadinessExpression(
            expectedURL: URL(string: "https://cloud.protopie.io/p/example")!, marker: "owned-preview")
        let result = try XCTUnwrap(context.evaluateScript(expression)?.toDictionary())
        XCTAssertNil(context.exception)
        return result
    }

    func testNewAboutBlankTargetWaitsWithoutDemandingLogin() throws {
        let context = try cloudContext(host: "", path: "blank", href: "about:blank")
        let result = try cloudEvaluation(context)
        XCTAssertEqual(result["ready"] as? Bool, false)
        XCTAssertNil(result["problem"])
        XCTAssertEqual(context.evaluateScript("document.title")?.toString(), "unmarked-source")
    }

    func testCloudLoadingDocumentWaitsWithoutDemandingLogin() throws {
        let context = try cloudContext(state: "loading")
        let result = try cloudEvaluation(context)
        XCTAssertEqual(result["ready"] as? Bool, false)
        XCTAssertNil(result["problem"])
        XCTAssertEqual(context.evaluateScript("document.title")?.toString(), "unmarked-source")
    }

    func testInteractiveDocumentWithLoadedPrototypeDoesNotWaitForUnrelatedResources() throws {
        let context = try cloudContext(state: "interactive")
        let result = try cloudEvaluation(context)
        XCTAssertEqual(result["ready"] as? Bool, true)
        XCTAssertNil(result["problem"])
        XCTAssertEqual(context.evaluateScript("document.title")?.toString(), "owned-preview")
    }

    func testInteractiveEmptyShellDoesNotCountAsLoadedPrototype() throws {
        let context = try cloudContext(state: "interactive")
        context.evaluateScript("contentImage.complete=false;contentImage.naturalWidth=0")
        let result = try cloudEvaluation(context)
        XCTAssertEqual(result["ready"] as? Bool, false)
        XCTAssertNil(result["problem"])
        XCTAssertEqual(context.evaluateScript("document.title")?.toString(), "unmarked-source")
    }

    func testLoadingAuthenticationRedirectWaitsWithoutPrematureLoginFailure() throws {
        for host in ["cloud.protopie.io", "accounts.protopie.io"] {
          for state in ["loading", "interactive"] {
            let context = try cloudContext(host: host, path: "/auth/callback",
                                           href: "https://\(host)/auth/callback", state: state)
            let result = try cloudEvaluation(context)
            XCTAssertEqual(result["ready"] as? Bool, false)
            XCTAssertNil(result["problem"])
          }
        }
    }

    func testCompleteLoginAndPasswordPagesStillRequestUserAction() throws {
        for host in ["cloud.protopie.io", "accounts.protopie.io"] {
            let context = try cloudContext(host: host, path: "/login", href: "https://\(host)/login")
            let result = try cloudEvaluation(context)
            XCTAssertNotNil(result["problem"])
            XCTAssertFalse(result["ready"] as? Bool ?? false)
            XCTAssertEqual(context.evaluateScript("document.title")?.toString(), "unmarked-source")
        }
        let password = try cloudContext()
        password.evaluateScript("password=true")
        XCTAssertNotNil(try cloudEvaluation(password)["problem"])
    }

    func testBlankTargetCanFinishLoadingAndBecomeReadyInSameContext() throws {
        let context = try cloudContext(host: "", path: "blank", href: "about:blank")
        XCTAssertNil(try cloudEvaluation(context)["problem"])
        context.evaluateScript("location={hostname:'cloud.protopie.io',pathname:'/p/example',href:'https://cloud.protopie.io/p/example'};document.readyState='loading'")
        XCTAssertEqual(try cloudEvaluation(context)["ready"] as? Bool, false)
        context.evaluateScript("document.readyState='complete'")
        let result = try cloudEvaluation(context)
        XCTAssertEqual(result["ready"] as? Bool, true)
        XCTAssertNil(result["problem"])
        XCTAssertEqual(context.evaluateScript("document.title")?.toString(), "owned-preview")
    }
}
