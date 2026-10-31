#if canImport(UIKit)
import UIKit
import UIKit.UIGestureRecognizerSubclass
import OuoReplayCore

/// A gesture recognizer that only observes: it never leaves `.possible` while touches are down,
/// does not cancel or delay the app's own gestures and recognises simultaneously with everything.
/// Reports touches in window points, `moved` samples coalesced to one per `moveInterval`. Replay
/// records them as `touches`; `OuoSDK` reads the `UITouch` itself for taps (`onUITouch`: every
/// phase, uncoalesced, with the number of fingers down).
public final class TouchObserver: UIGestureRecognizer, UIGestureRecognizerDelegate {
    var onTouch: ((Touch) -> Void)?
    public var onUITouch: ((UITouch, TouchPhase, Int) -> Void)?
    var moveInterval: TimeInterval = 0.05
    private var lastMoveAt: TimeInterval = 0

    /// Uses the inherited `init(target:action:)` so no designated initializer has to be redeclared.
    public static func make() -> TouchObserver {
        let observer = TouchObserver(target: nil, action: nil)
        observer.cancelsTouchesInView = false
        observer.delaysTouchesBegan = false
        observer.delaysTouchesEnded = false
        observer.delegate = observer
        return observer
    }

    // MARK: UIGestureRecognizerDelegate

    public func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
        true
    }

    public func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldBeRequiredToFailBy other: UIGestureRecognizer) -> Bool {
        false
    }

    public func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRequireFailureOf other: UIGestureRecognizer) -> Bool {
        false
    }

    // MARK: touches

    public override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        super.touchesBegan(touches, with: event)
        uiTouch(touches, event, .began)
        report(touches, phase: .began)
    }

    public override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent) {
        super.touchesMoved(touches, with: event)
        uiTouch(touches, event, .moved)
        let now = ProcessInfo.processInfo.systemUptime
        guard now - lastMoveAt >= moveInterval else { return }
        lastMoveAt = now
        report(touches, phase: .moved)
    }

    public override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) {
        super.touchesEnded(touches, with: event)
        uiTouch(touches, event, .ended)
        report(touches, phase: .ended)
        // Leaving `.possible` here lets UIKit reset the recognizer for the next touch sequence.
        state = .failed
    }

    public override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) {
        super.touchesCancelled(touches, with: event)
        uiTouch(touches, event, .ended)
        report(touches, phase: .ended)
        state = .failed
    }

    public override func reset() {
        super.reset()
        lastMoveAt = 0
    }

    private func uiTouch(_ touches: Set<UITouch>, _ event: UIEvent, _ phase: TouchPhase) {
        guard let handler = onUITouch, let touch = touches.first else { return }
        handler(touch, phase, event.allTouches?.count ?? 1)
    }

    private func report(_ touches: Set<UITouch>, phase: TouchPhase) {
        guard let window = view as? UIWindow ?? view?.window, let touch = touches.first else { return }
        let point = touch.location(in: window)
        onTouch?(Touch(ts: Clock.nowMillis(), x: Double(point.x), y: Double(point.y), phase: phase))
    }
}
#endif
