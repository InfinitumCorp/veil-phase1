// swift-tools-version:5.9
// The gating rules below are Foundation-only so Linux CI can run them.
// The app links this package and Tor.framework; Tor itself is not started here.

import PackageDescription

let package = Package(
    name: "VeilLogic",
    products: [
        .library(name: "VeilLogic", targets: ["VeilLogic"]),
    ],
    targets: [
        .target(name: "VeilLogic"),
        .testTarget(name: "VeilLogicTests", dependencies: ["VeilLogic"]),
    ]
)
