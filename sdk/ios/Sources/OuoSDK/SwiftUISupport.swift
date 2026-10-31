#if canImport(SwiftUI) && canImport(UIKit)
import OuoReplayCore
import SwiftUI
import UIKit

public extension View {
    /// This view is a screen (C7, C4): `navigation` and its TTID when it appears. SwiftUI screens
    /// are not view controllers of the app, so the automatic tracking does not see them.
    func ouoScreen(_ name: String) -> some View {
        onAppear { Ouo.trackScreen(name) }
    }

    /// Replay masks this view's area whatever the masking options say (C8): an `ouo-mask` marker
    /// view behind it, which the redaction planner covers.
    func ouoMask() -> some View {
        background(OuoMarker(identifier: RedactionRules.maskIdentifier))
    }

    /// Replay shows this view's area unmasked, whatever the options mask inside it: an `ouo-unmask`
    /// marker view behind it.
    func ouoUnmask() -> some View {
        background(OuoMarker(identifier: RedactionRules.unmaskIdentifier))
    }
}

/// An empty, untouchable `UIView` carrying a replay marker identifier, sized like the view it backs.
struct OuoMarker: UIViewRepresentable {
    let identifier: String

    func makeUIView(context: Context) -> UIView {
        let v = UIView()
        v.accessibilityIdentifier = identifier
        v.isUserInteractionEnabled = false
        v.backgroundColor = .clear
        v.isAccessibilityElement = false
        return v
    }

    func updateUIView(_ uiView: UIView, context: Context) {}
}
#endif
