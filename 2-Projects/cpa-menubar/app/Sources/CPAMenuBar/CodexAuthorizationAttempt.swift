import Foundation

struct CodexAuthorizationAttempt {
    private(set) var id: UUID?
    private(set) var deadline: Date?
    private(set) var oauthState: String?

    mutating func begin(now: Date = Date(), timeout: TimeInterval = 300) -> UUID {
        let nextID = UUID()
        id = nextID
        deadline = now.addingTimeInterval(timeout)
        oauthState = nil
        return nextID
    }

    func isCurrent(_ attemptID: UUID) -> Bool {
        id == attemptID
    }

    func canContinue(_ attemptID: UUID, now: Date = Date()) -> Bool {
        isCurrent(attemptID) && deadline.map { now < $0 } == true
    }

    @discardableResult
    mutating func recordState(_ state: String, for attemptID: UUID) -> Bool {
        guard isCurrent(attemptID), !state.isEmpty else { return false }
        oauthState = state
        return true
    }

    func acceptsCallback(_ url: URL, for attemptID: UUID, now: Date = Date()) -> Bool {
        guard canContinue(attemptID, now: now), let oauthState else { return false }
        return OAuthCallbackValidation.matches(url, expectedState: oauthState)
    }

    @discardableResult
    mutating func finish(_ attemptID: UUID) -> Bool {
        guard isCurrent(attemptID) else { return false }
        id = nil
        deadline = nil
        oauthState = nil
        return true
    }
}

enum OAuthCallbackValidation {
    static func matches(_ url: URL, expectedState: String) -> Bool {
        guard !expectedState.isEmpty, url.path == "/auth/callback",
              let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems
        else { return false }
        let states = query.filter { $0.name == "state" }
        return states.count == 1 && states[0].value == expectedState
            && query.contains { ($0.name == "code" || $0.name == "error") && $0.value?.isEmpty == false }
    }
}
