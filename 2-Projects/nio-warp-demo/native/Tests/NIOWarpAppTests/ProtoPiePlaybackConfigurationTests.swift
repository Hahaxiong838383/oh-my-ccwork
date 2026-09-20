import Foundation
import XCTest
@testable import NIOWarpApp

final class ProtoPiePlaybackConfigurationTests: XCTestCase {
    private func validItem() -> ProtoPiePlaylistItem {
        var value = ProtoPiePlaylistItem()
        value.cloudURL = "https://cloud.protopie.io/p/example?token=private"
        return value
    }

    func testEachPlaylistSourceInheritsExistingPresentationWithoutChangingGeometryOrLegacy() throws {
        var legacy = ProtoPieConfiguration()
        legacy.source = .localFile; legacy.filePath = "/tmp/original.pie"; legacy.fileBookmark = Data([1, 2, 3])
        legacy.autoStart = true; legacy.autoRecover = false; legacy.scaleToFit = false; legacy.hidePlayerUI = false
        legacy.fillWidth = true; legacy.widthFitVerticalPosition = -0.88
        var item = validItem()
        let inherited = try item.configuration(inheriting: legacy)
        XCTAssertEqual(inherited.source, .cloud)
        XCTAssertEqual(inherited.cloudURL, item.cloudURL)
        XCTAssertEqual(inherited.fileBookmark, legacy.fileBookmark)
        XCTAssertEqual(inherited.filePath, legacy.filePath)
        XCTAssertEqual(inherited.autoStart, legacy.autoStart)
        XCTAssertEqual(inherited.autoRecover, legacy.autoRecover)
        XCTAssertEqual(inherited.scaleToFit, legacy.scaleToFit)
        XCTAssertEqual(inherited.hidePlayerUI, legacy.hidePlayerUI)
        XCTAssertEqual(inherited.fillWidth, true)
        XCTAssertEqual(inherited.widthFitVerticalPosition, -0.88)
        item.fillWidth = false; item.verticalPosition = 0.25
        let overridden = try item.configuration(inheriting: legacy)
        XCTAssertEqual(overridden.fillWidth, false)
        XCTAssertEqual(overridden.widthFitVerticalPosition, 0.25)
        XCTAssertEqual(legacy.source, .localFile)
        XCTAssertEqual(legacy.widthFitVerticalPosition, -0.88)
    }

    func testNamesAndIndependentScriptsSurviveRoundTrip() throws {
        var library = ProtoPiePlaybackLibrary()
        var first = validItem(); first.name = "泊车演示"; first.script.name = "泊车脚本"
        first.script.enabled = true
        first.script.initialization = [ProtoPieScriptStep()]
        var step = ProtoPieScriptStep(); step.key = "KeyA"
        first.script.steps = [step]
        var second = validItem(); second.name = "导航演示"; second.script.name = "导航脚本"
        second.script.repeatCount = 3
        library.items = [first, second]; library.selectedItemID = second.id
        try library.validate()
        let decoded = try JSONDecoder().decode(ProtoPiePlaybackLibrary.self, from: JSONEncoder().encode(library))
        XCTAssertEqual(decoded, library)
        XCTAssertNotEqual(decoded.items[0].script.name, decoded.items[1].script.name)
    }

    func testInvalidSourcesCannotRunAndOnlyDisabledEmptyEntriesCanBeDrafts() throws {
        var draft = ProtoPiePlaylistItem(); draft.enabled = false
        try draft.validate()
        XCTAssertThrowsError(try draft.configuration(inheriting: ProtoPieConfiguration()))
        draft.enabled = true
        XCTAssertThrowsError(try draft.validate())
        for source in ["http://cloud.protopie.io/p/a", "https://cloud.protopie.io.evil.test/p/a", "https://u:p@cloud.protopie.io/p/a", "file:///tmp/a"] {
            draft.cloudURL = source
            XCTAssertThrowsError(try draft.validate())
        }
    }

    func testNonFiniteAndOutOfRangeTimingCoordinatesAreRejected() {
        for value in [Double.nan, .infinity, -.infinity, -0.01, 1.01] {
            var step = ProtoPieScriptStep(); step.x = value
            XCTAssertThrowsError(try step.validate())
        }
        for value in [Double.nan, .infinity, -.infinity, -1, 0] {
            var item = validItem(); item.durationSeconds = value
            XCTAssertThrowsError(try item.validate())
            var plan = ProtoPiePlaybackPlan(); plan.totalDurationSeconds = value
            XCTAssertThrowsError(try plan.validate())
        }
        var step = ProtoPieScriptStep(); step.deltaY = .nan
        XCTAssertThrowsError(try step.validate())
        var script = ProtoPieAutomationScript(); script.loopInterval = 0
        XCTAssertThrowsError(try script.validate())
        var plan = ProtoPiePlaybackPlan(); plan.totalDurationSeconds = nil
        XCTAssertNoThrow(try plan.validate())
    }

    func testEscapeAndSystemShortcutsCannotBeInjectedByScripts() {
        for key in ["Escape", "Esc", "Cmd", "ControlLeft", "MetaLeft", "Cmd+Q", "Control+W", "2", "javascript:alert(1)"] {
            var step = ProtoPieScriptStep(); step.key = key
            XCTAssertThrowsError(try step.validate(), key)
        }
        for key in ["Numpad2", "Digit2", "KeyA", "ArrowLeft", "Space", "F12"] {
            var step = ProtoPieScriptStep(); step.key = key
            XCTAssertNoThrow(try step.validate(), key)
        }
    }

    func testInvalidSelectionAndDuplicateIdentifiersAreRejected() {
        let item = validItem()
        var library = ProtoPiePlaybackLibrary(); library.items = [item, item]
        XCTAssertThrowsError(try library.validate())
        library.items = [item]; library.selectedItemID = UUID()
        XCTAssertThrowsError(try library.validate())
        var script = ProtoPieAutomationScript(); let step = ProtoPieScriptStep()
        script.initialization = [step]; script.steps = [step]
        XCTAssertThrowsError(try script.validate())
    }
}

@MainActor final class ProtoPiePlaybackStoreTests: XCTestCase {
    private func withDefaults(_ body: (UserDefaults) throws -> Void) throws {
        let name = "NIOWarp.PlaybackTests." + UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        try body(defaults)
    }

    func testFirstMigrationCopiesURLOnceAndNeverWritesLegacyKey() throws {
        try withDefaults { defaults in
            var legacy = ProtoPieConfiguration(); legacy.cloudURL = "https://cloud.protopie.io/p/legacy?token=private"
            let original = try JSONEncoder().encode(legacy)
            defaults.set(original, forKey: "nioWarpProtoPie.configuration.v1")
            let store = ProtoPiePlaybackStore(defaults: defaults, legacy: legacy)
            XCTAssertEqual(store.library.items.count, 1)
            XCTAssertEqual(store.library.items[0].cloudURL, legacy.cloudURL)
            XCTAssertEqual(defaults.data(forKey: "nioWarpProtoPie.configuration.v1"), original)
            let initialID = store.library.items[0].id
            legacy.cloudURL = "https://cloud.protopie.io/p/new"
            let reopened = ProtoPiePlaybackStore(defaults: defaults, legacy: legacy)
            XCTAssertEqual(reopened.library.items.count, 1)
            XCTAssertEqual(reopened.library.items[0].id, initialID)
            XCTAssertEqual(reopened.library.items[0].cloudURL, "https://cloud.protopie.io/p/legacy?token=private")
        }
    }

    func testLocalLegacyAndEmptyLibraryStayIndependent() throws {
        try withDefaults { defaults in
            var legacy = ProtoPieConfiguration(); legacy.source = .localFile; legacy.filePath = "/tmp/example.pie"
            let store = ProtoPiePlaybackStore(defaults: defaults, legacy: legacy)
            XCTAssertTrue(store.library.items.isEmpty)
            XCTAssertNotNil(defaults.data(forKey: ProtoPiePlaybackStore.storageKey))
        }
    }

    func testInvalidSaveDoesNotReplaceLastValidLibrary() throws {
        try withDefaults { defaults in
            let store = ProtoPiePlaybackStore(defaults: defaults, legacy: ProtoPieConfiguration())
            let before = defaults.data(forKey: ProtoPiePlaybackStore.storageKey)
            var invalid = store.library; invalid.items = [ProtoPiePlaylistItem()]
            XCTAssertThrowsError(try store.save(invalid))
            XCTAssertEqual(defaults.data(forKey: ProtoPiePlaybackStore.storageKey), before)
            XCTAssertTrue(store.library.items.isEmpty)
        }
    }

    func testCorruptAndFutureLibraryRemainUntilExplicitSaveAndAreBackedUp() throws {
        for original in [Data("not json".utf8), Data(#"{"schemaVersion":99,"items":[],"plan":{"mode":"sequence","endAction":"keepPreview","retryLimit":3}}"#.utf8)] {
            try withDefaults { defaults in
                defaults.set(original, forKey: ProtoPiePlaybackStore.storageKey)
                let store = ProtoPiePlaybackStore(defaults: defaults, legacy: ProtoPieConfiguration())
                XCTAssertNotNil(store.warning)
                XCTAssertEqual(defaults.data(forKey: ProtoPiePlaybackStore.storageKey), original)
                try store.save(ProtoPiePlaybackLibrary())
                XCTAssertEqual(defaults.data(forKey: ProtoPiePlaybackStore.unreadableBackupKey), original)
                XCTAssertNotEqual(defaults.data(forKey: ProtoPiePlaybackStore.storageKey), original)
            }
        }
    }
}
