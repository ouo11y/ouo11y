// Scripted real-tap journey for the overhead measurement (scripts/perf/run.sh).
//
// Real UIKit touches through XCUITest, on a fixed schedule measured from the launch, so every run
// does the same thing at the same time whatever the SDK mix. Taps go to fixed coordinates
// (points on the 402x874 iPhone 18 Pro, Home screen layout of examples/sentry-mobile) instead of
// element queries: every XCUITest element query makes the app build an accessibility snapshot,
// which would add app CPU that has nothing to do with the SDKs.
//
// The coordinates were calibrated on the 402 pt wide iPhone 18 Pro simulator. Taps at x = 201 are row
// centres and move with the screen's centre; header back buttons are left-aligned and keep their x.
// PERF_DY shifts every y (points) for a device whose safe area or header differs; calibrate it from
// a screenshot and check each tap's backend request (project/kb/sdk-overhead-ios.md).
//
// Environment (xcodebuild passes TEST_RUNNER_<name> as <name>):
//   PERF_SECONDS   length of the run from the launch (default 95)
//   PERF_JOURNEY   `taps` (default), `loop` (repeat the taps every PERF_LOOP_PERIOD seconds, default 80,
//                  until PERF_SECONDS: the memory soak) or `idle` (launch, no taps)
//   PERF_DY        vertical offset in points (default 0)
// The harness writes Documents/perf-mode.json before this runs.
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

    private var dy = 0.0
    private var centreX = 201.0

    private func point(_ x: Double, _ y: Double) -> XCUICoordinate {
        let px = x == 201 ? centreX : x
        return app.coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 0)).withOffset(CGVector(dx: px, dy: y + dy))
    }

    /// Device runs only (bench.py Device.reset): the first launch after an install asks for the
    /// Local Network permission (the SDKs and the backend are on the Mac's LAN IP), and every
    /// request waits until it is answered. Launch once with no SDK, allow it in Springboard's
    /// alert, quit; the measured launch that follows is a cold start with the permission granted.
    func testPrime() {
        app.launch()
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let allow = springboard.buttons.matching(NSPredicate(format: "label IN %@", ["Allow", "OK"])).firstMatch
        if allow.waitForExistence(timeout: 15) {
            allow.tap()
            print("PERF prime allowed local network")
        } else {
            print("PERF prime no alert")
        }
        Thread.sleep(forTimeInterval: 4)
        app.terminate()
    }

    func testJourney() {
        let env = ProcessInfo.processInfo.environment
        let seconds = Double(env["PERF_SECONDS"] ?? "") ?? 95
        let journey = env["PERF_JOURNEY"] ?? "taps"
        let period = Double(env["PERF_LOOP_PERIOD"] ?? "") ?? 80
        dy = Double(env["PERF_DY"] ?? "") ?? 0
        let t0 = Date()
        print("PERF launch_request_ms=\(Int(t0.timeIntervalSince1970 * 1000))")
        app.launch()
        print("PERF launch_returned_s=\(String(format: "%.3f", Date().timeIntervalSince(t0)))")
        // One query after launch, before the first tap, for the screen width (the same in every cell).
        centreX = Double(app.windows.firstMatch.frame.width) / 2
        print("PERF screen_width=\(centreX * 2) dy=\(dy) journey=\(journey)")
        var plan: [(Double, Step, String)] = []
        if journey == "taps" {
            plan = schedule
        } else if journey == "loop" {
            var cycle = 0.0
            while cycle + 80 <= seconds {
                plan += schedule.map { ($0.0 + cycle, $0.1, $0.2) }
                cycle += period
            }
        }
        for (at, step, label) in plan {
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
