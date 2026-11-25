// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "WorkBuddyQQGateway",
    defaultLocalization: "zh-Hans",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .executable(
            name: "WorkBuddyQQGateway",
            targets: ["WorkBuddyQQGateway"]
        )
    ],
    targets: [
        .executableTarget(
            name: "WorkBuddyQQGateway",
            path: "Sources/WorkBuddyQQGateway"
        ),
        .testTarget(
            name: "WorkBuddyQQGatewayTests",
            dependencies: ["WorkBuddyQQGateway"],
            path: "Tests/WorkBuddyQQGatewayTests"
        )
    ]
)
