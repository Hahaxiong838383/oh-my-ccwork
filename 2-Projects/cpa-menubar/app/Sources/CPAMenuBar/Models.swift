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
    let routeUpstreamModels: [String]?
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
        case routeUpstreamModels = "route_upstream_models"
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

    var routeModelText: String? {
        guard hasCPARouterUsage else { return nil }
        let models = Set((routeUpstreamModels ?? []).map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty })
        return models.isEmpty ? nil : models.sorted().joined(separator: " / ")
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
    let xaiQuota: XAIAccountQuota?
    let subscriptionUntil: String?
    let removalEligible: Bool
    let removalReason: String?

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
        case xaiQuota = "xai_quota"
        case subscriptionUntil = "subscription_until"
        case removalEligible = "removal_eligible"
        case removalReason = "removal_reason"
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        provider = try container.decode(String.self, forKey: .provider)
        emailMasked = try container.decode(String.self, forKey: .emailMasked)
        plan = try container.decodeIfPresent(String.self, forKey: .plan)
        disabled = try container.decode(Bool.self, forKey: .disabled)
        expiredAt = try container.decodeIfPresent(String.self, forKey: .expiredAt)
        lastRefreshAt = try container.decodeIfPresent(String.self, forKey: .lastRefreshAt)
        hasRefreshToken = try container.decode(Bool.self, forKey: .hasRefreshToken)
        isK12 = try container.decode(Bool.self, forKey: .isK12)
        usage = try container.decodeIfPresent(UsagePayload.self, forKey: .usage)
        usageStatus = try container.decode(String.self, forKey: .usageStatus)
        usageError = try container.decodeIfPresent(String.self, forKey: .usageError)
        runtimeUsage = try container.decodeIfPresent(RuntimeUsage.self, forKey: .runtimeUsage)
        xaiQuota = try container.decodeIfPresent(XAIAccountQuota.self, forKey: .xaiQuota)
        subscriptionUntil = try container.decodeIfPresent(String.self, forKey: .subscriptionUntil)
        removalEligible = try container.decodeIfPresent(Bool.self, forKey: .removalEligible) ?? false
        removalReason = try container.decodeIfPresent(String.self, forKey: .removalReason)
    }

    var usageSnapshot: UsageSnapshot {
        UsageParser.parse(usage)
    }
}

struct XAIAccountQuota: Decodable, Equatable {
    let status: String
    let error: String?
    let source: String?
    let periodType: String?
    let usedPercent: Double?
    let remainingPercent: Double?
    let usageInferred: Bool
    let periodStart: String?
    let periodEnd: String?
    let productUsage: [XAIProductQuota]
    let onDemandCapUSD: Double?
    let onDemandUsedUSD: Double?
    let prepaidBalanceUSD: Double?
    let unifiedBilling: Bool?
    let updatedAt: String?

    enum CodingKeys: String, CodingKey {
        case status, error, source
        case periodType = "period_type"
        case usedPercent = "used_percent"
        case remainingPercent = "remaining_percent"
        case usageInferred = "usage_inferred"
        case periodStart = "period_start"
        case periodEnd = "period_end"
        case productUsage = "product_usage"
        case onDemandCapUSD = "on_demand_cap_usd"
        case onDemandUsedUSD = "on_demand_used_usd"
        case prepaidBalanceUSD = "prepaid_balance_usd"
        case unifiedBilling = "unified_billing"
        case updatedAt = "updated_at"
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        status = try container.decode(String.self, forKey: .status)
        error = try container.decodeIfPresent(String.self, forKey: .error)
        source = try container.decodeIfPresent(String.self, forKey: .source)
        periodType = try container.decodeIfPresent(String.self, forKey: .periodType)
        usedPercent = try container.decodeIfPresent(Double.self, forKey: .usedPercent)
        remainingPercent = try container.decodeIfPresent(Double.self, forKey: .remainingPercent)
        usageInferred = try container.decodeIfPresent(Bool.self, forKey: .usageInferred) ?? false
        periodStart = try container.decodeIfPresent(String.self, forKey: .periodStart)
        periodEnd = try container.decodeIfPresent(String.self, forKey: .periodEnd)
        productUsage = try container.decodeIfPresent([XAIProductQuota].self, forKey: .productUsage) ?? []
        onDemandCapUSD = try container.decodeIfPresent(Double.self, forKey: .onDemandCapUSD)
        onDemandUsedUSD = try container.decodeIfPresent(Double.self, forKey: .onDemandUsedUSD)
        prepaidBalanceUSD = try container.decodeIfPresent(Double.self, forKey: .prepaidBalanceUSD)
        unifiedBilling = try container.decodeIfPresent(Bool.self, forKey: .unifiedBilling)
        updatedAt = try container.decodeIfPresent(String.self, forKey: .updatedAt)
    }
}

struct XAIProductQuota: Decodable, Equatable, Identifiable {
    let product: String
    let usedPercent: Double?

    var id: String { product }

    enum CodingKeys: String, CodingKey {
        case product
        case usedPercent = "used_percent"
    }
}

struct XAIQuotaPool: Equatable {
    let totalAccounts: Int
    let measuredAccounts: Int
    let inferredAccounts: Int
    let averageRemainingPercent: Double?
    let minimumRemainingPercent: Double?
    let earliestResetAt: String?

    init(accounts: [Account]) {
        let xaiAccounts = accounts.filter { $0.provider.lowercased() == "xai" }
        let quotas = xaiAccounts.compactMap { account -> XAIAccountQuota? in
            guard let quota = account.xaiQuota,
                  quota.status == "ok",
                  quota.remainingPercent != nil
            else { return nil }
            return quota
        }
        let remaining = quotas.compactMap(\.remainingPercent)

        totalAccounts = xaiAccounts.count
        measuredAccounts = remaining.count
        inferredAccounts = quotas.filter(\.usageInferred).count
        averageRemainingPercent = remaining.isEmpty
            ? nil
            : remaining.reduce(0, +) / Double(remaining.count)
        minimumRemainingPercent = remaining.min()
        earliestResetAt = quotas
            .compactMap(\.periodEnd)
            .compactMap { value in ISO8601Parsing.date(value).map { ($0, value) } }
            .min { $0.0 < $1.0 }?
            .1
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

    enum CodingKeys: String, CodingKey {
        case availableCount = "available_count"
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

struct XAIOAuthStartResponse: Decodable, Equatable {
    let state: String
    let verificationURL: URL
    let userCode: String
    let expiresIn: Int
    let status: String

    enum CodingKeys: String, CodingKey {
        case state, status
        case verificationURL = "verification_url"
        case userCode = "user_code"
        case expiresIn = "expires_in"
    }
}

struct XAIOAuthStatusResponse: Decodable, Equatable {
    let state: String
    let status: String
    let message: String?
    let accountMasked: String?

    enum CodingKeys: String, CodingKey {
        case state, status, message
        case accountMasked = "account_masked"
    }
}

enum XAIOAuthStatus: String, Equatable {
    case pending
    case complete
    case declined
    case expired
    case error

    var isTerminal: Bool { self != .pending }
}

struct XAIOAuthSession: Equatable {
    let state: String
    let verificationURL: URL
    let userCode: String
    let startedAt: Date
    let expiresAt: Date
    var status: XAIOAuthStatus
    var message: String?

    func remainingSeconds(at date: Date = Date()) -> Int {
        max(0, Int(ceil(expiresAt.timeIntervalSince(date))))
    }
}

enum XAIOAuthValidation {
    static func isAllowedVerificationURL(_ url: URL) -> Bool {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return false }
        return components.scheme?.lowercased() == "https"
            && components.host?.lowercased() == "accounts.x.ai"
            && components.user == nil
            && components.password == nil
            && components.port == nil
    }
}

struct ResetCreditRequest: Encodable {
    let confirm = "CONSUME_RESET_CREDIT"
}

struct ResetCreditResponse: Decodable {
    let accountID: String
    let status: String
    let windowsReset: Int?

    enum CodingKeys: String, CodingKey {
        case accountID = "account_id"
        case status
        case windowsReset = "windows_reset"
    }
}

struct RemoveAccountRequest: Encodable {
    let confirm = "REMOVE_INVALID_ACCOUNT"
}

struct RemoveAccountResponse: Decodable {
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
