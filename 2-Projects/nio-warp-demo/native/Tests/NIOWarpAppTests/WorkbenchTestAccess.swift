import Foundation
import XCTest
@testable import NIOWarpApp

/// Legacy editing tests explicitly request a debug session. The verifier is an
/// injected fixture dependency; production always uses its password digest.
/// Never put the installation password into test sources, artifacts, or logs.
func authorizedWorkbenchAccessSession() -> WorkbenchAccessSession {
    MainActor.assumeIsolated {
        let access = WorkbenchAccessSession(passwordVerifier: { $0 == "fixture-debug-access" })
        XCTAssertTrue(access.unlock(password: "fixture-debug-access"))
        return access
    }
}
