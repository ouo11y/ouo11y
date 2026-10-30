import Foundation
import QuartzCore
import Testing
@testable import OuoVitals

/// The watchdog thread: no wakeups while the app is not active (review item 2), ticks while it is.
@Suite(.serialized) struct HangWatchdogTests {
    final class Counter: @unchecked Sendable {
        private let lock = NSLock()
        private var n = 0
        func add() { lock.withLock { n += 1 } }
        var value: Int { lock.withLock { n } }
    }

    @Test func waitsWithoutWakingWhileInactiveAndTicksWhileActive() throws {
        let ticks = Counter()
        let starts = Counter()
        let w = HangWatchdog(interval: 0.05, onStart: { _ in starts.add() }, onEnd: { _ in }) { _ in
            ticks.add()
            return ticks.value == 3 ? .started(start: 1, fullyBlocking: true) : nil
        }
        w.start()
        defer { w.cancel() }
        Thread.sleep(forTimeInterval: 0.5)
        #expect(ticks.value == 0, "inactive: the thread waits, it does not poll")
        w.active = true
        Thread.sleep(forTimeInterval: 0.5)
        let active = ticks.value
        #expect(active >= 3)
        #expect(starts.value == 1, "onStart gets the detected hang")
        w.active = false
        Thread.sleep(forTimeInterval: 0.2)
        let stopped = ticks.value
        Thread.sleep(forTimeInterval: 0.5)
        #expect(ticks.value == stopped, "no ticks after the app resigned active")
    }
}
