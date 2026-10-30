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

    static func walk(_ window: UIWindow, maxDepth: Int = 64) -> Walk {
        var animations = 0
        let tree = node(for: window, maxDepth: maxDepth, animations: &animations)
        return Walk(tree: tree, animations: animations)
    }

    private static func node(for view: UIView, maxDepth: Int, animations: inout Int) -> ViewNode {
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
        if let scroll = view as? UIScrollView, scroll.isDragging || scroll.isDecelerating {
            moving = true
        }
        var children: [ViewNode] = []
        var truncated = false
        if !invisible {
            if maxDepth > 0 {
                children = view.subviews.map { node(for: $0, maxDepth: maxDepth - 1, animations: &animations) }
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
            children: children
        )
    }
}
#endif
