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

    private func decode(_ json: String) throws -> UsagePayload {
        try JSONDecoder().decode(UsagePayload.self, from: Data(json.utf8))
    }
}
