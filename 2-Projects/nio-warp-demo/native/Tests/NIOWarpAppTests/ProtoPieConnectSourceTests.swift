import Foundation
import XCTest
@testable import NIOWarpApp

final class ProtoPieConnectSourceTests: XCTestCase {
    func testAcceptsLocalhostIPAndDomainsWithCustomPorts() throws {
        for text in ["http://localhost:9981/pie?pieid=1", "http://127.0.0.1:10001/pie?pieid=2",
                     "http://[::1]:9981/pie?pieid=3", "https://connect.example.test/pie?pieid=4",
                     "https://connect.example.test:9443/pie?pieid=5"] {
            let source = try ProtoPieConnectSource.parse(text)
            XCTAssertEqual(source.url.absoluteString, text)
            XCTAssertGreaterThan(source.identity.pieID, 0)
        }
    }

    func testPlaybackOnlyReplacesNativeBackgroundAndFitParameters() throws {
        let source = try ProtoPieConnectSource.parse(" http://localhost:9981/pie?pieid=23&name=A%20B&token=a%2Bb&custom=1&custom=2&touchHint=true&cursorHide=false&bg=white&bg=red&scaleToFit=false#scene ")
        let components = try XCTUnwrap(URLComponents(url: source.playbackURL(scaleToFit: true), resolvingAgainstBaseURL: false))
        let items = components.queryItems ?? []
        XCTAssertEqual(items.filter { $0.name == "bg" }, [URLQueryItem(name: "bg", value: "#000000")])
        XCTAssertEqual(items.filter { $0.name == "scaleToFit" }, [URLQueryItem(name: "scaleToFit", value: "true")])
        XCTAssertEqual(items.filter { $0.name == "custom" }.map(\.value), ["1", "2"])
        XCTAssertEqual(items.first { $0.name == "token" }?.value, "a+b")
        XCTAssertEqual(items.first { $0.name == "name" }?.value, "A B")
        XCTAssertEqual(items.first { $0.name == "touchHint" }?.value, "true")
        XCTAssertEqual(items.first { $0.name == "cursorHide" }?.value, "false")
        XCTAssertFalse(items.contains { ["ui", "bgColor"].contains($0.name) })
        XCTAssertEqual(components.fragment, "scene")
        let unscaled = try XCTUnwrap(URLComponents(url: source.playbackURL(scaleToFit: false), resolvingAgainstBaseURL: false))
        XCTAssertEqual(unscaled.queryItems?.first { $0.name == "scaleToFit" }?.value, "false")
    }

    func testRejectsNonHTTPUserInfoMalformedHostPortPathAndPieID() {
        for text in ["file:///pie?pieid=1", "javascript:alert(1)", "ftp://localhost/pie?pieid=1",
                     "http:///pie?pieid=1", "http://user@localhost:9981/pie?pieid=1", "http://user:pass@localhost/pie?pieid=1",
                     "http://localhost:0/pie?pieid=1", "http://localhost:65536/pie?pieid=1", "http://localhost:abc/pie?pieid=1",
                     "http://localhost:/pie?pieid=1", "http://localhost:9981/", "http://localhost:9981/pie/extra?pieid=1",
                     "http://localhost:9981/pie?pieid=0", "http://localhost:9981/pie?pieid=-1", "http://localhost:9981/pie?pieid=1.5",
                     "http://localhost:9981/pie?pieid=+1", "http://localhost:9981/pie?pieid=1&pieid=2", "http://localhost:9981/pie?pieid=",
                     "http://localhost:9981/pie?pieid=999999999999999999999999999999", "http://local host/pie?pieid=1"] {
            XCTAssertThrowsError(try ProtoPieConnectSource.parse(text), text)
        }
    }

    func testPageIdentityIncludesOriginPathAndPieIDWithoutDisplayParameters() throws {
        let expected = try XCTUnwrap(URL(string: "http://localhost:9981/pie?pieid=23&name=Before&bg=white"))
        XCTAssertTrue(ProtoPieConnectSource.matchesPage(URL(string: "http://LOCALHOST:9981/pie?pieid=23&name=After&bg=black")!, expected: expected))
        for text in ["http://localhost:9981/pie?pieid=24", "http://localhost:9982/pie?pieid=23", "https://localhost:9981/pie?pieid=23",
                     "http://127.0.0.1:9981/pie?pieid=23", "http://localhost:9981/other?pieid=23", "http://localhost:9981/pie?pieid=23&pieid=23"] {
            XCTAssertFalse(ProtoPieConnectSource.matchesPage(URL(string: text)!, expected: expected), text)
        }
        XCTAssertTrue(ProtoPieConnectSource.matchesPage(URL(string: "http://localhost:80/pie?pieid=1")!, expected: URL(string: "http://localhost/pie?pieid=1")!))
    }

    func testConfigurationDispatchesConnectAndKeepsCloudValidationStrict() throws {
        var config = ProtoPieConfiguration(); config.source = .connect
        config.connectURL = "http://localhost:9981/pie?pieid=23&touchHint=true"
        config.cloudURL = "https://cloud.protopie.io/p/original"
        config.scaleToFit = false; config.fillWidth = true; config.hidePlayerUI = true
        let result = try config.playbackURL()
        XCTAssertEqual(result.host, "localhost")
        XCTAssertEqual(URLComponents(url: result, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "scaleToFit" }?.value, "false")
        XCTAssertTrue(config.sourceLabel.contains("23"))
        config.source = .cloud; config.cloudURL = config.connectURL
        XCTAssertThrowsError(try config.playbackURL())
        config.source = .localFile
        XCTAssertThrowsError(try config.playbackURL())
    }
}
