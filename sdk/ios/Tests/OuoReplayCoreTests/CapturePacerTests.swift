import Foundation
import Testing
@testable import OuoReplayCore

@Suite struct CapturePacerTests {
    /// Runs `decide` and books `cost` seconds of main-thread time when it captures.
    private func step(_ p: inout CapturePacer, _ now: TimeInterval, animations: Int = 0, transitioning: Bool = false, cost: TimeInterval = 0.02) -> CapturePacer.Decision {
        let d = p.decide(now: now, animations: animations, transitioning: transitioning)
        if case .capture = d { p.spent(cost, now: now) }
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
        p.requestFrame(.resume, now: 0.2)
        #expect(step(&p, 0.2) == .capture(.resume))
    }

    /// Four or more running animations defer a due frame up to one second, then it is forced.
    @Test func AnimationsDeferUpToOneSecond() {
        var p = CapturePacer(mode: .session, interval: 1)
        #expect(step(&p, 0, animations: 6) == .wait)
        #expect(step(&p, 0.5, animations: 6) == .wait)
        #expect(step(&p, 0.6, animations: 3) == .wait, "settling")
        #expect(step(&p, 0.75, animations: 3) == .capture(.timer))
        #expect(step(&p, 1.75, animations: 9) == .wait)
        #expect(step(&p, 2.74, animations: 9) == .wait)
        #expect(step(&p, 2.75, animations: 9) == .capture(.timer), "forced: a spinner must not stop replay")
    }

    /// A view controller transition is never captured, however long it runs (an interactive
    /// swipe back), and the frame after it waits until the screen shows the end state.
    @Test func TransitionsAreNeverCapturedAndSettleAfterwards() {
        var p = CapturePacer(mode: .session, interval: 1)
        for t in stride(from: 0.0, through: 3.0, by: 0.1) {
            #expect(step(&p, t, animations: 0, transitioning: true) == .wait)
        }
        #expect(step(&p, 3.1) == .wait)
        #expect(step(&p, 3.2) == .wait)
        #expect(step(&p, 3.3) == .capture(.timer))
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
        // Steady state: 1.5 s apart (the bank refills 0.1 per second, a capture costs 0.15).
        let gaps = zip(captures.dropFirst(), captures).map { ($0 - $1) }
        #expect(captures.count >= 6 && captures.count <= 8, "captures \(captures)")
        #expect(gaps.dropFirst(2).allSatisfy { $0 >= 1.4 }, "gaps \(gaps)")

        var cheap = CapturePacer(mode: .session, interval: 1)
        var n = 0
        for tick in 0..<100 { if case .capture = step(&cheap, Double(tick) * 0.1, cost: 0.03) { n += 1 } }
        #expect(n == 10)
    }

    /// The walk alone also spends the bank (a pass that deferred still cost main-thread time).
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
        p.requestFrame(.resume, now: 0)
        #expect(step(&p, 0) == .capture(.resume))
        #expect(step(&p, 5) == .wait)
        p.screenDidChange(now: 6)
        #expect(step(&p, 6.2) == .wait, "waits for the transition to start")
        #expect(step(&p, 6.4) == .capture(.navigation))
        #expect(step(&p, 9) == .wait)
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
