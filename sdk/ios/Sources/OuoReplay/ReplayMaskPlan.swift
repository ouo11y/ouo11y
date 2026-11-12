#if canImport(UIKit)
import UIKit
import OuoReplayCore
import OuoReplayObjC
import OuoReplaySentryCore

/// The masking plan of the OTLP replay path, the same for both pixel recorders (ADR-0021
/// decision 5: they mask identically). The frames recorder runs these steps inline with its pacer;
/// the video recorder's core (`SentryCoreRecorder`) asks `plan(_:)` before every render.
///
/// - No look while a view controller transition runs: the screen is between two trees and the
///   pixels the render server last drew may belong to either (`isTransitioning`).
/// - The walk reads the host's overrides from `ReplayMaskRegistry` and marks secure fields; the
///   planner applies the strict rules (PRV-6, PRV-7: a mask inside an unmasked subtree masks, a
///   secure field is always masked).
/// - No plan, no frame (PRV-8): a walk that raised, or a masked view on a moving layer.
final class ReplayMaskPlanner {
    let planner: RedactionPlanner

    init(rules: RedactionRules) {
        var strict = rules
        strict.strict = true
        planner = RedactionPlanner(rules: strict, mergeOverlapping: true)
    }

    /// Main thread.
    func plan(_ view: UIView) -> OuoMaskPlan {
        guard let window = view as? UIWindow ?? view.window else { return .drop }
        if Self.isTransitioning(window.rootViewController) { return .wait }
        let detail = ViewTreeBuilder.Detail(masks: ReplayMaskRegistry.shared.snapshot())
        var walked: ViewTreeBuilder.Walk?
        let fault = OuoReplayCatch { walked = ViewTreeBuilder.walk(window, detail: detail) }
        guard let walk = walked, fault == nil else { return .drop }
        guard let rects = planner.rects(for: walk.tree, window: window.bounds) else { return .drop }
        return .mask(rects)
    }

    /// A push, pop, present or dismiss is running somewhere under `vc`.
    static func isTransitioning(_ vc: UIViewController?) -> Bool {
        guard let vc else { return false }
        if vc.transitionCoordinator != nil { return true }
        return isTransitioning(vc.presentedViewController) || vc.children.contains { isTransitioning($0) }
    }
}
#endif
