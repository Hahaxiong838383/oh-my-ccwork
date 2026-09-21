import Foundation
import Testing
@testable import CPAMenuBar

@Suite
struct CodexAuthorizationTests {
    @Test func cancellationRejectsLateResponsesAndClearsDeadline() throws {
        var attempt = CodexAuthorizationAttempt()
        let attemptID = attempt.begin()
        attempt.recordState("fixture-state", for: attemptID)
        let finished = attempt.finish(attemptID)
        #expect(finished)
        #expect(!attempt.canContinue(attemptID))
        #expect(!attempt.acceptsCallback(try callback(state: "fixture-state"), for: attemptID))
        #expect(attempt.deadline == nil)
        #expect(attempt.oauthState == nil)
    }

    @Test func oldAttemptCannotCompleteOrCancelNewAttempt() throws {
        var attempt = CodexAuthorizationAttempt()
        let oldID = attempt.begin()
        attempt.recordState("old-state", for: oldID)
        let newID = attempt.begin()
        attempt.recordState("new-state", for: newID)
        let oldFinished = attempt.finish(oldID)
        let oldRecorded = attempt.recordState("old-state", for: oldID)
        #expect(!oldFinished)
        #expect(!oldRecorded)
        #expect(attempt.canContinue(newID))
        #expect(!attempt.acceptsCallback(try callback(state: "old-state"), for: newID))
        #expect(attempt.acceptsCallback(try callback(state: "new-state"), for: newID))
    }

    @Test func timeoutBoundaryRejectsCallbackWithoutWaitingForTimer() throws {
        let start = Date(timeIntervalSince1970: 1_700_000_000)
        var attempt = CodexAuthorizationAttempt()
        let attemptID = attempt.begin(now: start)
        attempt.recordState("fixture-state", for: attemptID)
        #expect(attempt.canContinue(attemptID, now: start.addingTimeInterval(299)))
        #expect(!attempt.canContinue(attemptID, now: start.addingTimeInterval(300)))
        #expect(!attempt.acceptsCallback(try callback(state: "fixture-state"), for: attemptID, now: start.addingTimeInterval(301)))
        let finished = attempt.finish(attemptID)
        #expect(finished)
    }

    @Test func callbackBeforeStartResponseIsRejected() throws {
        var attempt = CodexAuthorizationAttempt()
        let attemptID = attempt.begin()
        let recorded = attempt.recordState("", for: attemptID)
        #expect(!recorded)
        #expect(!attempt.acceptsCallback(try callback(state: "fixture-state"), for: attemptID))
    }

    @Test func rejectsFaviconAndMissingOrDuplicatedState() throws {
        let invalidURLs = [
            "http://localhost:1455/favicon.ico",
            "http://localhost:1455/auth/callback?code=fixture",
            "http://localhost:1455/auth/callback?state=fixture-state",
            "http://localhost:1455/auth/callback?state=fixture-state&state=fixture-state&code=fixture",
            "http://localhost:1455/auth/callback?state=wrong-state&code=fixture"
        ]
        for text in invalidURLs {
            #expect(!OAuthCallbackValidation.matches(try #require(URL(string: text)), expectedState: "fixture-state"))
        }
    }

    @Test func matchingUserDeclineCanEndAttempt() throws {
        let url = try #require(URL(string: "http://localhost:1455/auth/callback?state=fixture-state&error=access_denied"))
        #expect(OAuthCallbackValidation.matches(url, expectedState: "fixture-state"))
    }

    @Test func cancellationIsIdempotent() {
        var attempt = CodexAuthorizationAttempt()
        let attemptID = attempt.begin()
        let firstFinish = attempt.finish(attemptID)
        let secondFinish = attempt.finish(attemptID)
        #expect(firstFinish)
        #expect(!secondFinish)
    }

    @Test func invalidCallbackKeepsListenerAndStopReleasesIt() async throws {
        let listener = OAuthCallbackListener(port: 0)
        defer { listener.stop() }
        let results = CallbackResults()
        try listener.start(expectedState: "fixture-state") { result in results.append(result) }
        let port = try await waitForPort(listener)
        let session = URLSession(configuration: .ephemeral)
        defer { session.invalidateAndCancel() }
        for path in ["/favicon.ico", "/auth/callback?state=old-state&code=fixture"] {
            let url = try #require(URL(string: "http://127.0.0.1:\(port)\(path)"))
            let (_, response) = try await session.data(from: url)
            #expect((response as? HTTPURLResponse)?.statusCode == 400)
            #expect(listener.listeningPort == port)
            #expect(results.count == 0)
        }
        listener.stop()
        #expect(listener.listeningPort == nil)
        try listener.start(expectedState: "new-state") { result in results.append(result) }
        let newPort = try await waitForPort(listener)
        let url = try #require(URL(string: "http://127.0.0.1:\(newPort)/auth/callback?state=new-state&code=fixture"))
        let (_, response) = try await session.data(from: url)
        #expect((response as? HTTPURLResponse)?.statusCode == 200)
        #expect(results.count == 1)
        #expect(listener.listeningPort == nil)
    }

    private func callback(state: String) throws -> URL {
        try #require(URL(string: "http://localhost:1455/auth/callback?state=\(state)&code=fixture"))
    }

    private func waitForPort(_ listener: OAuthCallbackListener) async throws -> UInt16 {
        for _ in 0..<100 {
            if let port = listener.listeningPort, port != 0 { return port }
            try await Task.sleep(for: .milliseconds(10))
        }
        return try #require(listener.listeningPort)
    }
}

private final class CallbackResults: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [Result<URL, Error>] = []

    var count: Int {
        lock.lock()
        defer { lock.unlock() }
        return values.count
    }

    func append(_ value: Result<URL, Error>) {
        lock.lock()
        values.append(value)
        lock.unlock()
    }
}
