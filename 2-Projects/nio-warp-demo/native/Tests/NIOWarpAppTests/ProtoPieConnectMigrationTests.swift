import Foundation
import XCTest
@testable import NIOWarpApp

final class ProtoPieConnectConfigurationMigrationTests: XCTestCase {
    func testV1ConfigurationWithoutConnectFieldDecodesAsItsOriginalSource() throws {
        for source in ["cloud", "localFile"] {
            let data = Data("{\"source\":\"\(source)\",\"cloudURL\":\"https://cloud.protopie.io/p/original\",\"filePath\":\"/tmp/original.pie\",\"autoStart\":true,\"autoRecover\":false,\"scaleToFit\":false,\"hidePlayerUI\":false}".utf8)
            let configuration = try JSONDecoder().decode(ProtoPieConfiguration.self, from: data)
            XCTAssertEqual(configuration.source.rawValue, source)
            XCTAssertEqual(configuration.connectURL, "")
            XCTAssertEqual(configuration.filePath, "/tmp/original.pie")
            XCTAssertTrue(configuration.autoStart)
            XCTAssertFalse(configuration.autoRecover)
        }
    }

    func testConnectConfigurationRoundTripKeepsIndependentLinksAndPresentation() throws {
        var configuration = ProtoPieConfiguration(); configuration.source = .connect
        configuration.connectURL = "http://localhost:9981/pie?pieid=7&name=Demo"
        configuration.cloudURL = "https://cloud.protopie.io/p/old"
        configuration.filePath = "/tmp/old.pie"; configuration.fillWidth = true
        configuration.widthFitVerticalPosition = -0.375
        XCTAssertEqual(try JSONDecoder().decode(ProtoPieConfiguration.self, from: JSONEncoder().encode(configuration)), configuration)
    }

    func testPlaylistWithoutSourceIsCloudAndConnectPreservesCloudGeometryWithNativeFit() throws {
        var old = ProtoPiePlaylistItem(); old.cloudURL = "https://cloud.protopie.io/p/old"
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(old)) as? [String: Any])
        var legacyObject = object; legacyObject.removeValue(forKey: "source")
        let decoded = try JSONDecoder().decode(ProtoPiePlaylistItem.self, from: JSONSerialization.data(withJSONObject: legacyObject))
        XCTAssertEqual(decoded.source, .cloud)
        var item = decoded; item.source = .connect; item.cloudURL = " http://localhost:9981/pie?pieid=7 "
        item.fillWidth = true; item.verticalPosition = 0.5
        var previous = ProtoPieConfiguration(); previous.cloudURL = old.cloudURL; previous.filePath = "/tmp/old.pie"
        previous.fileBookmark = Data([1, 2]); previous.autoRecover = false; previous.scaleToFit = false
        let result = try item.configuration(inheriting: previous)
        XCTAssertEqual(result.source, .connect)
        XCTAssertEqual(result.connectURL, "http://localhost:9981/pie?pieid=7")
        XCTAssertEqual(result.cloudURL, previous.cloudURL)
        XCTAssertEqual(result.fileBookmark, previous.fileBookmark)
        XCTAssertEqual(result.filePath, previous.filePath)
        XCTAssertFalse(result.autoRecover); XCTAssertTrue(result.scaleToFit)
        XCTAssertEqual(result.fillWidth, previous.fillWidth)
        XCTAssertEqual(result.widthFitVerticalPosition, previous.widthFitVerticalPosition)
        let persistedItem = try JSONDecoder().decode(ProtoPiePlaylistItem.self, from: JSONEncoder().encode(item))
        XCTAssertEqual(persistedItem.fillWidth, true)
        XCTAssertEqual(persistedItem.verticalPosition, 0.5)
        XCTAssertTrue(persistedItem.connectScaleToFit)
        item = persistedItem; item.source = .cloud; item.cloudURL = old.cloudURL
        let cloudResult = try item.configuration(inheriting: previous)
        XCTAssertEqual(cloudResult.source, .cloud)
        XCTAssertEqual(cloudResult.scaleToFit, previous.scaleToFit)
        XCTAssertTrue(cloudResult.fillWidth)
        XCTAssertEqual(cloudResult.widthFitVerticalPosition, 0.5)
        item.source = .localFile; item.enabled = false; item.cloudURL = ""
        XCTAssertThrowsError(try item.validate())
    }
}

@MainActor final class ProtoPieConnectPlaybackMigrationTests: XCTestCase {
    private func withDefaults(_ body: (UserDefaults) throws -> Void) throws {
        let name = "NIOWarp.ConnectMigrationTests." + UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        try body(defaults)
    }

    func testV2MigrationAndSaveNeverRewriteV1PlaylistBytes() throws {
        try withDefaults { defaults in
            var item = ProtoPiePlaylistItem(); item.cloudURL = "https://cloud.protopie.io/p/old"
            var library = ProtoPiePlaybackLibrary(); library.items = [item]; library.selectedItemID = item.id
            let original = try JSONEncoder().encode(library)
            defaults.set(original, forKey: "nioWarpProtoPie.playbackLibrary.v1")
            let store = ProtoPiePlaybackStore(defaults: defaults, legacy: ProtoPieConfiguration())
            XCTAssertEqual(store.library, library)
            XCTAssertEqual(defaults.data(forKey: "nioWarpProtoPie.playbackLibrary.v1"), original)
            var next = store.library; next.items[0].source = .connect; next.items[0].cloudURL = "http://localhost:9981/pie?pieid=1"
            try store.save(next)
            XCTAssertEqual(defaults.data(forKey: "nioWarpProtoPie.playbackLibrary.v1"), original)
            XCTAssertNotNil(defaults.data(forKey: "nioWarpProtoPie.playbackLibrary.v2"))
            let reopened = ProtoPiePlaybackStore(defaults: defaults, legacy: ProtoPieConfiguration())
            XCTAssertEqual(reopened.library, next)
        }
    }

    func testUnreadableV1PlaylistIsPreservedWhenSavingV2() throws {
        try withDefaults { defaults in
            let original = Data("not json".utf8)
            defaults.set(original, forKey: "nioWarpProtoPie.playbackLibrary.v1")
            let store = ProtoPiePlaybackStore(defaults: defaults, legacy: ProtoPieConfiguration())
            XCTAssertNotNil(store.warning)
            XCTAssertNil(defaults.data(forKey: "nioWarpProtoPie.playbackLibrary.v2"))
            try store.save(ProtoPiePlaybackLibrary())
            XCTAssertEqual(defaults.data(forKey: "nioWarpProtoPie.playbackLibrary.v1"), original)
            XCTAssertNotNil(defaults.data(forKey: "nioWarpProtoPie.playbackLibrary.v2"))
        }
    }

    func testConnectSingleSourceSeedsOnlyV2Library() throws {
        try withDefaults { defaults in
            var legacy = ProtoPieConfiguration(); legacy.source = .connect; legacy.connectURL = "http://localhost:9981/pie?pieid=5"
            let store = ProtoPiePlaybackStore(defaults: defaults, legacy: legacy)
            XCTAssertEqual(store.library.items.first?.source, .connect)
            XCTAssertEqual(store.library.items.first?.cloudURL, legacy.connectURL)
            XCTAssertNil(defaults.object(forKey: "nioWarpProtoPie.playbackLibrary.v1"))
        }
    }
}
