import XCTest

/// C6.1 on the example: a tap on Home, a long press and a swipe on Cart, by accessibility identifier.
/// The example must already run (run.sh launches it with the `taps` action).
final class Taps: XCTestCase {
    func testTapLongPressSwipe() {
        let app = XCUIApplication(bundleIdentifier: "dev.ouo.example.ios")
        app.activate()
        let element = { (id: String) in app.descendants(matching: .any).matching(identifier: id).firstMatch }
        XCTAssertTrue(element("open-products").waitForExistence(timeout: 10))
        element("open-products").tap()
        XCTAssertTrue(element("add-to-cart").waitForExistence(timeout: 10))
        element("add-to-cart").tap()
        XCTAssertTrue(element("checkout").waitForExistence(timeout: 10))
        element("checkout").press(forDuration: 0.9)
        element("cart-items").swipeLeft()
        // Let the last touch end and the records be emitted.
        Thread.sleep(forTimeInterval: 2)
    }
}
