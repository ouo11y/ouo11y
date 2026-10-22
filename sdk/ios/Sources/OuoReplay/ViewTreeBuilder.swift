#if canImport(UIKit)
import UIKit
import OuoReplayCore

/// Walks `UIView.subviews` into the platform-neutral `ViewNode` tree the redaction planner reads.
/// Main thread only.
enum ViewTreeBuilder {
    /// Class name and superclass chain per class: the same few dozen classes come back on every
    /// capture, and building their names each time was a large part of the main-thread walk.
    private static var classNames: [ObjectIdentifier: (name: String, superclasses: [String])] = [:]

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

    static func node(for view: UIView, maxDepth: Int = 64) -> ViewNode {
        let frame = view.convert(view.bounds, to: nil)
        let names = names(of: type(of: view))
        let superclasses = names.superclasses
        let children: [ViewNode]
        if maxDepth > 0 {
            children = view.subviews.map { node(for: $0, maxDepth: maxDepth - 1) }
        } else {
            children = []
        }
        // An image view without an image (UIKit bar backgrounds, placeholders) carries no user
        // content; reporting it as a plain view keeps whole navigation bars from being redacted.
        var className = names.name
        if let imageView = view as? UIImageView, imageView.image == nil {
            className = "UIView"
        }
        return ViewNode(
            className: className,
            superclassNames: superclasses,
            frameInWindow: frame,
            hidden: view.isHidden,
            alpha: view.alpha,
            accessibilityIdentifier: view.accessibilityIdentifier,
            children: children
        )
    }
}
#endif
