import Foundation
import Testing
@testable import OuoVitals

/// A 60 Hz display and a watchdog ticking every 400 ms, driven on one simulated clock.
private struct Sim {
    var d = HangDetector()
    var t = 100.0
    var nextTick = 100.4
    var events: [HangDetector.Tick] = []
    /// The last frame drawn.
    var last = 100.0
    let frame = 1.0 / 60

    init() { d.frame(timestamp: t, targetTimestamp: t + frame) }

    /// Advances the clock to `until`, ticking the watchdog on the way.
    mutating func advance(to until: Double) {
        while nextTick <= until {
            if let e = d.tick(now: nextTick) { events.append(e) }
            nextTick += 0.4
        }
        t = max(t, until)
    }

    /// Normal frames for `seconds`.
    mutating func draw(_ seconds: Double) { drawFrames(every: frame, for: seconds) }

    /// Frames every `interval` (late when above the slow threshold) for `seconds`.
    mutating func drawFrames(every interval: Double, for seconds: Double) {
        let end = t + seconds
        while t + interval <= end + 1e-9 {
            advance(to: t + interval)
            d.frame(timestamp: t, targetTimestamp: t + frame)
            last = t
        }
        advance(to: end)
    }

    /// The main thread blocks for `seconds`, then draws a frame.
    mutating func block(_ seconds: Double) {
        advance(to: last + seconds)
        d.frame(timestamp: t, targetTimestamp: t + frame)
        last = t
    }

    var hangs: [Hang] { events.compactMap { if case .ended(let h) = $0 { return h }; return nil } }
    var starts: Int { events.filter { if case .started = $0 { return true }; return false }.count }
}

@Suite struct HangDetectorTests {
    @Test func normalFramesAreNoHang() {
        var s = Sim()
        s.draw(10)
        #expect(s.events.isEmpty)
    }

    @Test func aThreeSecondBlockIsOneFullyBlockingHangWithItsWholeDuration() {
        var s = Sim()
        s.draw(1)
        let blockedAt = s.last
        s.block(3)
        s.draw(3)
        #expect(s.starts == 1)
        #expect(s.hangs.count == 1)
        let h = try! #require(s.hangs.first)
        #expect(h.fullyBlocking)
        #expect(abs(h.start - blockedAt) < 1e-9)
        #expect(abs(h.duration - 3) < 1e-9, "the whole blocked time, not the 2 s threshold: \(h.duration)")
    }

    @Test func detectionComesWhileTheThreadIsStillBlocked() {
        var s = Sim()
        s.draw(1)
        let blockedAt = s.last
        s.advance(to: blockedAt + 2.5)
        // Started, not ended: the caller reads the main thread's stack now.
        #expect(s.events == [.started(start: blockedAt, fullyBlocking: true)])
    }

    @Test func aBlockShorterThanTheTimeoutIsNoHang() {
        var s = Sim()
        s.draw(1)
        s.block(1.9)
        s.draw(3)
        #expect(s.events.isEmpty)
    }

    @Test func aLongBlockIsStillOneEvent() {
        var s = Sim()
        s.draw(1)
        s.block(30)
        s.draw(5)
        #expect(s.starts == 1)
        #expect(s.hangs.count == 1)
        #expect(abs(s.hangs[0].duration - 30) < 1e-9)
    }

    @Test func framesDrawnLateTheWholeTimeAreANonFullyBlockingHang() {
        var s = Sim()
        s.draw(1)
        let busyAt = s.last
        // 1.2 s frames for 4.8 s: the app draws, but over 99 % of the window is frame delay.
        s.drawFrames(every: 1.2, for: 4.8)
        s.draw(3)
        #expect(s.starts == 1)
        let h = try! #require(s.hangs.first)
        #expect(!h.fullyBlocking)
        #expect(abs(h.start - busyAt) < 1e-9)
        #expect(abs(h.duration - 4.8) < 1e-9)
    }

    @Test func halfSecondFramesAreJankNotAHang() {
        // Sentry's 99 % rule: four on-time frame starts in 2 s keep it under the threshold.
        var s = Sim()
        s.draw(1)
        s.drawFrames(every: 0.5, for: 6)
        #expect(s.events.isEmpty)
    }

    @Test func aSlowButResponsiveAppIsNoHang() {
        var s = Sim()
        s.draw(1)
        // 100 ms frames (10 fps): janky, but more than 1 % of the window is on time.
        s.drawFrames(every: 0.1, for: 6)
        #expect(s.events.isEmpty)
    }

    @Test func twoBlocksCloseTogetherAreOneHang() {
        var s = Sim()
        s.draw(1)
        s.block(3)
        s.draw(0.2)
        s.block(2.5)
        s.draw(4)
        // The second block starts before the first hang was seen to end: one hang over both, fully
        // blocking (the main thread drew nothing for 3 s within it).
        #expect(s.starts == 1)
        #expect(s.hangs.count == 1)
        #expect(s.hangs[0].fullyBlocking)
        #expect(abs(s.hangs[0].duration - 5.7) < 1e-9)
    }

    @Test func jankLeadingIntoABlockIsOneFullyBlockingHangFromTheJank() {
        // Seen on the simulator: a 300 ms frame right before a 3 s block makes the 99 % rule fire
        // first; the hang still counts as fully blocking and starts at the jank.
        var s = Sim()
        s.draw(1)
        let jankAt = s.last
        s.block(0.3)
        s.block(3)
        s.draw(3)
        #expect(s.hangs.count == 1)
        let h = try! #require(s.hangs.first)
        #expect(h.fullyBlocking)
        #expect(abs(h.start - jankAt) < 1e-9)
        #expect(abs(h.duration - 3.3) < 1e-9)
    }

    @Test func aSecondHangAfterTheQuietPeriodIsReported() {
        var s = Sim()
        s.draw(1)
        s.block(3)
        s.draw(4)
        s.block(3)
        s.draw(3)
        #expect(s.hangs.count == 2)
        #expect(s.hangs.allSatisfy { $0.fullyBlocking && abs($0.duration - 3) < 1e-9 })
    }

    @Test func aLateWatchdogTickForgetsTheFrames() {
        // The process was stopped (debugger, suspension) for 10 s: the gap is no hang.
        var d = HangDetector()
        d.frame(timestamp: 100, targetTimestamp: 100 + 1.0 / 60)
        #expect(d.tick(now: 100.4) == nil)
        #expect(d.tick(now: 110.4) == nil)
        #expect(d.tick(now: 110.8) == nil, "no frame since the gap: nothing to measure")
        d.frame(timestamp: 110.81, targetTimestamp: 110.81 + 1.0 / 60)
        #expect(d.tick(now: 111.2) == nil)
    }

    @Test func noFramesYetIsNoHang() {
        var d = HangDetector()
        #expect(d.tick(now: 1) == nil)
        #expect(d.tick(now: 1.4) == nil)
    }

    @Test func leavingTheForegroundEndsAnOngoingHangAndDropsTheGap() {
        var s = Sim()
        s.draw(1)
        let blockedAt = s.last
        s.advance(to: blockedAt + 2.5)
        #expect(s.starts == 1)
        // The block ends and the resign-active notification runs at once, before the next tick.
        s.t = blockedAt + 2.7
        s.d.frame(timestamp: s.t, targetTimestamp: s.t + s.frame)
        let ended = s.d.interrupt(now: s.t)
        #expect(ended == Hang(start: blockedAt, end: blockedAt + 2.7, fullyBlocking: true))
        // In the background no frames come; coming back is no hang.
        #expect(s.d.interrupt(now: s.t + 60) == nil)
        #expect(s.d.tick(now: s.t + 60.4) == nil)
    }

    @Test func thresholdFollowsTheRefreshRate() {
        // At 120 Hz, 12 ms frames are late (threshold 8.4 ms); at 60 Hz they are not.
        var d = HangDetector()
        var t = 0.0
        d.frame(timestamp: t, targetTimestamp: t + 1.0 / 120)
        var started = false
        var tick = 0.4
        while t < 3 {
            t += 0.012
            d.frame(timestamp: t, targetTimestamp: t + 1.0 / 120)
            if t >= tick { if d.tick(now: tick) != nil { started = true }; tick += 0.4 }
        }
        // 12 ms frames at 120 Hz are 3.6 ms late each: far below 99 % of the window.
        #expect(!started)
    }
}
