import AppKit
import MetalKit
import XCTest
import simd
@testable import NIOWarpApp

final class BezierIntegrationTests: XCTestCase {
    private func baseline() -> WarpConfiguration {
        var configuration = WarpConfiguration.defaultConfiguration(displayWidth: 5120, displayHeight: 2880)
        configuration.manual.strength = 2.25
        return configuration
    }

    private func leftRightCorrection() -> WarpConfiguration {
        var configuration = baseline()
        configuration.bezierWarp.enabled = true
        configuration.bezierWarp.scope = .wholeCanvas
        configuration.bezierWarp.linkage = .uniform
        configuration.bezierWarp.horizontalRadius = 0.2
        XCTAssertTrue(configuration.bezierWarp.applyOffsetDelta(SIMD2(0, -12), at: 0))
        XCTAssertTrue(configuration.bezierWarp.applyOffsetDelta(SIMD2(0, 8), at: configuration.bezierWarp.columns - 1))
        XCTAssertTrue(configuration.bezierWarp.applyTangentDelta(SIMD2(0, -60), axis: .horizontal, at: 0))
        XCTAssertTrue(configuration.bezierWarp.applyTangentDelta(SIMD2(0, 45), axis: .horizontal, at: configuration.bezierWarp.columns - 1))
        return configuration
    }

    private func assertPointsEqual(
        _ actual: [SIMD2<Float>], _ expected: [SIMD2<Float>], accuracy: Float = 0.002,
        file: StaticString = #filePath, line: UInt = #line
    ) {
        XCTAssertEqual(actual.count, expected.count, file: file, line: line)
        for (actualPoint, expectedPoint) in zip(actual, expected) {
            XCTAssertEqual(actualPoint.x, expectedPoint.x, accuracy: accuracy, file: file, line: line)
            XCTAssertEqual(actualPoint.y, expectedPoint.y, accuracy: accuracy, file: file, line: line)
        }
    }

    func testSchemaElevenWithoutNewLayersPreservesFrozenLegacyMapping() throws {
        let original = baseline()
        var json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(original)) as? [String: Any])
        json["schemaVersion"] = 11
        json.removeValue(forKey: "bezierWarp")
        json.removeValue(forKey: "alignment")
        let decoded = try JSONDecoder().decode(WarpConfiguration.self, from: JSONSerialization.data(withJSONObject: json))
        XCTAssertFalse(decoded.bezierWarp.enabled)
        XCTAssertFalse(decoded.bezierWarp.hasEdits)
        XCTAssertFalse(decoded.alignment.centerHorizontal)
        XCTAssertFalse(decoded.alignment.centerVertical)
        XCTAssertFalse(decoded.alignment.level)
        XCTAssertFalse(decoded.alignment.snapTilt)
        XCTAssertFalse(decoded.alignment.snapHorizontalBend)

        // Frozen from the unmodified v0.9.2 implementation on Air, 2026-09-17.
        // This catches a changed legacy mapping even if both new configurations change together.
        let samples: [SIMD2<Float>] = [
            SIMD2(0, 0), SIMD2(1, 0), SIMD2(0, 1), SIMD2(1, 1),
            SIMD2(0.25, 0.25), SIMD2(0.5, 0.5), SIMD2(0.75, 0.75), SIMD2(0.1, 0.8)
        ]
        let expected: [SIMD2<Float>] = [
            SIMD2(307.19998, 1166.7352), SIMD2(4812.8, 970.53937),
            SIMD2(958.2384, 1637.7374), SIMD2(4161.7617, 2131.2),
            SIMD2(1365.0085, 1044.4431), SIMD2(2443.7432, 1164.4231),
            SIMD2(3417.8467, 1526.6754), SIMD2(1168.7327, 1466.7234)
        ]
        assertPointsEqual(WarpMath.physicalPoints(canvasPoints: samples, configuration: decoded), expected)
        let decodedMesh = WarpMath.makeMesh(configuration: decoded)
        let originalMesh = WarpMath.makeMesh(configuration: original)
        XCTAssertEqual(decodedMesh.vertices.map(\.position), originalMesh.vertices.map(\.position))
        XCTAssertEqual(decodedMesh.indices, originalMesh.indices)
        XCTAssertEqual(decodedMesh.validation, originalMesh.validation)
    }

    func testMaximumStrengthWithLeftAndRightEditsMovesMultipleRowsAndPreservesCenter() {
        let original = baseline()
        let corrected = leftRightCorrection()
        XCTAssertTrue(WarpMath.makeMesh(configuration: original).validation.isValid)
        let mesh = WarpMath.makeMesh(configuration: corrected, columns: 192, rows: 72)
        XCTAssertTrue(mesh.validation.isValid, mesh.validation.summary)
        XCTAssertTrue(corrected.validationErrors().isEmpty)
        XCTAssertEqual(corrected.manual, original.manual)
        XCTAssertEqual(corrected.polynomial, original.polynomial)
        for x in [Float(0.1), 0.9] {
            let samples = [Float(0.1), 0.35, 0.65, 0.9].map { SIMD2(x, $0) }
            let before = WarpMath.physicalPoints(canvasPoints: samples, configuration: original)
            let after = WarpMath.physicalPoints(canvasPoints: samples, configuration: corrected)
            let firstDelta = after[0] - before[0]
            XCTAssertGreaterThan(abs(firstDelta.y), 1, "每侧微调须进入整片画面，而非只移动顶边")
            for (beforePoint, afterPoint) in zip(before, after) {
                XCTAssertEqual(afterPoint.x, beforePoint.x, accuracy: 0.002)
                XCTAssertEqual(afterPoint.y - beforePoint.y, firstDelta.y, accuracy: 0.002, "等量联动应保留纵向行间距")
            }
            if x < 0.5 { XCTAssertLessThan(firstDelta.y, 0) }
            else { XCTAssertGreaterThan(firstDelta.y, 0) }
        }
        let center = [Float(0), 0.25, 0.5, 0.75, 1].map { SIMD2(Float(0.5), $0) }
        assertPointsEqual(
            WarpMath.physicalPoints(canvasPoints: center, configuration: corrected),
            WarpMath.physicalPoints(canvasPoints: center, configuration: original)
        )
    }

    func testBezierHandlesAloneChangeInteriorCurvatureAcrossAllRows() {
        let original = baseline()
        var configuration = original
        configuration.bezierWarp.enabled = true
        configuration.bezierWarp.horizontalRadius = 0.2
        let offsets = configuration.bezierWarp.nodes.map(\.offset)
        XCTAssertTrue(configuration.bezierWarp.applyTangentDelta(SIMD2(0, 150), axis: .horizontal, at: 0))
        XCTAssertEqual(configuration.bezierWarp.nodes.map(\.offset), offsets, "拖手柄不能冒充移动节点")
        let samples = [Float(0.1), 0.4, 0.7, 0.95].map { SIMD2(Float(0.125), $0) }
        let before = WarpMath.physicalPoints(canvasPoints: samples, configuration: original)
        let after = WarpMath.physicalPoints(canvasPoints: samples, configuration: configuration)
        for (beforePoint, afterPoint) in zip(before, after) {
            XCTAssertGreaterThan(afterPoint.y - beforePoint.y, 1, "切线手柄也必须带动中下部多行弯曲")
            XCTAssertEqual(afterPoint.y - beforePoint.y, after[0].y - before[0].y, accuracy: 0.002)
        }
        XCTAssertTrue(WarpMath.makeMesh(configuration: configuration).validation.isValid)
    }

    func testGradientLinkageFallsOffThroughInteriorWithoutMovingBottom() {
        let original = baseline()
        var configuration = original
        configuration.bezierWarp.enabled = true
        configuration.bezierWarp.horizontalRadius = 0.2
        configuration.bezierWarp.linkage = .gradient
        XCTAssertTrue(configuration.bezierWarp.applyOffsetDelta(SIMD2(0, -16), at: 0))
        let samples = [Float(0), 0.25, 0.5, 0.75, 1].map { SIMD2(Float(0.1), $0) }
        let before = WarpMath.physicalPoints(canvasPoints: samples, configuration: original)
        let after = WarpMath.physicalPoints(canvasPoints: samples, configuration: configuration)
        let deltas = zip(before, after).map { abs($1.y - $0.y) }
        XCTAssertGreaterThan(deltas[0], deltas[1])
        XCTAssertGreaterThan(deltas[1], deltas[2])
        XCTAssertGreaterThan(deltas[2], deltas[3])
        XCTAssertGreaterThan(deltas[3], 0.01)
        XCTAssertEqual(deltas[4], 0, accuracy: 0.002)
        XCTAssertTrue(WarpMath.makeMesh(configuration: configuration).validation.isValid)
    }

    func testDisablingBezierRestoresExactBaseMeshWithoutLosingEdits() {
        var configuration = leftRightCorrection()
        let savedNodes = configuration.bezierWarp.nodes
        configuration.bezierWarp.enabled = false
        XCTAssertEqual(configuration.bezierWarp.nodes, savedNodes)
        let disabled = WarpMath.makeMesh(configuration: configuration)
        let original = WarpMath.makeMesh(configuration: baseline())
        XCTAssertEqual(disabled.vertices.map(\.position), original.vertices.map(\.position))
        XCTAssertEqual(disabled.validation, original.validation)
    }

    func testInverseMaximumWarpRemainsValidWithBothSideCorrections() {
        var original = baseline()
        original.warpTrend = .inverse
        var corrected = leftRightCorrection()
        corrected.warpTrend = .inverse
        XCTAssertTrue(WarpMath.makeMesh(configuration: original).validation.isValid)
        let mesh = WarpMath.makeMesh(configuration: corrected, columns: 192, rows: 72)
        XCTAssertTrue(mesh.validation.isValid, mesh.validation.summary)
        let points: [SIMD2<Float>] = [SIMD2(0.1, 0.5), SIMD2(0.9, 0.5)]
        let before = WarpMath.physicalPoints(canvasPoints: points, configuration: original)
        let after = WarpMath.physicalPoints(canvasPoints: points, configuration: corrected)
        XCTAssertLessThan(after[0].y, before[0].y)
        XCTAssertGreaterThan(after[1].y, before[1].y)
    }

    func testExistingLocalCorrectionStillAddsToBezierInPhysicalPixels() {
        let original = leftRightCorrection().preparedForLocalEditing()
        var combined = original
        combined.localWarp.enabled = true
        let point = SIMD2<Float>(0.125, 0.5)
        combined.localWarp.setOffset(SIMD2(1.5, -2.5), at: combined.localCoordinate(at: point))
        let before = WarpMath.physicalPoints(canvasPoints: [point], configuration: original)[0]
        let after = WarpMath.physicalPoints(canvasPoints: [point], configuration: combined)[0]
        XCTAssertEqual(after.x - before.x, 1.5, accuracy: 0.002)
        XCTAssertEqual(after.y - before.y, -2.5, accuracy: 0.002)
        XCTAssertEqual(combined.bezierWarp, original.bezierWarp)
        let mesh = WarpMath.makeMesh(configuration: combined, columns: 192, rows: 72)
        XCTAssertTrue(mesh.validation.isValid, mesh.validation.summary)
    }

    func testRawReflectionAndAAComparisonBypassNewLayersWithoutDiscardingControls() {
        var configuration = leftRightCorrection()
        configuration.alignment.centerHorizontal = true
        configuration.alignment.centerVertical = true
        configuration.alignment.level = true
        configuration.alignment.snapTilt = true
        configuration.alignment.snapHorizontalBend = true
        for preview in [configuration.rawReflectionCalibrationConfiguration(), configuration.antiAliasingComparisonConfiguration()] {
            XCTAssertFalse(preview.bezierWarp.enabled)
            XCTAssertEqual(preview.bezierWarp.nodes, configuration.bezierWarp.nodes)
            XCTAssertEqual(preview.alignment, WarpAlignmentConfiguration())
            var uncorrected = preview
            uncorrected.bezierWarp = BezierWarpConfiguration()
            uncorrected.alignment = WarpAlignmentConfiguration()
            XCTAssertEqual(
                WarpMath.makeMesh(configuration: preview).vertices.map(\.position),
                WarpMath.makeMesh(configuration: uncorrected).vertices.map(\.position)
            )
        }
        XCTAssertTrue(configuration.bezierWarp.enabled)
        XCTAssertTrue(configuration.alignment.level)
    }

    func testRoundTripPreservesFullBezierSurfaceAndAlignment() throws {
        var configuration = leftRightCorrection()
        XCTAssertTrue(configuration.bezierWarp.insertColumn(at: 0.125))
        XCTAssertTrue(configuration.bezierWarp.insertRow(at: 0.25))
        configuration.alignment.centerHorizontal = true
        configuration.alignment.centerVertical = true
        configuration.alignment.level = true
        configuration.alignment.snapTilt = true
        configuration.alignment.snapHorizontalBend = true
        let decoded = try JSONDecoder().decode(WarpConfiguration.self, from: JSONEncoder().encode(configuration))
        XCTAssertEqual(decoded, configuration)
        let samples = [SIMD2<Float>(0.1, 0.3), SIMD2(0.5, 0.7), SIMD2(0.9, 0.4)]
        assertPointsEqual(
            WarpMath.physicalPoints(canvasPoints: samples, configuration: decoded),
            WarpMath.physicalPoints(canvasPoints: samples, configuration: configuration)
        )
    }

    private func assertAligned(_ configuration: WarpConfiguration, file: StaticString = #filePath, line: UInt = #line) {
        let mesh = WarpMath.makeMesh(configuration: configuration, columns: 192, rows: 72)
        XCTAssertTrue(mesh.validation.isValid, mesh.validation.summary, file: file, line: line)
        let physical = mesh.vertices.map {
            SIMD2(($0.position.x + 1) * 0.5 * Float(configuration.displayPixelWidth),
                  (1 - $0.position.y) * 0.5 * Float(configuration.displayPixelHeight))
        }
        let minimum = physical.reduce(SIMD2<Float>(repeating: .greatestFiniteMagnitude)) { simd_min($0, $1) }
        let maximum = physical.reduce(SIMD2<Float>(repeating: -.greatestFiniteMagnitude)) { simd_max($0, $1) }
        let center = (minimum + maximum) * 0.5
        let aa = configuration.aaRect
        XCTAssertEqual(Double(center.x), (aa.x + aa.width * 0.5) * Double(configuration.displayPixelWidth), accuracy: 0.1, file: file, line: line)
        XCTAssertEqual(Double(center.y), (aa.y + aa.height * 0.5) * Double(configuration.displayPixelHeight), accuracy: 0.1, file: file, line: line)
        let endpoints = WarpMath.physicalPoints(canvasPoints: [SIMD2(0, 0.5), SIMD2(1, 0.5)], configuration: configuration)
        XCTAssertEqual(endpoints[0].y, endpoints[1].y, accuracy: 0.002, file: file, line: line)
    }

    func testGeometricAlignmentCentersAndLevelsFinalMeshWhilePreservingCurvedShape() {
        let original = leftRightCorrection()
        var aligned = original
        aligned.alignment.centerHorizontal = true
        aligned.alignment.centerVertical = true
        aligned.alignment.level = true
        assertAligned(aligned)
        XCTAssertEqual(aligned.manual, original.manual)
        XCTAssertEqual(aligned.bezierWarp, original.bezierWarp)
        let samples: [SIMD2<Float>] = [SIMD2(0, 0.5), SIMD2(1, 0.5), SIMD2(0.5, 0.5), SIMD2(0.125, 0.25), SIMD2(0.875, 0.75)]
        let before = WarpMath.physicalPoints(canvasPoints: samples, configuration: original)
        let after = WarpMath.physicalPoints(canvasPoints: samples, configuration: aligned)
        for first in samples.indices {
            for second in samples.indices where second > first {
                XCTAssertEqual(simd_distance(before[first], before[second]), simd_distance(after[first], after[second]), accuracy: 0.01, "居正应为刚体变换，不能拉直/缩放已有曲面")
            }
        }
        XCTAssertGreaterThan(abs(after[2].y - after[0].y), 10, "对齐后中线应仍有弧度，不能被压成直线")
    }

    func testAlignmentRecomputesAfterGlobalAndRegionalEditsAndAAChange() {
        var configuration = leftRightCorrection()
        configuration.alignment.centerHorizontal = true
        configuration.alignment.centerVertical = true
        configuration.alignment.level = true
        assertAligned(configuration)
        configuration.manual.tilt += 0.012
        XCTAssertTrue(configuration.bezierWarp.applyOffsetDelta(SIMD2(4, 9), at: configuration.bezierWarp.columns - 1))
        configuration.aaRect = NormalizedRect(x: 0.12, y: 0.2, width: 0.7, height: 0.55)
        assertAligned(configuration)
    }

    func testFoldedBezierSurfaceIsRejectedEvenWhenControlValuesAreInRange() {
        var configuration = baseline()
        configuration.manual.enabled = false
        configuration.bezierWarp.enabled = true
        let middleIndex = configuration.bezierWarp.columns + configuration.bezierWarp.columns / 2
        configuration.bezierWarp.nodes[middleIndex].offset.y = -1000
        XCTAssertTrue(configuration.validationErrors().isEmpty, "这是数值合法但几何折叠的配置")
        let mesh = WarpMath.makeMesh(configuration: configuration, columns: 192, rows: 72)
        XCTAssertFalse(mesh.validation.isValid)
        XCTAssertGreaterThan(mesh.validation.foldedCellCount, 0)
    }

    func testInvalidBezierNumbersCannotReachAnAcceptedMesh() {
        var configuration = leftRightCorrection()
        configuration.bezierWarp.nodes[0].tangentU.y = .nan
        XCTAssertFalse(configuration.validationErrors().isEmpty)
        let mesh = WarpMath.makeMesh(configuration: configuration)
        XCTAssertFalse(mesh.validation.isValid)
        XCTAssertGreaterThan(mesh.validation.nonFiniteSampleCount, 0)
    }

    private final class LiveFixture {
        let suite = "NIOWarp.BezierIntegration.\(UUID().uuidString)"
        let defaults: UserDefaults
        let store: ConfigurationStore
        let history: ConfigurationHistoryStore
        let renderer: WarpRenderer
        let panel: ControlPanelController

        init(configuration: WarpConfiguration) throws {
            _ = NSApplication.shared
            guard MTLCreateSystemDefaultDevice() != nil else { throw XCTSkip("需要 Metal 设备") }
            defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
            store = ConfigurationStore(defaults: defaults)
            history = ConfigurationHistoryStore(defaults: defaults)
            store.save(configuration)
            renderer = try XCTUnwrap(WarpRenderer(view: MTKView(frame: .zero), frameStore: LatestFrameStore(), configuration: configuration))
            panel = ControlPanelController(renderer: renderer, store: store, configuration: configuration, sourceScreen: nil, outputScreen: nil,
                setWarpVisible: { _ in XCTFail("调整不应改变输出显隐") }, isWarpVisible: { true },
                applyCaptureConfiguration: { _ in XCTFail("调整不应重启捕获") }, updateAABoundary: { _, _ in }, updateWarpBoundary: { _, _ in },
                presentWindow: false, historyStore: history, presetStore: PresetStore(defaults: defaults), accessSession: authorizedWorkbenchAccessSession())
        }

        deinit { panel.close(); defaults.removePersistentDomain(forName: suite) }

        func controls() throws -> [NSControl] {
            func descendants(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(descendants) }
            let content = try XCTUnwrap(panel.window?.contentView)
            let tabs = try XCTUnwrap(descendants(content).compactMap { $0 as? NSTabView }.first)
            return tabs.tabViewItems.compactMap(\.view).flatMap(descendants).compactMap { $0 as? NSControl }
        }
    }

    func testRealSlidersSnapNearZeroOnlyWhenTheirCheckboxIsEnabled() throws {
        let fixture = try LiveFixture(configuration: baseline())
        let controls = try fixture.controls()
        func verify(action: String, title: String, threshold: Double, parameter: KeyPath<WarpConfiguration, Double>) throws {
            let slider = try XCTUnwrap(controls.compactMap { $0 as? NSSlider }.first { $0.action == NSSelectorFromString(action) })
            let checkbox = try XCTUnwrap(controls.compactMap { $0 as? NSButton }.first { $0.title == title })
            func move(_ value: Double) {
                slider.doubleValue = value
                slider.sendAction(NSSelectorFromString(action), to: slider.target)
            }
            XCTAssertEqual(checkbox.state, .off)
            move(threshold * 0.5)
            XCTAssertEqual(fixture.store.offlineConfiguration()[keyPath: parameter], threshold * 0.5, accuracy: 1e-12)
            checkbox.performClick(nil)
            XCTAssertEqual(fixture.store.offlineConfiguration()[keyPath: parameter], 0, "开启吸附应立即对当前近零值归零")
            move(-threshold * 0.5)
            XCTAssertEqual(fixture.renderer.activeConfiguration[keyPath: parameter], 0)
            XCTAssertEqual(slider.doubleValue, 0)
            move(threshold * 1.5)
            XCTAssertEqual(fixture.store.offlineConfiguration()[keyPath: parameter], threshold * 1.5, accuracy: 1e-12)
            checkbox.performClick(nil)
            move(-threshold * 0.5)
            XCTAssertEqual(fixture.renderer.activeConfiguration[keyPath: parameter], -threshold * 0.5, accuracy: 1e-12)
            XCTAssertEqual(fixture.store.offlineConfiguration()[keyPath: parameter], -threshold * 0.5, accuracy: 1e-12)
        }
        try verify(action: "updateTilt:", title: "倾斜零点吸附", threshold: 0.002, parameter: \.manual.tilt)
        try verify(action: "updateHorizontalBend:", title: "水平弯曲零点吸附", threshold: 0.001, parameter: \.manual.horizontalBend)
    }

    func testRejectedBezierCandidateRetainsRendererStoreAndHistoryThenAllowsSafeEdit() throws {
        var configuration = baseline()
        configuration.manual.enabled = false
        configuration.bezierWarp.enabled = true
        configuration.bezierWarp.scope = .region
        configuration.bezierWarp.linkage = .gradient
        configuration.bezierWarp.horizontalRadius = 0.2
        configuration.bezierWarp.verticalRadius = 0.2
        let fixture = try LiveFixture(configuration: configuration)
        let editor = fixture.panel.showBezierEditor(presentWindow: false)
        let selected = configuration.bezierWarp.columns + configuration.bezierWarp.columns / 2
        editor.selectNode(selected)
        let revision = fixture.renderer.meshRevision
        let vertices = try XCTUnwrap(fixture.renderer.currentMesh).vertices.map(\.position)
        editor.nudge(dx: 0, dy: -1000)
        let rejectedDeadline = Date().addingTimeInterval(8)
        while !editor.statusText.contains("未应用"), Date() < rejectedDeadline {
            RunLoop.current.run(until: Date().addingTimeInterval(0.01))
        }
        XCTAssertTrue(editor.statusText.contains("未应用"), editor.statusText)
        XCTAssertEqual(fixture.renderer.meshRevision, revision)
        XCTAssertEqual(try XCTUnwrap(fixture.renderer.currentMesh).vertices.map(\.position), vertices)
        XCTAssertEqual(fixture.store.offlineConfiguration(), configuration)
        XCTAssertEqual(fixture.renderer.activeConfiguration, configuration)
        XCTAssertEqual(fixture.panel.configurationForOfflinePreview, configuration)
        XCTAssertEqual(editor.draftConfiguration, configuration)
        XCTAssertEqual(fixture.history.count, 0)

        editor.nudge(dx: 0, dy: -1)
        let acceptedDeadline = Date().addingTimeInterval(8)
        while fixture.renderer.meshRevision == revision, Date() < acceptedDeadline {
            RunLoop.current.run(until: Date().addingTimeInterval(0.01))
        }
        XCTAssertEqual(fixture.store.offlineConfiguration().bezierWarp.nodes[selected].offset.y, -1)
        XCTAssertEqual(fixture.history.count, 1)
        XCTAssertTrue(try XCTUnwrap(fixture.renderer.currentMesh).validation.isValid)
    }

    func testNavigationPreservesPendingValidationAndLocksOtherGeometryUntilCompletion() throws {
        var configuration = leftRightCorrection().preparedForLocalEditing()
        configuration.localWarp.enabled = true
        let fixture = try LiveFixture(configuration: configuration)
        let bezier = fixture.panel.showBezierEditor(presentWindow: false)
        let local = fixture.panel.showLocalEditor(presentWindow: false)
        bezier.selectNode(0)
        local.select(.zero)
        let initialRevision = fixture.renderer.meshRevision

        // Navigation remains available, but a second layer cannot race an unfinished baseline.
        bezier.nudge(dx: 0, dy: -3)
        fixture.panel.selectModule("quality")
        fixture.panel.selectModule("local")
        local.nudge(dx: 1, dy: -1)
        fixture.panel.selectModule("protopie")
        XCTAssertEqual(fixture.panel.selectedModuleIdentifier, "protopie")
        let firstDeadline = Date().addingTimeInterval(8)
        while fixture.renderer.meshRevision == initialRevision, Date() < firstDeadline {
            RunLoop.current.run(until: Date().addingTimeInterval(0.01))
        }
        RunLoop.current.run(until: Date().addingTimeInterval(0.1))
        let firstApplied = fixture.store.offlineConfiguration()
        var expectedBezier = configuration.bezierWarp
        XCTAssertTrue(expectedBezier.applyOffsetDelta(SIMD2(0, -3), at: 0))
        XCTAssertEqual(firstApplied.bezierWarp, expectedBezier, "切模块不得取消已经提交的贝塞尔校验")
        XCTAssertEqual(firstApplied.localWarp, configuration.localWarp, "校验期间不接受第二层的并发几何修改")
        XCTAssertEqual(fixture.renderer.meshRevision, initialRevision + 1)
        XCTAssertEqual(fixture.history.count, 1)

        fixture.panel.selectModule("local")
        local.select(.zero)
        local.nudge(dx: 2, dy: -1)
        fixture.panel.selectModule("canvas")
        let secondDeadline = Date().addingTimeInterval(8)
        while fixture.renderer.meshRevision == initialRevision + 1, Date() < secondDeadline {
            RunLoop.current.run(until: Date().addingTimeInterval(0.01))
        }
        let secondApplied = fixture.store.offlineConfiguration()
        XCTAssertEqual(secondApplied.localWarp.anchors.first?.offset, SIMD2(2, -1))
        XCTAssertEqual(secondApplied.bezierWarp, firstApplied.bezierWarp)
        XCTAssertEqual(fixture.renderer.meshRevision, initialRevision + 2)
        XCTAssertEqual(fixture.history.count, 2)
        XCTAssertEqual(fixture.renderer.activeConfiguration, secondApplied)
        XCTAssertEqual(fixture.panel.selectedModuleIdentifier, "canvas")
    }
}
