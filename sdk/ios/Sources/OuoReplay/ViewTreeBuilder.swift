#if canImport(UIKit)
import UIKit
import OuoReplayCore

/// Walks `UIView.subviews` into the platform-neutral `ViewNode` tree the redaction planner reads.
enum ViewTreeBuilder {
    static func node(for view: UIView, maxDepth: Int = 64) -> ViewNode {
        let frame = view.convert(view.bounds, to: nil)
        var superclasses: [String] = []
        var cls: AnyClass? = class_getSuperclass(type(of: view))
        while let c = cls, c != UIView.self, c != UIResponder.self, c != NSObject.self {
            superclasses.append(NSStringFromClass(c))
            cls = class_getSuperclass(c)
        }
        let children: [ViewNode]
        if maxDepth > 0 {
            children = view.subviews.map { node(for: $0, maxDepth: maxDepth - 1) }
        } else {
            children = []
        }
        return ViewNode(
            className: NSStringFromClass(type(of: view)),
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
