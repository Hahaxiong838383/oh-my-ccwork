import AppKit
import XCTest
@testable import NIOWarpApp

final class WindowLifecycleTests: XCTestCase {
    private func makeWindow() -> OutputWindow {
        _ = NSApplication.shared
        return OutputWindow(
            contentRect: NSRect(x: 0, y: 0, width: 160, height: 90),
            styleMask: .borderless, backing: .buffered, defer: false, screen: nil
        )
    }

    func testOutputWindowUsesARCOwnershipWithProductionInitializer() {
        autoreleasepool {
            let window = makeWindow()
            XCTAssertFalse(window.isReleasedWhenClosed)
            XCTAssertFalse(window.canBecomeKey)
            XCTAssertFalse(window.canBecomeMain)
            window.close()
        }
    }

    func testOutputCanBecomeKeyOnlyDuringExplicitMappedInputWithoutChangingMainOwnership() {
        autoreleasepool {
            let window = makeWindow()
            XCTAssertFalse(window.acceptsMappedInput)
            XCTAssertFalse(window.canBecomeKey)
            window.acceptsMappedInput = true
            XCTAssertTrue(window.canBecomeKey)
            XCTAssertFalse(window.canBecomeMain)
            XCTAssertFalse(window.isVisible, "启用焦点能力本身不得启动演示窗口或抢占焦点")
            window.acceptsMappedInput = false
            XCTAssertFalse(window.canBecomeKey)
            XCTAssertFalse(window.canBecomeMain)
            window.close()
            XCTAssertFalse(window.isReleasedWhenClosed)
        }
    }

    func testClosingOutputDoesNotInvalidateAnOwnedReference() {
        autoreleasepool {
            let window = makeWindow()
            window.title = "Window lifecycle regression"
            window.close()
            XCTAssertEqual(window.title, "Window lifecycle regression")
            XCTAssertFalse(window.isVisible)
            window.close()
            XCTAssertFalse(window.isReleasedWhenClosed)
        }
    }

    func testRepeatedWindowCloseAndPoolDrainReleaseExactlyOnce() {
        for _ in 0..<300 {
            weak var releasedWindow: OutputWindow?
            autoreleasepool {
                let window = makeWindow()
                releasedWindow = window
                XCTAssertFalse(window.isReleasedWhenClosed)
                window.close()
            }
            XCTAssertNil(releasedWindow)
        }
    }

    func testAutomaticQuitIsSuppressedDuringReplacementOrWithAConsole() {
        XCTAssertFalse(DisplaySessionPolicy.shouldTerminateAfterWindowClose(isReconfiguring: true, controlWindowVisible: false, controlWindowMiniaturized: false))
        XCTAssertFalse(DisplaySessionPolicy.shouldTerminateAfterWindowClose(isReconfiguring: false, controlWindowVisible: true, controlWindowMiniaturized: false))
        XCTAssertFalse(DisplaySessionPolicy.shouldTerminateAfterWindowClose(isReconfiguring: false, controlWindowVisible: false, controlWindowMiniaturized: true))
        XCTAssertTrue(DisplaySessionPolicy.shouldTerminateAfterWindowClose(isReconfiguring: false, controlWindowVisible: false, controlWindowMiniaturized: false))
    }
}
