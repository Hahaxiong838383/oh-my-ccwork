import Foundation
import Testing
@testable import CPAMenuBar

struct XAIOAuthTests {
    @Test func decodesStartResponse() throws {
        let data = Data(#"{"state":"opaque-state","verification_url":"https://accounts.x.ai/device","user_code":"ABCD-EFGH","expires_in":1800,"status":"pending"}"#.utf8)
        let response = try JSONDecoder().decode(XAIOAuthStartResponse.self, from: data)

        #expect(response.state == "opaque-state")
        #expect(response.verificationURL.absoluteString == "https://accounts.x.ai/device")
        #expect(response.userCode == "ABCD-EFGH")
        #expect(response.expiresIn == 1800)
        #expect(response.status == "pending")
    }

    @Test func allowsOnlyExactXAIHTTPSHost() {
        #expect(XAIOAuthValidation.isAllowedVerificationURL(URL(string: "https://accounts.x.ai/device")!))
        #expect(!XAIOAuthValidation.isAllowedVerificationURL(URL(string: "http://accounts.x.ai/device")!))
        #expect(!XAIOAuthValidation.isAllowedVerificationURL(URL(string: "https://sub.accounts.x.ai/device")!))
        #expect(!XAIOAuthValidation.isAllowedVerificationURL(URL(string: "https://accounts.x.ai.example.com/device")!))
        #expect(!XAIOAuthValidation.isAllowedVerificationURL(URL(string: "https://user:pass@accounts.x.ai/device")!))
        #expect(!XAIOAuthValidation.isAllowedVerificationURL(URL(string: "https://example.com/device")!))
    }

    @Test func classifiesTerminalStatuses() {
        #expect(!XAIOAuthStatus.pending.isTerminal)
        #expect(XAIOAuthStatus.complete.isTerminal)
        #expect(XAIOAuthStatus.declined.isTerminal)
        #expect(XAIOAuthStatus.expired.isTerminal)
        #expect(XAIOAuthStatus.error.isTerminal)
    }

    @Test func calculatesRemainingAuthorizationTime() {
        let startedAt = Date(timeIntervalSince1970: 1_000)
        let session = XAIOAuthSession(
            state: "opaque-state",
            verificationURL: URL(string: "https://accounts.x.ai/device")!,
            userCode: "ABCD-EFGH",
            startedAt: startedAt,
            expiresAt: startedAt.addingTimeInterval(10),
            status: .pending,
            message: nil
        )

        #expect(session.remainingSeconds(at: startedAt.addingTimeInterval(3.2)) == 7)
        #expect(session.remainingSeconds(at: startedAt.addingTimeInterval(12)) == 0)
    }
}
