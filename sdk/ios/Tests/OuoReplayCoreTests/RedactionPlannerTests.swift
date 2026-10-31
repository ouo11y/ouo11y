import Foundation
import Testing
@testable import OuoReplayCore

@Suite struct RedactionPlannerTests {
    private let window = CGRect(x: 0, y: 0, width: 393, height: 852)
    private let planner = RedactionPlanner(rules: RedactionRules(), mergeOverlapping: false)

    private func node(_ cls: String, _ frame: CGRect, hidden: Bool = false, alpha: CGFloat = 1, id: String? = nil, supers: [String] = [], _ children: [ViewNode] = []) -> ViewNode {
        ViewNode(className: cls, superclassNames: supers, frameInWindow: frame, hidden: hidden, alpha: alpha, accessibilityIdentifier: id, children: children)
    }

    /// A matched parent with an empty frame must not hide a child that draws (React Native
    /// paragraph views inside navigation bars), and an off-screen parent must not hide an
    /// on-screen child either: UIKit does not clip subviews by default.
    @Test func EmptyOrOffscreenParentsDoNotStopTheWalk() throws {
        let root = node("UIWindow", window, [
            node("RCTParagraphComponentView", CGRect(x: 300, y: 20, width: 0, height: 0), [
                node("RCTParagraphTextView", CGRect(x: 300, y: 20, width: 80, height: 16)),
            ]),
            node("UIView", CGRect(x: -500, y: 0, width: 10, height: 10), [
                node("UILabel", CGRect(x: 10, y: 100, width: 50, height: 20)),
            ]),
        ])
        let rects = try #require(planner.rects(for: root, window: window))
        #expect(rects == [CGRect(x: 300, y: 20, width: 80, height: 16), CGRect(x: 10, y: 100, width: 50, height: 20)])
    }

    /// SwiftUI's `.ouoUnmask()`: a childless marker behind content drawn by its siblings unmasks the
    /// masked rectangles inside its area, not those outside or only partly inside.
    @Test func AChildlessUnmaskMarkerUnmasksItsArea() throws {
        let window = CGRect(x: 0, y: 0, width: 400, height: 800)
        let root = node("UIWindow", window, [
            node("UIView", CGRect(x: 0, y: 0, width: 400, height: 200), id: "ouo-unmask"),
            node("UILabel", CGRect(x: 10, y: 10, width: 100, height: 20)),
            node("UILabel", CGRect(x: 10, y: 190, width: 100, height: 20)),
            node("UILabel", CGRect(x: 10, y: 400, width: 100, height: 20)),
        ])
        let rects = try #require(RedactionPlanner().rects(for: root, window: window))
        #expect(rects == [CGRect(x: 10, y: 190, width: 100, height: 20), CGRect(x: 10, y: 400, width: 100, height: 20)])
    }

    /// SwiftUI text and symbols are drawn in `SwiftUI.CGDrawingView`: masked with `maskText`, but not
    /// inside a navigation bar (iOS 26+ draws its glass with the same class).
    @Test func SwiftUIDrawingIsMaskedOutsideBars() throws {
        let window = CGRect(x: 0, y: 0, width: 400, height: 800)
        let root = node("UIWindow", window, [
            node("UINavigationBar", CGRect(x: 0, y: 0, width: 400, height: 100), [node("SwiftUI.CGDrawingView", CGRect(x: 0, y: 0, width: 400, height: 100))]),
            node("_TtGC7SwiftUI14_UIHostingViewVS_7AnyView_", CGRect(x: 0, y: 100, width: 400, height: 700), [node("SwiftUI.CGDrawingView", CGRect(x: 20, y: 120, width: 200, height: 20))]),
        ])
        #expect(try #require(RedactionPlanner().rects(for: root, window: window)) == [CGRect(x: 20, y: 120, width: 200, height: 20)])
        #expect(try #require(RedactionPlanner(rules: RedactionRules(maskText: false)).rects(for: root, window: window)).isEmpty)
    }

    @Test func MaskedClassesByDefault() throws {
        let root = node("UIWindow", window, [
            node("UIView", window, [
                node("UITextField", CGRect(x: 10, y: 10, width: 100, height: 40)),
                node("UITextView", CGRect(x: 10, y: 60, width: 100, height: 40)),
                node("UILabel", CGRect(x: 10, y: 110, width: 100, height: 40)),
                node("RCTTextView", CGRect(x: 10, y: 160, width: 100, height: 40)),
                node("RCTParagraphComponentView", CGRect(x: 10, y: 210, width: 100, height: 40)),
                node("UIImageView", CGRect(x: 10, y: 260, width: 100, height: 40)),
                node("RCTImageView", CGRect(x: 10, y: 310, width: 100, height: 40)),
                node("RCTImageComponentView", CGRect(x: 10, y: 360, width: 100, height: 40)),
                node("WKWebView", CGRect(x: 10, y: 410, width: 100, height: 40)),
                node("UIButton", CGRect(x: 10, y: 460, width: 100, height: 40)),
                node("RCTViewComponentView", CGRect(x: 10, y: 510, width: 100, height: 40)),
            ]),
        ])
        let rects = try #require(planner.rects(for: root, window: window))
        #expect(rects.count == 9)
        #expect(rects.map(\.origin.y) == [10, 60, 110, 160, 210, 260, 310, 360, 410])
    }

    @Test func SubclassesMatchViaSuperclassNames() {
        let root = node("UIWindow", window, [
            node("RCTUITextFieldSubclass", CGRect(x: 0, y: 0, width: 50, height: 50), supers: ["RCTUITextField", "UITextField", "UIControl"]),
            node("MyFancyView", CGRect(x: 0, y: 100, width: 50, height: 50), supers: ["UIControl"]),
        ])
        #expect(planner.rects(for: root, window: window) == [CGRect(x: 0, y: 0, width: 50, height: 50)])
    }

    @Test func MaskFlagsDisableCategories() {
        let root = node("UIWindow", window, [
            node("UILabel", CGRect(x: 0, y: 0, width: 50, height: 50)),
            node("UIImageView", CGRect(x: 0, y: 100, width: 50, height: 50)),
            node("WKWebView", CGRect(x: 0, y: 200, width: 50, height: 50)),
        ])
        let textOnly = RedactionPlanner(rules: RedactionRules(maskText: true, maskImages: false, maskWebViews: false))
        #expect(textOnly.rects(for: root, window: window)?.map(\.origin.y) == [0])
        let none = RedactionPlanner(rules: RedactionRules(maskText: false, maskInputs: false, maskImages: false, maskWebViews: false))
        #expect(none.rects(for: root, window: window) == [])
        #expect(!(none.rules.masksAnything))
        let extra = RedactionPlanner(rules: RedactionRules(maskText: false, maskInputs: false, maskImages: false, maskWebViews: false, extraClasses: ["WKWebView"]))
        #expect(extra.rects(for: root, window: window)?.map(\.origin.y) == [200])
        #expect(extra.rules.masksAnything)
    }

    /// `maskText: false` shows labels and React Native text but must keep every text input
    /// redacted: inputs are governed by `maskInputs` alone.
    @Test func MaskTextFalseKeepsInputsMasked() {
        let root = node("UIWindow", window, [
            node("UILabel", CGRect(x: 0, y: 0, width: 50, height: 50)),
            node("RCTParagraphComponentView", CGRect(x: 0, y: 100, width: 50, height: 50)),
            node("_TtCC5UIKit19NavigationButtonBar15ItemWrapperView", CGRect(x: 0, y: 200, width: 50, height: 50)),
            node("UITextField", CGRect(x: 0, y: 300, width: 50, height: 50)),
            node("UITextView", CGRect(x: 0, y: 400, width: 50, height: 50)),
            node("RCTTextInputComponentView", CGRect(x: 0, y: 500, width: 50, height: 50)),
            node("RCTUITextField", CGRect(x: 0, y: 600, width: 50, height: 50), supers: ["UITextField", "UIControl"]),
            node("RCTUITextView", CGRect(x: 0, y: 700, width: 50, height: 50), supers: ["UITextView", "UIScrollView"]),
        ])
        let labelsVisible = RedactionPlanner(rules: RedactionRules(maskText: false), mergeOverlapping: false)
        #expect(labelsVisible.rects(for: root, window: window)?.map(\.origin.y) == [300, 400, 500, 600, 700])
        #expect(labelsVisible.rules.masksAnything)
        #expect(RedactionRules.textClasses.isDisjoint(with: RedactionRules.inputClasses))
    }

    /// `maskInputs: false` with `maskText: true` masks labels but not inputs (the opposite split).
    @Test func MaskInputsFalseKeepsLabelsMasked() {
        let root = node("UIWindow", window, [
            node("UILabel", CGRect(x: 0, y: 0, width: 50, height: 50)),
            node("RCTTextView", CGRect(x: 0, y: 100, width: 50, height: 50)),
            node("UITextField", CGRect(x: 0, y: 200, width: 50, height: 50)),
            node("RCTTextInputComponentView", CGRect(x: 0, y: 300, width: 50, height: 50)),
            node("RCTUITextField", CGRect(x: 0, y: 400, width: 50, height: 50), supers: ["UITextField", "UIControl"]),
        ])
        let inputsVisible = RedactionPlanner(rules: RedactionRules(maskText: true, maskInputs: false), mergeOverlapping: false)
        #expect(inputsVisible.rects(for: root, window: window)?.map(\.origin.y) == [0, 100])
    }

    @Test func OuoMaskForcesAnyView() throws {
        let root = node("UIWindow", window, [
            node("RCTViewComponentView", CGRect(x: 20, y: 20, width: 200, height: 60), id: "ouo-mask", [
                node("UIButton", CGRect(x: 30, y: 30, width: 50, height: 20)),
            ]),
        ])
        let rects = try #require(planner.rects(for: root, window: window))
        #expect(rects == [CGRect(x: 20, y: 20, width: 200, height: 60)], "the forced rect covers the subtree, children are not listed separately")
    }

    @Test func OuoUnmaskSkipsSubtree() {
        let root = node("UIWindow", window, [
            node("RCTViewComponentView", CGRect(x: 0, y: 0, width: 393, height: 200), id: "ouo-unmask", [
                node("UILabel", CGRect(x: 10, y: 10, width: 100, height: 20)),
                node("RCTParagraphComponentView", CGRect(x: 10, y: 40, width: 100, height: 20)),
            ]),
            node("UILabel", CGRect(x: 10, y: 300, width: 100, height: 20)),
        ])
        #expect(planner.rects(for: root, window: window) == [CGRect(x: 10, y: 300, width: 100, height: 20)])
    }

    @Test func UnmaskOnTheMaskedViewItself() {
        let root = node("UIWindow", window, [
            node("UILabel", CGRect(x: 10, y: 10, width: 100, height: 20), id: "ouo-unmask"),
        ])
        #expect(planner.rects(for: root, window: window) == [])
    }

    @Test func HiddenAndTransparentSubtreesAreSkipped() {
        let root = node("UIWindow", window, [
            node("UIView", window, hidden: true, [
                node("UILabel", CGRect(x: 10, y: 10, width: 100, height: 20)),
            ]),
            node("UIView", window, alpha: 0, [
                node("UILabel", CGRect(x: 10, y: 50, width: 100, height: 20)),
            ]),
            node("UILabel", CGRect(x: 10, y: 90, width: 100, height: 20), hidden: true),
            node("UILabel", CGRect(x: 10, y: 130, width: 100, height: 20), alpha: 0.005),
            node("UILabel", CGRect(x: 10, y: 170, width: 100, height: 20), alpha: 0.5),
        ])
        #expect(planner.rects(for: root, window: window) == [CGRect(x: 10, y: 170, width: 100, height: 20)])
    }

    @Test func ClipsToWindowAndDropsOffscreen() throws {
        let root = node("UIWindow", window, [
            node("UILabel", CGRect(x: -50, y: -10, width: 100, height: 40)),       // partially visible
            node("UILabel", CGRect(x: 500, y: 10, width: 100, height: 40)),       // fully off to the right
            node("UILabel", CGRect(x: 10, y: 900, width: 100, height: 40)),       // below the window
            node("UILabel", CGRect(x: 350, y: 830, width: 100, height: 40)),      // bottom-right corner
            node("UIView", CGRect(x: 1000, y: 0, width: 100, height: 100), [      // offscreen container, child still visible
                node("UILabel", CGRect(x: 10, y: 10, width: 10, height: 10)),
            ]),
            node("UILabel", CGRect(x: 10, y: 10, width: 0, height: 40)),          // zero width
        ])
        let rects = try #require(planner.rects(for: root, window: window))
        #expect(rects == [
            CGRect(x: 0, y: 0, width: 50, height: 30),
            CGRect(x: 350, y: 830, width: 43, height: 22),
            CGRect(x: 10, y: 10, width: 10, height: 10),
        ])
    }

    @Test func MergeOverlapping() {
        let merged = RedactionPlanner.merge([
            CGRect(x: 0, y: 0, width: 10, height: 10),
            CGRect(x: 5, y: 5, width: 10, height: 10),
            CGRect(x: 50, y: 50, width: 10, height: 10),
            CGRect(x: 14, y: 14, width: 2, height: 2),
        ])
        #expect(merged == [CGRect(x: 0, y: 0, width: 16, height: 16), CGRect(x: 50, y: 50, width: 10, height: 10)])
        let merging = RedactionPlanner(rules: RedactionRules(), mergeOverlapping: true)
        let root = node("UIWindow", window, [
            node("UILabel", CGRect(x: 0, y: 0, width: 10, height: 10)),
            node("UILabel", CGRect(x: 5, y: 5, width: 10, height: 10)),
        ])
        #expect(merging.rects(for: root, window: window) == [CGRect(x: 0, y: 0, width: 15, height: 15)])
    }

    /// Fail closed (ADR-0006 rev 2): a masked view on a moving layer, or inside one (a view
    /// controller sliding in), drops the frame; an unmasked moving view does not.
    @Test func MovingMaskDropsTheFrame() {
        let label = ViewNode(className: "UILabel", frameInWindow: CGRect(x: 10, y: 10, width: 50, height: 20))
        var slidingLabel = label
        slidingLabel.moving = true
        #expect(planner.rects(for: node("UIWindow", window, [slidingLabel]), window: window) == nil)
        let sliding = ViewNode(className: "UIView", frameInWindow: window, moving: true, children: [label])
        #expect(planner.rects(for: node("UIWindow", window, [sliding]), window: window) == nil)
        let spinner = ViewNode(className: "UIActivityIndicatorView", frameInWindow: CGRect(x: 0, y: 400, width: 20, height: 20), moving: true)
        #expect(planner.rects(for: node("UIWindow", window, [spinner, label]), window: window) == [label.frameInWindow])
        // An unmasked subtree may move: it is drawn as is.
        let unmasked = ViewNode(className: "UIView", frameInWindow: window, accessibilityIdentifier: RedactionRules.unmaskIdentifier, moving: true, children: [label])
        #expect(planner.rects(for: node("UIWindow", window, [unmasked]), window: window) == [])
    }

    /// A subtree the walk cut at its depth limit is masked whole.
    @Test func TruncatedSubtreeIsMasked() {
        let deep = ViewNode(className: "UIView", frameInWindow: CGRect(x: 0, y: 100, width: 200, height: 50), truncated: true)
        #expect(planner.rects(for: node("UIWindow", window, [deep]), window: window) == [deep.frameInWindow])
    }

    /// After `UIView.animate { v.alpha = 0 }` the model alpha is 0 at once while the screen still
    /// shows `v` fading out: its subtree is masked until the animation ends.
    @Test func FadingOutViewIsStillMasked() {
        let label = ViewNode(className: "UILabel", frameInWindow: CGRect(x: 10, y: 10, width: 50, height: 20))
        let fading = ViewNode(className: "UIView", frameInWindow: window, alpha: 0, animating: true, children: [label])
        #expect(planner.rects(for: node("UIWindow", window, [fading]), window: window) == [label.frameInWindow])
        let gone = ViewNode(className: "UIView", frameInWindow: window, alpha: 0, children: [label])
        #expect(planner.rects(for: node("UIWindow", window, [gone]), window: window) == [])
    }
}

