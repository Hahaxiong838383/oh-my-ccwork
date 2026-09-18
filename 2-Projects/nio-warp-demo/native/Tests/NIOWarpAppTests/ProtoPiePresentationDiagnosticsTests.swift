import AppKit
import XCTest
@testable import NIOWarpApp

@MainActor final class ProtoPiePresentationDiagnosticsTests: XCTestCase {
    func testStableFullscreenWithUnreadyLayoutReportsInternalLayout() {
        let message = ProtoPiePresentationDiagnostics.timeoutMessage(geometryStable: true, layoutReady: false)
        XCTAssertTrue(message.contains("已无边框全屏"))
        XCTAssertTrue(message.contains("内部画面布局尚未就绪"))
        XCTAssertFalse(message.contains("尚未确认播放器"))
    }

    func testUnstableOrUnobservedGeometryDoesNotClaimFullscreen() {
        for stable in [false, true] {
            for layout: Bool? in [nil, false, true] where !(stable && layout == false) {
                let message = ProtoPiePresentationDiagnostics.timeoutMessage(geometryStable: stable, layoutReady: layout)
                XCTAssertTrue(message.contains("尚未确认播放器已无边框全屏"))
                XCTAssertFalse(message.contains("内部画面布局尚未就绪"))
            }
        }
    }

    func testDiagnosticsSeparatelyExposeCorrectGeometryAndUnreadyLayout() throws {
        let suite = "NIOWarp.PresentationDiagnostic.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let target = CGRect(x: 1512, y: 0, width: 7680, height: 2800)
        let observation = ProtoPieFullscreenObservation(windowID: 42, frame: target, browserFrame: target,
            windowState: "fullscreen", viewportPixels: target.size, displayScale: 1)
        ProtoPiePresentationDiagnostics.record(stage: .monitorComplete, sourceDisplayID: 15, outputDisplayID: 4,
            processID: 123, targetFrame: target, observation: observation,
            layoutReady: false, issue: .layoutNotReady, defaults: defaults)
        let data = try XCTUnwrap(defaults.data(forKey: ProtoPiePresentationDiagnostics.defaultsKey))
        let result = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let current = try XCTUnwrap(result["current"] as? [String: Any])
        XCTAssertEqual(current["geometryReady"] as? Bool, true)
        XCTAssertEqual(current["layoutReady"] as? Bool, false)
        XCTAssertEqual(current["issue"] as? String, "layoutNotReady")
        XCTAssertEqual(current["targetFrame"] as? [Double], [1512,0,7680,2800])
        XCTAssertEqual(current["capturedFrame"] as? [Double], [1512,0,7680,2800])
        XCTAssertEqual(current["browserFrame"] as? [Double], [1512,0,7680,2800])
        XCTAssertEqual(current["viewportPixels"] as? [Double], [7680,2800])
        XCTAssertEqual(current["sourceDisplayID"] as? Int, 15)
        XCTAssertEqual(current["outputDisplayID"] as? Int, 4)
        XCTAssertEqual(current["windowID"] as? Int, 42)
        XCTAssertNotNil(current["frontProcessID"])
    }

    func testDiagnosticHistoryIsBoundedAndUnknownWindowTextIsRedacted() throws {
        let suite = "NIOWarp.PresentationDiagnostic.Bounds.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        for index in 0..<40 {
            ProtoPiePresentationDiagnostics.record(stage: .prepareGeometry, sourceDisplayID: 15, processID: 123,
                windowID: CGWindowID(index), windowState: "https://private.example/?key=secret", defaults: defaults)
        }
        let data = try XCTUnwrap(defaults.data(forKey: ProtoPiePresentationDiagnostics.defaultsKey))
        let text = String(decoding: data, as: UTF8.self)
        XCTAssertFalse(text.contains("private.example")); XCTAssertFalse(text.contains("secret"))
        let result = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let recent = try XCTUnwrap(result["recent"] as? [[String: Any]])
        XCTAssertEqual(recent.count, ProtoPiePresentationDiagnostics.maximumRecords)
        XCTAssertEqual(recent.first?["windowID"] as? Int, 16)
        XCTAssertEqual(recent.last?["windowID"] as? Int, 39)
        XCTAssertEqual(recent.last?["windowState"] as? String, "unknown")
    }

    func testUnknownLayoutIsNotRecordedAsFalseAndInvalidNumbersDoNotBreakRecord() throws {
        let suite = "NIOWarp.PresentationDiagnostic.Invalid.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        ProtoPiePresentationDiagnostics.record(stage: .monitorGeometry, sourceDisplayID: 15, processID: 123,
            targetFrame: CGRect(x: CGFloat.nan, y: 0, width: 20, height: 30),
            viewportPixels: CGSize(width: CGFloat.infinity, height: 1), issue: .invalidViewport, defaults: defaults)
        let data = try XCTUnwrap(defaults.data(forKey: ProtoPiePresentationDiagnostics.defaultsKey))
        let result = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let current = try XCTUnwrap(result["current"] as? [String: Any])
        XCTAssertNil(current["targetFrame"]); XCTAssertNil(current["viewportPixels"])
        XCTAssertNil(current["geometryReady"]); XCTAssertNil(current["layoutReady"])
        XCTAssertEqual(current["issue"] as? String, "invalidViewport")
    }
}
