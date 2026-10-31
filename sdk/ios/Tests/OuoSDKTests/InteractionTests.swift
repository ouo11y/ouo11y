import Foundation
import Testing
#if canImport(UIKit)
import UIKit
#endif
@testable import OuoReplayCore
@testable import OuoSDK

/// Taps (C6), screens (C7), feedback (C10) and the crash-time context: the rules and the records.
@Suite struct InteractionTests {
    private func v(_ cls: String, id: String? = nil, control: Bool = false) -> TouchedView {
        TouchedView(className: cls, identifier: id, isControl: control)
    }

    @Test func Gestures() {
        #expect(TapRules.gesture(durationMs: 100, dx: 3, dy: 4) == "tap")
        #expect(TapRules.gesture(durationMs: 600, dx: 0, dy: 0) == "long_press")
        #expect(TapRules.gesture(durationMs: 600, dx: 6, dy: 8) == "swipe", "10 points: a swipe, however long")
        #expect(TapRules.gesture(durationMs: 499, dx: 0, dy: 9.9) == "tap")
    }

    @Test func TargetPathAndViewType() throws {
        // A button's title label inside the button inside a cell with a test id.
        let chain = [v("UIButtonLabel"), v("UIButton", id: "pay", control: true), v("MyApp.CheckoutCell", id: "checkout-cell"), v("UIView"), v("UIWindow")]
        let d = try #require(TapRules.describe(chain, labels: true))
        #expect(d.target == "pay")
        #expect(d.path == "pay > checkout-cell")
        #expect(d.viewType == "UIButton")
        // Labels off: what was touched, never what it is called.
        let off = try #require(TapRules.describe(chain, labels: false))
        #expect(off == ("UIButton", nil, "UIButton"))
    }

    /// Without a test id the target is the view type: the touched control's class, else the view's.
    /// Replay markers are not names.
    @Test func WithoutATestIdTheTargetIsTheViewType() throws {
        let control = try #require(TapRules.describe([v("UIButtonLabel"), v("UIButton", control: true), v("UIView", id: "ouo-mask"), v("UIWindow")], labels: true))
        #expect(control == ("UIButton", nil, "UIButton"))
        let swiftUI = try #require(TapRules.describe([v("SwiftUI.CGDrawingView"), v("_TtGC7SwiftUI14_UIHostingViewVS_7AnyView_"), v("UIWindow")], labels: true))
        #expect(swiftUI.target == "CGDrawingView")
    }

    #if canImport(UIKit)
    /// Rule 6 with an assistive technology on (VoiceOver, Voice Control, an XCUITest runner): UIKit
    /// then gives a button its visible title as accessibility label and the button trait. The tap
    /// never carries it.
    @MainActor @Test func AButtonTitleNeverLeaksIntoATap() throws {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 300, height: 300))
        let button = UIButton(type: .system)
        button.setTitle("Send to Ada Lovelace", for: .normal)
        button.accessibilityLabel = "Send to Ada Lovelace"
        button.accessibilityTraits = .button
        let cell = UIView()
        cell.accessibilityLabel = "Ada Lovelace, 99 dollars"
        cell.addSubview(button)
        window.addSubview(cell)
        for labels in [true, false] {
            let d = try #require(TapRules.describe(TapTracking.chain(button), labels: labels))
            let step = TapRules.step(gesture: "tap", target: d.target, viewType: d.viewType, screen: "Cart")
            #expect(![d.target, d.path ?? "", d.viewType, step].contains { $0.contains("Ada") })
            #expect(d.target == "UIButton")
        }
    }
    #endif

    @Test func StepsReadLikeTheReactNativeSDK() {
        #expect(TapRules.step(gesture: "tap", target: "add-to-cart", viewType: "button", screen: "Products") == "Tap add-to-cart (button) on Products")
        #expect(TapRules.step(gesture: "swipe", target: "cart-items", viewType: "UIScrollView", screen: "Cart") == "Swipe cart-items (UIScrollView) on Cart")
        #expect(TapRules.step(gesture: "long_press", target: "button", viewType: "button", screen: "") == "Long press button")
    }

    @Test func WhichControllersAreScreens() {
        #expect(ScreenRules.isScreen(inMainBundle: true, parentIsSystemContainer: false, hasParent: false), "presented on its own")
        #expect(ScreenRules.isScreen(inMainBundle: true, parentIsSystemContainer: true, hasParent: true), "in a navigation controller")
        #expect(!ScreenRules.isScreen(inMainBundle: true, parentIsSystemContainer: false, hasParent: true), "a child of the app's own container")
        #expect(!ScreenRules.isScreen(inMainBundle: false, parentIsSystemContainer: true, hasParent: true), "UIKit's and SwiftUI's controllers")
        #expect(ScreenRules.name(className: "MyApp.CartViewController", override: nil) == "CartViewController")
        #expect(ScreenRules.name(className: "MyApp.CartViewController", override: "Cart") == "Cart")
        #expect(ScreenRules.name(className: "MyApp.CartViewController", override: "") == nil, "opted out")
    }

    @Test func FeedbackText() throws {
        #expect(Feedback.attributes(message: "  \n ", contact: nil, id: "x") == nil)
        let a = try #require(Feedback.attributes(message: " slow cart ", contact: " ada@example.com ", id: "id-1"))
        #expect(a["ouo.feedback.message"] == "slow cart")
        #expect(a["ouo.feedback.contact"] == "ada@example.com")
        #expect(a["ouo.feedback.id"] == "id-1")
        let long = try #require(Feedback.attributes(message: String(repeating: "é", count: 3000), contact: nil, id: "x"))
        #expect(long["ouo.feedback.message"]?.text.utf8.count == 4096 + "…".utf8.count)
    }

    /// The crash handler's context is set before the call that changed it returns.
    @Test func TapsAndScreensSetTheCrashContextAtOnce() throws {
        let h = Harness()
        let lock = NSLock()
        var contexts: [ScreenContext] = []
        var hooks = Core.Hooks()
        hooks.now = { h.clock.now }
        hooks.transport = h.sink
        hooks.after = { ms, b in h.manual.after(ms, b) }
        hooks.crashContext = { d in if let c = try? JSONDecoder().decode(ScreenContext.self, from: d) { lock.withLock { contexts.append(c) } } }
        let c = Core(settings: Settings(Harness.config()), directory: h.dir, hooks: hooks)
        c.start(previousReport: nil, background: false, appStart: nil)
        c.trackScreen("Cart")
        #expect(lock.withLock { contexts.last?.screen } == "Cart")
        c.tap(target: "pay", path: nil, viewType: "button", gesture: "tap", at: h.clock.now, screen: "Cart")
        let last = try #require(lock.withLock { contexts.last })
        #expect(last.events.last?.body == "Tap pay (button) on Cart")
    }

    @Test func TapRecords() async throws {
        let h = Harness()
        let c = h.core()
        c.start(previousReport: nil, background: false, appStart: nil)
        c.trackScreen("Products")
        c.tap(target: "add-to-cart", path: "add-to-cart > product-card", viewType: "button", gesture: "long_press", at: h.clock.now - 700, screen: c.screenName)
        let off = h.core { $0.taps = false }
        off.start(previousReport: nil, background: false, appStart: nil)
        off.tap(target: "x", path: nil, viewType: nil, gesture: "tap", at: h.clock.now, screen: "")
        await flush(c)
        await flush(off)
        let t = try #require(h.sink.events("ui.tap").first)
        #expect(h.sink.events("ui.tap").count == 1, "taps off sends none")
        #expect(t.s("ouo.ui.target") == "add-to-cart")
        #expect(t.s("ouo.ui.path") == "add-to-cart > product-card")
        #expect(t.s("ouo.ui.view_type") == "button")
        #expect(t.s("ouo.ui.gesture") == "long_press")
        #expect(t.s("app.screen.name") == "Products")
        #expect(t.body == "Long press add-to-cart (button) on Products")
        #expect(t.time == h.clock.now - 700, "stamped at the touch start")
    }

    /// A UIKit screen's TTID runs from `viewWillAppear` (the `startedAt` the swizzle passes).
    @Test func ScreenTTIDFromItsStart() async throws {
        let h = Harness()
        let c = h.core()
        c.start(previousReport: nil, background: false, appStart: nil)
        c.trackScreen("Home")
        h.manual.drawFrame()
        let willAppear = h.clock.now
        h.clock.advance(350)
        c.trackScreen("Cart", startedAt: willAppear)
        h.clock.advance(16)
        h.manual.drawFrame()
        c.didEnterBackground()
        await flush(c)
        let cart = try #require(h.sink.events("ouo.screen.display").first { $0.s("app.screen.name") == "Cart" })
        #expect(cart.attrs["ouo.screen.ttid_ms"] as? Double == 366)
    }

    @Test func FeedbackRecord() async throws {
        let h = Harness()
        let c = h.core()
        c.start(previousReport: nil, background: false, appStart: nil)
        c.trackScreen("Cart")
        #expect(c.feedback(message: " ", contact: nil, screenshot: false) == nil)
        let id = try #require(c.feedback(message: "the cart is slow", contact: "ada@example.com", screenshot: true))
        await flush(c)
        let f = try #require(h.sink.events("feedback").first)
        #expect(f.s("ouo.feedback.id") == id)
        #expect(f.body == "the cart is slow")
        #expect(f.s("ouo.feedback.contact") == "ada@example.com")
        #expect(f.b("ouo.feedback.screenshot") == true)
        let last = try JSONDecoder().decode([RecentEvent].self, from: Data(try #require(f.s("ouo.last_events")).utf8))
        #expect(last.last?.body == "/Cart")
    }

    /// The context the crash handler wrote wins over `context.json`, which a crash right after a tap
    /// can leave one step behind.
    @Test func ThePreviousCrashUsesTheHandlersContext() async throws {
        let dir = tempDir()
        let first = Harness(dir: dir)
        let c1 = first.core()
        c1.start(previousReport: nil, background: false, appStart: nil)
        let crashed = c1.sessionId
        c1.trackScreen("Home")
        settle(c1)
        let handler = ScreenContext(sessionId: crashed, screen: "Cart", events: [RecentEvent(ts: 1, name: "ui.tap", body: "Tap pay (button) on Cart")])
        let b64 = try JSONEncoder().encode(handler).base64EncodedString()
        let report = try #require(NativeReport.parse(#"{"mechanism":"signal","timestamp_ms":\#(Int64(first.clock.now + 100)),"session_id":"\#(crashed)","context":"\#(b64)","signal":{"name":"SIGSEGV"}}"#))
        let second = Harness(dir: dir, clock: first.clock)
        let c2 = second.core()
        c2.start(previousReport: report, background: false, appStart: nil)
        await flush(c2)
        let e = try #require(second.sink.events("exception").first)
        #expect(e.s("app.screen.name") == "Cart")
        #expect(e.s("ouo.last_events")?.contains("Tap pay (button) on Cart") == true)
        #expect(NativeReport.parse(#"{"mechanism":"signal","timestamp_ms":1,"context":"not base64!"}"#)?.screenContext == nil)
    }
}
