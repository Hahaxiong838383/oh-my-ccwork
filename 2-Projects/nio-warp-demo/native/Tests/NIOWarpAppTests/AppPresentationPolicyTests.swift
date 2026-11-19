import AppKit
import XCTest
@testable import NIOWarpApp

final class AppPresentationPolicyTests: XCTestCase {
    func testAccessoryPolicyDoesNotSetOrRecordAgain() {
        var reads = 0
        var writes = 0
        var records = 0
        let succeeded = AppPresentationPolicy.reconcile(
            readPolicy: { reads += 1; return .accessory },
            setPolicy: { _ in writes += 1; return true },
            recordAttempt: { _ in records += 1 }
        )
        XCTAssertTrue(succeeded)
        XCTAssertEqual(reads, 1)
        XCTAssertEqual(writes, 0)
        XCTAssertEqual(records, 0)
    }

    func testRegularAndProhibitedPoliciesRecoverAndThenRemainIdempotent() {
        for initial in [NSApplication.ActivationPolicy.regular, .prohibited] {
            var current = initial
            var writes = [NSApplication.ActivationPolicy]()
            var attempts = [AppPresentationPolicy.Attempt]()
            for _ in 0..<3 {
                XCTAssertTrue(AppPresentationPolicy.reconcile(
                    readPolicy: { current },
                    setPolicy: { writes.append($0); current = $0; return true },
                    recordAttempt: { attempts.append($0) }
                ))
            }
            XCTAssertEqual(writes, [.accessory])
            XCTAssertEqual(attempts.count, 1)
            XCTAssertEqual(attempts.first?.previous, initial)
            XCTAssertEqual(attempts.first?.observed, .accessory)
            XCTAssertEqual(attempts.first?.succeeded, true)
        }
    }

    func testRejectedRequestReportsFailure() {
        var attempts = [AppPresentationPolicy.Attempt]()
        XCTAssertFalse(AppPresentationPolicy.reconcile(
            readPolicy: { .regular }, setPolicy: { _ in false },
            recordAttempt: { attempts.append($0) }
        ))
        XCTAssertEqual(attempts.count, 1)
        XCTAssertEqual(attempts.first?.setterAccepted, false)
        XCTAssertEqual(attempts.first?.observed, .regular)
        XCTAssertEqual(attempts.first?.succeeded, false)
    }

    func testAcceptedRequestWithoutEffectivePolicyChangeReportsFailure() {
        var attempts = [AppPresentationPolicy.Attempt]()
        XCTAssertFalse(AppPresentationPolicy.reconcile(
            readPolicy: { .regular }, setPolicy: { _ in true },
            recordAttempt: { attempts.append($0) }
        ))
        XCTAssertEqual(attempts.first?.setterAccepted, true)
        XCTAssertEqual(attempts.first?.observed, .regular)
        XCTAssertEqual(attempts.first?.succeeded, false)
    }

    func testRejectedRequestIsNotReportedAsSuccessfulEvenIfPolicyChanged() {
        var current = NSApplication.ActivationPolicy.regular
        XCTAssertFalse(AppPresentationPolicy.reconcile(
            readPolicy: { current }, setPolicy: { current = $0; return false },
            recordAttempt: { XCTAssertFalse($0.succeeded) }
        ))
    }

    func testFailedAttemptCanRecoverOnNextPresentation() {
        var current = NSApplication.ActivationPolicy.regular
        var attempts = [AppPresentationPolicy.Attempt]()
        XCTAssertFalse(AppPresentationPolicy.reconcile(
            readPolicy: { current }, setPolicy: { _ in false },
            recordAttempt: { attempts.append($0) }
        ))
        XCTAssertTrue(AppPresentationPolicy.reconcile(
            readPolicy: { current }, setPolicy: { current = $0; return true },
            recordAttempt: { attempts.append($0) }
        ))
        XCTAssertEqual(attempts.map(\.succeeded), [false, true])
    }

    func testDiagnosticHistoryIsBoundedAndContainsOnlyPolicyEvidence() throws {
        let suite = "NIOWarpTests.AppPresentationPolicy.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let count = AppPresentationPolicy.maximumDiagnosticRecords + 3
        for index in 0..<count {
            let accepted = index.isMultiple(of: 2)
            AppPresentationPolicy.record(
                .init(previous: .regular, observed: accepted ? .accessory : .regular, setterAccepted: accepted),
                reason: .applicationActivation, defaults: defaults, now: Date(timeIntervalSince1970: Double(index))
            )
        }
        let data = try XCTUnwrap(defaults.data(forKey: AppPresentationPolicy.diagnosticsKey))
        let value = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let recent = try XCTUnwrap(value["recent"] as? [[String: Any]])
        let current = try XCTUnwrap(value["current"] as? [String: Any])
        XCTAssertEqual(recent.count, AppPresentationPolicy.maximumDiagnosticRecords)
        XCTAssertEqual(recent.first?["timestamp"] as? Double, 3)
        XCTAssertEqual(current["timestamp"] as? Double, Double(count - 1))
        XCTAssertEqual(current["succeeded"] as? Bool, true)
        XCTAssertEqual(current["reason"] as? String, "applicationActivation")
        let fields: Set<String> = ["timestamp", "reason", "previousPolicy", "requestedPolicy", "observedPolicy", "setterAccepted", "succeeded"]
        XCTAssertTrue(recent.allSatisfy { Set($0.keys) == fields })
    }

    func testMalformedDiagnosticHistoryDoesNotPreventNewEvidence() throws {
        let suite = "NIOWarpTests.AppPresentationPolicy.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        defaults.set(Data("broken".utf8), forKey: AppPresentationPolicy.diagnosticsKey)
        AppPresentationPolicy.record(.init(previous: .regular, observed: .regular, setterAccepted: false),
                                     reason: .startup, defaults: defaults)
        let data = try XCTUnwrap(defaults.data(forKey: AppPresentationPolicy.diagnosticsKey))
        let value = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let recent = try XCTUnwrap(value["recent"] as? [[String: Any]])
        XCTAssertEqual(recent.count, 1)
        XCTAssertEqual(recent.first?["succeeded"] as? Bool, false)
    }
}
