#if canImport(UIKit)
import UIKit
import OuoReplayCore

/// Walks `UIView.subviews` into the platform-neutral `ViewNode` tree the redaction planner reads,
/// and counts the running layer animations for the capture pacer. Main thread only.
enum ViewTreeBuilder {
    struct Walk {
        let tree: ViewNode
        /// Layer animations running in the visible tree (Sentry defers a capture at 4 or more).
        let animations: Int
    }

    /// Class name and superclass chain per class: the same few dozen classes come back on every
    /// capture, and building their names each time was a large part of the main-thread walk.
    private static var classNames: [ObjectIdentifier: (name: String, superclasses: [String])] = [:]

    /// Animated key paths that change how a layer looks but not where: a mask over such a layer
    /// still covers it. Any other key path (position, bounds, transform, or one we do not know, or
    /// an animation that is not a property animation) counts as moving, so masking fails closed.
    private static let inPlaceKeyPaths: Set<String> = [
        "opacity", "backgroundColor", "contents", "borderColor", "borderWidth", "cornerRadius",
        "shadowOpacity", "shadowColor", "shadowRadius", "shadowOffset", "shadowPath", "filters",
    ]

    private static func names(of cls: AnyClass) -> (name: String, superclasses: [String]) {
        let key = ObjectIdentifier(cls)
        if let cached = classNames[key] { return cached }
        var superclasses: [String] = []
        var c: AnyClass? = class_getSuperclass(cls)
        while let s = c, s != UIView.self, s != UIResponder.self, s != NSObject.self {
            superclasses.append(NSStringFromClass(s))
            c = class_getSuperclass(s)
        }
        let entry = (name: NSStringFromClass(cls), superclasses: superclasses)
        classNames[key] = entry
        return entry
    }

    /// What the OTLP replay path adds to the walk (the legacy recorder passes none): secure fields
    /// and the host's overrides from the mask registry.
    struct Detail {
        var masks = ReplayMaskRegistry.Snapshot()
    }

    static func walk(_ window: UIWindow, maxDepth: Int = 64, detail: Detail? = nil) -> Walk {
        var animations = 0
        let tree = node(for: window, maxDepth: maxDepth, animations: &animations, detail: detail)
        return Walk(tree: tree, animations: animations)
    }

    // MARK: detail (OTLP replay path)

    private static let reactTagSelector = NSSelectorFromString("reactTag")
    /// Content types that hold a secret whether or not the field hides its characters.
    private static let secretContentTypes: Set<UITextContentType> = [.password, .newPassword, .oneTimeCode, .creditCardNumber]

    /// The React tag of a React Native view: Paper keeps it in `reactTag`, Fabric in `tag`.
    private static func reactTag(of view: UIView, className: String) -> Int? {
        if view.responds(to: reactTagSelector), let n = view.perform(reactTagSelector)?.takeUnretainedValue() as? NSNumber {
            return n.intValue
        }
        return view.tag > 0 && className.hasPrefix("RCT") ? view.tag : nil
    }

    /// The text field or text view behind an input node (React Native's Fabric input wraps it), and
    /// whether what it holds is a secret (PRV-7).
    private static func input(of view: UIView, names: (name: String, superclasses: [String])) -> (field: UIView, secure: Bool)? {
        func describe(_ v: UIView) -> (field: UIView, secure: Bool)? {
            if let f = v as? UITextField {
                return (f, f.isSecureTextEntry || f.textContentType.map(secretContentTypes.contains) ?? false)
            }
            if let t = v as? UITextView {
                return (t, t.isSecureTextEntry || t.textContentType.map(secretContentTypes.contains) ?? false)
            }
            return nil
        }
        if let own = describe(view) { return own }
        guard RedactionRules.inputClasses.contains(names.name) || names.superclasses.contains(where: RedactionRules.inputClasses.contains) else { return nil }
        for sub in view.subviews {
            if let inner = describe(sub) { return inner }
        }
        return (view, false)
    }

    private static func node(for view: UIView, maxDepth: Int, animations: inout Int, detail: Detail?) -> ViewNode {
        var secure = false
        var maskOverride: ViewNode.MaskOverride?
        if let detail {
            let names = names(of: type(of: view))
            secure = input(of: view, names: names)?.secure ?? false
            maskOverride = detail.masks.override(reactTag: reactTag(of: view, className: names.name), accessibilityIdentifier: view.accessibilityIdentifier)
        }
        let frame = view.convert(view.bounds, to: nil)
        let names = names(of: type(of: view))
        let layer = view.layer
        let keys = view.isHidden ? [] : (layer.animationKeys() ?? [])
        // A hidden or transparent view hides its subtree: the planner skips it, so do not walk it.
        // A transparent one that still animates may be fading out on screen: walked and masked.
        let invisible = view.isHidden || (view.alpha <= 0.01 && keys.isEmpty)
        animations += keys.count
        var moving = keys.contains { key in
            guard let path = (layer.animation(forKey: key) as? CAPropertyAnimation)?.keyPath else { return true }
            return !inPlaceKeyPaths.contains(path)
        }
        // Scrolling moves content without an animation, and the screen shows the previous offset.
        if let scroll = view as? UIScrollView {
            if scroll.isDragging || scroll.isDecelerating { moving = true }
            if !view.isHidden, ScrollMotion.isMoving(scroll, now: ProcessInfo.processInfo.systemUptime) { moving = true }
        }
        var children: [ViewNode] = []
        var truncated = false
        if !invisible {
            if maxDepth > 0 {
                children = view.subviews.map { node(for: $0, maxDepth: maxDepth - 1, animations: &animations, detail: detail) }
            } else {
                truncated = !view.subviews.isEmpty
            }
        }
        // An image view without an image (UIKit bar backgrounds, placeholders) carries no user
        // content; reporting it as a plain view keeps whole navigation bars from being redacted.
        var className = names.name
        if let imageView = view as? UIImageView, imageView.image == nil {
            className = "UIView"
        }
        return ViewNode(
            className: className,
            superclassNames: names.superclasses,
            frameInWindow: frame,
            hidden: view.isHidden,
            alpha: view.alpha,
            accessibilityIdentifier: view.accessibilityIdentifier,
            animating: !keys.isEmpty,
            moving: moving,
            truncated: truncated,
            children: children,
            secure: secure,
            maskOverride: maskOverride
        )
    }
}

/// Whether a scroll view's content is moving right now, when nothing on its layer says so. A
/// programmatic scroll (`setContentOffset(_:animated: true)`) moves the offset from a display link:
/// no layer animation, not dragging, not decelerating, the presentation layer equal to the model,
/// yet the render lags the model by a frame, so text slid out from under its mask (found by the
/// `pixel/video` leak measurement, in both pixel recorders). The scroll views a walk meets are
/// sampled once per main run-loop pass (an observer before Core Animation's commit); one whose
/// offset changed within `settle` is moving, so masked content in it drops the frame. Main thread.
enum ScrollMotion {
    static let settle: TimeInterval = 0.1
    private static let watched = NSHashTable<UIScrollView>.weakObjects()
    private static let lastOffset = NSMapTable<UIScrollView, NSValue>.weakToStrongObjects()
    private static let changedAt = NSMapTable<UIScrollView, NSNumber>.weakToStrongObjects()
    private static var observer: CFRunLoopObserver?

    static func isMoving(_ scroll: UIScrollView, now: TimeInterval) -> Bool {
        sample(scroll, now: now)
        if !watched.contains(scroll) {
            watched.add(scroll)
            installIfNeeded()
        }
        guard let at = changedAt.object(forKey: scroll)?.doubleValue else { return false }
        return now - at < settle
    }

    private static func sample(_ scroll: UIScrollView, now: TimeInterval) {
        let offset = scroll.contentOffset
        if let last = lastOffset.object(forKey: scroll)?.cgPointValue, last != offset {
            changedAt.setObject(NSNumber(value: now), forKey: scroll)
        }
        lastOffset.setObject(NSValue(cgPoint: offset), forKey: scroll)
    }

    /// One observer for the process; the table is weak, so a gone scroll view costs nothing.
    private static func installIfNeeded() {
        guard observer == nil else { return }
        let o = CFRunLoopObserverCreateWithHandler(nil, CFRunLoopActivity.beforeWaiting.rawValue, true, 0) { _, _ in
            let now = ProcessInfo.processInfo.systemUptime
            for scroll in watched.allObjects { sample(scroll, now: now) }
        }
        CFRunLoopAddObserver(CFRunLoopGetMain(), o, .commonModes)
        observer = o
    }
}
#endif
