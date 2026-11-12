import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// One look of the structure format: the view tree as the walker saw it (with `ViewNode.style`),
/// the window in points and the screen's pixels per point.
public struct TreeLook: ReplayLook, Sendable {
    public var root: ViewNode
    public var window: CGRect
    public var scale: Double

    public init(root: ViewNode, window: CGRect, scale: Double) {
        self.root = root
        self.window = window
        self.scale = scale
    }
}

/// Turns a view tree into the nodes of `ouo-wireframe/1`: rectangles with a kind, colours and
/// text, never pixels. The model follows the wireframe replays of Datadog and PostHog as the
/// vendor research describes them (ADR-0019 decision 6); no code is taken from either.
///
/// Masking (PRV-5 to PRV-8), decided here and nowhere later:
/// - a secure text field is kind `secure` with text `***`, whatever the options and overrides say;
/// - text is `***` when `maskText` applies (labels, React Native text) or `maskInputs` applies
///   (inputs), unless an `ouo-unmask` / `unmask(reactTag)` ancestor shows it;
/// - a view masked by the host (`ouo-mask`, `mask(reactTag)`, an extra class) or cut off by the
///   depth limit is one rectangle with `"masked":true` and nothing of its subtree (mask wins);
/// - an image or a web view is its kind and rectangle only; an input, an image and a web view
///   are leaves, so what UIKit draws inside them (the field's own labels) is never walked.
public struct WireframeBuilder: Sendable {
    public static let maskedText = "***"

    public var rules: RedactionRules
    /// Nodes written per snapshot; the rest of the tree is left out and the event says so.
    public var maxNodes: Int
    /// Characters of an unmasked text kept.
    public var maxTextLength: Int

    public init(rules: RedactionRules = RedactionRules(), maxNodes: Int = 2000, maxTextLength: Int = 2000) {
        self.rules = rules
        self.maxNodes = maxNodes
        self.maxTextLength = maxTextLength
    }

    public struct Result: Equatable, Sendable {
        /// One JSON object per node, parents before children.
        public var nodes: [String]
        public var truncated: Bool
    }

    private enum Kind: String { case view, text, input, image, web, secure }
    private enum Bar { case none, bar, item }

    private struct State {
        var nodes: [String] = []
        var truncated = false
    }

    public func build(_ look: TreeLook) -> Result {
        var state = State()
        let scale = look.scale.isFinite && look.scale > 0 ? look.scale : 1
        visit(look.root, parent: 0, unmasked: false, forceMask: false, alpha: 1, bar: .none, isRoot: true, window: look.window, scale: scale, state: &state)
        return Result(nodes: state.nodes, truncated: state.truncated)
    }

    private func visit(_ node: ViewNode, parent: Int, unmasked: Bool, forceMask: Bool, alpha: Double, bar: Bar, isRoot: Bool, window: CGRect, scale: Double, state: inout State) {
        if node.hidden || (node.alpha <= 0.01 && !node.animating) { return }
        if state.nodes.count >= maxNodes {
            state.truncated = true
            return
        }
        let forced = node.accessibilityIdentifier == RedactionRules.maskIdentifier || node.maskOverride == .mask
        let unmaskHere = !forced && (node.accessibilityIdentifier == RedactionRules.unmaskIdentifier || node.maskOverride == .unmask)
        let unmasked = unmasked || unmaskHere
        let clipped = node.frameInWindow.intersection(window)
        let visible = !(clipped.isNull || clipped.isEmpty)
        var bar = bar
        if bar == .none, RedactionPlanner.isKind(node, RedactionRules.barClasses) { bar = .bar }
        if bar == .bar, node.className.contains(RedactionRules.barItemHostMarker) { bar = .item }
        let chrome = bar == .bar && RedactionRules.drawingClasses.contains(node.className)
        let alpha = min(1, max(0, alpha * Double(node.alpha)))

        var kind = Kind.view
        var box = false
        if node.secure {
            kind = .secure
        } else if forceMask || forced || node.truncated || (!unmasked && RedactionPlanner.isKind(node, rules.extraClasses)) {
            box = true
        } else if RedactionPlanner.isKind(node, RedactionRules.inputClasses) {
            kind = .input
        } else if RedactionPlanner.isKind(node, RedactionRules.webViewClasses) {
            kind = .web
        } else if RedactionPlanner.isKind(node, RedactionRules.imageClasses) || RedactionRules.imageClassSuffixes.contains(where: { node.className.hasSuffix($0) }) {
            kind = .image
        } else if RedactionPlanner.isKind(node, RedactionRules.textClasses), !chrome {
            kind = .text
        }

        if box || kind != .view {
            if visible {
                state.nodes.append(json(node, id: state.nodes.count + 1, parent: parent, kind: box ? .view : kind, box: box, unmasked: unmasked, rect: clipped, alpha: alpha, scale: scale))
                return
            }
            // No rectangle of its own, but UIKit does not clip subviews: what is inside may still
            // draw. Text containers are walked as usual (their text child is matched by the same
            // rules); anything else is masked whatever it holds.
            let mask = box || kind != .text
            for child in node.children {
                visit(child, parent: parent, unmasked: unmasked, forceMask: forceMask || mask, alpha: alpha, bar: bar, isRoot: false, window: window, scale: scale, state: &state)
            }
            return
        }

        var parent = parent
        let style = node.style
        let paints = (style?.background).map { $0 & 0xff != 0 } ?? false || ((style?.borderWidth ?? 0) > 0 && style?.borderColor != nil)
        if visible, isRoot || paints {
            state.nodes.append(json(node, id: state.nodes.count + 1, parent: parent, kind: .view, box: false, unmasked: unmasked, rect: clipped, alpha: alpha, scale: scale))
            parent = state.nodes.count
        }
        for child in node.children {
            visit(child, parent: parent, unmasked: unmasked, forceMask: false, alpha: alpha, bar: bar, isRoot: false, window: window, scale: scale, state: &state)
        }
    }

    private func json(_ node: ViewNode, id: Int, parent: Int, kind: Kind, box: Bool, unmasked: Bool, rect: CGRect, alpha: Double, scale: Double) -> String {
        var out = "{\"id\":\(id),\"parent\":\(parent),\"kind\":\"\(kind.rawValue)\""
        out += ",\"x\":\(ReplayJSON.number(Double(rect.minX) * scale)),\"y\":\(ReplayJSON.number(Double(rect.minY) * scale))"
        out += ",\"w\":\(ReplayJSON.number(Double(rect.width) * scale)),\"h\":\(ReplayJSON.number(Double(rect.height) * scale))"
        if box {
            // Nothing else: a masked view gives away neither its colours nor what is inside.
            return out + ",\"masked\":true}"
        }
        let style = node.style
        if let bg = style?.background, let c = Self.faded(bg, alpha) { out += ",\"bg\":\(ReplayJSON.color(c))" }
        if let fg = style?.foreground, let c = Self.faded(fg, alpha) { out += ",\"fg\":\(ReplayJSON.color(c))" }
        if let r = style?.cornerRadius, r > 0 { out += ",\"radius\":\(ReplayJSON.number(r * scale))" }
        if let w = style?.borderWidth, w > 0, let color = style?.borderColor, let c = Self.faded(color, alpha) {
            out += ",\"border\":{\"w\":\(ReplayJSON.number(w * scale)),\"color\":\(ReplayJSON.color(c))}"
        }
        switch kind {
        case .secure:
            out += ",\"text\":\(ReplayJSON.string(Self.maskedText))"
        case .text, .input:
            let masks = !unmasked && (kind == .text ? rules.maskText : rules.maskInputs)
            if masks {
                out += ",\"text\":\(ReplayJSON.string(Self.maskedText))"
            } else if let text = style?.text, !text.isEmpty {
                out += ",\"text\":\(ReplayJSON.string(String(text.prefix(max(0, maxTextLength)))))"
            }
        case .view, .image, .web:
            break
        }
        if kind == .secure || kind == .text || kind == .input {
            if let size = style?.fontSize, size > 0 { out += ",\"fontSize\":\(ReplayJSON.number(size * scale))" }
            if let align = style?.align, ["left", "center", "right", "justify"].contains(align) { out += ",\"align\":\"\(align)\"" }
        }
        return out + "}"
    }

    /// The colour with the view's (and its ancestors') alpha folded into its own; nil when nothing
    /// is left to see.
    private static func faded(_ rgba: UInt32, _ alpha: Double) -> UInt32? {
        let a = (Double(rgba & 0xff) * alpha).rounded()
        guard a >= 1 else { return nil }
        return (rgba & 0xffff_ff00) | UInt32(min(255, a))
    }
}

/// The structure format, `ouo-wireframe/1` (ADR-0019 decision 5). One event per changed tree:
///
/// `{"t":ms,"type":"full","w":px,"h":px,"scale":n,"nodes":[{"id":int,"parent":int,"kind":
/// "view|text|input|image|web|secure","x":..,"y":..,"w":..,"h":..,"masked":true?,"bg":"#rrggbbaa"?,
/// "fg":"#rrggbbaa"?,"radius":n?,"border":{"w":n,"color":"#rrggbbaa"}?,"text":"***"?,
/// "fontSize":n?,"align":"left|center|right|justify"?}],"truncated":true?}`
///
/// Rectangles, radius, border width and font size are screen pixels (points times `scale`), `id`
/// counts from 1 in drawing order and `parent` is 0 for the top. Every event is a full snapshot,
/// so every event is a keyframe; an unchanged tree writes nothing. Touches are the shared `touch`
/// event.
public final class WireframeFormatAdapter: ReplayFormatAdapter {
    public static let format = "ouo-wireframe/1"

    public let formatId = WireframeFormatAdapter.format
    public let masked: Bool
    private let builder: WireframeBuilder
    /// Hash and length of the last snapshot written, without its time.
    private var last: (hash: UInt64, count: Int)?

    public init(rules: RedactionRules = RedactionRules(), maxNodes: Int = 2000) {
        var rules = rules
        rules.strict = true
        builder = WireframeBuilder(rules: rules, maxNodes: maxNodes)
        masked = rules.masksAnything
    }

    public func requestKeyframe() {
        last = nil
    }

    public func events(for look: ReplayLook, at t: EpochMillis) throws -> [ReplayEvent] {
        guard let look = look as? TreeLook else { throw ReplayFormatError.wrongLook }
        // A window without a size has no rectangles to place anything in: nothing can be said
        // about what is masked, so the frame is dropped.
        guard look.window.width > 0, look.window.height > 0, look.scale.isFinite, look.scale > 0 else {
            throw ReplayFormatError.maskingFailed
        }
        let result = builder.build(look)
        var body = "\"type\":\"full\",\"w\":\(ReplayJSON.number(Double(look.window.width) * look.scale)),\"h\":\(ReplayJSON.number(Double(look.window.height) * look.scale)),\"scale\":\(ReplayJSON.number(look.scale)),\"nodes\":["
        body += result.nodes.joined(separator: ",")
        body += "]"
        if result.truncated { body += ",\"truncated\":true" }
        let bytes = Array(body.utf8)
        let signature = (hash: Self.fnv1a(bytes), count: bytes.count)
        if let last, last == signature { return [] }
        last = signature
        var json = Data("{\"t\":\(t),".utf8)
        json.append(contentsOf: bytes)
        json.append(UInt8(ascii: "}"))
        return [ReplayEvent(t: t, keyframe: true, json: json)]
    }

    static func fnv1a(_ bytes: [UInt8]) -> UInt64 {
        var hash: UInt64 = 0xcbf2_9ce4_8422_2325
        for b in bytes {
            hash ^= UInt64(b)
            hash = hash &* 0x0000_0100_0000_01b3
        }
        return hash
    }
}
