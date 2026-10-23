import Foundation

/// Cumulative frame counters (mobile vitals spec 2.3). Callers diff two snapshots to get a window.
public struct FrameStats: Equatable {
    public var total = 0
    public var slow = 0
    public var frozen = 0
    /// Sum of the time slow and frozen frames ran over their expected duration, ms.
    public var delayMs = 0.0
    /// Expected duration of a frame at the current refresh rate, ms (16.7 at 60 Hz); 0 until a frame was seen.
    public var expectedFrameMs = 0.0

    public init() {}
}

/// Classifies display link callbacks into normal, slow and frozen frames, the way sentry-cocoa's
/// SentryFramesTracker does: the frame duration is the time between two callbacks, the expected
/// duration comes from the link's own `targetTimestamp - timestamp` (so 60, 120 Hz and ProMotion
/// throttling are all handled), a frame is slow when it took longer than one frame at
/// `fps - 1` (Sentry's tolerance for timestamp jitter) and frozen at 700 ms or more.
public struct FrameCounter {
    public static let frozenThreshold: CFTimeInterval = 0.7

    public private(set) var stats = FrameStats()
    private var previous: CFTimeInterval?

    public init() {}

    /// One display link callback. The first one after `reset()` only sets the reference point.
    public mutating func frame(timestamp: CFTimeInterval, targetTimestamp: CFTimeInterval) {
        defer { previous = timestamp }
        guard let prev = previous else { return }
        let duration = timestamp - prev
        let expected = targetTimestamp - timestamp
        guard duration > 0, expected > 0 else { return }
        stats.total += 1
        stats.expectedFrameMs = expected * 1000
        let fps = (1 / expected).rounded()
        let slowThreshold = fps > 1 ? 1 / (fps - 1) : expected
        if duration >= Self.frozenThreshold {
            stats.frozen += 1
            stats.delayMs += (duration - expected) * 1000
        } else if duration > slowThreshold {
            stats.slow += 1
            stats.delayMs += (duration - expected) * 1000
        }
    }

    /// Forgets the reference point: the next callback starts a new interval. Called when the app
    /// leaves the foreground, so the time spent in the background is not one frozen frame.
    public mutating func reset() {
        previous = nil
    }
}
