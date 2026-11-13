#if canImport(UIKit)
import Testing
import UIKit
@testable import OuoReplay
@testable import OuoReplaySentryCore

/// The masking plan of `pixel/video` is the one of `pixel/frames` (`ReplayMaskPlanner`): the host's
/// overrides through `ReplayMaskRegistry`, the default classes, secure fields always masked, no
/// frame when the mask cannot be established (PRV-8). And the screen-transition leak of the Sentry
/// spike: the plan is taken from the views as committed in this pass, never from presentation
/// layers, which do not yet hold what was committed in it.
@MainActor @Suite(.serialized) struct ReplayMaskPlanTests {
    /// A React Native view: Paper keeps the tag in `reactTag`.
    final class RCTFakeView: UIView {
        @objc var reactTag: NSNumber = 0
    }

    private func window() -> UIWindow {
        let w = UIWindow(frame: CGRect(x: 0, y: 0, width: 400, height: 800))
        w.rootViewController = UIViewController()
        w.rootViewController?.view.backgroundColor = .white
        w.isHidden = false
        w.layoutIfNeeded()
        return w
    }

    private func label(_ text: String, _ frame: CGRect) -> UILabel {
        let l = UILabel(frame: frame)
        l.text = text
        return l
    }

    private func rects(_ plan: OuoMaskPlan) -> [CGRect] {
        if case .mask(let r) = plan { return r }
        Issue.record("expected a mask plan, got \(plan)")
        return []
    }

    private func covers(_ rects: [CGRect], _ frame: CGRect) -> Bool {
        rects.contains { $0.insetBy(dx: -0.5, dy: -0.5).contains(frame) }
    }

    @Test func DefaultsMaskTextInputsAndImagesNotPlainViews() {
        ReplayMaskRegistry.shared.reset()
        let w = window()
        let root = w.rootViewController!.view!
        let text = label("Card ending 4242", CGRect(x: 10, y: 100, width: 200, height: 20))
        let field = UITextField(frame: CGRect(x: 10, y: 140, width: 200, height: 30))
        let image = UIImageView(frame: CGRect(x: 10, y: 200, width: 50, height: 50))
        image.image = UIGraphicsImageRenderer(size: CGSize(width: 20, height: 20)).image { _ in }
        let plain = UIView(frame: CGRect(x: 10, y: 300, width: 100, height: 100))
        plain.backgroundColor = .red
        [text, field, image, plain].forEach(root.addSubview)
        let r = rects(ReplayMaskPlanner(rules: RedactionRules()).plan(w))
        #expect(covers(r, text.frame))
        #expect(covers(r, field.frame))
        #expect(covers(r, image.frame))
        #expect(!covers(r, plain.frame))
    }

    @Test func RegistryAndIdentifierOverridesAreHonoured() {
        ReplayMaskRegistry.shared.reset()
        defer { ReplayMaskRegistry.shared.reset() }
        let w = window()
        let root = w.rootViewController!.view!
        // mask(reactTag): a plain React Native view is masked.
        let rn = RCTFakeView(frame: CGRect(x: 0, y: 0, width: 100, height: 40))
        rn.reactTag = 11
        ReplayMaskRegistry.shared.mask(reactTag: 11)
        // unmask(reactTag): a container of labels is shown...
        let shown = RCTFakeView(frame: CGRect(x: 0, y: 100, width: 300, height: 200))
        shown.reactTag = 12
        ReplayMaskRegistry.shared.unmask(reactTag: 12)
        let visible = label("Total 4.50", CGRect(x: 0, y: 0, width: 100, height: 20))
        // ...but a secure field inside it stays masked (PRV-7), and so does a mask inside it (PRV-6).
        let secret = UITextField(frame: CGRect(x: 0, y: 40, width: 200, height: 30))
        secret.isSecureTextEntry = true
        let forced = UIView(frame: CGRect(x: 0, y: 100, width: 50, height: 50))
        forced.accessibilityIdentifier = "ouo-mask"
        [visible, secret, forced].forEach(shown.addSubview)
        // `.ouoUnmask()` / `ouo-unmask` on a label.
        let unmasked = label("Espresso cup", CGRect(x: 0, y: 400, width: 200, height: 20))
        unmasked.accessibilityIdentifier = "ouo-unmask"
        [rn, shown, unmasked].forEach(root.addSubview)
        let r = rects(ReplayMaskPlanner(rules: RedactionRules()).plan(w))
        #expect(covers(r, rn.frame))
        #expect(!covers(r, shown.convert(visible.frame, to: nil)))
        #expect(covers(r, shown.convert(secret.frame, to: nil)))
        #expect(covers(r, shown.convert(forced.frame, to: nil)))
        #expect(!covers(r, unmasked.frame))
    }

    @Test func OptionsOffStillMaskSecureFields() {
        ReplayMaskRegistry.shared.reset()
        let w = window()
        let root = w.rootViewController!.view!
        let text = label("Ada Lovelace", CGRect(x: 0, y: 0, width: 200, height: 20))
        let secret = UITextField(frame: CGRect(x: 0, y: 50, width: 200, height: 30))
        secret.isSecureTextEntry = true
        [text, secret].forEach(root.addSubview)
        let none = RedactionRules(maskText: false, maskInputs: false, maskImages: false, maskWebViews: false)
        let r = rects(ReplayMaskPlanner(rules: none).plan(w))
        #expect(!covers(r, text.frame))
        #expect(covers(r, secret.frame))
    }

    @Test func AMaskedViewThatMovesDropsTheFrame() {
        ReplayMaskRegistry.shared.reset()
        let w = window()
        let text = label("IBAN DE89 3704", CGRect(x: 0, y: 0, width: 200, height: 20))
        w.rootViewController!.view.addSubview(text)
        let move = CABasicAnimation(keyPath: "position.x")
        move.fromValue = 0
        move.toValue = 300
        move.duration = 10
        text.layer.add(move, forKey: "move")
        #expect(ReplayMaskPlanner(rules: RedactionRules()).plan(w) == .drop)
    }

    @Test func NoLookWhileAViewControllerTransitionRuns() {
        ReplayMaskRegistry.shared.reset()
        let w = UIWindow(frame: CGRect(x: 0, y: 0, width: 400, height: 800))
        let nav = UINavigationController(rootViewController: UIViewController())
        w.rootViewController = nav
        w.isHidden = false
        w.layoutIfNeeded()
        nav.pushViewController(UIViewController(), animated: true)
        #expect(nav.transitionCoordinator != nil)
        #expect(ReplayMaskPlanner(rules: RedactionRules()).plan(w) == .wait)
    }

    /// The leak: a screen's views committed in the pass that captures. The plan walks the views,
    /// so it masks them at once; the spike's walk read `layer.presentation()`, which on screen does
    /// not hold layers committed in this pass yet, so their text went out unmasked. (The lag needs
    /// the render server of a displayed window, so this test pins the plan's side; the trace in
    /// the kb entry shows the presentation side.)
    @Test func ViewsCommittedInThisPassAreMaskedAtOnce() {
        ReplayMaskRegistry.shared.reset()
        let w = window()
        let screen = UIView(frame: w.bounds)
        screen.backgroundColor = .white
        let text = label("Card ending 4242", CGRect(x: 24, y: 160, width: 200, height: 20))
        screen.addSubview(text)
        w.rootViewController!.view.addSubview(screen)
        w.layoutIfNeeded()
        CATransaction.flush()
        let r = rects(ReplayMaskPlanner(rules: RedactionRules()).plan(w))
        #expect(covers(r, screen.convert(text.frame, to: nil)))
    }

    /// A programmatic scroll moves the offset from a display link: no layer animation, not
    /// dragging, yet the render lags the model. An offset that changed within the settle time
    /// drops the frame; once it held that long, the next look masks.
    @Test func AScrollOffsetThatJustMovedDropsTheFrame() {
        ReplayMaskRegistry.shared.reset()
        let w = window()
        let scroll = UIScrollView(frame: w.bounds)
        scroll.contentSize = CGSize(width: 400, height: 4000)
        let text = label("IBAN DE89 3704 0044 0532 0130 01  balance 113.1", CGRect(x: 10, y: 1000, width: 380, height: 20))
        scroll.addSubview(text)
        w.rootViewController!.view.addSubview(scroll)
        let planner = ReplayMaskPlanner(rules: RedactionRules())
        guard case .mask = planner.plan(w) else { Issue.record("first look"); return }
        scroll.contentOffset = CGPoint(x: 0, y: 936)
        #expect(scroll.layer.animationKeys() == nil && !scroll.isDragging && !scroll.isDecelerating)
        #expect(planner.plan(w) == .drop)
        #expect(planner.plan(w) == .drop)
        RunLoop.main.run(until: Date().addingTimeInterval(ScrollMotion.settle + 0.05))
        let r = rects(planner.plan(w))
        #expect(covers(r, scroll.convert(text.frame, to: nil)))
    }

    @Test func ThePaintedMaskIsBlackAtOnePixelPerPoint() throws {
        let size = CGSize(width: 40, height: 20)
        let white = UIGraphicsImageRenderer(size: size).image { ctx in
            UIColor.white.setFill()
            ctx.fill(CGRect(origin: .zero, size: size))
        }
        let painted = SentryCoreRecorder.paint(white, size: size, rects: [CGRect(x: 0, y: 0, width: 10, height: 10)])
        let cg = try #require(painted.cgImage)
        #expect(cg.width == 40 && cg.height == 20)
        var px = [UInt8](repeating: 0, count: 40 * 20 * 4)
        let ctx = try #require(CGContext(data: &px, width: 40, height: 20, bitsPerComponent: 8, bytesPerRow: 160, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        ctx.draw(cg, in: CGRect(x: 0, y: 0, width: 40, height: 20))
        // Row 0 is the top (the bitmap is drawn upright into a top-down buffer).
        func rgb(_ x: Int, _ y: Int) -> [UInt8] { Array(px[(y * 40 + x) * 4..<(y * 40 + x) * 4 + 3]) }
        #expect(rgb(5, 5) == [0, 0, 0])
        #expect(rgb(30, 15) == [255, 255, 255])
    }
}
#endif
