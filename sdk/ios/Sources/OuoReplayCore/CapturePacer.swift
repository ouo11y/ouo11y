import Foundation

/// What the recorder captures (docs/specs/mobile-replay.md, "Modes").
public enum ReplayMode: String, Codable, Sendable {
    /// One frame per `frameInterval` while the screen changes.
    case session
    /// One frame per screen: on start, resume and every `screenDidChange()`. The low-end default.
    case navigation
    /// `navigation` on devices with less than `lowEndMemory` of RAM, `session` otherwise.
    case auto

    /// iPhones with 3 GB or less (iPhone X, XR, 8, SE 2nd gen and older) count as low end.
    public static let lowEndMemory: UInt64 = 3 * 1024 * 1024 * 1024 + 512 * 1024 * 1024

    /// `auto` resolved for a device with `physicalMemory` bytes; the other modes stay as they are.
    public func resolved(physicalMemory: UInt64) -> ReplayMode {
        guard self == .auto else { return self }
        return physicalMemory < Self.lowEndMemory ? .navigation : .session
    }
}

/// Decides, once per main run-loop pass, whether a frame is captured now. Pure state machine on
/// monotonic seconds, so the rules are unit tested without UIKit (ADR-0006 rev 2):
///
/// - **Interval**: at most one frame per `interval` in `session` mode; in `navigation` mode only
///   when a screen change (or start / resume) is pending, `settleDelay` after it was signalled so
///   the transition has begun before we look.
/// - **Motion and settle**: the recorder reports a running view controller transition on every
///   pass (`motion(now:)`); 4 or more layer animations at the walk count as motion too. Nothing is
///   due until `settleTime` after the last motion, because `drawHierarchy(afterScreenUpdates:
///   false)` reads what the screen last showed, which trails the model.
/// - **Animation deferral** (Sentry): animations defer a due frame up to `maxDeferral`, then it is
///   taken anyway (a spinner must not stop replay). A transition defers it with no limit.
/// - **Time bank** (Datadog): the main-thread part of capturing may spend `budgetPerSecond` per
///   second, banked up to `budgetPerSecond`. A capture spends what it took; while the bank is
///   negative nothing is captured. This is also the backoff: a 150 ms capture at 1 fps leaves
///   one frame every 1.5 s, a 300 ms one every 3 s.
/// - **Retry**: a requested frame (resume, a new screen) that was dropped is asked for again
///   `retryDelay` later, at most `maxRetries` times.
///
/// `wakeAt` is the earliest time a frame can become due: the recorder wakes the run loop then and
/// skips every pass before it, so no pass walks the view tree while a frame waits.
public struct CapturePacer: Sendable {
    public enum Decision: Equatable, Sendable {
        case capture(FrameReason)
        case wait
    }

    public var mode: ReplayMode
    public var interval: TimeInterval
    public var animationThreshold = 4
    public var maxDeferral: TimeInterval = 1
    public var settleDelay: TimeInterval = 0.4
    public var settleTime: TimeInterval = 0.25
    public var budgetPerSecond: TimeInterval = 0.1
    public var retryDelay: TimeInterval = 0.5
    public var maxRetries = 3

    private var lastCaptureAt: TimeInterval?
    private var deferringSince: TimeInterval?
    private var lastMotionAt: TimeInterval?
    private var pending: (reason: FrameReason, at: TimeInterval)?
    private var retries = 0
    private var bank: TimeInterval
    private var bankUpdatedAt: TimeInterval?

    public init(mode: ReplayMode, interval: TimeInterval) {
        self.mode = mode == .auto ? .session : mode
        self.interval = max(0.1, interval)
        self.bank = budgetPerSecond
    }

    /// Start or resume: the first pass from `at` on captures, in every mode.
    public mutating func requestFrame(_ reason: FrameReason, at: TimeInterval) {
        pending = (reason, at)
        deferringSince = nil
        retries = 0
    }

    /// A new screen: in `navigation` mode the frame is taken once the screen settled.
    public mutating func screenDidChange(now: TimeInterval) {
        guard mode == .navigation else { return }
        requestFrame(.navigation, at: now + settleDelay)
    }

    /// Something on screen is moving that the walk does not see (a view controller transition).
    public mutating func motion(now: TimeInterval) {
        lastMotionAt = now
    }

    /// A captured frame was not kept (a masked view moving, a render failure). Interval frames wait
    /// for the next interval; a requested one is asked for again.
    public mutating func dropped(_ reason: FrameReason, now: TimeInterval) {
        guard reason != .timer, retries < maxRetries else { return }
        retries += 1
        pending = (reason, now + retryDelay)
    }

    /// Cheap check before the view walk: false when nothing can be captured on this pass.
    public mutating func isDue(now: TimeInterval) -> Bool {
        refill(now: now)
        guard let at = wakeAt(now: now) else { return false }
        return now >= at
    }

    /// The earliest time a frame can be due, nil when none is wanted (navigation mode, nothing
    /// pending).
    public func wakeAt(now: TimeInterval) -> TimeInterval? {
        var at: TimeInterval
        if let p = pending {
            at = p.at
        } else if mode == .session {
            at = lastCaptureAt.map { $0 + interval } ?? now
        } else {
            return nil
        }
        if let m = lastMotionAt { at = max(at, m + settleTime) }
        if bank < 0, let updated = bankUpdatedAt { at = max(at, updated - bank / budgetPerSecond) }
        return at
    }

    /// After the walk: `animations` is the number of running layer animations on screen.
    public mutating func decide(now: TimeInterval, animations: Int) -> Decision {
        guard isDue(now: now) else { return .wait }
        if animations >= animationThreshold {
            let since = deferringSince ?? now
            deferringSince = since
            if now - since < maxDeferral {
                lastMotionAt = now
                return .wait
            }
        }
        deferringSince = nil
        let reason = pending?.reason ?? .timer
        pending = nil
        lastCaptureAt = now
        return .capture(reason)
    }

    /// The main-thread seconds a pass spent (walk, and render when it captured).
    public mutating func spent(_ seconds: TimeInterval, now: TimeInterval) {
        refill(now: now)
        bank -= max(0, seconds)
    }

    /// Bank balance in seconds (tests, debug log).
    public var balance: TimeInterval { bank }

    private mutating func refill(now: TimeInterval) {
        if let at = bankUpdatedAt, now > at {
            bank = min(budgetPerSecond, bank + (now - at) * budgetPerSecond)
        }
        bankUpdatedAt = now
    }
}
