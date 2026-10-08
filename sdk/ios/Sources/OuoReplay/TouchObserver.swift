#if canImport(UIKit)
import UIKit
import UIKit.UIGestureRecognizerSubclass
import OuoReplayCore

/// A gesture recognizer that only observes: it never leaves `.possible` while touches are down,
/// does not cancel or delay the app's own gestures and recognises simultaneously with everything.
/// Reports touches in window points, `moved` samples coalesced to one per `moveInterval`.
final class TouchObserver: UIGestureRecognizer, UIGestureRecognizerDelegate {
    var onTouch: ((Touch) -> Void)?
    var moveInterval: TimeInterval = 0.05
    private var lastMoveAt: TimeInterval = 0

    /// Uses the inherited `init(target:action:)` so no designated initializer has to be redeclared.
    static func make() -> TouchObserver {
        let observer = TouchObserver(target: nil, action: nil)
        observer.cancelsTouchesInView = false
        observer.delaysTouchesBegan = false
        observer.delaysTouchesEnded = false
        observer.delegate = observer
        return observer
    }

    // MARK: UIGestureRecognizerDelegate

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
        true
    }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldBeRequiredToFailBy other: UIGestureRecognizer) -> Bool {
        false
    }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRequireFailureOf other: UIGestureRecognizer) -> Bool {
        false
    }

    // MARK: touches

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        super.touchesBegan(touches, with: event)
        report(touches, phase: .began)
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent) {
        super.touchesMoved(touches, with: event)
        let now = ProcessInfo.processInfo.systemUptime
        guard now - lastMoveAt >= moveInterval else { return }
        lastMoveAt = now
        report(touches, phase: .moved)
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) {
        super.touchesEnded(touches, with: event)
        report(touches, phase: .ended)
        // Leaving `.possible` here lets UIKit reset the recognizer for the next touch sequence.
        state = .failed
    }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) {
        super.touchesCancelled(touches, with: event)
        report(touches, phase: .ended)
        state = .failed
    }

    override func reset() {
        super.reset()
        lastMoveAt = 0
    }

    private func report(_ touches: Set<UITouch>, phase: TouchPhase) {
        guard let window = view as? UIWindow ?? view?.window, let touch = touches.first else { return }
        let point = touch.location(in: window)
        onTouch?(Touch(ts: Clock.nowMillis(), x: Double(point.x), y: Double(point.y), phase: phase))
    }
}
#endif
