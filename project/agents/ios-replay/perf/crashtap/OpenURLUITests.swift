// Launches sentry-demo, lets it run OUO_WAIT seconds (TEST_RUNNER_OUO_WAIT, default 10), then opens
// the deep link OUO_URL and confirms iOS 27's "Open in …?" sheet, which `xcrun simctl openurl`
// cannot answer headless (crash-flow.sh). The launch happens here because the UI test runner
// terminates the target app when it starts; launched by simctl, the link would cold-start a new
// process and the crash would land in a session a few hundred milliseconds old.
import XCTest

final class OpenURLUITests: XCTestCase {
    func testOpenURL() throws {
        let env = ProcessInfo.processInfo.environment
        let link = try XCTUnwrap(env["OUO_URL"].flatMap(URL.init(string:)))
        let wait = UInt32(env["OUO_WAIT"] ?? "") ?? 10
        let app = XCUIApplication(bundleIdentifier: "dev.ouo.sentrydemo")
        app.launch()
        sleep(wait)
        print("OUO opening \(link) pid-hint \(app.state.rawValue)")
        // The system opens it (not XCUIApplication.open, which waits for the app's accessibility and
        // times out when the link crashes the app, the point of the exercise).
        XCUIDevice.shared.system.open(link)
        let open = XCUIApplication(bundleIdentifier: "com.apple.springboard").buttons["Open"]
        if open.waitForExistence(timeout: 3) { open.tap() }
        sleep(4)
    }
}
