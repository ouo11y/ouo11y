// swift-tools-version:5.9
import PackageDescription

// The native iOS example (W8): a UIKit app with a SwiftUI screen, on the `OuoSDK` product of
// sdk/ios. A SwiftPM executable that scripts/build.sh wraps into an .app for the simulator, so the
// repository needs no Xcode project. Its journeys are the native iOS conformance suite
// (tests/e2e/mobile-native/).
let package = Package(
    name: "OuoExample",
    platforms: [.iOS(.v15)],
    dependencies: [.package(path: "../../sdk/ios")],
    targets: [
        .executableTarget(name: "OuoExample", dependencies: [.product(name: "OuoSDK", package: "ios")]),
    ]
)
