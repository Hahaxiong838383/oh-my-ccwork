import Foundation
import XCTest
@testable import NIOWarpApp

@MainActor final class MouseAutomationHandoffTests: XCTestCase {
    func testFocusLossRemainsBetweenCapturedDownAndReentryClick() {
        var buffer = MouseAutomationHandoffBuffer()
        XCTAssertTrue(buffer.append(.mouse(.button(down: true, number: 0, clickCount: 1, modifiers: 0))))
        XCTAssertTrue(buffer.append(.leftSurface))
        XCTAssertTrue(buffer.append(.mouse(.button(down: true, number: 0, clickCount: 1, modifiers: 0))))
        XCTAssertTrue(buffer.append(.mouse(.button(down: false, number: 0, clickCount: 1, modifiers: 0))))
        let result = buffer.drain()
        XCTAssertEqual(result.map(label), ["left-down", "release-scope", "left-down", "left-up"],
            "范围外物理 up 被 Native 捕获排空，重放必须在再次进入前补释放")
        XCTAssertTrue(buffer.events.isEmpty)
        XCTAssertTrue(buffer.drain().isEmpty)
    }

    func testKeyboardReleasesAndPointerMovesRemainInOriginalOrderDuringHandoff() {
        var buffer = MouseAutomationHandoffBuffer()
        let down = MouseKeyboardInput(down: true, keyCode: 84, text: "2", unmodifiedText: "2", modifiers: 0, isAutoRepeat: false)
        let up = MouseKeyboardInput(down: false, keyCode: 84, text: "2", unmodifiedText: "2", modifiers: 0, isAutoRepeat: false)
        XCTAssertTrue(buffer.append(.keyboard(down)))
        XCTAssertTrue(buffer.append(.mouse(.move(dx: 6, dy: -4, modifiers: 0))))
        XCTAssertTrue(buffer.append(.keyboard(up)))
        XCTAssertTrue(buffer.append(.leftSurface))
        let result = buffer.drain()
        XCTAssertEqual(result.map(label), ["key-down", "move", "key-up", "release-scope"])
        if case let .mouse(.move(dx, dy, _)) = result[1] {
            XCTAssertEqual(dx, 6); XCTAssertEqual(dy, -4)
        } else { XCTFail("首个人工移动应保留原始补偿后位移") }
    }

    func testOverflowIsExplicitInsteadOfSilentlyDroppingARelease() {
        var buffer = MouseAutomationHandoffBuffer()
        for _ in 0..<MouseAutomationHandoffBuffer.capacity {
            XCTAssertTrue(buffer.append(.mouse(.move(dx: 1, dy: 0, modifiers: 0))))
        }
        XCTAssertFalse(buffer.append(.mouse(.button(down: false, number: 0, clickCount: 1, modifiers: 0))),
            "调用方必须在 false 时停止会话并平衡输入，不能继续重放残缺动作")
        XCTAssertEqual(buffer.events.count, MouseAutomationHandoffBuffer.capacity)
        buffer.reset()
        XCTAssertTrue(buffer.events.isEmpty)
        XCTAssertTrue(buffer.append(.leftSurface))
    }

    func testManualEntryPausesAPlaylistButAutomaticEntryDoesNotPauseItself() throws {
        let name = "nio-warp-handoff-tests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        let controller = MouseMappingController(defaults: defaults)
        var userActivity = 0
        controller.onAutomationUserActivity = { userActivity += 1 }
        // These start tasks are cancelled synchronously before native capture.
        controller.start()
        XCTAssertEqual(userActivity, 1)
        controller.start()
        XCTAssertEqual(userActivity, 1, "重复进入请求不能重复暂停或重绑")
        controller.stop()
        controller.start(automatic: true)
        XCTAssertEqual(userActivity, 1, "计划自己的输入准备不能当成人工接管")
        controller.stop()
        XCTAssertFalse(controller.isActive)
        XCTAssertFalse(controller.automationOwnsInput)
    }

    private func label(_ event: MouseAutomationHandoffBuffer.Event) -> String {
        switch event {
        case .leftSurface: return "release-scope"
        case .keyboard(let key): return key.kind == .down ? "key-down" : "key-up"
        case .mouse(.move): return "move"
        case .mouse(.wheel): return "wheel"
        case .mouse(.button(let down, _, _, _)): return down ? "left-down" : "left-up"
        }
    }
}
