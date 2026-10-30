import Foundation

/// A main-thread hang, measured from display link frames (mobile SDK spec C3.1).
public struct Hang: Equatable {
    /// Monotonic seconds (the display link's clock): the last frame before the main thread stopped
    /// drawing on time, and the end of the last late frame.
    public let start: CFTimeInterval
    public let end: CFTimeInterval
    /// The main thread drew no frame at all for `timeout` or longer within the hang (it was stuck,
    /// not only slow).
    public let fullyBlocking: Bool

    public var duration: CFTimeInterval { end - start }

    public init(start: CFTimeInterval, end: CFTimeInterval, fullyBlocking: Bool) {
        self.start = start
        self.end = end
        self.fullyBlocking = fullyBlocking
    }
}

/// Decides when the main thread hangs, from the same display link callbacks as `FrameCounter`,
/// with sentry-cocoa's app hang rules (SentryANRTrackerV2, `appHangTimeoutInterval` 2 s):
///
/// - every `timeout / 5` the watchdog asks for the **frame delay** of the last `timeout`: the time
///   frames ran over the slow-frame threshold, plus the frame still being waited for (since the
///   last callback);
/// - a hang **starts** when that delay is at least `timeout` and comes from the waited-for frame
///   alone (no frame was drawn in the window), or when frames were drawn but their delay is above
///   99 % of `timeout`;
/// - the hang **ends** when the delay of the last `2 × timeout / 5` drops below 20 % of that
///   window; it is reported once, then, with the whole blocked time, as **fully blocking** when one
///   frame within it took `timeout` or longer (the main thread was stuck, even if jank led into it),
///   else as not fully blocking (frames were drawn, all of them late);
/// - after a hang, none starts for `timeout` (no event storm), and a watchdog tick that came
///   `timeout` late (the process was suspended or stopped in a debugger) forgets the frames.
///
/// Pure: time is passed in. The caller holds the lock shared with the display link.
public struct HangDetector {
    public static let defaultTimeout: CFTimeInterval = 2

    public let timeout: CFTimeInterval
    /// How often the watchdog calls `tick`.
    public var tickInterval: CFTimeInterval { timeout / 5 }

    private struct LateFrame {
        let start: CFTimeInterval
        let end: CFTimeInterval
        let threshold: CFTimeInterval
        /// The part of the frame that was late.
        var delayed: ClosedRange<CFTimeInterval> { min(start + threshold, end)...end }
    }

    private struct Ongoing {
        let start: CFTimeInterval
        var end: CFTimeInterval
        /// Late frames drawn since `start` (none: the waited-for frame has not come yet).
        var frames: Int
        /// The longest of them.
        var longest: CFTimeInterval
    }

    private var lastFrame: CFTimeInterval?
    private var slowThreshold: CFTimeInterval = 1.0 / 59
    /// Late frames of the last `timeout` (bounded: at most one per refresh).
    private var late: [LateFrame] = []
    private var ongoing: Ongoing?
    private var quietUntil: CFTimeInterval = 0
    private var lastTick: CFTimeInterval?

    public init(timeout: CFTimeInterval = HangDetector.defaultTimeout) {
        self.timeout = timeout
    }

    public var isHanging: Bool { ongoing != nil }

    /// One display link callback (the same arguments as `FrameCounter.frame`).
    public mutating func frame(timestamp: CFTimeInterval, targetTimestamp: CFTimeInterval) {
        defer { lastFrame = timestamp }
        let expected = targetTimestamp - timestamp
        if expected > 0 {
            let fps = (1 / expected).rounded()
            slowThreshold = fps > 1 ? 1 / (fps - 1) : expected
        }
        guard let prev = lastFrame, timestamp > prev, timestamp - prev > slowThreshold else { return }
        let f = LateFrame(start: prev, end: timestamp, threshold: slowThreshold)
        late.append(f)
        if var o = ongoing, f.end > o.start {
            o.end = max(o.end, f.end)
            o.frames += 1
            o.longest = max(o.longest, f.end - f.start)
            ongoing = o
        }
        let horizon = timestamp - timeout * 2
        if let i = late.firstIndex(where: { $0.end >= horizon }), i > 0 { late.removeFirst(i) }
    }

    /// The app left the foreground (or came back): frames stop or start again. An ongoing hang
    /// ends here (with what was drawn, else at `now`), and the gap is not a frame.
    public mutating func interrupt(now: CFTimeInterval) -> Hang? {
        let ended = ongoing.map { o in o.frames > 0 ? finish(o, end: o.end) : finish(o, end: now, waited: now - o.end) }
        forget()
        return ended
    }

    /// One watchdog pass. Returns `.started` once when a hang is detected (the caller captures the
    /// main thread's stack then) and `.ended` once when it is over.
    public mutating func tick(now: CFTimeInterval) -> Tick? {
        defer { lastTick = now }
        if let last = lastTick, now - last >= timeout {
            // The watchdog itself did not run: the whole process was stopped.
            ongoing = nil
            forget()
            return nil
        }
        guard lastFrame != nil else { return nil }
        if let o = ongoing {
            let window = tickInterval * 2
            guard delay(from: now - window, to: now).total < window * 0.2 else { return nil }
            return .ended(finish(o, end: o.end))
        }
        guard now >= quietUntil else { return nil }
        let d = delay(from: now - timeout, to: now)
        let fully = d.frames == 0 && d.total >= timeout
        guard fully || d.total > timeout * 0.99 else { return nil }
        let o = Ongoing(start: d.firstStart, end: d.lastEnd, frames: d.frames, longest: d.longest)
        ongoing = o
        return .started(start: o.start, fullyBlocking: fully)
    }

    public enum Tick: Equatable {
        /// `fullyBlocking`: what the detection saw; the reported hang decides on its whole length.
        case started(start: CFTimeInterval, fullyBlocking: Bool)
        case ended(Hang)
    }

    /// `waited`: the frame still awaited when the hang ends without it (the app left the foreground).
    private mutating func finish(_ o: Ongoing, end: CFTimeInterval, waited: CFTimeInterval = 0) -> Hang {
        ongoing = nil
        quietUntil = end + timeout
        return Hang(start: o.start, end: max(end, o.start), fullyBlocking: max(o.longest, waited) >= timeout)
    }

    private mutating func forget() {
        lastFrame = nil
        late.removeAll()
    }

    /// Frame delay in `[from, to]`: the late parts of drawn frames, plus the frame being waited
    /// for since the last callback. `frames` counts the drawn late frames that overlap.
    private func delay(from: CFTimeInterval, to: CFTimeInterval) -> (total: CFTimeInterval, frames: Int, firstStart: CFTimeInterval, lastEnd: CFTimeInterval, longest: CFTimeInterval) {
        func overlap(_ r: ClosedRange<CFTimeInterval>) -> CFTimeInterval { max(0, min(r.upperBound, to) - max(r.lowerBound, from)) }
        let waited = lastFrame ?? to
        var total = to > waited + slowThreshold ? overlap((waited + slowThreshold)...to) : 0
        var frames = 0
        var first = waited
        var last = waited
        var longest: CFTimeInterval = 0
        for f in late.reversed() {
            if f.end < from { break }
            let o = overlap(f.delayed)
            guard o > 0 else { continue }
            total += o
            if frames == 0 { last = f.end }
            frames += 1
            first = min(first, f.start)
            longest = max(longest, f.end - f.start)
        }
        // Without a drawn late frame the hang has no end yet: it starts and "ends" where the wait began.
        return (total, frames, first, frames == 0 ? waited : last, longest)
    }
}
