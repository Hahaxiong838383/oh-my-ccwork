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
    let codexUsage: RuntimeUsage?
    let codexUsageStatus: String?
    let codexUsageError: String?
    let apiKeyBudgets: [APIKeyBudget]?
    let apiKeyBudgetStatus: String?
    let apiKeyBudgetError: String?
    let xaiUsage: XAIUsage?
    let xaiUsageStatus: String?
    let xaiUsageError: String?

    enum CodingKeys: String, CodingKey {
        case generatedAt = "generated_at"
        case accountsTotal = "accounts_total"
        case codexAccounts = "codex_accounts"
        case xaiAccounts = "xai_accounts"
        case k12Accounts = "k12_accounts"
        case refreshableAccounts = "refreshable_accounts"
        case expiredAccounts = "expired_accounts"
        case services
        case codexUsage = "codex_usage"
        case codexUsageStatus = "codex_usage_status"
        case codexUsageError = "codex_usage_error"
        case apiKeyBudgets = "api_key_budgets"
        case apiKeyBudgetStatus = "api_key_budget_status"
        case apiKeyBudgetError = "api_key_budget_error"
        case xaiUsage = "xai_usage"
        case xaiUsageStatus = "xai_usage_status"
        case xaiUsageError = "xai_usage_error"
    }
}

struct APIKeyBudget: Decodable, Equatable, Identifiable {
    let id: String
    let name: String
    let enabled: Bool
    let rpm: Int
    let modelCount: Int
    let dailyLimitUSD: Double
    let weeklyLimitUSD: Double
    let dailySpendUSD: Double?
    let weeklySpendUSD: Double?
    let dailyRemainingUSD: Double?
    let weeklyRemainingUSD: Double?
    let effectiveRemainingUSD: Double?
    let effectiveRemainingPercent: Double?
    let usageStatus: String
    let usageError: String?

    enum CodingKeys: String, CodingKey {
        case id, name, enabled, rpm
        case modelCount = "model_count"
        case dailyLimitUSD = "daily_limit_usd"
        case weeklyLimitUSD = "weekly_limit_usd"
        case dailySpendUSD = "daily_spend_usd"
        case weeklySpendUSD = "weekly_spend_usd"
        case dailyRemainingUSD = "daily_remaining_usd"
        case weeklyRemainingUSD = "weekly_remaining_usd"
        case effectiveRemainingUSD = "effective_remaining_usd"
        case effectiveRemainingPercent = "effective_remaining_percent"
        case usageStatus = "usage_status"
        case usageError = "usage_error"
    }
}

struct RuntimeUsage: Decodable, Equatable {
    let window: String
    let requests: Int64
    let successes: Int64
    let errors: Int64
    let inputTokens: Int64
    let outputTokens: Int64
    let reasoningTokens: Int64
    let cacheReadTokens: Int64
    let cacheCreationTokens: Int64
    let totalTokens: Int64
    let averageLatencyMS: Double
    let averageTTFTMS: Double
    let fastRequested: Int64
    let fastActual: Int64
    let usageSamples: Int64
    let topModel: String?
    let lastRequestAt: String?
    let lastErrorAt: String?
    let lastErrorStatus: Int?

    enum CodingKeys: String, CodingKey {
        case window, requests, successes, errors
        case inputTokens = "input_tokens"
        case outputTokens = "output_tokens"
        case reasoningTokens = "reasoning_tokens"
        case cacheReadTokens = "cache_read_tokens"
        case cacheCreationTokens = "cache_creation_tokens"
        case totalTokens = "total_tokens"
        case averageLatencyMS = "average_latency_ms"
        case averageTTFTMS = "average_ttft_ms"
        case fastRequested = "fast_requested"
        case fastActual = "fast_actual"
        case usageSamples = "usage_samples"
        case topModel = "top_model"
        case lastRequestAt = "last_request_at"
        case lastErrorAt = "last_error_at"
        case lastErrorStatus = "last_error_status"
    }

    var successPercent: Double? {
        guard requests > 0 else { return nil }
        return Double(successes) / Double(requests) * 100
    }

    var fastActualPercent: Double? {
        guard fastRequested > 0 else { return nil }
        return Double(fastActual) / Double(fastRequested) * 100
    }

    var usageCoveragePercent: Double? {
        guard requests > 0 else { return nil }
        return Double(usageSamples) / Double(requests) * 100
    }
}

struct XAIUsage: Decodable, Equatable {
    let officialStatus: String?
    let officialError: String?
    let officialPeriodStart: String?
    let officialPeriodEnd: String?
    let officialSpendUSD: Double?
    let prepaidBalanceUSD: Double?
    let hasPrepaidCredit: Bool?
    let officialLimitReached: Bool?
    let cpaStatus: String?
    let cpaError: String?
    let windowHours: Int
    let requests: Int64
    let successes: Int64
    let errors: Int64
    let inputTokens: Int64
    let outputTokens: Int64
    let totalTokens: Int64
    let todayTokens: Int64
    let dailyTokenLimit: Int64
    let lastRequestAt: String?

    enum CodingKeys: String, CodingKey {
        case requests, successes, errors
        case officialStatus = "official_status"
        case officialError = "official_error"
        case officialPeriodStart = "official_period_start"
        case officialPeriodEnd = "official_period_end"
        case officialSpendUSD = "official_spend_usd"
        case prepaidBalanceUSD = "prepaid_balance_usd"
        case hasPrepaidCredit = "has_prepaid_credit"
        case officialLimitReached = "official_limit_reached"
        case cpaStatus = "cpa_status"
        case cpaError = "cpa_error"
        case windowHours = "window_hours"
        case inputTokens = "input_tokens"
        case outputTokens = "output_tokens"
        case totalTokens = "total_tokens"
        case todayTokens = "today_tokens"
        case dailyTokenLimit = "daily_token_limit"
        case lastRequestAt = "last_request_at"
    }

    var successPercent: Double? {
        guard requests > 0 else { return nil }
        return Double(successes) / Double(requests) * 100
    }

    var todayBudgetUsedPercent: Double? {
        guard dailyTokenLimit > 0 else { return nil }
        return min(100, max(0, Double(todayTokens) / Double(dailyTokenLimit) * 100))
    }

    var todayBudgetRemainingTokens: Int64? {
        guard dailyTokenLimit > 0 else { return nil }
        return max(0, dailyTokenLimit - todayTokens)
    }

    var todayBudgetRemainingPercent: Double? {
        todayBudgetUsedPercent.map { max(0, 100 - $0) }
    }

    var hasOfficialBilling: Bool {
        (officialStatus == "ok" || officialStatus == "partial") && officialSpendUSD != nil
    }

    var hasCPARouterUsage: Bool {
        cpaStatus == nil || cpaStatus == "ok"
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
    let runtimeUsage: RuntimeUsage?
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
        case runtimeUsage = "runtime_usage"
        case subscriptionUntil = "subscription_until"
    }

    var usageSnapshot: UsageSnapshot {
        UsageParser.parse(usage)
    }
}

struct UsagePayload: Decodable {
    let planType: String?
    let rateLimit: RateLimit?
    let resetCredits: ResetCreditsInfo?
    let credits: CreditsInfo?

    enum CodingKeys: String, CodingKey {
        case planType = "plan_type"
        case rateLimit = "rate_limit"
        case resetCredits = "rate_limit_reset_credits"
        case credits
    }
}

struct ResetCreditsInfo: Decodable {
    let availableCount: Int
    let applicableAvailableCount: Int

    enum CodingKeys: String, CodingKey {
        case availableCount = "available_count"
        case applicableAvailableCount = "applicable_available_count"
    }
}

struct CreditsInfo: Decodable {
    let hasCredits: Bool
    let unlimited: Bool
    let overageLimitReached: Bool
    let balance: String?

    enum CodingKeys: String, CodingKey {
        case hasCredits = "has_credits"
        case unlimited
        case overageLimitReached = "overage_limit_reached"
        case balance
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

struct ResetCreditRequest: Encodable {
    let confirm = "CONSUME_RESET_CREDIT"
}

struct ResetCreditResponse: Decodable {
    let accountID: String
    let status: String

    enum CodingKeys: String, CodingKey {
        case accountID = "account_id"
        case status
    }
}

struct BridgeErrorResponse: Decodable {
    let error: String
}
