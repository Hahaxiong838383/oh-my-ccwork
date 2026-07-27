import Foundation

struct Summary: Decodable {
    let generatedAt: String
    let accountsTotal: Int
    let codexAccounts: Int
    let xaiAccounts: Int
    let k12Accounts: Int
    let refreshableAccounts: Int
    let expiredAccounts: Int
    let services: [String: Bool]

    enum CodingKeys: String, CodingKey {
        case generatedAt = "generated_at"
        case accountsTotal = "accounts_total"
        case codexAccounts = "codex_accounts"
        case xaiAccounts = "xai_accounts"
        case k12Accounts = "k12_accounts"
        case refreshableAccounts = "refreshable_accounts"
        case expiredAccounts = "expired_accounts"
        case services
    }
}

struct AccountsResponse: Decodable {
    let generatedAt: String
    let accounts: [Account]

    enum CodingKeys: String, CodingKey {
        case generatedAt = "generated_at"
        case accounts
    }
}

struct Account: Decodable, Identifiable {
    let id: String
    let provider: String
    let emailMasked: String
    let plan: String?
    let disabled: Bool
    let expiredAt: String?
    let lastRefreshAt: String?
    let hasRefreshToken: Bool
    let isK12: Bool
    let usage: UsagePayload?
    let usageStatus: String
    let usageError: String?
    let subscriptionUntil: String?

    enum CodingKeys: String, CodingKey {
        case id, provider, plan, disabled, usage
        case emailMasked = "email_masked"
        case expiredAt = "expired_at"
        case lastRefreshAt = "last_refresh_at"
        case hasRefreshToken = "has_refresh_token"
        case isK12 = "is_k12"
        case usageStatus = "usage_status"
        case usageError = "usage_error"
        case subscriptionUntil = "subscription_until"
    }

    var usageSnapshot: UsageSnapshot {
        UsageParser.parse(usage)
    }
}

struct UsagePayload: Decodable {
    let planType: String?
    let rateLimit: RateLimit?

    enum CodingKeys: String, CodingKey {
        case planType = "plan_type"
        case rateLimit = "rate_limit"
    }
}

struct RateLimit: Decodable {
    let primaryWindow: UsageWindow?
    let secondaryWindow: UsageWindow?

    enum CodingKeys: String, CodingKey {
        case primaryWindow = "primary_window"
        case secondaryWindow = "secondary_window"
    }
}

struct UsageWindow: Decodable, Equatable {
    let usedPercent: Double?
    let resetAfterSeconds: Double?
    let limitWindowSeconds: Double?
    let resetsAt: Double?

    enum CodingKeys: String, CodingKey {
        case usedPercent = "used_percent"
        case resetAfterSeconds = "reset_after_seconds"
        case limitWindowSeconds = "limit_window_seconds"
        case resetsAt = "resets_at"
    }

    var resetSeconds: TimeInterval? {
        if let resetAfterSeconds, resetAfterSeconds >= 0 {
            return resetAfterSeconds
        }
        if let resetsAt, resetsAt > 0 {
            return max(0, resetsAt - Date().timeIntervalSince1970)
        }
        return nil
    }
}

struct UsageSnapshot: Equatable {
    let planType: String?
    let primaryUsedPercent: Double?
    let primaryResetSeconds: TimeInterval?
    let weeklyUsedPercent: Double?
    let weeklyResetSeconds: TimeInterval?

    var primaryRemainingPercent: Double? {
        primaryUsedPercent.map { max(0, min(100, 100 - $0)) }
    }

    var weeklyRemainingPercent: Double? {
        weeklyUsedPercent.map { max(0, min(100, 100 - $0)) }
    }
}

struct OAuthStartResponse: Decodable {
    let state: String
    let url: URL
    let callbackURL: URL
    let expiresAt: String

    enum CodingKeys: String, CodingKey {
        case state, url
        case callbackURL = "callback_url"
        case expiresAt = "expires_at"
    }
}

struct OAuthCallbackRequest: Encodable {
    let redirectURL: String

    enum CodingKeys: String, CodingKey {
        case redirectURL = "redirect_url"
    }
}

struct OAuthStatusResponse: Decodable {
    let state: String
    let status: String
    let message: String?
    let accountMasked: String?

    enum CodingKeys: String, CodingKey {
        case state, status, message
        case accountMasked = "account_masked"
    }
}

struct BridgeErrorResponse: Decodable {
    let error: String
}
