// swift-tools-version:5.9
import PackageDescription

// A UIKit app for the W8 part 1 simulator run (../w8-native-sim.sh): the OuoSDK package as an app
// links it, driven by OUO_ACTION. Not shipped; the UIKit + SwiftUI example app is W8 part 2.
let package = Package(
    name: "OuoSimApp",
    platforms: [.iOS(.v15)],
    dependencies: [.package(path: "../../../../../sdk/ios")],
    targets: [
        .executableTarget(name: "OuoSimApp", dependencies: [.product(name: "OuoSDK", package: "ios")]),
    ]
)
