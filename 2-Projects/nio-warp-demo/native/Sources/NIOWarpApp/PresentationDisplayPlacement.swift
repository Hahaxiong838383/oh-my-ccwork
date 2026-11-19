import CoreGraphics
import Foundation

/// Geometry-only planning. A snapshot is valid only while the anchored screens
/// retain their identities, modes, mirroring and main-display roles.
enum PresentationDisplayPlacement {
    struct Screen: Equatable {
        var id: CGDirectDisplayID
        var vendor: UInt32
        var model: UInt32
        var serial: UInt32
        var pixelWidth: Int
        var pixelHeight: Int
        var modeWidth: Int
        var modeHeight: Int
        var modeID: UInt32
        var refreshRate: Double
        var rotation: Double
        var mirror: CGDirectDisplayID
        var isMain: Bool
        var bounds: CGRect
        var modeFallback = false

        func matchesIdentityAndMode(_ other: Screen) -> Bool {
            id == other.id && vendor == other.vendor && model == other.model && serial == other.serial
                && pixelWidth == other.pixelWidth && pixelHeight == other.pixelHeight
                && modeWidth == other.modeWidth && modeHeight == other.modeHeight
                && modeID == other.modeID && refreshRate == other.refreshRate
                && rotation == other.rotation && mirror == other.mirror && isMain == other.isMain
                && bounds.size == other.bounds.size
        }
    }

    struct Snapshot { var anchors: [Screen]; var sources: [Screen] = [] }
    struct Move: Equatable { var id: CGDirectDisplayID; var origin: CGPoint }
    struct Plan {
        var moves: [Move]
        var restoredSnapshot: Bool
        var restoredMainDisplayID: CGDirectDisplayID? = nil
    }

    /// Only the owner may supply a previously observed real mode. The current
    /// live identity and geometry must still agree; only the unavailable mode
    /// object is substituted, never the live origin or device identity.
    static func verifiedModeFallback(_ verified: Screen, observed: Screen) -> Screen? {
        guard !verified.modeFallback, verified.modeWidth > 0, verified.modeHeight > 0,
              verified.id == observed.id, verified.vendor == observed.vendor,
              verified.model == observed.model, verified.serial == observed.serial,
              verified.pixelWidth == observed.pixelWidth, verified.pixelHeight == observed.pixelHeight,
              verified.bounds.size == observed.bounds.size, verified.rotation == observed.rotation,
              verified.mirror == observed.mirror, verified.isMain == observed.isMain else { return nil }
        var result = observed
        result.modeWidth = verified.modeWidth; result.modeHeight = verified.modeHeight
        result.modeID = verified.modeID; result.refreshRate = verified.refreshRate
        result.modeFallback = true
        return result
    }

    static func snapshot(_ screens: [Screen], movableIDs: [CGDirectDisplayID]) -> Snapshot {
        let owned = Set(movableIDs)
        return Snapshot(anchors: screens.filter { !owned.contains($0.id) }.sorted { $0.id < $1.id },
                        sources: screens.filter { owned.contains($0.id) })
    }

    static func plan(baseline: Snapshot, current: [Screen], movableIDs: [CGDirectDisplayID],
                     preservingIDs: Set<CGDirectDisplayID>? = nil, leadingID: CGDirectDisplayID? = nil) -> Plan? {
        let anchors = snapshot(current, movableIDs: movableIDs).anchors
        guard !anchors.isEmpty, current.allSatisfy({
            !$0.bounds.isEmpty && !$0.bounds.isInfinite && !$0.bounds.isNull
                && $0.bounds.minX.isFinite && $0.bounds.minY.isFinite
                && $0.bounds.maxX.isFinite && $0.bounds.maxY.isFinite
        }) else { return nil }
        // A main or mirrored virtual screen is not safe to relocate implicitly.
        let owned = current.filter { movableIDs.contains($0.id) }
        guard owned.allSatisfy({ !$0.isMain && $0.mirror == kCGNullDirectDisplay }) else { return nil }
        let compatible = anchors.count == baseline.anchors.count
            && zip(anchors, baseline.anchors).allSatisfy { $0.matchesIdentityAndMode($1) }
        let targetAnchors = compatible ? baseline.anchors : anchors
        var moves = zip(anchors, targetAnchors).compactMap { actual, target -> Move? in
            actual.bounds.origin == target.bounds.origin ? nil : Move(id: actual.id, origin: target.bounds.origin)
        }
        let right = targetAnchors.map(\.bounds.maxX).max()!
        let edgeAnchors = targetAnchors.filter { $0.bounds.maxX == right }
        let top = (edgeAnchors.first(where: \.isMain) ?? edgeAnchors[0]).bounds.minY
        var cursor = right
        if let leadingID {
            guard owned.contains(where: { $0.id == leadingID }) else { return nil }
            // The soon-to-be-captured source must be adjacent to the physical
            // desktop. Old sources become the tail, so releasing them cannot
            // compact a hole and leave Chrome's fullscreen Space at an old x.
            for id in [leadingID] + movableIDs.filter({ $0 != leadingID }) {
                guard let screen = owned.first(where: { $0.id == id }) else { continue }
                let origin = CGPoint(x: cursor, y: top)
                if origin != screen.bounds.origin { moves.append(Move(id: id, origin: origin)) }
                cursor += screen.bounds.width
            }
        } else {
            let preserving = preservingIDs ?? Set(movableIDs)
            var desired = [(screen: Screen, bounds: CGRect)]()
            for screen in owned {
                var preferred = screen.bounds
                if compatible, preserving.contains(screen.id),
                   let saved = baseline.sources.first(where: { $0.matchesIdentityAndMode(screen) }) {
                    preferred = saved.bounds
                }
                desired.append((screen, preferred))
            }
            desired.sort {
                if $0.bounds.minX == $1.bounds.minX { return $0.screen.id < $1.screen.id }
                return $0.bounds.minX < $1.bounds.minX
            }
            // Restore surviving source positions where they still form a
            // connected row. Never reintroduce a gap macOS will compact again.
            for (screen, preferred) in desired {
                let origin = preferred.minX == cursor && preferred.minY == top
                    ? preferred.origin : CGPoint(x: cursor, y: top)
                if origin != screen.bounds.origin { moves.append(Move(id: screen.id, origin: origin)) }
                cursor += screen.bounds.width
            }
        }
        guard moves.allSatisfy({ move in
            [move.origin.x, move.origin.y].allSatisfy {
                $0.isFinite && $0 >= Double(Int32.min) && $0 <= Double(Int32.max) && $0.rounded() == $0
            }
        }) else { return nil }
        return Plan(moves: moves, restoredSnapshot: compatible)
    }

    /// Explicitly undo our source creation taking over the main-display role.
    /// Only the resource owner's bounded create/release transaction may use
    /// this path. A changed physical topology or mode must still be rejected.
    static func planRestoringBaselineMain(baseline: Snapshot, current: [Screen], movableIDs: [CGDirectDisplayID],
                                          preservingIDs: Set<CGDirectDisplayID>? = nil,
                                          leadingID: CGDirectDisplayID? = nil) -> Plan? {
        let owned = Set(movableIDs)
        let currentMain = current.filter(\.isMain)
        let baselineMain = baseline.anchors.filter(\.isMain)
        let anchors = snapshot(current, movableIDs: movableIDs).anchors
        guard currentMain.count == 1, owned.contains(currentMain[0].id),
              currentMain[0].bounds.origin == .zero,
              baselineMain.count == 1, !owned.contains(baselineMain[0].id),
              baselineMain[0].bounds.origin == .zero,
              !baseline.sources.contains(where: \.isMain),
              current.allSatisfy({ $0.mirror == kCGNullDirectDisplay }),
              (baseline.anchors + baseline.sources).allSatisfy({ $0.mirror == kCGNullDirectDisplay }),
              Set(current.map(\.id)).count == current.count,
              Set(baseline.anchors.map(\.id)).count == baseline.anchors.count,
              !anchors.isEmpty, anchors.count == baseline.anchors.count else { return nil }
        let savedAnchors = baseline.anchors.sorted { $0.id < $1.id }
        guard zip(anchors, savedAnchors).allSatisfy({ actual, saved in
            var normalized = actual
            normalized.isMain = saved.isMain
            return normalized.matchesIdentityAndMode(saved)
        }) else { return nil }
        // Keep the live origins so the ordinary planner emits every required
        // move, but compare roles against the verified pre-creation baseline.
        let normalized = current.map { screen -> Screen in
            var screen = screen
            screen.isMain = screen.id == baselineMain[0].id
            return screen
        }
        let orderedBaseline = Snapshot(anchors: savedAnchors, sources: baseline.sources)
        guard var recovery = plan(baseline: orderedBaseline, current: normalized,
                                  movableIDs: movableIDs, preservingIDs: preservingIDs,
                                  leadingID: leadingID), recovery.restoredSnapshot else { return nil }
        // Configuring the physical main's origin to (0,0) restores its role in
        // the same session transaction that moves our source away from it.
        let mainMove = Move(id: baselineMain[0].id, origin: .zero)
        recovery.moves.removeAll { $0.id == mainMove.id }
        recovery.moves.insert(mainMove, at: 0)
        recovery.restoredMainDisplayID = mainMove.id
        return recovery
    }
}

enum PresentationDisplayPlacementRuntime {
    static func activeDisplayIDs() throws -> [CGDirectDisplayID] {
        var count: UInt32 = 0
        guard CGGetActiveDisplayList(0, nil, &count) == .success, count > 0, count <= 128 else {
            throw ProtoPieError.unavailable("无法读取当前显示器排列。")
        }
        var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
        guard CGGetActiveDisplayList(count, &ids, &count) == .success else {
            throw ProtoPieError.unavailable("显示器排列正在变化，请稍后重试。")
        }
        return Array(ids.prefix(Int(count)))
    }

    static func screens(displayIDs: [CGDirectDisplayID]? = nil,
                        verifiedSourceModes: [CGDirectDisplayID: PresentationDisplayPlacement.Screen] = [:],
                        excludingIDs: Set<CGDirectDisplayID> = []) throws -> [PresentationDisplayPlacement.Screen] {
        let ids = try displayIDs ?? activeDisplayIDs()
        return try ids.filter { !excludingIDs.contains($0) }.map { id in
            var observed = PresentationDisplayPlacement.Screen(id: id, vendor: CGDisplayVendorNumber(id),
                model: CGDisplayModelNumber(id), serial: CGDisplaySerialNumber(id),
                pixelWidth: CGDisplayPixelsWide(id), pixelHeight: CGDisplayPixelsHigh(id),
                modeWidth: 0, modeHeight: 0, modeID: 0, refreshRate: 0,
                rotation: CGDisplayRotation(id), mirror: CGDisplayMirrorsDisplay(id),
                isMain: CGDisplayIsMain(id) != 0, bounds: CGDisplayBounds(id))
            if let mode = CGDisplayCopyDisplayMode(id) {
                observed.pixelWidth = mode.pixelWidth; observed.pixelHeight = mode.pixelHeight
                observed.modeWidth = mode.width; observed.modeHeight = mode.height
                observed.modeID = UInt32(bitPattern: mode.ioDisplayModeID); observed.refreshRate = mode.refreshRate
                return observed
            }
            if CGDisplayIsActive(id) > 0, CGDisplayIsOnline(id) > 0,
               let verified = verifiedSourceModes[id],
               let fallback = PresentationDisplayPlacement.verifiedModeFallback(verified, observed: observed) {
                return fallback
            } else {
                throw ProtoPieError.unavailable("显示器模式尚未就绪（id \(id)，active \(CGDisplayIsActive(id))，online \(CGDisplayIsOnline(id))，vendor \(CGDisplayVendorNumber(id))，model \(CGDisplayModelNumber(id))）。")
            }
        }
    }

    static func apply(_ plan: PresentationDisplayPlacement.Plan) throws {
        guard !plan.moves.isEmpty else { return }
        var transaction: CGDisplayConfigRef?
        guard CGBeginDisplayConfiguration(&transaction) == .success, let transaction else {
            throw ProtoPieError.unavailable("无法开始内容屏排列调整。")
        }
        for move in plan.moves {
            let result = CGConfigureDisplayOrigin(transaction, move.id, Int32(move.origin.x), Int32(move.origin.y))
            guard result == .success else {
                CGCancelDisplayConfiguration(transaction)
                throw ProtoPieError.unavailable("内容屏排列调整失败（系统错误 \(result.rawValue)）。")
            }
        }
        let result = CGCompleteDisplayConfiguration(transaction, .forSession)
        guard result == .success else {
            throw ProtoPieError.unavailable("内容屏排列提交失败（系统错误 \(result.rawValue)）。")
        }
    }
}
