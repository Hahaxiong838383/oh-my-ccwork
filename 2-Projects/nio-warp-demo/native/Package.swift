// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "NIOWarpApp",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "NIOWarpApp", targets: ["NIOWarpApp"]),
    ],
    targets: [
        .target(
            name: "NIOVirtualDisplay",
            path: "Sources/NIOVirtualDisplay",
            publicHeadersPath: "include",
            cSettings: [.unsafeFlags(["-fobjc-arc"])],
            linkerSettings: [.linkedFramework("Foundation"), .linkedFramework("CoreGraphics")]
        ),
        .executableTarget(
            name: "NIOWarpApp",
            dependencies: ["NIOVirtualDisplay"],
            path: "Sources/NIOWarpApp"
        ),
        .testTarget(
            name: "NIOWarpAppTests",
            dependencies: ["NIOWarpApp", "NIOVirtualDisplay"],
            path: "Tests/NIOWarpAppTests"
        ),
    ],
    swiftLanguageModes: [.v5]
)
