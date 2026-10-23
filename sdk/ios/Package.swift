// swift-tools-version:5.9
import PackageDescription

// OuoReplay: iOS session replay capture for ouo (ADR-0006, docs/specs/mobile-replay.md).
//
// Two targets on purpose:
//  - OuoReplayCore is pure Swift + Foundation (+ zlib): chunk models, chunk builder, seq store,
//    frame dedupe, redaction geometry, gzip and the uploader. It builds and tests on macOS with
//    only the Command Line Tools installed.
//  - OuoReplay depends on UIKit for the capture itself (window snapshot, view walk, touches).
//    Without UIKit (macOS) it compiles to a stub so `swift build` succeeds everywhere.
//  - OuoCrash (Swift) on OuoCrashCore (C): native crash capture, signals and uncaught NSExceptions,
//    written to disk at crash time and sent on the next launch by the host SDK. Tested on macOS by
//    crashing the OuoCrashProbe executable.
let package = Package(
    // Named after the mirror repo github.com/ouo11y/ouo11y-ios (ADR-0009). SwiftPM's package identity
    // comes from the URL or path, so apps write `package: "ouo11y-ios"` for the mirror and
    // `package: "ios"` for a local `.package(path: ".../sdk/ios")`.
    name: "ouo11y-ios",
    platforms: [.iOS(.v15), .macOS(.v13)],
    products: [
        .library(name: "OuoReplay", targets: ["OuoReplay"]),
        .library(name: "OuoReplayCore", targets: ["OuoReplayCore"]),
        .library(name: "OuoCrash", targets: ["OuoCrash"]),
    ],
    targets: [
        .target(
            name: "OuoReplayCore",
            linkerSettings: [.linkedLibrary("z")]
        ),
        .target(
            name: "OuoReplay",
            dependencies: ["OuoReplayCore"]
        ),
        // Native crash capture (checklist G1): async-signal-safe C handlers plus the Swift API.
        .target(name: "OuoCrashCore"),
        .target(
            name: "OuoCrash",
            dependencies: ["OuoCrashCore"]
        ),
        // Test helper: a process that installs the handlers and crashes on purpose.
        .executableTarget(
            name: "OuoCrashProbe",
            dependencies: ["OuoCrash"]
        ),
        .testTarget(
            name: "OuoCrashTests",
            dependencies: ["OuoCrash", "OuoCrashProbe"]
        ),
        .testTarget(
            name: "OuoReplayCoreTests",
            dependencies: ["OuoReplayCore"],
            resources: [.copy("Fixtures")]
        ),
    ]
)
