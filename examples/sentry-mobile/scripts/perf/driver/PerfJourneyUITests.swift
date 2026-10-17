// Scripted real-tap journey for the overhead measurement (scripts/perf/run.sh).
//
// Real UIKit touches through XCUITest, on a fixed schedule measured from the launch, so every run
// does the same thing at the same time whatever the SDK mix. Taps go to fixed coordinates
// (points on the 402x874 iPhone 18 Pro, Home screen layout of examples/sentry-mobile) instead of
// element queries: every XCUITest element query makes the app build an accessibility snapshot,
// which would add app CPU that has nothing to do with the SDKs.
//
// Environment (xcodebuild passes TEST_RUNNER_<name> as <name>): PERF_SECONDS, the length of the run
// from the launch (default 95). The harness writes Documents/perf-mode.json before this runs.
import XCTest

final class PerfJourneyUITests: XCTestCase {
    private let app = XCUIApplication(bundleIdentifier: "dev.ouo.sentrydemo")

    private enum Step {
        case tap(Double, Double)
        case swipe(from: (Double, Double), to: (Double, Double))
    }

    // (seconds after launch, step, label). Home: product rows, Open cart, shop flows, network,
    // errors. Product: Add to cart, Go to cart. Header back buttons at (73, 84) / (92, 84).
    private let schedule: [(Double, Step, String)] = [
        (6, .tap(201, 418), "browse-catalog"),
        (10, .tap(201, 463), "search"),
        (14, .tap(201, 219), "product p-1001"),
        (18, .tap(201, 239), "add to cart"),
        (21, .tap(201, 285), "go to cart"),
        (25, .tap(73, 84), "back to product"),
        (28, .tap(92, 84), "back to home"),
        (31, .tap(201, 508), "checkout"),
        (35, .tap(201, 629), "fetch-ok"),
        (39, .swipe(from: (300, 700), to: (300, 400)), "scroll down (moves the list ~255 pt: touch slop)"),
        (43, .tap(201, 419), "fetch-500"),
        (47, .tap(201, 509), "xhr-cart"),
        (51, .tap(201, 586), "handled-error"),
        (55, .tap(201, 676), "message"),
        (59, .swipe(from: (300, 300), to: (300, 760)), "scroll to top"),
        (63, .tap(201, 418), "browse-catalog"),
        (67, .tap(201, 259), "product p-1002"),
        (71, .tap(201, 239), "add to cart"),
        (74, .tap(92, 84), "back to home"),
    ]

    override func setUp() {
        continueAfterFailure = true
    }

    private func point(_ x: Double, _ y: Double) -> XCUICoordinate {
        app.coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 0)).withOffset(CGVector(dx: x, dy: y))
    }

    func testJourney() {
        let seconds = Double(ProcessInfo.processInfo.environment["PERF_SECONDS"] ?? "") ?? 95
        let t0 = Date()
        print("PERF launch_request_ms=\(Int(t0.timeIntervalSince1970 * 1000))")
        app.launch()
        print("PERF launch_returned_s=\(String(format: "%.3f", Date().timeIntervalSince(t0)))")
        for (at, step, label) in schedule {
            let wait = at - Date().timeIntervalSince(t0)
            if wait > 0 { Thread.sleep(forTimeInterval: wait) }
            switch step {
            case let .tap(x, y):
                point(x, y).tap()
            case let .swipe(from, to):
                // Hold at the end so the list stops where the finger stops (no momentum): the taps after a
                // scroll hit known positions.
                point(from.0, from.1).press(forDuration: 0.05, thenDragTo: point(to.0, to.1), withVelocity: .slow, thenHoldForDuration: 0.4)
            }
            print("PERF step t=\(String(format: "%.2f", Date().timeIntervalSince(t0))) planned=\(at) \(label)")
        }
        let rest = seconds - Date().timeIntervalSince(t0)
        if rest > 0 { Thread.sleep(forTimeInterval: rest) }
        print("PERF end t=\(String(format: "%.2f", Date().timeIntervalSince(t0)))")
    }
}
