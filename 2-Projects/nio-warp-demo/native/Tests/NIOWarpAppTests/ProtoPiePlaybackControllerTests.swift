import Foundation
import XCTest
@testable import NIOWarpApp

@MainActor private final class PlaybackTestClock {
    var time = 0.0
    private var sleepers: [UUID: (Double, CheckedContinuation<Void, Error>)] = [:]
    func sleep(_ seconds: Double) async throws {
        let id = UUID(); let deadline = time + seconds
        try await withTaskCancellationHandler(operation: {
            try Task.checkCancellation()
            try await withCheckedThrowingContinuation { continuation in
                sleepers[id] = (deadline, continuation)
            }
        }, onCancel: { Task { @MainActor in self.cancel(id) } })
    }
    private func cancel(_ id: UUID) {
        sleepers.removeValue(forKey: id)?.1.resume(throwing: CancellationError())
    }
    func advance(_ seconds: Double) {
        time += seconds
        let ready = sleepers.filter { $0.value.0 <= time }
        for (id, value) in ready { sleepers.removeValue(forKey: id); value.1.resume() }
    }
    func cancelAll() {
        let pending = sleepers; sleepers = [:]
        for (_, value) in pending { value.1.resume(throwing: CancellationError()) }
    }
}

@MainActor final class ProtoPiePlaybackControllerTests: XCTestCase {
    private var domains = [String]()
    private var directories = [URL]()
    private var controllers = [ProtoPiePlaybackController]()
    private var clocks = [PlaybackTestClock]()

    override func tearDown() async throws {
        for controller in controllers { controller.shutdown(); await controller.log.flush() }
        for clock in clocks { clock.cancelAll() }
        for domain in domains { UserDefaults.standard.removePersistentDomain(forName: domain) }
        for directory in directories { try? FileManager.default.removeItem(at: directory) }
        controllers = []; clocks = []; domains = []; directories = []
        try await super.tearDown()
    }

    private func make(count: Int = 2, total: Double? = 120, retry: Int = 0) throws -> (ProtoPiePlaybackController, PlaybackTestClock) {
        let domain = "NIOWarp.Playback.Controller.\(UUID())"; domains.append(domain)
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(domain)
        directories.append(directory)
        let store = ProtoPiePlaybackStore(defaults: UserDefaults(suiteName: domain)!, legacy: ProtoPieConfiguration())
        var library = store.library
        library.items = (0..<count).map { index in
            var item = ProtoPiePlaylistItem(); item.name = "演示 \(index)"
            item.cloudURL = "https://cloud.protopie.io/p/test\(index)"; item.durationSeconds = 10
            return item
        }
        library.selectedItemID = library.items.first?.id
        library.plan.totalDurationSeconds = total; library.plan.retryLimit = retry
        try store.save(library)
        let clock = PlaybackTestClock(); clocks.append(clock)
        let controller = ProtoPiePlaybackController(store: store, log: ProtoPiePlaybackLog(directory: directory),
            now: { clock.time }, sleep: { try await clock.sleep($0) }, watchdogInterval: 0.1, releaseTimeout: 2)
        controller.prepare = { _, _ in }; controller.bindInput = {}; controller.performAction = { _ in }; controller.releaseInput = {}
        controllers.append(controller)
        return (controller, clock)
    }

    private func settle() async { for _ in 0..<100 { await Task.yield() } }
    private func step(_ clock: PlaybackTestClock, _ seconds: Double) async { clock.advance(seconds); await settle() }

    func testCreationAndSavingNeverLaunchPlayer() throws {
        let (controller, _) = try make(); var prepares = 0
        controller.prepare = { _, _ in prepares += 1 }
        var value = controller.library; value.items[0].name = "改名"
        try controller.saveLibrary(value); controller.select(value.items[1].id)
        XCTAssertEqual(prepares, 0); XCTAssertEqual(controller.runtime.state, .idle)
    }

    func testDwellStartsOnlyAfterReadyAndRunningUsesImmutableSnapshot() async throws {
        let (controller, clock) = try make(); var ready: CheckedContinuation<Void, Never>?
        var prepared = [String]()
        controller.prepare = { item, _ in
            prepared.append(item.name)
            if prepared.count == 1 { await withCheckedContinuation { ready = $0 } }
        }
        controller.start(); await settle(); await step(clock, 5)
        XCTAssertEqual(controller.runtime.remainingItemSeconds, 10)
        var edited = controller.library; edited.items[1].name = "未来新名"; try controller.saveLibrary(edited)
        ready?.resume(); await settle()
        XCTAssertEqual(controller.runtime.state, .running)
        await step(clock, 10)
        XCTAssertEqual(prepared, ["演示 0", "演示 1"])
        XCTAssertEqual(controller.runtime.remainingItemSeconds, 10)
    }

    func testPauseCancelsCandidateAndLateCallbackCannotRunScript() async throws {
        let (controller, _) = try make(); var ready: CheckedContinuation<Void, Never>?
        var actions = 0; var cancellations = 0
        var value = controller.library; value.items[0].script.enabled = true
        value.items[0].script.steps = [ProtoPieScriptStep()]; try controller.saveLibrary(value)
        controller.prepare = { _, _ in await withCheckedContinuation { ready = $0 } }
        controller.cancelPreparation = { cancellations += 1 }
        controller.performAction = { _ in actions += 1 }
        controller.start(); await settle(); controller.pause(); ready?.resume(); await settle()
        XCTAssertEqual(controller.runtime.state, .paused); XCTAssertEqual(actions, 0)
        XCTAssertGreaterThan(cancellations, 0)
    }

    func testNextWhilePausedDoesNotResumeOrStealInput() async throws {
        let (controller, _) = try make(); var prepares = 0
        controller.prepare = { _, _ in prepares += 1 }
        controller.start(); await settle(); controller.pause(); controller.next(); await settle()
        XCTAssertEqual(controller.runtime.itemID, controller.library.items[1].id)
        XCTAssertEqual(controller.runtime.state, .paused); XCTAssertEqual(prepares, 1)
    }

    func testTotalHardDeadlineIncludesPauseAndReleasesInput() async throws {
        let (controller, clock) = try make(total: 5); var releaseCount = 0; var returned = 0
        var value = controller.library; value.plan.endAction = .workbench; try controller.saveLibrary(value)
        controller.releaseInput = { releaseCount += 1 }; controller.stopPresentation = { returned += 1 }
        controller.start(); await settle(); controller.pause(); await settle()
        let before = releaseCount
        await step(clock, 6)
        XCTAssertEqual(controller.runtime.state, .completed); XCTAssertEqual(returned, 1)
        XCTAssertGreaterThan(releaseCount, before)
        controller.resume(); await settle(); XCTAssertEqual(controller.runtime.state, .completed)
    }

    func testHungPrepareStillObeysTotalDeadlineAndLateCompletionCannotResurrect() async throws {
        let (controller, clock) = try make(total: 3)
        var ready: CheckedContinuation<Void, Never>?
        controller.prepare = { _, _ in await withCheckedContinuation { ready = $0 } }
        controller.start(); await settle(); await step(clock, 4)
        XCTAssertEqual(controller.runtime.state, .failed)
        XCTAssertTrue(controller.runtime.notice.contains("没有任何预览来源就绪"))
        XCTAssertEqual(controller.log.entries.last(where: { $0.event == "run_ended" })?.details["reason"], "all_items_failed")
        ready?.resume(); await settle(); XCTAssertEqual(controller.runtime.state, .failed)
    }

    func testFailuresSkipBadItemAndExhaustionPausesWithoutLooping() async throws {
        let (controller, clock) = try make(retry: 1); var attempts = [UUID: Int]()
        controller.prepare = { item, _ in
            attempts[item.id, default: 0] += 1
            throw NSError(domain: "test", code: 1)
        }
        controller.start(); await settle(); await step(clock, 1); await step(clock, 1)
        XCTAssertEqual(controller.runtime.state, .paused)
        XCTAssertEqual(attempts.values.sorted(), [2, 2])
        await step(clock, 50)
        XCTAssertEqual(attempts.values.sorted(), [2, 2])
    }

    func testRetryBudgetSurvivesSuccessfulPreparationAndLaterInterruption() async throws {
        let (controller, clock) = try make(count: 1, retry: 1); var prepares = 0
        controller.prepare = { _, _ in prepares += 1 }
        controller.start(); await settle()
        controller.reportInterruption("first"); await settle(); await step(clock, 1)
        XCTAssertEqual(controller.runtime.state, .running)
        controller.reportInterruption("second"); await settle()
        XCTAssertEqual(controller.runtime.state, .paused); XCTAssertEqual(prepares, 2)
    }

    func testSingleStepAdvancesAndDoesNotExecuteInitializationImplicitly() async throws {
        let (controller, _) = try make(count: 1); var actions = [String]()
        var value = controller.library
        var first = ProtoPieScriptStep(); first.key = "Numpad2"; first.waitAfter = 0
        var second = ProtoPieScriptStep(); second.key = "Numpad0"; second.waitAfter = 0
        var initialization = ProtoPieScriptStep(); initialization.key = "Numpad9"; initialization.waitAfter = 0
        value.items[0].script.initialization = [initialization]; value.items[0].script.steps = [first, second]
        try controller.saveLibrary(value)
        controller.performAction = { actions.append($0.key) }
        controller.tryScript(singleStep: true); await settle()
        XCTAssertEqual(controller.runtime.state, .completed)
        controller.tryScript(singleStep: true); await settle()
        XCTAssertEqual(actions, ["Numpad2", "Numpad0"])
    }

    func testSingleTrialRunsInitializationAndOneLoopDespiteInfiniteScript() async throws {
        let (controller, _) = try make(count: 1); var actions = [String]()
        var value = controller.library
        var initialization = ProtoPieScriptStep(); initialization.key = "Numpad2"; initialization.waitAfter = 0
        var action = ProtoPieScriptStep(); action.key = "Numpad0"; action.waitAfter = 0; action.repeatCount = 2
        value.items[0].script.initialization = [initialization]; value.items[0].script.steps = [action]
        value.items[0].script.repeatCount = 0; try controller.saveLibrary(value)
        controller.performAction = { actions.append($0.key) }
        controller.tryScript(); await settle()
        XCTAssertEqual(actions, ["Numpad2", "Numpad0", "Numpad0"])
        XCTAssertEqual(controller.runtime.state, .completed)
    }

    func testStopDuringHeldActionReleasesAndLateActionCannotExecuteNextStep() async throws {
        let (controller, _) = try make(count: 1); var held: CheckedContinuation<Void, Never>?
        var actions = 0; var releases = 0
        var value = controller.library; value.items[0].script.enabled = true
        var one = ProtoPieScriptStep(); one.kind = .mouseHold; one.duration = 5; one.waitAfter = 0
        var two = ProtoPieScriptStep(); two.waitAfter = 0
        value.items[0].script.steps = [one, two]; try controller.saveLibrary(value)
        controller.performAction = { _ in actions += 1; await withCheckedContinuation { held = $0 } }
        controller.releaseInput = { releases += 1 }
        controller.start(); await settle(); let before = releases
        controller.stop(); await settle(); held?.resume(); await settle()
        XCTAssertEqual(actions, 1); XCTAssertGreaterThan(releases, before); XCTAssertEqual(controller.runtime.state, .idle)
    }

    func testReleaseTimeoutBlocksNewSourceInsteadOfLateReleaseStealingIt() async throws {
        let (controller, clock) = try make(); var release: CheckedContinuation<Void, Never>?
        var prepares = 0
        controller.releaseInput = { await withCheckedContinuation { release = $0 } }
        controller.prepare = { _, _ in prepares += 1 }
        controller.start(); await settle(); await step(clock, 3)
        XCTAssertEqual(controller.runtime.state, .paused); XCTAssertEqual(prepares, 0)
        controller.resume(); await settle()
        XCTAssertEqual(prepares, 0)
        release?.resume(); await settle(); controller.releaseInput = {}
    }

    func testPreviewDoesNotBindOrRunScriptsAndLeavesPreviewReady() async throws {
        let (controller, _) = try make(count: 1); var binds = 0; var actions = 0
        var value = controller.library; value.items[0].script.enabled = true
        value.items[0].script.steps = [ProtoPieScriptStep()]; try controller.saveLibrary(value)
        controller.bindInput = { binds += 1 }; controller.performAction = { _ in actions += 1 }
        controller.previewSelected(); await settle()
        XCTAssertEqual(controller.runtime.state, .completed); XCTAssertEqual(binds, 0); XCTAssertEqual(actions, 0)
    }

    func testStageTimeoutBoundsHungPrepareEvenWithoutTotalLimit() async throws {
        let (controller, clock) = try make(count: 1, total: nil)
        var ready: CheckedContinuation<Void, Never>?
        controller.prepare = { _, _ in await withCheckedContinuation { ready = $0 } }
        controller.start(); await settle(); await step(clock, 61)
        XCTAssertEqual(controller.runtime.state, .paused)
        ready?.resume(); await settle(); XCTAssertEqual(controller.runtime.state, .paused)
    }

    func testPauseResumeReinitializesFreshDocumentAndPreservesRemainingDwell() async throws {
        let (controller, clock) = try make(count: 1); var refreshes = [Bool](); var actions = [String]()
        var value = controller.library; value.items[0].script.enabled = true
        var initialization = ProtoPieScriptStep(); initialization.key = "Numpad2"; initialization.waitAfter = 0
        var action = ProtoPieScriptStep(); action.key = "Numpad0"; action.waitAfter = 0
        value.items[0].script.initialization = [initialization]; value.items[0].script.steps = [action]
        value.items[0].script.repeatCount = 1; try controller.saveLibrary(value)
        controller.prepare = { _, refresh in refreshes.append(refresh) }
        controller.performAction = { actions.append($0.key) }
        controller.start(); await settle(); await step(clock, 2)
        controller.pause(); await settle(); controller.resume(); await settle()
        XCTAssertEqual(refreshes, [false, true])
        XCTAssertEqual(actions, ["Numpad2", "Numpad0", "Numpad2", "Numpad0"])
        XCTAssertEqual(controller.runtime.remainingItemSeconds, 8)
    }

    func testTotalDeadlineWinsOverRecoveryBackoff() async throws {
        let (controller, clock) = try make(count: 1, total: 2, retry: 3); var attempts = 0
        controller.prepare = { _, _ in attempts += 1; throw NSError(domain: "test", code: 1) }
        controller.start(); await settle(); await step(clock, 3)
        XCTAssertEqual(controller.runtime.state, .failed); XCTAssertEqual(attempts, 1)
        XCTAssertEqual(controller.log.entries.last(where: { $0.event == "run_ended" })?.details["reason"], "all_items_failed")
    }

    func testReloadLoopRebindsAndReplaysInitialization() async throws {
        let (controller, clock) = try make(count: 1); var refreshes = [Bool](); var actions = [String](); var binds = 0
        var value = controller.library; value.items[0].script.enabled = true
        var initialization = ProtoPieScriptStep(); initialization.key = "Numpad2"; initialization.waitAfter = 0
        var action = ProtoPieScriptStep(); action.key = "Numpad0"; action.waitAfter = 0
        value.items[0].script.initialization = [initialization]; value.items[0].script.steps = [action]
        value.items[0].script.repeatCount = 2; value.items[0].script.reloadEachLoop = true
        value.items[0].script.loopInterval = 1; try controller.saveLibrary(value)
        controller.prepare = { _, refresh in refreshes.append(refresh) }
        controller.bindInput = { binds += 1 }; controller.performAction = { actions.append($0.key) }
        controller.start(); await settle(); await step(clock, 1)
        XCTAssertEqual(refreshes, [false, true]); XCTAssertEqual(binds, 2)
        XCTAssertEqual(actions, ["Numpad2", "Numpad0", "Numpad2", "Numpad0"])
        XCTAssertEqual(controller.runtime.state, .running)
    }

    func testFailureLogKeepsStableInputClassificationWithoutRawErrorText() async throws {
        let (controller, _) = try make(count: 1)
        var value = controller.library; value.items[0].script.enabled = true
        value.items[0].script.steps = [ProtoPieScriptStep()]; try controller.saveLibrary(value)
        controller.performAction = { _ in throw MouseInputTransportError.timeout }
        controller.start(); await settle()
        let failure = controller.log.entries.last(where: { $0.event == "item_failed" })
        XCTAssertEqual(failure?.details["errorKind"], "timeout")
        XCTAssertEqual(failure?.details["stage"], "script_action")
        XCTAssertEqual(controller.runtime.state, .paused)
    }

    func testDeadlineAfterOneReadyItemRemainsCompletedEvenIfNextSourceHangs() async throws {
        let (controller, clock) = try make(total: 5)
        var value = controller.library; value.items[0].durationSeconds = 1
        try controller.saveLibrary(value)
        var attempts = 0; var gate: CheckedContinuation<Void, Never>?
        controller.prepare = { _, _ in
            attempts += 1
            if attempts == 2 { await withCheckedContinuation { gate = $0 } }
        }
        controller.start(); await settle(); await step(clock, 1)
        XCTAssertEqual(attempts, 2); XCTAssertEqual(controller.runtime.state, .preparing)
        await step(clock, 5)
        XCTAssertEqual(controller.runtime.state, .completed)
        XCTAssertEqual(controller.log.entries.last(where: { $0.event == "run_ended" })?.details["reason"], "plan_complete")
        gate?.resume(); await settle(); XCTAssertEqual(controller.runtime.state, .completed)
    }

    func testReadyEvidenceDoesNotCarryOverFromEarlierPreviewOrPlan() async throws {
        let (controller, clock) = try make(count: 1, total: 3)
        controller.previewSelected(); await settle()
        XCTAssertEqual(controller.runtime.state, .completed)
        controller.prepare = { _, _ in throw ProtoPieError.unavailable("模拟无外屏") }
        controller.start(); await settle(); await step(clock, 4)
        XCTAssertEqual(controller.runtime.state, .failed)
        XCTAssertTrue(controller.runtime.notice.contains("没有任何预览来源就绪"))
        XCTAssertEqual(controller.log.entries.last(where: { $0.event == "run_ended" })?.details["reason"], "all_items_failed")
    }

}
