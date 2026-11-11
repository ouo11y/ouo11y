// swift-tools-version:5.9
import PackageDescription

// OuoReplay: iOS session replay capture for ouo (ADR-0006, docs/specs/mobile-replay.md).
//
// Targets:
//  - OuoReplayCore is pure Swift + Foundation (+ zlib): chunk models, chunk builder, seq store,
//    frame dedupe, redaction geometry, gzip and the uploader. It builds and tests on macOS with
//    only the Command Line Tools installed.
//  - OuoReplay depends on UIKit for the capture itself (window snapshot, view walk, touches).
//    Without UIKit (macOS) it compiles to a stub so `swift build` succeeds everywhere.
//  - OuoCrash (Swift) on OuoCrashCore (C): native crash capture, signals and uncaught NSExceptions,
//    written to disk at crash time and sent on the next launch by the host SDK. Tested on macOS by
//    crashing the OuoCrashProbe executable.
//  - OuoVitals (Swift) on OuoVitalsCore (C): app start and frame counters for the mobile vitals.
//  - OuoSDK: the SDK for native apps (`Ouo.start`): sessions, OTLP/JSON export with a durable
//    outbox, the URLSession hook, and the three packages above wired into one entry point
//    (ADR-0016: no opentelemetry-swift). Its pure parts test on macOS.
let package = Package(
    // Named after the mirror repo github.com/ouo11y/ouo11y-ios (ADR-0009). SwiftPM's package identity
    // comes from the URL or path, so apps write `package: "ouo11y-ios"` for the mirror and
    // `package: "ios"` for a local `.package(path: ".../sdk/ios")`.
    name: "ouo11y-ios",
    platforms: [.iOS(.v15), .macOS(.v13)],
    products: [
        .library(name: "OuoReplay", targets: ["OuoReplay"]),
        .library(name: "OuoReplayCore", targets: ["OuoReplayCore"]),
        .library(name: "OuoReplaySentryCore", targets: ["OuoReplaySentryCore"]),
        .library(name: "OuoCrash", targets: ["OuoCrash"]),
        .library(name: "OuoVitals", targets: ["OuoVitals"]),
        .library(name: "OuoSDK", targets: ["OuoSDK"]),
    ],
    targets: [
        .target(
            name: "OuoReplayCore",
            linkerSettings: [.linkedLibrary("z")]
        ),
        .target(
            name: "OuoReplay",
            dependencies: ["OuoReplayCore", "OuoReplaySentryCore"]
        ),
        // Spike: sentry-cocoa's session-replay recorder core (MIT), copied by
        // scripts/sentry-core-sync.sh into Upstream/ and driven by SentryCoreRecorder. OuoReplay
        // uses it when `OuoReplayConfig.recorder` is `.sentryVideo`. The ObjC target holds the one
        // Objective-C helper it needs (catching a Core Animation NSException while redacting).
        .target(name: "OuoReplaySentryCoreObjC"),
        .target(
            name: "OuoReplaySentryCore",
            dependencies: ["OuoReplaySentryCoreObjC"],
            exclude: ["UPSTREAM_TAG"]
        ),
        // Native crash capture (checklist G1): async-signal-safe C handlers plus the Swift API.
        .target(name: "OuoCrashCore"),
        // Hangs and foreground terminations (W4) are reported through OuoCrash: the hang watchdog
        // runs on OuoVitals' display link frames.
        .target(
            name: "OuoCrash",
            dependencies: ["OuoCrashCore", "OuoVitals"]
        ),
        // Mobile vitals (checklist G2): process start and image load time (C), display link frame
        // counters and the cold/warm decision (Swift). Without UIKit the frame tracker is left out.
        .target(name: "OuoVitalsCore"),
        .target(
            name: "OuoVitals",
            dependencies: ["OuoVitalsCore"]
        ),
        .target(
            name: "OuoSDK",
            dependencies: ["OuoReplay", "OuoCrash", "OuoVitals"],
            // The privacy manifest of the whole package (an app links all four through OuoSDK).
            resources: [.copy("PrivacyInfo.xcprivacy")]
        ),
        // The Objective-C surface of OuoSDK, compiled (not run) for iOS by CI: a call of every
        // public method, so a change that drops one from Objective-C fails the build.
        .target(name: "OuoObjCSmoke", dependencies: ["OuoSDK"]),
        .testTarget(
            name: "OuoSDKTests",
            dependencies: ["OuoSDK"]
        ),
        .testTarget(
            name: "OuoVitalsTests",
            dependencies: ["OuoVitals"]
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
