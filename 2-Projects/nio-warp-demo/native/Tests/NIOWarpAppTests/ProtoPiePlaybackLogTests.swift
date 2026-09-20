import Foundation
import XCTest
@testable import NIOWarpApp

@MainActor final class ProtoPiePlaybackLogTests: XCTestCase {
    private func temporaryDirectory() throws -> URL {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("NIOWarp.PlaybackLogTests." + UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }

    private func logText(_ directory: URL) throws -> String {
        try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "jsonl" }.map { try String(contentsOf: $0, encoding: .utf8) }.joined(separator: "\n")
    }

    func testPrivateShareURLsKeyContentAndRawErrorsNeverReachLog() async throws {
        let directory = try temporaryDirectory(); defer { try? FileManager.default.removeItem(at: directory) }
        let log = ProtoPiePlaybackLog(directory: directory)
        log.record("script_step", details: ["key": "Numpad2", "url": "https://cloud.protopie.io/p/secret?token=private",
            "reason": "https://cloud.protopie.io/p/secret", "errorKind": "Numpad2", "name": "Private prototype",
            "attempt": "2", "connected": "true", "elapsedSeconds": "1.25", "memoryMB": "nan", "kind": "keyPress"])
        await log.flush()
        let text = try logText(directory)
        for secret in ["Numpad2", "https:", "private", "Private prototype", "secret", "nan"] { XCTAssertFalse(text.contains(secret), secret) }
        XCTAssertTrue(text.contains("keyPress"))
        XCTAssertTrue(text.contains("1.25"))
        XCTAssertEqual(log.entries.last?.details["reason"], "other")
    }

    func testUnclosedRunIsRecordedOnceWithoutAutomaticallyResumingIt() async throws {
        let directory = try temporaryDirectory(); defer { try? FileManager.default.removeItem(at: directory) }
        let first = ProtoPiePlaybackLog(directory: directory); let id = UUID()
        first.beginRun(id); await first.flush()
        let second = ProtoPiePlaybackLog(directory: directory); await second.flush()
        XCTAssertTrue(try logText(directory).contains("previous_run_unclosed"))
        XCTAssertFalse(FileManager.default.fileExists(atPath: directory.appendingPathComponent("active-run.json").path))
        let third = ProtoPiePlaybackLog(directory: directory); await third.flush()
        XCTAssertEqual(try logText(directory).components(separatedBy: "previous_run_unclosed").count - 1, 1)
    }

    func testLateEndCannotClearNewerRunAndCleanEndDoesNotReportCrash() async throws {
        let directory = try temporaryDirectory(); defer { try? FileManager.default.removeItem(at: directory) }
        let log = ProtoPiePlaybackLog(directory: directory); let old = UUID(); let current = UUID()
        log.beginRun(old); log.beginRun(current); log.endRun(old, reason: "cancelled")
        await log.flush()
        let marker = directory.appendingPathComponent("active-run.json")
        let data = try Data(contentsOf: marker)
        XCTAssertTrue(String(decoding: data, as: UTF8.self).contains(current.uuidString))
        log.endRun(current, reason: "user_stop"); await log.flush()
        let reopened = ProtoPiePlaybackLog(directory: directory); await reopened.flush()
        XCTAssertFalse(try logText(directory).contains("previous_run_unclosed"))
    }

    func testRotationBoundsDiskAndMemoryWithoutDeletingUnrelatedFiles() async throws {
        let directory = try temporaryDirectory(); defer { try? FileManager.default.removeItem(at: directory) }
        let unrelated = directory.appendingPathComponent("operator-notes.txt")
        try Data("keep".utf8).write(to: unrelated)
        var policy = ProtoPiePlaybackLog.Policy(); policy.maximumBytes = 4096; policy.maximumFileBytes = 1024
        let log = ProtoPiePlaybackLog(directory: directory, policy: policy)
        for i in 0..<250 { log.record("health", details: ["count": String(i)]); if i % 20 == 0 { await log.flush() } }
        await log.flush()
        let files = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.fileSizeKey])
            .filter { $0.pathExtension == "jsonl" }
        let size = try files.reduce(0) { try $0 + ($1.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0) }
        XCTAssertLessThanOrEqual(size, 4096)
        XCTAssertLessThanOrEqual(log.entries.count, 200)
        XCTAssertTrue(FileManager.default.fileExists(atPath: unrelated.path))
        XCTAssertTrue(try logText(directory).contains("249"))
    }

    func testExpiredLogRemovedButRecentLogSurvives() async throws {
        let directory = try temporaryDirectory(); defer { try? FileManager.default.removeItem(at: directory) }
        let expired = directory.appendingPathComponent("playback-20000101-old.jsonl")
        try Data("{}\n".utf8).write(to: expired)
        try FileManager.default.setAttributes([.modificationDate: Date(timeIntervalSinceNow: -8 * 24 * 60 * 60)], ofItemAtPath: expired.path)
        let log = ProtoPiePlaybackLog(directory: directory)
        log.record("health"); await log.flush()
        XCTAssertFalse(FileManager.default.fileExists(atPath: expired.path))
        XCTAssertTrue(try logText(directory).contains("health"))
    }

    func testZIPExportContainsLogsAndDoesNotExportLibrary() async throws {
        let directory = try temporaryDirectory(); defer { try? FileManager.default.removeItem(at: directory) }
        let logDirectory = directory.appendingPathComponent("logs")
        let log = ProtoPiePlaybackLog(directory: logDirectory)
        log.record("health", details: ["count": "3", "url": "https://cloud.protopie.io/p/private"])
        let destination = directory.appendingPathComponent("diagnostics.zip")
        try await log.export(to: destination)
        let bytes = try Data(contentsOf: destination)
        XCTAssertEqual(Array(bytes.prefix(2)), [0x50, 0x4b])
        XCTAssertFalse(FileManager.default.fileExists(atPath: logDirectory.appendingPathComponent("configuration.json").path))
        XCTAssertTrue(try logText(logDirectory).contains("health"))
    }

    func testInvalidDirectoryFailsWithoutBlockingRecentDiagnostics() async throws {
        let directory = try temporaryDirectory(); defer { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appendingPathComponent("not-a-directory")
        try Data("data".utf8).write(to: file)
        let log = ProtoPiePlaybackLog(directory: file)
        log.record("run_started"); await log.flush()
        for _ in 0..<10 { await Task.yield() }
        XCTAssertEqual(log.entries.last?.event, "run_started")
        XCTAssertNotNil(log.warning)
    }
}
