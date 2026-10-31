import Foundation
import OuoReplayCore

/// One view of the chain a touch went through, innermost first: what the tap rules need, read on the
/// main thread by the UIKit glue (`UIKitTracking`).
struct TouchedView: Equatable {
    var className: String
    /// `accessibilityIdentifier` (a test id; `ouo-mask` and `ouo-unmask` are not labels).
    var identifier: String?
    /// `accessibilityLabel`, used only for controls (rule 6: a label view's label is its text).
    var accessibilityLabel: String?
    /// A `UIControl`, or an element with the button or link trait.
    var isControl: Bool
    /// `button` or `link` from the accessibility traits, nil otherwise.
    var role: String?
    /// A view that shows text (labels, text fields and views): its accessibility label is never read.
    var showsText: Bool
}

/// `ui.tap` (mobile SDK spec C6), the rules of the React Native SDK's taps for native views.
enum TapRules {
    static let swipeDistance: Double = 10
    static let longPress: Double = 500
    static let maxPath = 5

    /// `swipe` when the touch moved 10 points or more, else `long_press` when held 500 ms or more, else `tap`.
    static func gesture(durationMs: Double, dx: Double, dy: Double) -> String {
        if (dx * dx + dy * dy).squareRoot() >= swipeDistance { return "swipe" }
        return durationMs >= longPress ? "long_press" : "tap"
    }

    /// A view's label: its test id, else a control's accessibility label; never text content.
    static func label(_ v: TouchedView) -> String? {
        if let id = v.identifier, !id.isEmpty, id != RedactionRules.maskIdentifier, id != RedactionRules.unmaskIdentifier { return id }
        if v.isControl, !v.showsText, let l = v.accessibilityLabel, !l.isEmpty { return l }
        return nil
    }

    /// `ouo.ui.target`, `ouo.ui.path` and `ouo.ui.view_type` for a touch on `chain` (innermost first).
    /// Without labels (`tapLabels` off) the target is the view type and there is no path.
    static func describe(_ chain: [TouchedView], labels: Bool) -> (target: String, path: String?, viewType: String)? {
        guard let innermost = chain.first else { return nil }
        let labelled = chain.firstIndex { label($0) != nil }
        let carrier = labelled.map { chain[$0] } ?? chain.first { $0.isControl } ?? innermost
        let viewType = carrier.role ?? shortName(carrier.className)
        guard labels else { return (viewType, nil, viewType) }
        guard let i = labelled, let target = label(chain[i]) else { return (shortName(innermost.className), nil, viewType) }
        let names = chain[i...].compactMap(label).prefix(maxPath)
        return (target, names.count > 1 ? names.joined(separator: " > ") : nil, viewType)
    }

    /// `Tap add-to-cart (button) on Products`.
    static func step(gesture: String, target: String, viewType: String?, screen: String) -> String {
        let verb = ["tap": "Tap", "long_press": "Long press", "swipe": "Swipe"][gesture] ?? "Tap"
        let type = viewType.flatMap { $0 == target ? nil : " (\($0))" } ?? ""
        return "\(verb) \(target)\(type)\(screen.isEmpty ? "" : " on \(screen)")"
    }

    /// `MyApp.CartViewController` and `_TtC5MyApp4Cart` read as `CartViewController`, `Cart`.
    static func shortName(_ className: String) -> String {
        if let dot = className.lastIndex(of: ".") { return String(className[className.index(after: dot)...]) }
        return className
    }
}

/// Which view controllers are screens (C7): the app's own (its class is in the main bundle), shown
/// on their own or in a system container (navigation, tab bar, split, page). Not system controllers
/// (alerts, keyboards, SwiftUI's hosting controllers: SwiftUI screens use `.ouoScreen`), not the
/// app's containers' children.
enum ScreenRules {
    static func isScreen(inMainBundle: Bool, parentIsSystemContainer: Bool, hasParent: Bool) -> Bool {
        inMainBundle && (!hasParent || parentIsSystemContainer)
    }

    /// The screen's name: what the controller says (`OuoScreenNaming`), else its class name.
    static func name(className: String, override: String?) -> String? {
        if let o = override { return o.isEmpty ? nil : o }
        return TapRules.shortName(className)
    }
}

/// A view controller that names its screen, or opts out with nil (Objective-C: `ouoScreenName`).
@objc public protocol OuoScreenNaming {
    /// The screen's name in `navigation` and `app.screen.name`; nil: not a screen.
    var ouoScreenName: String? { get }
}

/// `feedback` (mobile SDK spec C10): the user's text as the app passes it, trimmed and cut.
enum Feedback {
    static let maxBytes = 4096

    static func attributes(message: String, contact: String?, id: String) -> Attributes? {
        let m = message.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !m.isEmpty else { return nil }
        var a: Attributes = ["ouo.feedback.message": .string(cutUtf8(m, maxBytes)), "ouo.feedback.id": .string(id)]
        if let c = contact?.trimmingCharacters(in: .whitespacesAndNewlines), !c.isEmpty { a["ouo.feedback.contact"] = .string(cutUtf8(c, maxBytes)) }
        return a
    }
}
