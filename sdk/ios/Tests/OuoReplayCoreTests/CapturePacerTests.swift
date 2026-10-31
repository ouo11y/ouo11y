import Foundation
import Testing
@testable import OuoReplayCore

@Suite struct CapturePacerTests {
    /// What the recorder does on a pass: report a transition (and stop), or walk and decide, then
    /// book `cost` seconds of main-thread time when it walked.
    private func step(_ p: inout CapturePacer, _ now: TimeInterval, animations: Int = 0, transitioning: Bool = false, cost: TimeInterval = 0.02) -> CapturePacer.Decision {
        if transitioning {
            p.motion(now: now)
            return .wait
        }
        guard p.isDue(now: now) else { return .wait }
        let d = p.decide(now: now, animations: animations)
        p.spent(cost, now: now)
        return d
    }

    @Test func SessionModeCapturesOncePerInterval() {
        var p = CapturePacer(mode: .session, interval: 1)
        #expect(step(&p, 0) == .capture(.timer))
        #expect(step(&p, 0.5) == .wait)
        #expect(step(&p, 0.99) == .wait)
        #expect(step(&p, 1.0) == .capture(.timer))
    }

    @Test func RequestedFrameIsTakenRightAway() {
        var p = CapturePacer(mode: .session, interval: 1)
        _ = step(&p, 0)
        p.requestFrame(.resume, at: 0.2)
        #expect(step(&p, 0.2) == .capture(.resume))
    }

    /// Four or more running animations defer a due frame up to one second, then it is forced; when
    /// they stop, the frame waits for the screen to settle.
    @Test func AnimationsDeferUpToOneSecond() {
        var p = CapturePacer(mode: .session, interval: 1)
        #expect(step(&p, 0, animations: 6) == .wait)
        #expect(step(&p, 0.3, animations: 6) == .wait)
        #expect(step(&p, 0.6, animations: 3) == .capture(.timer), "0.3 s after the last motion seen")
        #expect(step(&p, 1.6, animations: 9) == .wait)
        #expect(step(&p, 2.0, animations: 9) == .wait)
        #expect(step(&p, 2.6, animations: 9) == .capture(.timer), "forced: a spinner must not stop replay")
    }

    /// While a frame waits, no pass may walk the tree: `isDue` stays false until the settle ends,
    /// and `wakeAt` says when to look again.
    @Test func NoWalkWhileWaitingForTheScreenToSettle() {
        var p = CapturePacer(mode: .session, interval: 1)
        #expect(step(&p, 0, animations: 5) == .wait)
        #expect(p.wakeAt(now: 0.01) == 0.25)
        let early = p.isDue(now: 0.1)
        let late = p.isDue(now: 0.25)
        #expect(!early)
        #expect(late)
    }

    /// A view controller transition is never captured, however long it runs (an interactive
    /// swipe back), and the frame after it waits until the screen shows the end state.
    @Test func TransitionsAreNeverCapturedAndSettleAfterwards() {
        var p = CapturePacer(mode: .session, interval: 1)
        for t in stride(from: 0.0, through: 3.0, by: 0.1) {
            #expect(step(&p, t, transitioning: true) == .wait)
        }
        #expect(step(&p, 3.1) == .wait)
        #expect(step(&p, 3.2) == .wait)
        #expect(step(&p, 3.3) == .capture(.timer))
    }

    /// A transition that ends just before the interval still delays the frame: the recorder reports
    /// transitions on every pass, not only when a frame is due.
    @Test func TransitionEndingBetweenDuePassesStillSettles() {
        var p = CapturePacer(mode: .session, interval: 1)
        #expect(step(&p, 0) == .capture(.timer))
        for t in [0.5, 0.7, 0.9, 0.95] {
            _ = step(&p, t, transitioning: true)
        }
        #expect(step(&p, 1.0) == .wait)
        #expect(p.wakeAt(now: 1.0) == 1.2)
        #expect(step(&p, 1.2) == .capture(.timer))
    }

    /// Time bank: 100 ms of main-thread capture work per second. A 150 ms capture leaves one frame
    /// every 1.5 s; a cheap one never hits the bank.
    @Test func TimeBankBacksOffSlowCaptures() {
        var p = CapturePacer(mode: .session, interval: 1)
        var captures: [TimeInterval] = []
        for tick in 0..<100 {
            let now = Double(tick) * 0.1
            if case .capture = step(&p, now, cost: 0.15) { captures.append(now) }
        }
        let gaps = zip(captures.dropFirst(), captures).map { ($0 - $1) }
        #expect(captures.count >= 6 && captures.count <= 8, "captures \(captures)")
        #expect(gaps.dropFirst(2).allSatisfy { $0 >= 1.4 }, "gaps \(gaps)")

        var cheap = CapturePacer(mode: .session, interval: 1)
        var n = 0
        for tick in 0..<100 { if case .capture = step(&cheap, Double(tick) * 0.1, cost: 0.03) { n += 1 } }
        #expect(n == 10)
    }

    /// The walk alone also spends the bank (a pass that deferred still cost main-thread time), and
    /// `wakeAt` waits for the bank to refill.
    @Test func WalkCostCountsEvenWithoutACapture() {
        var p = CapturePacer(mode: .session, interval: 1)
        p.spent(0.3, now: 0)
        let dueAfterOneSecond = p.isDue(now: 1)
        let dueAfterTwo = p.isDue(now: 2.1)
        #expect(!dueAfterOneSecond)
        #expect(dueAfterTwo)
    }

    @Test func NavigationModeCapturesOnlyAfterAScreenChange() {
        var p = CapturePacer(mode: .navigation, interval: 1)
        p.requestFrame(.resume, at: 0)
        #expect(step(&p, 0) == .capture(.resume))
        #expect(step(&p, 5) == .wait)
        #expect(p.wakeAt(now: 5) == nil, "nothing to wake for")
        p.screenDidChange(now: 6)
        #expect(p.wakeAt(now: 6) == 6.4)
        #expect(step(&p, 6.2) == .wait, "waits for the transition to start")
        #expect(step(&p, 6.4) == .capture(.navigation))
        #expect(step(&p, 9) == .wait)
    }

    /// A navigation frame that was dropped (a masked view still moving) is asked for again later,
    /// at most three times: in navigation mode nothing else would show that screen, and a masked
    /// view that never stops moving must not cost a render twice a second.
    @Test func DroppedNavigationFrameIsRetriedThreeTimes() {
        var p = CapturePacer(mode: .navigation, interval: 1)
        p.screenDidChange(now: 0)
        var t = 0.4
        #expect(step(&p, t) == .capture(.navigation))
        for _ in 0..<3 {
            p.dropped(.navigation, now: t)
            #expect(step(&p, t + 0.4) == .wait)
            t += 0.5
            #expect(step(&p, t) == .capture(.navigation))
        }
        p.dropped(.navigation, now: t)
        #expect(p.wakeAt(now: t) == nil, "gave up after three retries")
        p.screenDidChange(now: 10)
        #expect(step(&p, 10.4) == .capture(.navigation), "a new screen starts over")
    }

    /// N76: a feedback asks for a frame at once in both modes, between interval frames too, and a
    /// dropped one is retried like a new screen's.
    @Test func FeedbackFrameIsTakenAtOnceInEveryMode() {
        var s = CapturePacer(mode: .session, interval: 1)
        #expect(step(&s, 0) == .capture(.timer))
        s.requestFrame(.feedback, at: 0.3)
        #expect(s.wakeAt(now: 0.3) == 0.3)
        #expect(step(&s, 0.3) == .capture(.feedback), "does not wait for the next interval")
        s.dropped(.feedback, now: 0.3)
        #expect(step(&s, 0.8) == .capture(.feedback), "retried")

        var n = CapturePacer(mode: .navigation, interval: 1)
        n.requestFrame(.resume, at: 0)
        _ = step(&n, 0)
        n.requestFrame(.feedback, at: 5)
        #expect(step(&n, 5) == .capture(.feedback))
        #expect(n.wakeAt(now: 5) == nil)
    }

    @Test func DroppedIntervalFrameWaitsForTheNextInterval() {
        var p = CapturePacer(mode: .session, interval: 1)
        #expect(step(&p, 0) == .capture(.timer))
        p.dropped(.timer, now: 0)
        #expect(step(&p, 0.5) == .wait)
        #expect(step(&p, 1.0) == .capture(.timer))
    }

    @Test func ScreenChangesAreIgnoredInSessionMode() {
        var p = CapturePacer(mode: .session, interval: 1)
        _ = step(&p, 0)
        p.screenDidChange(now: 0.1)
        #expect(step(&p, 0.6) == .wait)
    }

    @Test func AutoModePicksNavigationOnLowEndDevices() {
        let gib: UInt64 = 1024 * 1024 * 1024
        #expect(ReplayMode.auto.resolved(physicalMemory: 3 * gib) == .navigation)
        #expect(ReplayMode.auto.resolved(physicalMemory: 2 * gib) == .navigation)
        #expect(ReplayMode.auto.resolved(physicalMemory: 4 * gib - 300 * 1024 * 1024) == .session)
        #expect(ReplayMode.auto.resolved(physicalMemory: 8 * gib) == .session)
        #expect(ReplayMode.session.resolved(physicalMemory: 1 * gib) == .session)
    }
}
