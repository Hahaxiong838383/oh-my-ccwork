import Foundation
import XCTest
@testable import NIOWarpApp

@MainActor final class WorkbenchAccessSessionTests: XCTestCase {
    func testNewSessionAllowsOnlyTheTwoDailyUseModules() {
        let access = WorkbenchAccessSession()
        XCTAssertFalse(access.isDebugMode)
        XCTAssertFalse(access.isAuthenticating)
        XCTAssertFalse(access.allowsDebugEditing)
        for module in ["canvas", "global", "local", "quality", "mouse", "", "unknown"] {
            XCTAssertFalse(access.allowsModule(module), module)
        }
        XCTAssertTrue(access.allowsModule("history"))
        XCTAssertTrue(access.allowsModule("protopie"))
    }

    func testWrongPasswordAndCancelledAuthenticationKeepSessionLocked() {
        let access = WorkbenchAccessSession(passwordVerifier: { $0 == "fixture-debug-access" })
        let initialGeneration = access.generation
        XCTAssertTrue(access.beginAuthentication())
        XCTAssertFalse(access.beginAuthentication(), "同一会话不能叠加密码对话框")
        XCTAssertTrue(access.isAuthenticating)
        XCTAssertFalse(access.unlock(password: "incorrect"))
        XCTAssertFalse(access.unlock(password: ""))
        XCTAssertFalse(access.isDebugMode)
        XCTAssertFalse(access.allowsDebugEditing)
        XCTAssertEqual(access.generation, initialGeneration, "失败认证不应使已保存状态产生新代次")
        access.endAuthentication()
        XCTAssertFalse(access.isAuthenticating)
        XCTAssertFalse(access.isDebugMode)
        XCTAssertEqual(access.generation, initialGeneration)
    }

    func testUnlockAndRelockAreSessionLocalAndInvalidateOutstandingEditing() {
        let access = WorkbenchAccessSession(passwordVerifier: { $0 == "fixture-debug-access" })
        let originalGeneration = access.generation
        XCTAssertTrue(access.unlock(password: "fixture-debug-access"))
        XCTAssertTrue(access.isDebugMode)
        XCTAssertTrue(access.allowsDebugEditing)
        XCTAssertGreaterThan(access.generation, originalGeneration)
        for module in ["canvas", "global", "local", "quality", "history", "mouse", "protopie"] {
            XCTAssertTrue(access.allowsModule(module), module)
        }
        let editingGeneration = access.generation
        access.lock()
        XCTAssertFalse(access.isDebugMode)
        XCTAssertFalse(access.allowsDebugEditing)
        XCTAssertGreaterThan(access.generation, editingGeneration, "异步校正不能跨越回锁落盘")
        let relaunched = WorkbenchAccessSession(passwordVerifier: { $0 == "fixture-debug-access" })
        XCTAssertFalse(relaunched.isDebugMode, "模拟新App进程，不继承其他会话的授权")
        XCTAssertFalse(relaunched.isAuthenticating)
    }

    func testUseModeHidesCalibrationOnlyInRenderCopyAndPreservesEverySavedParameter() {
        let access = WorkbenchAccessSession(passwordVerifier: { $0 == "fixture-debug-access" })
        var saved = WarpConfiguration.defaultConfiguration(displayWidth: 7680, displayHeight: 936)
        saved.canvas = CanvasConfiguration(width: 12500, height: 2800)
        saved.render.testPattern = .calibrationGrid
        saved.manual.arch = 2.8
        saved.manual.verticalScale = 1.5
        saved.manual.tilt = -0.02
        let original = saved
        let rendered = access.renderConfiguration(saved)
        XCTAssertEqual(saved, original)
        XCTAssertEqual(rendered.render.testPattern, .off)
        var expected = original
        expected.render.testPattern = .off
        XCTAssertEqual(rendered, expected, "仅隐藏标定层，不能改画面几何、镜像或屏幕参数")
        XCTAssertTrue(access.unlock(password: "fixture-debug-access"))
        XCTAssertEqual(access.renderConfiguration(saved), original)
        access.lock()
        XCTAssertEqual(access.renderConfiguration(saved), expected)
        XCTAssertEqual(saved, original)
    }

    func testDefaultVerifierRejectsEmptyAndFixtureCredentials() {
        let access = WorkbenchAccessSession()
        for wrong in ["", "fixture-debug-access", "wrong-password", " "] {
            XCTAssertFalse(access.unlock(password: wrong))
        }
        XCTAssertFalse(access.isDebugMode)
    }

    func testProductionPasswordVerifierFromPrivateEnvironment() throws {
        guard let password = ProcessInfo.processInfo.environment["NIO_WARP_TEST_DEBUG_PASSWORD"], !password.isEmpty else {
            throw XCTSkip("未提供仅用于本次进程的正式口令；不在测试源码保存安装密码")
        }
        let access = WorkbenchAccessSession()
        XCTAssertFalse(access.unlock(password: password + " "), "口令不应忽略尾部字符")
        XCTAssertTrue(access.unlock(password: password), "正式校验器应接受已配置口令")
        XCTAssertTrue(access.isDebugMode)
        access.lock()
        XCTAssertFalse(access.isDebugMode)
    }
}
