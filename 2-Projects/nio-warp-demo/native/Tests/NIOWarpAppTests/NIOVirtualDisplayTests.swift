import CoreGraphics
import NIOVirtualDisplay
import XCTest
@testable import NIOWarpApp

final class NIOVirtualDisplayTests: XCTestCase {
    func testInvalidDimensionsAreRejectedBeforeCreatingAnyDisplay() {
        let invalid: [(UInt32, UInt32)] = [
            (0, 1), (1, 0), (16_385, 1), (1, 16_385),
            (16_384, 4_097), (8_193, 8_192), (.max, .max),
        ]
        for (width, height) in invalid {
            var error = [CChar](repeating: 0, count: 512)
            let handle = NIOVirtualDisplayCreate(width, height, &error, error.count)
            XCTAssertNil(handle, "无效尺寸 \(width)×\(height) 不能创建屏幕")
            XCTAssertTrue(String(cString: error).contains("尺寸"))
            NIOVirtualDisplayDestroy(handle)
        }
    }

    func testInvalidDimensionsAllowMissingOrTinyErrorBuffer() {
        XCTAssertNil(NIOVirtualDisplayCreate(0, 1, nil, 0))
        var terminator: CChar = 99
        XCTAssertNil(NIOVirtualDisplayCreate(0, 1, &terminator, 1))
        XCTAssertEqual(terminator, 0)
    }

    func testOwnedIdentityRequiresBothFieldsAndExcludesProbeAndPhysicalVendors() {
        XCTAssertTrue(NIOVirtualDisplayMatchesIdentity(0x4E49, 0x5752))
        let unrelated: [(UInt32, UInt32)] = [
            (505, 0x4E49), (505, 0x5752), // Temporary probe identities.
            (0x0610, 0x5752), (0x10AC, 0x5752), // Apple and Dell, even with same product.
            (0x4E49, 0), (0x4E49, 0x5751), (0, 0x5752), (0, 0),
        ]
        for (vendor, product) in unrelated {
            XCTAssertFalse(NIOVirtualDisplayMatchesIdentity(vendor, product))
        }
        XCTAssertFalse(NIOVirtualDisplayIsOwnedDisplay(kCGNullDirectDisplay))
    }

    func testNullHandleCanBeDestroyedAndCannotSelectOrReportADisplay() {
        NIOVirtualDisplayDestroy(nil)
        XCTAssertEqual(NIOVirtualDisplayGetDisplayID(nil), kCGNullDirectDisplay)
        var error = [CChar](repeating: 0, count: 512)
        XCTAssertEqual(NIOVirtualDisplaySelectExactMode(nil, &error, error.count), -1)
        XCTAssertTrue(String(cString: error).contains("已释放"))
        XCTAssertEqual(NIOVirtualDisplaySelectExactMode(nil, nil, 0), -1)
    }

    @MainActor
    func testSwiftOwnerRejectsInvalidSizesWithoutAllocatingOrOverflowing() async {
        let owner = OwnedPresentationDisplay()
        for (width, height) in [(Int.min, 1), (1, Int.max), (0, 0), (16_385, 1), (16_384, 4_097)] {
            do {
                _ = try await owner.ensure(width: width, height: height)
                XCTFail("无效尺寸不能进入虚拟显示器创建流程")
            } catch {
                XCTAssertTrue(error.localizedDescription.contains("尺寸"))
            }
            XCTAssertNil(owner.displayID)
        }
        owner.shutdown(); owner.shutdown()
        XCTAssertNil(owner.displayID)
    }
}
