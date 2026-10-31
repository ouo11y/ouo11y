#if canImport(UIKit)
import ObjectiveC
import OuoReplay
import OuoReplayCore
import UIKit

/// Screens (C7) from `UIViewController`: `viewWillAppear(_:)` stamps when a screen starts to show
/// (its TTID start), `viewDidAppear(_:)` reports it. Both are swizzled on `UIViewController` itself:
/// every subclass reaches them through `super`, as UIKit requires. Which controllers are screens:
/// `ScreenRules`.
enum ScreenTracking {
    private static var installed = false
    private static var appearKey = 0

    /// Main thread.
    static func install() {
        guard !installed else { return }
        installed = true
        swizzle(#selector(UIViewController.viewWillAppear(_:))) { vc in
            objc_setAssociatedObject(vc, &appearKey, Ouo.current?.now(), .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
        }
        swizzle(#selector(UIViewController.viewDidAppear(_:))) { vc in
            guard let c = Ouo.current, let name = screenName(vc) else { return }
            let start = objc_getAssociatedObject(vc, &appearKey) as? Double
            c.trackScreen(name, startedAt: start)
        }
    }

    static func screenName(_ vc: UIViewController) -> String? {
        let parent = vc.parent
        let system = parent.map { p in [UINavigationController.self, UITabBarController.self, UISplitViewController.self, UIPageViewController.self].contains { p.isKind(of: $0) } } ?? false
        guard ScreenRules.isScreen(inMainBundle: Bundle(for: type(of: vc)) == Bundle.main, parentIsSystemContainer: system, hasParent: parent != nil) else { return nil }
        return ScreenRules.name(className: NSStringFromClass(type(of: vc)), override: (vc as? OuoScreenNaming).map { $0.ouoScreenName ?? "" })
    }

    /// Calls the original, then `after`.
    private static func swizzle(_ sel: Selector, after: @escaping (UIViewController) -> Void) {
        guard let m = class_getInstanceMethod(UIViewController.self, sel) else { return }
        typealias Appear = @convention(c) (AnyObject, Selector, Bool) -> Void
        let original = unsafeBitCast(method_getImplementation(m), to: Appear.self)
        let block: @convention(block) (AnyObject, Bool) -> Void = { obj, animated in
            original(obj, sel, animated)
            if let vc = obj as? UIViewController { after(vc) }
        }
        method_setImplementation(m, imp_implementationWithBlock(block))
    }
}

/// Taps (C6): an observing recognizer (OuoReplay's `TouchObserver`, which never cancels or delays
/// the app's touches) on every window that becomes key. At a one-finger touch start it reads the
/// touched view chain and the screen; at the end, the gesture.
final class TapTracking {
    private struct Pending {
        let chain: [TouchedView]
        let screen: String
        let at: Double
        let start: CGPoint
        let uptime: TimeInterval
    }

    private let labels: Bool
    private var pending: Pending?
    private var observed = NSHashTable<UIWindow>.weakObjects()
    private var observer: NSObjectProtocol?

    init(labels: Bool) { self.labels = labels }

    /// Main thread.
    func install() {
        observer = NotificationCenter.default.addObserver(forName: UIWindow.didBecomeKeyNotification, object: nil, queue: .main) { [weak self] n in
            (n.object as? UIWindow).map { self?.attach($0) }
        }
        for scene in UIApplication.shared.connectedScenes {
            (scene as? UIWindowScene)?.windows.forEach(attach)
        }
    }

    private func attach(_ window: UIWindow) {
        guard !observed.contains(window) else { return }
        observed.add(window)
        let o = TouchObserver.make()
        o.onUITouch = { [weak self] touch, phase, fingers in self?.handle(touch, phase, fingers) }
        window.addGestureRecognizer(o)
    }

    private func handle(_ touch: UITouch, _ phase: TouchPhase, _ fingers: Int) {
        guard let c = Ouo.current else { return }
        switch phase {
        case .began:
            // A second finger is not a new tap; it ends none either.
            guard fingers == 1, let view = touch.view else {
                pending = nil
                return
            }
            pending = Pending(chain: Self.chain(view), screen: c.screenName, at: c.now(), start: touch.location(in: nil), uptime: touch.timestamp)
        case .moved:
            break
        case .ended:
            guard let p = pending else { return }
            pending = nil
            let end = touch.location(in: nil)
            let gesture = TapRules.gesture(durationMs: (touch.timestamp - p.uptime) * 1000, dx: Double(end.x - p.start.x), dy: Double(end.y - p.start.y))
            guard let d = TapRules.describe(p.chain, labels: labels) else { return }
            c.tap(target: d.target, path: d.path, viewType: d.viewType, gesture: gesture, at: p.at, screen: p.screen)
        }
    }

    /// The touched view and its superviews, innermost first, as the tap rules read them: class,
    /// test id, control. Nothing that can hold visible text.
    static func chain(_ view: UIView) -> [TouchedView] {
        var out: [TouchedView] = []
        var v: UIView? = view
        while let cur = v, out.count < 32 {
            out.append(TouchedView(className: NSStringFromClass(type(of: cur)), identifier: cur.accessibilityIdentifier, isControl: cur is UIControl))
            v = cur.superview
        }
        return out
    }
}
#endif
