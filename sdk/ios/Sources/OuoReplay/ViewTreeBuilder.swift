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

    /// What the OTLP replay path adds to the walk (the legacy recorder passes none): secure fields,
    /// the host's view-level masks by React tag, and the look of each view for the structure format.
    struct Detail {
        var masked: Set<Int> = []
        var unmasked: Set<Int> = []
        /// Fill `ViewNode.style` (the structure format).
        var style = false
        var rules = RedactionRules()
    }

    static func walk(_ window: UIWindow, maxDepth: Int = 64, detail: Detail? = nil) -> Walk {
        var animations = 0
        let tree = node(for: window, maxDepth: maxDepth, animations: &animations, detail: detail, showText: false)
        return Walk(tree: tree, animations: animations)
    }

    // MARK: detail (OTLP replay path)

    private static let reactTagSelector = NSSelectorFromString("reactTag")
    private static let attributedTextSelector = NSSelectorFromString("attributedText")
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

    private static func rgba(_ color: UIColor?, in view: UIView) -> UInt32? {
        guard let color else { return nil }
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        guard color.resolvedColor(with: view.traitCollection).getRed(&r, green: &g, blue: &b, alpha: &a) else { return nil }
        func channel(_ v: CGFloat) -> UInt32 { v.isFinite ? UInt32((min(max(v, 0), 1) * 255).rounded()) : 0 }
        return channel(r) << 24 | channel(g) << 16 | channel(b) << 8 | channel(a)
    }

    private static func alignment(_ a: NSTextAlignment) -> String? {
        switch a {
        case .left: return "left"
        case .center: return "center"
        case .right: return "right"
        case .justified: return "justify"
        default: return nil
        }
    }

    /// `showText`: an ancestor (or the view) is unmasked by the host. Text is read only where the
    /// options could show it, and never from a secret field; the wireframe builder still decides.
    private static func style(of view: UIView, names: (name: String, superclasses: [String]), input: (field: UIView, secure: Bool)?, showText: Bool, rules: RedactionRules) -> ViewStyle {
        let layer = view.layer
        var s = ViewStyle()
        s.background = rgba(view.backgroundColor, in: view) ?? rgba(layer.backgroundColor.map(UIColor.init(cgColor:)), in: view)
        s.cornerRadius = layer.cornerRadius.isFinite ? Double(layer.cornerRadius) : 0
        s.borderWidth = layer.borderWidth.isFinite ? Double(layer.borderWidth) : 0
        s.borderColor = rgba(layer.borderColor.map(UIColor.init(cgColor:)), in: view)
        if let input {
            let readable = !input.secure && (showText || !rules.maskInputs)
            if let f = input.field as? UITextField {
                s.fontSize = (f.font?.pointSize).map(Double.init)
                s.foreground = rgba(f.textColor, in: f)
                s.align = alignment(f.textAlignment)
                if readable { s.text = (f.text?.isEmpty ?? true) ? f.placeholder : f.text }
            } else if let t = input.field as? UITextView {
                s.fontSize = (t.font?.pointSize).map(Double.init)
                s.foreground = rgba(t.textColor, in: t)
                s.align = alignment(t.textAlignment)
                if readable { s.text = t.text }
            }
            return s
        }
        let readable = showText || !rules.maskText
        if let label = view as? UILabel {
            s.fontSize = Double(label.font.pointSize)
            s.foreground = rgba(label.textColor, in: label)
            s.align = alignment(label.textAlignment)
            if readable { s.text = label.text }
        } else if RedactionRules.textClasses.contains(names.name) || names.superclasses.contains(where: RedactionRules.textClasses.contains) {
            // React Native text: Fabric's paragraph view exposes its attributed string.
            if view.responds(to: attributedTextSelector),
               let attributed = view.perform(attributedTextSelector)?.takeUnretainedValue() as? NSAttributedString, attributed.length > 0 {
                let attributes = attributed.attributes(at: 0, effectiveRange: nil)
                s.fontSize = ((attributes[.font] as? UIFont)?.pointSize).map(Double.init)
                s.foreground = rgba(attributes[.foregroundColor] as? UIColor, in: view)
                s.align = ((attributes[.paragraphStyle] as? NSParagraphStyle)?.alignment).flatMap(alignment)
                if readable { s.text = attributed.string }
            } else if readable {
                s.text = view.accessibilityLabel
            }
        }
        return s
    }

    private static func node(for view: UIView, maxDepth: Int, animations: inout Int, detail: Detail?, showText: Bool) -> ViewNode {
        var secure = false
        var maskOverride: ViewNode.MaskOverride?
        var style: ViewStyle?
        var showText = showText
        if let detail {
            let names = names(of: type(of: view))
            let input = input(of: view, names: names)
            secure = input?.secure ?? false
            if let tag = reactTag(of: view, className: names.name) {
                maskOverride = detail.masked.contains(tag) ? .mask : (detail.unmasked.contains(tag) ? .unmask : nil)
            }
            if maskOverride == .unmask || (maskOverride == nil && view.accessibilityIdentifier == RedactionRules.unmaskIdentifier) { showText = true }
            if detail.style {
                style = Self.style(of: view, names: names, input: input, showText: showText, rules: detail.rules)
            }
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
        if let scroll = view as? UIScrollView, scroll.isDragging || scroll.isDecelerating {
            moving = true
        }
        var children: [ViewNode] = []
        var truncated = false
        if !invisible {
            if maxDepth > 0 {
                children = view.subviews.map { node(for: $0, maxDepth: maxDepth - 1, animations: &animations, detail: detail, showText: showText) }
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
            maskOverride: maskOverride,
            style: style
        )
    }
}
#endif
