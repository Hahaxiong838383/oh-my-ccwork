import XCTest
@testable import CPAMenuBar

final class UsageParserTests: XCTestCase {
    func testDualWindows() throws {
        let payload = try decode(#"{"plan_type":"plus","rate_limit":{"primary_window":{"used_percent":42,"reset_after_seconds":3600,"limit_window_seconds":18000},"secondary_window":{"used_percent":10,"reset_after_seconds":86400,"limit_window_seconds":604800}}}"#)
        let snapshot = UsageParser.parse(payload)
        XCTAssertEqual(snapshot.primaryRemainingPercent, 58)
        XCTAssertEqual(snapshot.weeklyRemainingPercent, 90)
    }

    func testWeeklyWindowCanOccupyPrimarySlot() throws {
        let payload = try decode(#"{"rate_limit":{"primary_window":{"used_percent":39,"reset_after_seconds":474388,"limit_window_seconds":604800},"secondary_window":null}}"#)
        let snapshot = UsageParser.parse(payload)
        XCTAssertNil(snapshot.primaryRemainingPercent)
        XCTAssertEqual(snapshot.weeklyRemainingPercent, 61)
    }

    func testReversedWindowSlotsUseDuration() throws {
        let payload = try decode(#"{"rate_limit":{"primary_window":{"used_percent":25,"limit_window_seconds":604800},"secondary_window":{"used_percent":40,"limit_window_seconds":18000}}}"#)
        let snapshot = UsageParser.parse(payload)
        XCTAssertEqual(snapshot.primaryRemainingPercent, 60)
        XCTAssertEqual(snapshot.weeklyRemainingPercent, 75)
    }

    func testDecodesCreditsAndResetCards() throws {
        let payload = try decode(#"{"credits":{"has_credits":true,"unlimited":false,"overage_limit_reached":false,"balance":"12.50"},"rate_limit_reset_credits":{"available_count":3,"applicable_available_count":1}}"#)
        XCTAssertEqual(payload.credits?.balance, "12.50")
        XCTAssertEqual(payload.resetCredits?.availableCount, 3)
        XCTAssertEqual(payload.resetCredits?.applicableAvailableCount, 1)
    }

    func testDecodesXAIUsageAndCalculatesRates() throws {
        let usage = try JSONDecoder().decode(
            XAIUsage.self,
            from: Data(#"{"window_hours":24,"requests":23,"successes":22,"errors":1,"input_tokens":4522,"output_tokens":3529,"total_tokens":8051,"today_tokens":1421,"daily_token_limit":1000000,"last_request_at":"2026-07-27T13:20:53+08:00"}"#.utf8)
        )
        XCTAssertEqual(usage.totalTokens, 8051)
        XCTAssertEqual(usage.successPercent ?? 0, 95.652173913, accuracy: 0.000001)
        XCTAssertEqual(usage.todayBudgetUsedPercent ?? 0, 0.1421, accuracy: 0.000001)
        XCTAssertEqual(usage.todayBudgetRemainingTokens, 998579)
        XCTAssertEqual(usage.todayBudgetRemainingPercent ?? 0, 99.8579, accuracy: 0.000001)
    }

    func testDecodesOfficialXAIBilling() throws {
        let usage = try JSONDecoder().decode(
            XAIUsage.self,
            from: Data(#"{"official_status":"ok","official_period_start":"2026-07-01T00:00:00+08:00","official_period_end":"2026-07-27T22:00:00+08:00","official_spend_usd":0.75,"prepaid_balance_usd":12.34,"has_prepaid_credit":true,"official_limit_reached":false,"cpa_status":"ok","window_hours":24,"requests":4,"successes":4,"errors":0,"input_tokens":30,"output_tokens":10,"total_tokens":40,"today_tokens":40,"daily_token_limit":100}"#.utf8)
        )
        XCTAssertTrue(usage.hasOfficialBilling)
        XCTAssertTrue(usage.hasCPARouterUsage)
        XCTAssertEqual(usage.officialSpendUSD, 0.75)
        XCTAssertEqual(usage.prepaidBalanceUSD, 12.34)
        XCTAssertEqual(usage.hasPrepaidCredit, true)
        XCTAssertTrue(UsageFormatting.usd(usage.officialSpendUSD).hasSuffix("0.75"))
    }

    func testZeroXAIRequestsHasNoSuccessPercentage() throws {
        let usage = try JSONDecoder().decode(
            XAIUsage.self,
            from: Data(#"{"window_hours":24,"requests":0,"successes":0,"errors":0,"input_tokens":0,"output_tokens":0,"total_tokens":0,"today_tokens":0,"daily_token_limit":0}"#.utf8)
        )
        XCTAssertNil(usage.successPercent)
        XCTAssertNil(usage.todayBudgetUsedPercent)
        XCTAssertNil(usage.todayBudgetRemainingTokens)
        XCTAssertNil(usage.todayBudgetRemainingPercent)
    }

    func testDecodesRuntimeUsageAndCalculatesFastHitRate() throws {
        let usage = try JSONDecoder().decode(
            RuntimeUsage.self,
            from: Data(#"{"window":"today","requests":12,"successes":11,"errors":1,"input_tokens":1000,"output_tokens":500,"reasoning_tokens":200,"cache_read_tokens":300,"cache_creation_tokens":100,"total_tokens":1500,"average_latency_ms":1250,"average_ttft_ms":420,"fast_requested":10,"fast_actual":4,"usage_samples":9,"top_model":"gpt-5.5","last_request_at":"2026-08-04T12:00:00Z","last_error_at":"2026-08-04T11:00:00Z","last_error_status":429}"#.utf8)
        )
        XCTAssertEqual(usage.successPercent ?? 0, 91.666666667, accuracy: 0.000001)
        XCTAssertEqual(usage.fastActualPercent, 40)
        XCTAssertEqual(usage.usageCoveragePercent, 75)
        XCTAssertEqual(usage.topModel, "gpt-5.5")
        XCTAssertEqual(UsageFormatting.compactInteger(1_500), "1.5K")
        XCTAssertEqual(UsageFormatting.milliseconds(1_250), "1.25秒")
    }

    func testDecodesXAIAccountRuntimeUsage() throws {
        let account = try JSONDecoder().decode(
            Account.self,
            from: Data(#"{"id":"xai-account","provider":"xai","email_masked":"xa***@example.com","disabled":false,"has_refresh_token":true,"is_k12":false,"usage_status":"not_applicable","runtime_usage":{"window":"today","requests":3,"successes":3,"errors":0,"input_tokens":200,"output_tokens":85,"reasoning_tokens":0,"cache_read_tokens":0,"cache_creation_tokens":0,"total_tokens":285,"average_latency_ms":700,"average_ttft_ms":0,"fast_requested":0,"fast_actual":0,"usage_samples":3,"top_model":"grok-4.3","last_request_at":"2026-08-08T13:47:20Z"}}"#.utf8)
        )
        XCTAssertEqual(account.provider, "xai")
        XCTAssertTrue(account.hasRefreshToken)
        XCTAssertEqual(account.runtimeUsage?.requests, 3)
        XCTAssertEqual(account.runtimeUsage?.totalTokens, 285)
        XCTAssertEqual(account.runtimeUsage?.topModel, "grok-4.3")
    }

    func testDecodesAPIKeyRemainingBudget() throws {
        let budget = try JSONDecoder().decode(
            APIKeyBudget.self,
            from: Data(#"{"id":"temporary-key","name":"Temporary USD 20","enabled":true,"rpm":30,"model_count":4,"daily_limit_usd":20,"weekly_limit_usd":20,"daily_spend_usd":0.25,"weekly_spend_usd":1.5,"daily_remaining_usd":19.75,"weekly_remaining_usd":18.5,"effective_remaining_usd":18.5,"effective_remaining_percent":92.5,"usage_status":"ok"}"#.utf8)
        )
        XCTAssertEqual(budget.effectiveRemainingUSD, 18.5)
        XCTAssertEqual(budget.effectiveRemainingPercent, 92.5)
        XCTAssertEqual(budget.modelCount, 4)
        XCTAssertEqual(UsageFormatting.compactUSD(budget.effectiveRemainingUSD), "$18.50")
        XCTAssertEqual(UsageFormatting.usdOrUnlimited(nil, limit: 0), "不限额")
    }

    private func decode(_ json: String) throws -> UsagePayload {
        try JSONDecoder().decode(UsagePayload.self, from: Data(json.utf8))
    }
}
