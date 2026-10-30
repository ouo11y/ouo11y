// swift-tools-version:5.9
import PackageDescription

// UIKit and SwiftUI apps for the W8 simulator run (../w8-native-sim.sh), in the three shapes an app
// can have: no scenes (OuoSimApp), a scene delegate (OuoSimScene, every new Xcode project) and a
// SwiftUI `App` (OuoSimSwiftUI). Not shipped; the example app is W8 part 2.
let package = Package(
    name: "OuoSimApp",
    platforms: [.iOS(.v15)],
    dependencies: [.package(path: "../../../../../sdk/ios")],
    targets: [
        .target(name: "SimKit", dependencies: [.product(name: "OuoSDK", package: "ios")]),
        .executableTarget(name: "OuoSimApp", dependencies: ["SimKit"]),
        .executableTarget(name: "OuoSimScene", dependencies: ["SimKit"]),
        .executableTarget(name: "OuoSimSwiftUI", dependencies: ["SimKit"]),
    ]
)
