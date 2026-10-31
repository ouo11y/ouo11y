import Foundation
import OuoReplayCore

/// One view of the chain a touch went through, innermost first: what the tap rules need, read on the
/// main thread by the UIKit glue (`UIKitTracking`). No accessibility label and no traits: with an
/// assistive technology on (VoiceOver, Voice Control, Switch Control, an XCUITest runner) UIKit
/// fills a button's label with its visible title (rule 6).
struct TouchedView: Equatable {
    var className: String
    /// `accessibilityIdentifier` (a test id; the replay markers are not names).
    var identifier: String?
    /// A `UIControl`: the view type of a touch on its content.
    var isControl: Bool
}

/// `ui.tap` (mobile SDK spec C6) for native views: named by test ids only.
enum TapRules {
    static let swipeDistance: Double = 10
    static let longPress: Double = 500
    static let maxPath = 5
    private static let markers: Set<String> = [RedactionRules.maskIdentifier, RedactionRules.unmaskIdentifier, RedactionRules.unmaskAreaIdentifier]

    /// `swipe` when the touch moved 10 points or more, else `long_press` when held 500 ms or more, else `tap`.
    static func gesture(durationMs: Double, dx: Double, dy: Double) -> String {
        if (dx * dx + dy * dy).squareRoot() >= swipeDistance { return "swipe" }
        return durationMs >= longPress ? "long_press" : "tap"
    }

    /// A view's name: its test id, never text.
    static func label(_ v: TouchedView) -> String? {
        guard let id = v.identifier, !id.isEmpty, !markers.contains(id) else { return nil }
        return id
    }

    /// `ouo.ui.target`, `ouo.ui.path` and `ouo.ui.view_type` for a touch on `chain` (innermost first):
    /// the first test id up the chain and the test ids above it; the view type is the class of the
    /// view that carries the id, else of the first control, else of the touched view, and is the
    /// target when nothing has an id. Without labels (`tapLabels` off) the target is the view type,
    /// without a path.
    static func describe(_ chain: [TouchedView], labels: Bool) -> (target: String, path: String?, viewType: String)? {
        guard let innermost = chain.first else { return nil }
        let labelled = chain.firstIndex { label($0) != nil }
        let carrier = labelled.map { chain[$0] } ?? chain.first { $0.isControl } ?? innermost
        let viewType = shortName(carrier.className)
        guard labels, let i = labelled, let target = label(chain[i]) else { return (viewType, nil, viewType) }
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
