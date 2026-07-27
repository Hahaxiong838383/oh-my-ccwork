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

    private func decode(_ json: String) throws -> UsagePayload {
        try JSONDecoder().decode(UsagePayload.self, from: Data(json.utf8))
    }
}
