import CoreGraphics
import XCTest
@testable import NIOWarpApp

final class PresentationDisplayPlacementTests: XCTestCase {
    private func screen(_ id: UInt32, _ x: CGFloat, _ y: CGFloat = 0,
                        width: CGFloat = 1920, height: CGFloat = 1080, main: Bool = false) -> PresentationDisplayPlacement.Screen {
        .init(id: id, vendor: id == 1 ? 1552 : 19501, model: id, serial: id,
              pixelWidth: Int(width), pixelHeight: Int(height), modeWidth: Int(width), modeHeight: Int(height),
              modeID: id, refreshRate: 60, rotation: 0, mirror: 0, isMain: main,
              bounds: CGRect(x: x, y: y, width: width, height: height))
    }
    private var physical: [PresentationDisplayPlacement.Screen] {
        [screen(1, 0, width: 1512, height: 982, main: true), screen(4, 1512)]
    }
    private func applying(_ plan: PresentationDisplayPlacement.Plan, to screens: [PresentationDisplayPlacement.Screen]) -> [PresentationDisplayPlacement.Screen] {
        screens.map { value in
            var value = value
            if let move = plan.moves.first(where: { $0.id == value.id }) { value.bounds.origin = move.origin }
            return value
        }
    }

    func testCreationRestoresPhysicalShiftAndMovesOnlyKnownSource() throws {
        let baseline = PresentationDisplayPlacement.snapshot(physical, movableIDs: [])
        var current = physical; current[1].bounds.origin.x = 3432
        current.append(screen(14, 1512, height: 1100))
        let plan = try XCTUnwrap(PresentationDisplayPlacement.plan(baseline: baseline, current: current, movableIDs: [14]))
        XCTAssertTrue(plan.restoredSnapshot)
        XCTAssertEqual(plan.moves, [.init(id: 4, origin: CGPoint(x: 1512, y: 0)), .init(id: 14, origin: CGPoint(x: 3432, y: 0))])
        let result = applying(plan, to: current)
        XCTAssertEqual(Array(result.prefix(2)), physical)
    }

    func testNegativeAndVerticalPhysicalOriginsArePreserved() throws {
        let anchors = [screen(1, 0, main: true), screen(4, -1920, -300), screen(5, 0, -2160)]
        let baseline = PresentationDisplayPlacement.snapshot(anchors, movableIDs: [])
        let current = anchors + [screen(14, -1920)]
        let plan = try XCTUnwrap(PresentationDisplayPlacement.plan(baseline: baseline, current: current, movableIDs: [14]))
        XCTAssertEqual(plan.moves, [.init(id: 14, origin: CGPoint(x: 1920, y: 0))])
        XCTAssertEqual(Array(applying(plan, to: current).prefix(3)), anchors)
    }

    func testHandoffPlacesCandidateFirstAndCapturedSourceAtTail() throws {
        let old = screen(13, 3432, height: 1200)
        let baseline = PresentationDisplayPlacement.snapshot(physical + [old], movableIDs: [13])
        var current = physical; current[1].bounds.origin.x = 5352
        current += [old, screen(14, 1512, height: 1100)]
        let plan = try XCTUnwrap(PresentationDisplayPlacement.plan(baseline: baseline, current: current, movableIDs: [13, 14], leadingID: 14))
        XCTAssertTrue(plan.moves.contains(.init(id: 13, origin: CGPoint(x: 5352, y: 0))))
        XCTAssertTrue(plan.moves.contains(.init(id: 14, origin: CGPoint(x: 3432, y: 0))))
        let next = applying(plan, to: current)
        let repeatPlan = try XCTUnwrap(PresentationDisplayPlacement.plan(baseline: baseline, current: next, movableIDs: [13, 14], leadingID: 14))
        XCTAssertTrue(repeatPlan.moves.isEmpty)
    }

    func testNextResizeReusesVacantSlotWithoutUnboundedRightwardDrift() throws {
        let old = screen(14, 5352, height: 1100)
        let baseline = PresentationDisplayPlacement.snapshot(physical + [old], movableIDs: [14])
        let current = physical + [old, screen(15, 1512, height: 1200)]
        let plan = try XCTUnwrap(PresentationDisplayPlacement.plan(baseline: baseline, current: current, movableIDs: [14, 15]))
        XCTAssertEqual(plan.moves, [.init(id: 15, origin: CGPoint(x: 3432, y: 0))])
        let autoAppended = physical + [old, screen(15, 7272, height: 1200)]
        let compact = try XCTUnwrap(PresentationDisplayPlacement.plan(baseline: baseline, current: autoAppended,
            movableIDs: [14, 15], preservingIDs: [14], leadingID: 15))
        XCTAssertEqual(compact.moves, [.init(id: 15, origin: CGPoint(x: 3432, y: 0))])
    }

    func testHotplugInvalidatesSnapshotAndKeepsCurrentAnchorOrigins() throws {
        let baseline = PresentationDisplayPlacement.snapshot(physical, movableIDs: [])
        var anchors = physical; anchors[1].bounds.origin.x = 2500
        anchors.append(screen(6, -1920))
        let plan = try XCTUnwrap(PresentationDisplayPlacement.plan(baseline: baseline, current: anchors + [screen(14, 1512)], movableIDs: [14]))
        XCTAssertFalse(plan.restoredSnapshot)
        XCTAssertEqual(plan.moves, [.init(id: 14, origin: CGPoint(x: 4420, y: 0))])
    }

    func testModeRefreshIdentityRotationAndMirrorChangesInvalidateSnapshot() throws {
        let baseline = PresentationDisplayPlacement.snapshot(physical, movableIDs: [])
        let mutations: [(inout PresentationDisplayPlacement.Screen) -> Void] = [
            { $0.pixelWidth *= 2 }, { $0.modeWidth *= 2 }, { $0.modeID += 1 }, { $0.refreshRate = 120 },
            { $0.serial += 1 }, { $0.vendor += 1 }, { $0.rotation = 90 }, { $0.mirror = 1 },
            { $0.bounds.size.height += 1 },
        ]
        for mutate in mutations {
            var anchors = physical; anchors[1].bounds.origin.x = 2500; mutate(&anchors[1])
            let plan = try XCTUnwrap(PresentationDisplayPlacement.plan(baseline: baseline, current: anchors + [screen(14, 1512)], movableIDs: [14]))
            XCTAssertFalse(plan.restoredSnapshot)
            XCTAssertFalse(plan.moves.contains { $0.id == 4 })
        }
    }

    func testMainDisplayChangeDoesNotRestorePreviousMainPosition() throws {
        let baseline = PresentationDisplayPlacement.snapshot(physical, movableIDs: [])
        var anchors = physical
        anchors[0].isMain = false; anchors[0].bounds.origin.x = -1512
        anchors[1].isMain = true; anchors[1].bounds.origin.x = 0
        let plan = try XCTUnwrap(PresentationDisplayPlacement.plan(baseline: baseline, current: anchors + [screen(14, -1512)], movableIDs: [14]))
        XCTAssertFalse(plan.restoredSnapshot)
        XCTAssertEqual(plan.moves, [.init(id: 14, origin: CGPoint(x: 1920, y: 0))])
    }

    func testUnownedThirdPartyScreenIsAnAnchorEvenWithNIOIdentity() throws {
        var thirdParty = screen(18, 3432); thirdParty.vendor = 0x4E49; thirdParty.model = 0x5752
        let anchors = physical + [thirdParty]
        let baseline = PresentationDisplayPlacement.snapshot(anchors, movableIDs: [])
        let plan = try XCTUnwrap(PresentationDisplayPlacement.plan(baseline: baseline, current: anchors + [screen(14, 1512)], movableIDs: [14]))
        XCTAssertEqual(plan.moves, [.init(id: 14, origin: CGPoint(x: 5352, y: 0))])
    }

    func testReleaseRestoresPhysicalOriginsWithoutRepositioningRemainingSource() throws {
        let source = screen(14, 3432)
        let baseline = PresentationDisplayPlacement.snapshot(physical + [screen(13, 5352), source], movableIDs: [13, 14])
        var current = physical; current[1].bounds.origin.x = 3432
        current.append(source)
        let plan = try XCTUnwrap(PresentationDisplayPlacement.plan(baseline: baseline, current: current, movableIDs: [14]))
        XCTAssertEqual(plan.moves, [.init(id: 4, origin: CGPoint(x: 1512, y: 0))])
    }

    func testReleaseDoesNotReintroduceLegacyGapThatSystemCompacts() throws {
        let prepared = screen(16, 5352, height: 1200)
        let baseline = PresentationDisplayPlacement.snapshot(physical + [screen(14, 3432, height: 1100), prepared], movableIDs: [14, 16])
        // Browser fullscreen was established at x=5352. The removed old source
        // causes macOS to compact the new source to x=3432 without moving Chrome.
        let current = physical + [screen(16, 3432, height: 1200)]
        let plan = try XCTUnwrap(PresentationDisplayPlacement.plan(baseline: baseline, current: current,
            movableIDs: [16], preservingIDs: [16]))
        XCTAssertTrue(plan.moves.isEmpty)
    }

    func testCreationKeepsCandidateFirstEvenWhenSystemInitiallyShiftsCapturedSource() throws {
        let old = screen(16, 3432, height: 1200)
        let baseline = PresentationDisplayPlacement.snapshot(physical + [old], movableIDs: [16])
        var current = physical; current[1].bounds.origin.x = 3432
        current += [screen(16, 5352, height: 1200), screen(17, 1512, height: 1100)]
        let plan = try XCTUnwrap(PresentationDisplayPlacement.plan(baseline: baseline, current: current,
            movableIDs: [16, 17], preservingIDs: [16], leadingID: 17))
        XCTAssertFalse(plan.moves.contains { $0.id == 16 })
        XCTAssertTrue(plan.moves.contains(.init(id: 17, origin: CGPoint(x: 3432, y: 0))))
        let next = applying(plan, to: current)
        let repeatPlan = try XCTUnwrap(PresentationDisplayPlacement.plan(baseline: baseline, current: next,
            movableIDs: [16, 17], preservingIDs: [16], leadingID: 17))
        XCTAssertTrue(repeatPlan.moves.isEmpty)
    }

    func testHeightRoundTripNeverLeavesGapAfterOldSourceRelease() throws {
        var source = screen(14, 3432, height: 1100)
        for (id, height): (UInt32, CGFloat) in [(16, 1200), (17, 1100), (18, 1200), (19, 1100)] {
            let baseline = PresentationDisplayPlacement.snapshot(physical + [source], movableIDs: [source.id])
            var displaced = physical; displaced[1].bounds.origin.x = 3432
            var shiftedSource = source; shiftedSource.bounds.origin.x = 5352
            displaced += [shiftedSource, screen(id, 1512, height: height)]
            let plan = try XCTUnwrap(PresentationDisplayPlacement.plan(baseline: baseline, current: displaced,
                movableIDs: [source.id, id], leadingID: id))
            let prepared = applying(plan, to: displaced)
            source = try XCTUnwrap(prepared.first { $0.id == id })
            XCTAssertEqual(source.bounds.origin, CGPoint(x: 3432, y: 0))
            XCTAssertEqual(source.bounds.height, height)
            let beforeRelease = PresentationDisplayPlacement.snapshot(prepared, movableIDs: [shiftedSource.id, id])
            let afterRelease = physical + [source]
            let finish = try XCTUnwrap(PresentationDisplayPlacement.plan(baseline: beforeRelease,
                current: afterRelease, movableIDs: [id]))
            XCTAssertTrue(finish.moves.isEmpty, "销毁尾部旧源后不应再移动正式来源")
        }
    }

    func testFailedCandidateRestoresOldSourceOriginalCoordinate() throws {
        let old = screen(14, 3432, height: 1100)
        let baseline = PresentationDisplayPlacement.snapshot(physical + [old], movableIDs: [14])
        var displacedOld = old; displacedOld.bounds.origin.x = 5352
        let plan = try XCTUnwrap(PresentationDisplayPlacement.plan(baseline: baseline,
            current: physical + [displacedOld], movableIDs: [14]))
        XCTAssertEqual(plan.moves, [.init(id: 14, origin: CGPoint(x: 3432, y: 0))])
    }

    func testNoAnchorsOrUnsafeMainOrMirroredSourceIsRejected() {
        let baseline = PresentationDisplayPlacement.snapshot(physical, movableIDs: [])
        XCTAssertNil(PresentationDisplayPlacement.plan(baseline: baseline, current: [screen(14, 0)], movableIDs: [14]))
        XCTAssertNil(PresentationDisplayPlacement.plan(baseline: baseline, current: physical + [screen(14, 3432, main: true)], movableIDs: [14]))
        var mirrored = screen(14, 3432); mirrored.mirror = 4
        XCTAssertNil(PresentationDisplayPlacement.plan(baseline: baseline, current: physical + [mirrored], movableIDs: [14]))
    }

    func testSettledLayoutIsIdempotentAndNoSourcesRequiresNoChanges() throws {
        let baseline = PresentationDisplayPlacement.snapshot(physical, movableIDs: [])
        let noSource = try XCTUnwrap(PresentationDisplayPlacement.plan(baseline: baseline, current: physical, movableIDs: []))
        XCTAssertTrue(noSource.moves.isEmpty)
        let plan = try XCTUnwrap(PresentationDisplayPlacement.plan(baseline: baseline, current: physical + [screen(14, 3432)], movableIDs: [14]))
        XCTAssertTrue(plan.moves.isEmpty)
    }

    func testModeFallbackCopiesOnlyVerifiedModeAndKeepsCurrentSourceOrigin() throws {
        let verified = screen(25, 3432, height: 1200)
        var observed = verified
        observed.bounds.origin.x = 5352
        observed.modeWidth = 0; observed.modeHeight = 0; observed.modeID = 0; observed.refreshRate = 0
        let fallback = try XCTUnwrap(PresentationDisplayPlacement.verifiedModeFallback(verified, observed: observed))
        XCTAssertEqual(fallback.bounds.origin.x, 5352)
        XCTAssertEqual(fallback.modeWidth, 1920)
        XCTAssertEqual(fallback.modeHeight, 1200)
        XCTAssertEqual(fallback.modeID, verified.modeID)
        XCTAssertEqual(fallback.refreshRate, 60)
        XCTAssertTrue(fallback.modeFallback)
        XCTAssertNil(PresentationDisplayPlacement.verifiedModeFallback(fallback, observed: observed), "不能把fallback再当作真实mode证据")
    }

    func testModeFallbackRejectsAnyLiveIdentityGeometryOrRoleChange() {
        let verified = screen(25, 3432, height: 1200)
        let mutations: [(inout PresentationDisplayPlacement.Screen) -> Void] = [
            { $0.id += 1 }, { $0.vendor += 1 }, { $0.model += 1 }, { $0.serial += 1 },
            { $0.pixelWidth += 1 }, { $0.pixelHeight += 1 }, { $0.bounds.size.width += 1 },
            { $0.bounds.size.height += 1 }, { $0.rotation = 90 }, { $0.mirror = 1 }, { $0.isMain = true },
        ]
        for mutate in mutations {
            var observed = verified; mutate(&observed)
            XCTAssertNil(PresentationDisplayPlacement.verifiedModeFallback(verified, observed: observed))
        }
        var missingMode = verified; missingMode.modeWidth = 0
        XCTAssertNil(PresentationDisplayPlacement.verifiedModeFallback(missingMode, observed: verified))
    }
}
