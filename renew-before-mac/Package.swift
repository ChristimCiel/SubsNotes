// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "RenewBefore",
    defaultLocalization: "en",
    platforms: [.macOS(.v14)],
    products: [.library(name: "RenewCore", targets: ["RenewCore"])],
    targets: [
        .target(name: "RenewCore", path: "Core", resources: [.process("Resources")]),
        .testTarget(name: "RenewCoreTests", dependencies: ["RenewCore"], path: "Tests")
    ]
)
