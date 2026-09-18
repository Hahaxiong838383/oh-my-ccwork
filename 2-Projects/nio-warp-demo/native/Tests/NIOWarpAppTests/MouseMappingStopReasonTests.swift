import XCTest
@testable import NIOWarpApp

@MainActor final class MouseMappingStopReasonTests: XCTestCase {
    func testWorkbenchCleanupPreservesFailureReason() throws {
        let name = "nio-warp-stop-tests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        let controller = MouseMappingController(defaults: defaults)
        controller.stop(reason: "播放器输入响应超时；鼠标映射已停止。")
        controller.stop()
        let data = try XCTUnwrap(defaults.data(forKey: "nioWarpMouseMapping.runtime.v1"))
        let state = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(state["message"] as? String, "播放器输入响应超时；鼠标映射已停止。")
        XCTAssertEqual(state["active"] as? Bool, false)
        XCTAssertEqual(state["buttons"] as? Int, 0)
        // Repeated idle cleanup must not manufacture failure history.
        XCTAssertNil(defaults.data(forKey: "nioWarpMouseMapping.stops.v1"))
    }

    func testExplicitLaterStopReasonReplacesEarlierReason() throws {
        let name = "nio-warp-stop-tests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        let controller = MouseMappingController(defaults: defaults)
        controller.stop(reason: "输入错误")
        controller.stop(reason: "程序正在退出。")
        let data = try XCTUnwrap(defaults.data(forKey: "nioWarpMouseMapping.runtime.v1"))
        let state = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(state["message"] as? String, "程序正在退出。")
    }
}
