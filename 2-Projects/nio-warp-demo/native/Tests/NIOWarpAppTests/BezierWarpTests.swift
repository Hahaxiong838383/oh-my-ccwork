import XCTest
import simd
@testable import NIOWarpApp

final class BezierWarpTests: XCTestCase {
    private func editable(columns: Int = 5, rows: Int = 3) -> BezierWarpConfiguration {
        var configuration = BezierWarpConfiguration(columns: columns, rows: rows)
        configuration.enabled = true
        return configuration
    }

    private func assertVector(_ actual: SIMD2<Double>, _ expected: SIMD2<Double>, accuracy: Double = 1e-8, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(actual.x, expected.x, accuracy: accuracy, file: file, line: line)
        XCTAssertEqual(actual.y, expected.y, accuracy: accuracy, file: file, line: line)
    }

    func testDefaultAndDisabledFieldsDoNotMoveExistingWarp() {
        var configuration = editable()
        XCTAssertEqual(BezierWarpConfiguration(), BezierWarpConfiguration())
        for u in stride(from: 0.0, through: 1, by: 0.05) {
            for v in stride(from: 0.0, through: 1, by: 0.1) {
                XCTAssertEqual(configuration.displacement(at: SIMD2(u, v)), .zero)
            }
        }
        XCTAssertTrue(configuration.applyOffsetDelta(SIMD2(12, -20), at: 0))
        configuration.enabled = false
        XCTAssertEqual(configuration.displacement(at: .zero), .zero)
        XCTAssertTrue(configuration.hasEdits)
    }

    func testUniformLinkageMovesMultipleRowsAndLeavesOppositeSideAndCenterUnchanged() {
        var configuration = editable()
        configuration.horizontalRadius = 0.2
        XCTAssertTrue(configuration.applyOffsetDelta(SIMD2(3, -18), at: 0))
        for v in [0.0, 0.18, 0.5, 0.76, 1] {
            assertVector(configuration.displacement(at: SIMD2(0, v)), SIMD2(3, -18))
            assertVector(configuration.displacement(at: SIMD2(0.12, v)), configuration.displacement(at: SIMD2(0.12, 0)))
            assertVector(configuration.displacement(at: SIMD2(0.5, v)), .zero)
            assertVector(configuration.displacement(at: SIMD2(1, v)), .zero)
        }
        XCTAssertTrue(configuration.applyOffsetDelta(SIMD2(-2, 9), at: configuration.columns - 1))
        for v in [0.0, 0.3, 0.7, 1] {
            assertVector(configuration.displacement(at: SIMD2(0, v)), SIMD2(3, -18))
            assertVector(configuration.displacement(at: SIMD2(1, v)), SIMD2(-2, 9))
            assertVector(configuration.displacement(at: SIMD2(0.5, v)), .zero)
        }
    }

    func testGradientLinkageTapersThroughDepth() {
        var configuration = editable(rows: 5)
        configuration.linkage = .gradient
        configuration.horizontalRadius = 0.2
        XCTAssertTrue(configuration.applyOffsetDelta(SIMD2(0, -30), at: 0))
        let top = configuration.displacement(at: SIMD2(0, 0)).y
        let middle = configuration.displacement(at: SIMD2(0, 0.5)).y
        let bottom = configuration.displacement(at: SIMD2(0, 1)).y
        XCTAssertEqual(top, -30)
        XCTAssertEqual(middle, -15, accuracy: 1e-8)
        XCTAssertEqual(bottom, 0, accuracy: 1e-8)
        for v in stride(from: 0.0, through: 0.95, by: 0.05) {
            XCTAssertLessThanOrEqual(configuration.displacement(at: SIMD2(0, v)).y,
                                     configuration.displacement(at: SIMD2(0, v + 0.05)).y + 1e-8)
        }
    }

    func testRegionalUniformLinkageHasPlateauAndUnaffectedDistantRows() {
        var configuration = editable(rows: 7)
        configuration.scope = .region
        configuration.linkage = .uniform
        configuration.verticalRadius = 0.5
        XCTAssertTrue(configuration.applyOffsetDelta(SIMD2(0, -12), at: 2))
        assertVector(configuration.displacement(at: SIMD2(0.5, 0)), SIMD2(0, -12))
        assertVector(configuration.displacement(at: SIMD2(0.5, 1.0 / 6)), SIMD2(0, -12))
        assertVector(configuration.displacement(at: SIMD2(0.5, 0.8)), .zero)
        assertVector(configuration.displacement(at: SIMD2(0.5, 1)), .zero)
    }

    func testBezierHandleChangesIntermediateCurvatureOnEveryLinkedRowWithoutMovingNodes() {
        var configuration = editable()
        configuration.horizontalRadius = 0.2
        let before = configuration.nodes.map(\.offset)
        XCTAssertTrue(configuration.applyTangentDelta(SIMD2(0, 120), axis: .horizontal, at: 1))
        XCTAssertEqual(configuration.nodes.map(\.offset), before)
        let left = configuration.displacement(at: SIMD2(0.125, 0))
        let right = configuration.displacement(at: SIMD2(0.375, 0))
        XCTAssertLessThan(left.y, -0.1)
        XCTAssertGreaterThan(right.y, 0.1)
        for v in [0.0, 0.1, 0.5, 0.9, 1] {
            assertVector(configuration.displacement(at: SIMD2(0.125, v)), left)
            assertVector(configuration.displacement(at: SIMD2(0.375, v)), right)
            assertVector(configuration.displacement(at: SIMD2(0.75, v)), .zero)
        }
    }

    func testVerticalHandleChangesCurvatureAndRegionalBoundaryStaysSmooth() {
        var configuration = editable(rows: 5)
        configuration.scope = .region
        configuration.linkage = .gradient
        configuration.verticalRadius = 0.4
        XCTAssertTrue(configuration.applyTangentDelta(SIMD2(40, -20), axis: .vertical, at: 7))
        XCTAssertGreaterThan(simd_length(configuration.displacement(at: SIMD2(0.5, 0.35))), 0.1)
        assertVector(configuration.displacement(at: SIMD2(0.5, 0.9)), .zero)
        let field = BezierWarpField(configuration)
        for u in configuration.horizontalKnots.dropFirst().dropLast() {
            for v in [0.13, 0.31, 0.54] {
                assertVector(field.sample(at: SIMD2(u - 1e-9, v)).du, field.sample(at: SIMD2(u + 1e-9, v)).du, accuracy: 0.001)
            }
        }
    }

    func testSubdivisionPreservesArbitraryBicubicValuesAndAllFirstDerivatives() {
        var configuration = editable(columns: 3, rows: 3)
        for index in configuration.nodes.indices {
            let n = Double(index + 1)
            configuration.nodes[index].offset = SIMD2(sin(n) * 4, cos(n) * 3)
            configuration.nodes[index].tangentU = SIMD2(cos(n) * 10, sin(n) * 8)
            configuration.nodes[index].tangentV = SIMD2(sin(n * 2) * 7, cos(n * 2) * 9)
            configuration.nodes[index].mixedDerivative = SIMD2(n * 2, -n)
        }
        let before = BezierWarpField(configuration)
        let oldIDs = Set(configuration.nodes.map(\.id))
        XCTAssertTrue(configuration.insertColumn(at: 0.18))
        XCTAssertTrue(configuration.insertColumn(at: 0.67))
        XCTAssertTrue(configuration.insertRow(at: 0.38))
        XCTAssertTrue(configuration.insertRow(at: 0.91))
        XCTAssertTrue(oldIDs.isSubset(of: Set(configuration.nodes.map(\.id))))
        let after = BezierWarpField(configuration)
        for u in stride(from: 0.0, through: 1, by: 0.027) {
            for v in stride(from: 0.0, through: 1, by: 0.031) {
                let a = before.sample(at: SIMD2(u, v))
                let b = after.sample(at: SIMD2(u, v))
                assertVector(a.value, b.value)
                assertVector(a.du, b.du)
                assertVector(a.dv, b.dv)
                assertVector(a.duv, b.duv)
            }
        }
    }

    func testIncreasingCountsPreservesShapeAndDecreasingEditedGridRequiresExplicitReset() {
        var configuration = editable()
        XCTAssertTrue(configuration.applyOffsetDelta(SIMD2(4, -9), at: 0))
        XCTAssertTrue(configuration.applyTangentDelta(SIMD2(-12, 24), axis: .horizontal, at: 2))
        let before = BezierWarpField(configuration)
        XCTAssertTrue(configuration.resize(columns: 9, rows: 7))
        for u in stride(from: 0.0, through: 1, by: 0.031) {
            for v in [0.0, 0.27, 0.68, 1] {
                assertVector(configuration.displacement(at: SIMD2(u, v)), before.displacement(at: SIMD2(u, v)))
            }
        }
        let unchanged = configuration
        XCTAssertFalse(configuration.resize(columns: 3, rows: 3))
        XCTAssertEqual(configuration, unchanged)
        XCTAssertTrue(configuration.resize(columns: 3, rows: 3, allowReset: true))
        XCTAssertFalse(configuration.hasEdits)
        XCTAssertTrue(configuration.enabled)
    }

    func testDisabledSurfaceStillSubdividesWithoutLosingStoredCalibration() {
        var configuration = editable()
        XCTAssertTrue(configuration.applyOffsetDelta(SIMD2(7, -3), at: 0))
        let before = configuration
        configuration.enabled = false
        XCTAssertTrue(configuration.resize(columns: 7, rows: 5))
        configuration.enabled = true
        for u in [0.0, 0.17, 0.28, 0.48, 1] {
            assertVector(configuration.displacement(at: SIMD2(u, 0.34)), before.displacement(at: SIMD2(u, 0.34)))
        }
    }

    func testCodableRoundTripAndMissingNewBlockDefaults() throws {
        var configuration = editable()
        XCTAssertTrue(configuration.applyOffsetDelta(SIMD2(4, 9), at: 0))
        XCTAssertTrue(configuration.applyTangentDelta(SIMD2(-12, 24), axis: .horizontal, at: 2))
        configuration.scope = .region
        configuration.linkage = .gradient
        let data = try JSONEncoder().encode(configuration)
        XCTAssertEqual(try JSONDecoder().decode(BezierWarpConfiguration.self, from: data), configuration)
        let empty = try JSONDecoder().decode(BezierWarpConfiguration.self, from: Data("{}".utf8))
        XCTAssertFalse(empty.enabled)
        XCTAssertFalse(empty.hasEdits)
        XCTAssertEqual(empty.columns, 5)
        XCTAssertEqual(empty.rows, 3)
    }

    func testInvalidEditsAreAtomicAndDoNotCorruptStoredSurface() {
        var configuration = editable()
        let before = configuration
        XCTAssertFalse(configuration.applyOffsetDelta(SIMD2(.nan, 0), at: 0))
        XCTAssertFalse(configuration.applyOffsetDelta(SIMD2(0, 1001), at: 0))
        XCTAssertFalse(configuration.applyOffsetDelta(SIMD2(1, 2), at: -1))
        XCTAssertFalse(configuration.applyTangentDelta(SIMD2(0, .infinity), axis: .horizontal, at: 0))
        XCTAssertFalse(configuration.applyTangentDelta(SIMD2(20_001, 0), axis: .horizontal, at: 0))
        XCTAssertFalse(configuration.insertColumn(at: .nan))
        XCTAssertFalse(configuration.insertColumn(at: 0.00001))
        XCTAssertFalse(configuration.insertRow(at: 0.5))
        XCTAssertFalse(configuration.resize(columns: 10, rows: 3))
        XCTAssertEqual(configuration, before)
    }

    func testDecoderRejectsMalformedTopologyIdentifiersAndValues() throws {
        let configuration = editable()
        let base = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(configuration)) as? [String: Any])
        var cases = [[String: Any]]()
        var invalid = base; invalid["horizontalKnots"] = [0.0, 0.3, 0.3, 0.8, 1.0]; cases.append(invalid)
        invalid = base; invalid["horizontalKnots"] = [0.0, 0.8, 0.4, 0.9, 1.0]; cases.append(invalid)
        invalid = base; invalid["verticalKnots"] = [0.1, 0.5, 1.0]; cases.append(invalid)
        invalid = base; invalid["nodes"] = []; cases.append(invalid)
        invalid = base; invalid["horizontalRadius"] = 0; cases.append(invalid)
        invalid = base; invalid["scope"] = "unsupported"; cases.append(invalid)
        invalid = base; invalid.removeValue(forKey: "verticalKnots"); cases.append(invalid)
        var duplicate = configuration; duplicate.nodes[1].id = duplicate.nodes[0].id
        cases.append(try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(duplicate)) as? [String: Any]))
        var oversized = configuration; oversized.nodes[0].offset.x = 1001
        cases.append(try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(oversized)) as? [String: Any]))
        for value in cases {
            XCTAssertThrowsError(try JSONDecoder().decode(BezierWarpConfiguration.self, from: JSONSerialization.data(withJSONObject: value)))
        }
    }

    func testInvalidFieldAndNonFiniteInputProduceRejectedCoordinates() {
        var configuration = editable()
        configuration.nodes.removeLast()
        let field = BezierWarpField(configuration)
        XCTAssertNotNil(field.error)
        XCTAssertTrue(field.displacement(at: .zero).x.isNaN)
        let valid = BezierWarpField(editable())
        XCTAssertTrue(valid.displacement(at: SIMD2(.nan, 0)).x.isNaN)
    }

    func testResetClearsGeometryWithoutChangingControlsOrNodeIdentity() {
        var configuration = editable()
        configuration.scope = .region
        configuration.linkage = .gradient
        XCTAssertTrue(configuration.applyOffsetDelta(SIMD2(3, -7), at: 1))
        let ids = configuration.nodes.map(\.id)
        let knots = configuration.horizontalKnots
        configuration.resetDeformation()
        XCTAssertEqual(configuration.nodes.map(\.id), ids)
        XCTAssertEqual(configuration.horizontalKnots, knots)
        XCTAssertEqual(configuration.scope, .region)
        XCTAssertEqual(configuration.linkage, .gradient)
        XCTAssertFalse(configuration.hasEdits)
    }
}
