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
    /// The layer runs any animation: a view whose model alpha is already 0 may still be fading out
    /// on screen, so it is not skipped as transparent.
    public var animating: Bool
    /// The view may not be where `frameInWindow` says: an animation that can move it (position,
    /// bounds, transform, or one we do not know) runs on its layer, or it is a scroll view being
    /// dragged or decelerating (the screen trails the model by a frame).
    public var moving: Bool
    /// The walk stopped at its depth limit with subviews left unvisited.
    public var truncated: Bool
    public var children: [ViewNode]

    public init(
        className: String,
        superclassNames: [String] = [],
        frameInWindow: CGRect,
        hidden: Bool = false,
        alpha: CGFloat = 1,
        accessibilityIdentifier: String? = nil,
        animating: Bool = false,
        moving: Bool = false,
        truncated: Bool = false,
        children: [ViewNode] = []
    ) {
        self.className = className
        self.superclassNames = superclassNames
        self.frameInWindow = frameInWindow
        self.hidden = hidden
        self.alpha = alpha
        self.accessibilityIdentifier = accessibilityIdentifier
        self.animating = animating || moving
        self.moving = moving
        self.truncated = truncated
        self.children = children
    }
}

/// Which classes get redacted (spec: capture rule 4) and the override identifiers.
public struct RedactionRules: Sendable {
    public static let maskIdentifier = "ouo-mask"
    public static let unmaskIdentifier = "ouo-unmask"

    /// Text inputs: UIKit entry views plus the React Native input components (`RCTUITextField` /
    /// `RCTUITextView` subclass UIKit's; Fabric wraps them in `RCTTextInputComponentView`).
    /// Governed by `maskInputs`, separately from `maskText`, so a host that opts out of label
    /// masking keeps whatever the user types redacted.
    public static let inputClasses: Set<String> = [
        "UITextField", "UITextView",
        "RCTUITextField", "RCTUITextView", "RCTTextInputComponentView",
    ]
    /// Displayed text: `UILabel` plus the React Native text components (RN renders text with
    /// its own views, not UILabel: Paper `RCTTextView`, Fabric `RCTParagraphComponentView`).
    /// Governed by `maskText`.
    public static let textClasses: Set<String> = [
        "UILabel",
        "RCTTextView", "RCTParagraphComponentView", "RCTParagraphTextView",
        // SwiftUI draws text (and symbol images) in these. iOS 26+ also draws the navigation bar's
        // glass with them, so inside system bars (`barClasses`) they are not masked.
        "SwiftUI.CGDrawingView",
        // iOS 26+ navigation bar items (back button title, bar button titles) are wrapped here.
        "_TtCC5UIKit19NavigationButtonBar15ItemWrapperView",
    ]
    public static let imageClasses: Set<String> = [
        "UIImageView", "RCTImageView", "RCTImageComponentView",
    ]
    public static let webViewClasses: Set<String> = ["WKWebView"]
    /// System bars: SwiftUI drawing views inside them are bar chrome, not app content.
    public static let barClasses: Set<String> = ["UINavigationBar", "UITabBar", "UIToolbar"]
    static let drawingClasses: Set<String> = ["SwiftUI.CGDrawingView"]

    /// Labels and React Native text (`textClasses`).
    public var maskText: Bool
    /// Text inputs (`inputClasses`). Independent of `maskText`.
    public var maskInputs: Bool
    public var maskImages: Bool
    public var maskWebViews: Bool
    /// Extra class names the host wants masked.
    public var extraClasses: Set<String>

    public init(maskText: Bool = true, maskInputs: Bool = true, maskImages: Bool = true, maskWebViews: Bool = true, extraClasses: Set<String> = []) {
        self.maskText = maskText
        self.maskInputs = maskInputs
        self.maskImages = maskImages
        self.maskWebViews = maskWebViews
        self.extraClasses = extraClasses
    }

    public var maskedClasses: Set<String> {
        var set = extraClasses
        if maskText { set.formUnion(RedactionRules.textClasses) }
        if maskInputs { set.formUnion(RedactionRules.inputClasses) }
        if maskImages { set.formUnion(RedactionRules.imageClasses) }
        if maskWebViews { set.formUnion(RedactionRules.webViewClasses) }
        return set
    }

    /// True when any rule masks (used for the chunk's `masked` flag).
    public var masksAnything: Bool { maskText || maskInputs || maskImages || maskWebViews || !extraClasses.isEmpty }
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
    /// Nil means the frame must be dropped (masking fails closed): a rectangle to mask sits on a
    /// layer that is moving, so the pixels the render server drew may be elsewhere.
    public func rects(for root: ViewNode, window: CGRect) -> [CGRect]? {
        var out: [CGRect] = []
        let masked = rules.maskedClasses
        guard visit(root, window: window, masked: masked, moving: false, inBar: false, into: &out) else { return nil }
        // A childless `ouo-unmask` marker (SwiftUI's `.ouoUnmask()`, a view behind content drawn in
        // its siblings) unmasks the area it covers: masked rectangles inside it are left out.
        let regions = Self.unmaskRegions(root)
        if !regions.isEmpty { out.removeAll { r in regions.contains { $0.insetBy(dx: -1, dy: -1).contains(r) } } }
        return mergeOverlapping ? RedactionPlanner.merge(out) : out
    }

    /// False when a masked rectangle is moving.
    private func visit(_ node: ViewNode, window: CGRect, masked: Set<String>, moving: Bool, inBar: Bool, into out: inout [CGRect]) -> Bool {
        // Hidden or transparent views hide their whole subtree, unless still fading out.
        if node.hidden || (node.alpha <= 0.01 && !node.animating) { return true }
        // Opt-out covers the subtree too (a container marked ouo-unmask shows its labels).
        if node.accessibilityIdentifier == RedactionRules.unmaskIdentifier { return true }
        let moving = moving || node.moving
        let clipped = node.frameInWindow.intersection(window)
        // UIKit does not clip subviews to their parent's bounds by default, so a zero-sized or
        // off-screen node can still have visible children (React Native paragraph views in
        // navigation bars report an empty frame while their text child draws). Only a node with a
        // visible rectangle of its own can cover its subtree; otherwise keep walking.
        let visible = !(clipped.isNull || clipped.isEmpty)
        let forced = node.accessibilityIdentifier == RedactionRules.maskIdentifier
        // A subtree the walk did not finish may hold anything: masked like a matched view.
        let inBar = inBar || Self.isKind(node, RedactionRules.barClasses)
        let bar = inBar && RedactionRules.drawingClasses.contains(node.className)
        if visible, forced || node.truncated || (matches(node, masked) && !bar) {
            if moving { return false }
            out.append(clipped)
            // The rectangle covers the subtree: no need to look inside.
            return true
        }
        for child in node.children {
            guard visit(child, window: window, masked: masked, moving: moving, inBar: inBar, into: &out) else { return false }
        }
        return true
    }

    private static func unmaskRegions(_ node: ViewNode) -> [CGRect] {
        if node.accessibilityIdentifier == RedactionRules.unmaskIdentifier, node.children.isEmpty { return [node.frameInWindow] }
        return node.children.flatMap(unmaskRegions)
    }

    private func matches(_ node: ViewNode, _ masked: Set<String>) -> Bool {
        Self.isKind(node, masked)
    }

    private static func isKind(_ node: ViewNode, _ classes: Set<String>) -> Bool {
        classes.contains(node.className) || node.superclassNames.contains { classes.contains($0) }
    }

    /// Union-merges every pair of intersecting rectangles until none intersect.
    /// Diagnostic: class names in the tree that look like text or images but matched no rule.
    /// Logged in debug mode so new UIKit / React Native classes can be added to the rules.
    public func unmatchedContentClasses(in root: ViewNode) -> [String] {
        var out = Set<String>()
        let masked = rules.maskedClasses
        func visit(_ node: ViewNode) {
            if node.accessibilityIdentifier == RedactionRules.unmaskIdentifier { return }
            let name = node.className
            let looksLikeContent = ["Text", "Label", "Paragraph", "Image", "Glyph", "Graphics", "Drawing", "Button"].contains { name.contains($0) }
            if looksLikeContent, !matches(node, masked) { out.insert(name) }
            node.children.forEach(visit)
        }
        visit(root)
        return out.sorted()
    }

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
