// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "NIOWarpApp",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "NIOWarpApp", targets: ["NIOWarpApp"]),
    ],
    targets: [
        .executableTarget(
            name: "NIOWarpApp",
            path: "Sources/NIOWarpApp"
        ),
    ],
    swiftLanguageModes: [.v5]
)
