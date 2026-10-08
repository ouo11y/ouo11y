import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// Platform-neutral snapshot of one view, built by walking `UIView.subviews` in the UIKit target
/// (`frameInWindow` = `convert(bounds, to: nil)`). Tests build trees by hand.
public struct ViewNode: Sendable {
    public var className: String
    /// Superclass names, nearest first, so a `RCTUITextField` (subclass of `UITextField`) is
    /// masked by the `UITextField` rule. Empty when the caller only knows the leaf class.
    public var superclassNames: [String]
    public var frameInWindow: CGRect
    public var hidden: Bool
    public var alpha: CGFloat
    public var accessibilityIdentifier: String?
    public var children: [ViewNode]

    public init(
        className: String,
        superclassNames: [String] = [],
        frameInWindow: CGRect,
        hidden: Bool = false,
        alpha: CGFloat = 1,
        accessibilityIdentifier: String? = nil,
        children: [ViewNode] = []
    ) {
        self.className = className
        self.superclassNames = superclassNames
        self.frameInWindow = frameInWindow
        self.hidden = hidden
        self.alpha = alpha
        self.accessibilityIdentifier = accessibilityIdentifier
        self.children = children
    }
}

/// Which classes get redacted (spec: capture rule 2) and the override identifiers.
public struct RedactionRules: Sendable {
    public static let maskIdentifier = "ouo-mask"
    public static let unmaskIdentifier = "ouo-unmask"

    /// UIKit text entry and display plus the React Native text components (RN renders text with
    /// its own views, not UILabel: Paper `RCTTextView`, Fabric `RCTParagraphComponentView`,
    /// inputs `RCTUITextField` / `RCTUITextView` subclass UIKit's).
    public static let textClasses: Set<String> = [
        "UITextField", "UITextView", "UILabel",
        "RCTTextView", "RCTParagraphComponentView",
        "RCTUITextField", "RCTUITextView", "RCTTextInputComponentView",
    ]
    public static let imageClasses: Set<String> = [
        "UIImageView", "RCTImageView", "RCTImageComponentView",
    ]
    public static let webViewClasses: Set<String> = ["WKWebView"]

    public var maskText: Bool
    public var maskImages: Bool
    public var maskWebViews: Bool
    /// Extra class names the host wants masked.
    public var extraClasses: Set<String>

    public init(maskText: Bool = true, maskImages: Bool = true, maskWebViews: Bool = true, extraClasses: Set<String> = []) {
        self.maskText = maskText
        self.maskImages = maskImages
        self.maskWebViews = maskWebViews
        self.extraClasses = extraClasses
    }

    public var maskedClasses: Set<String> {
        var set = extraClasses
        if maskText { set.formUnion(RedactionRules.textClasses) }
        if maskImages { set.formUnion(RedactionRules.imageClasses) }
        if maskWebViews { set.formUnion(RedactionRules.webViewClasses) }
        return set
    }

    /// True when any rule masks (used for the chunk's `masked` flag).
    public var masksAnything: Bool { maskText || maskImages || maskWebViews || !extraClasses.isEmpty }
}

/// Computes the rectangles (window coordinates, points) to paint black before a frame is encoded.
public struct RedactionPlanner: Sendable {
    public var rules: RedactionRules
    /// Merge rectangles that overlap into their union (fewer fills, same coverage).
    public var mergeOverlapping: Bool

    public init(rules: RedactionRules = RedactionRules(), mergeOverlapping: Bool = true) {
        self.rules = rules
        self.mergeOverlapping = mergeOverlapping
    }

    /// `window` is the window bounds; rectangles outside it are clipped, empty ones dropped.
    public func rects(for root: ViewNode, window: CGRect) -> [CGRect] {
        var out: [CGRect] = []
        let masked = rules.maskedClasses
        visit(root, window: window, masked: masked, into: &out)
        return mergeOverlapping ? RedactionPlanner.merge(out) : out
    }

    private func visit(_ node: ViewNode, window: CGRect, masked: Set<String>, into out: inout [CGRect]) {
        // Hidden or transparent views hide their whole subtree.
        if node.hidden || node.alpha <= 0.01 { return }
        // Opt-out covers the subtree too (a container marked ouo-unmask shows its labels).
        if node.accessibilityIdentifier == RedactionRules.unmaskIdentifier { return }
        let clipped = node.frameInWindow.intersection(window)
        // Views clipped entirely outside the window cannot be seen, nor can their children.
        if clipped.isNull || clipped.isEmpty {
            return
        }
        let forced = node.accessibilityIdentifier == RedactionRules.maskIdentifier
        if forced || matches(node, masked) {
            out.append(clipped)
            // The rectangle covers the subtree: no need to look inside.
            return
        }
        for child in node.children {
            visit(child, window: window, masked: masked, into: &out)
        }
    }

    private func matches(_ node: ViewNode, _ masked: Set<String>) -> Bool {
        if masked.contains(node.className) { return true }
        for name in node.superclassNames where masked.contains(name) { return true }
        return false
    }

    /// Union-merges every pair of intersecting rectangles until none intersect.
    public static func merge(_ rects: [CGRect]) -> [CGRect] {
        var result = rects
        var changed = true
        while changed {
            changed = false
            outer: for i in 0..<result.count {
                for j in (i + 1)..<result.count where result[i].intersects(result[j]) {
                    let union = result[i].union(result[j])
                    result.remove(at: j)
                    result[i] = union
                    changed = true
                    break outer
                }
            }
        }
        return result
    }
}
