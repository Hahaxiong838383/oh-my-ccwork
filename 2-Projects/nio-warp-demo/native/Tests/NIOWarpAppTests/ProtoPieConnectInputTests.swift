import AppKit
import XCTest
@testable import NIOWarpApp

/// Simulated CDP boundary tests; these do not connect to a real Connect service.
@MainActor final class ProtoPieConnectInputTests: XCTestCase {
    func testConnectBindsValidatedPageAndReleasesHeldMouseOnClose() async throws {
        let fixture = try ConnectInputFixture(); defer { fixture.remove() }
        let viewport = try await fixture.transport.connect(session: fixture.session)
        XCTAssertTrue(fixture.transport.isConnected)
        XCTAssertTrue(fixture.transport.send(MouseInputEvent(viewportID: viewport.bindingID,
            kind: .down, x: 123, y: 456, button: .left, buttons: 1)))
        try await fixture.transport.flush()
        await fixture.transport.releaseAllAndClose()
        XCTAssertEqual(fixture.wire.inputTypes, ["mousePressed", "mouseReleased"])
        XCTAssertFalse(fixture.transport.isConnected)
        XCTAssertTrue(fixture.wire.closed)
    }

    func testDifferentPieIDCannotBindEvenAtTheSameOriginAndPath() async throws {
        let fixture = try ConnectInputFixture(); defer { fixture.remove() }
        fixture.wire.url = "http://localhost:9981/pie?pieid=8"
        do { _ = try await fixture.transport.connect(session: fixture.session); XCTFail("Other pieid must be rejected") }
        catch { XCTAssertEqual(error as? MouseInputTransportError, .staleViewport) }
        XCTAssertFalse(fixture.transport.isConnected)
        XCTAssertFalse(fixture.wire.attached)
    }

    func testSilentPieSwitchClosesBindingWithoutReleasingIntoTheNewPrototype() async throws {
        let fixture = try ConnectInputFixture(); defer { fixture.remove() }
        let viewport = try await fixture.transport.connect(session: fixture.session)
        XCTAssertTrue(fixture.transport.send(MouseInputEvent(viewportID: viewport.bindingID,
            kind: .down, x: 12, y: 34, button: .left, buttons: 1)))
        try await fixture.transport.flush()
        fixture.wire.url = "http://localhost:9981/pie?pieid=8"
        do { _ = try await fixture.transport.refreshViewport(); XCTFail("Silent pie switch must invalidate input") }
        catch { XCTAssertEqual(error as? MouseInputTransportError, .staleViewport) }
        await fixture.transport.releaseAllAndClose()
        XCTAssertEqual(fixture.wire.inputTypes, ["mousePressed"])
        XCTAssertFalse(fixture.transport.isConnected)
    }

    func testBoundSameOriginHTTPCacheSuppliesOnlyTheDeclaredOriginalCursor() async throws {
        let fixture = try ConnectInputFixture(); defer { fixture.remove() }
        let resource = "http://localhost:9981/assets/original.png"
        fixture.wire.css = "url(\"\(resource)\") 0 0, auto"
        fixture.wire.resources[resource] = ConnectInputFixture.png
        _ = try await fixture.transport.connect(session: fixture.session)
        let style = try await fixture.transport.cursorStyle(at: CGPoint(x: 1, y: 1))
        XCTAssertEqual(style.imageSize, CGSize(width: 1, height: 1))
        XCTAssertEqual(style.hotSpot, .zero)
        XCTAssertTrue(style.identifier.hasPrefix("css-image-sha256:"))
        XCTAssertEqual(fixture.wire.readResources, [resource])
        XCTAssertEqual(fixture.transport.diagnosticSnapshot["cursorResourceOrigin"] as? String, "page-cache")
        XCTAssertEqual(fixture.nativeLoads, 0)
        await fixture.transport.releaseAllAndClose()
    }

    func testHTTPCacheCannotCrossTheBoundOriginOrUseNativeFallback() async throws {
        for resource in ["http://localhost:9982/assets/original.png", "http://127.0.0.1:9981/assets/original.png"] {
            let fixture = try ConnectInputFixture(); defer { fixture.remove() }
            fixture.wire.css = "url(\"\(resource)\") 0 0, auto"
            fixture.wire.resources[resource] = ConnectInputFixture.png
            _ = try await fixture.transport.connect(session: fixture.session)
            do { _ = try await fixture.transport.cursorStyle(at: CGPoint(x: 1, y: 1)); XCTFail("Cross-origin HTTP artwork must fail") }
            catch { XCTAssertEqual(error as? ProtoPieCursorArtworkError, .resourceUnavailable) }
            XCTAssertTrue(fixture.transport.isConnected, "Artwork failure must retain ordinary input")
            XCTAssertTrue(fixture.wire.readResources.isEmpty)
            XCTAssertEqual(fixture.nativeLoads, 0)
            await fixture.transport.releaseAllAndClose()
        }
    }
}

@MainActor private final class ConnectInputFixture {
    static let png = Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ1sAAAAASUVORK5CYII=")!
    let profile: URL
    let wire = ConnectInputWire()
    let session: ProtoPieSession
    var nativeLoads = 0
    lazy var transport = MouseInputTransport(profileURL: profile, monitorInterval: 0,
        connectionFactory: { [unowned self] _ in self.wire },
        windowLookup: { _, _ in CGRect(x: 0, y: 0, width: 1920, height: 1080) },
        cursorResourceLoader: { [unowned self] _ in self.nativeLoads += 1; return Self.png })

    init() throws {
        profile = FileManager.default.temporaryDirectory.appendingPathComponent("ConnectInputTest-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: profile, withIntermediateDirectories: true)
        try "18765\n/devtools/browser/connect-fixture".write(to: profile.appendingPathComponent("DevToolsActivePort"), atomically: true, encoding: .utf8)
        var configuration = ProtoPieConfiguration()
        configuration.source = .connect
        configuration.connectURL = "http://localhost:9981/pie?pieid=7&name=synthetic"
        session = ProtoPieSession(windowID: 42, processID: 123, configuration: configuration,
            cloudTargetID: "connect-target", title: "Synthetic Connect fixture")
        wire.url = try configuration.playbackURL().absoluteString
    }
    func remove() { try? FileManager.default.removeItem(at: profile) }
}

@MainActor private final class ConnectInputWire: MouseInputCDPConnection {
    var onEvent: ((String, [String: Any], String?) -> Void)?
    var onFailure: ((Error) -> Void)?
    var url = ""
    var css = "crosshair"
    var resources = [String: Data]()
    var readResources = [String]()
    var inputTypes = [String]()
    var attached = false, closed = false

    func call(_ method: String, parameters: [String: Any], sessionID: String?) async throws -> [String: Any] {
        guard !closed else { throw MouseInputTransportError.closed }
        switch method {
        case "SystemInfo.getProcessInfo": return ["processInfo": [["type": "browser", "id": 123]]]
        case "Target.getTargetInfo": return ["targetInfo": ["targetId": "connect-target", "type": "page", "url": url]]
        case "Target.attachToTarget": attached = true; return ["sessionId": "connect-page-session"]
        case "Browser.getWindowForTarget": return ["windowId": 88, "bounds": ["left": 0, "top": 0, "width": 1920, "height": 1080, "windowState": "fullscreen"]]
        case "Page.getResourceTree": return ["frameTree": ["frame": ["id": "connect-frame", "url": url], "resources": resources.keys.map { ["url": $0, "type": "Image"] }]]
        case "Page.getResourceContent":
            let resource = parameters["url"] as? String ?? ""
            guard let data = resources[resource], parameters["frameId"] as? String == "connect-frame" else {
                throw MouseInputTransportError.unavailable("Fixture resource unavailable")
            }
            readResources.append(resource)
            return ["base64Encoded": true, "content": data.base64EncodedString()]
        case "Runtime.evaluate":
            let expression = parameters["expression"] as? String ?? ""
            if expression.contains("nioCursorStyle:true") { return ["result": ["value": ["timeOrigin": 12345, "css": css]]] }
            if expression.contains("nioCursorResource:true") { return ["result": ["value": ["timeOrigin": 12345, "ok": false]]] }
            return ["result": ["value": ["url": url, "width": 1920, "height": 1080, "dpr": 1, "timeOrigin": 12345,
                "readyState": "complete", "visualScale": 1, "visualOffsetX": 0, "visualOffsetY": 0]]]
        case "Input.dispatchMouseEvent": inputTypes.append(parameters["type"] as? String ?? "invalid"); return [:]
        default: return [:]
        }
    }
    func close() { closed = true }
}
