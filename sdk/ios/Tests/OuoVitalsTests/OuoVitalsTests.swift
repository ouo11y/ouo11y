import Foundation
import Testing
@testable import OuoVitals

@Suite struct FrameCounterTests {
    /// Feeds frames of the given durations (s) at a fixed refresh rate.
    func run(_ durations: [Double], hz: Double = 60) -> FrameStats {
        var c = FrameCounter()
        let expected = 1 / hz
        var t = 100.0
        c.frame(timestamp: t, targetTimestamp: t + expected)
        for d in durations {
            t += d
            c.frame(timestamp: t, targetTimestamp: t + expected)
        }
        return c.stats
    }

    @Test func firstCallbackOnlySetsTheReference() {
        var c = FrameCounter()
        c.frame(timestamp: 1, targetTimestamp: 1 + 1.0 / 60)
        #expect(c.stats.total == 0)
    }

    @Test func normalFramesAreNotSlow() {
        let s = run(Array(repeating: 1.0 / 60, count: 60))
        #expect(s.total == 60)
        #expect(s.slow == 0)
        #expect(s.frozen == 0)
        #expect(s.delayMs == 0)
        #expect(abs(s.expectedFrameMs - 1000.0 / 60) < 0.001)
    }

    @Test func jitterWithinOneFrameAtFpsMinusOneIsTolerated() {
        // 1/59 s is Sentry's slow threshold at 60 Hz; 16.9 ms is below it.
        let s = run([0.0169, 1.0 / 60])
        #expect(s.slow == 0)
    }

    @Test func slowAndFrozenFrames() {
        let s = run([1.0 / 60, 0.050, 0.699, 0.700, 2.0])
        #expect(s.total == 5)
        #expect(s.slow == 2)
        #expect(s.frozen == 2)
        let expected = 1000.0 / 60
        let delay = (50 - expected) + (699 - expected) + (700 - expected) + (2000 - expected)
        #expect(abs(s.delayMs - delay) < 0.001)
    }

    @Test func thresholdFollowsTheRefreshRate() {
        // 12 ms is slow at 120 Hz (expected 8.3 ms) and normal at 60 Hz.
        #expect(run([0.012], hz: 120).slow == 1)
        #expect(abs(run([0.012], hz: 120).expectedFrameMs - 1000.0 / 120) < 0.001)
        #expect(run([0.012], hz: 60).slow == 0)
    }

    @Test func resetDropsTheGap() {
        var c = FrameCounter()
        let e = 1.0 / 60
        c.frame(timestamp: 10, targetTimestamp: 10 + e)
        c.frame(timestamp: 10 + e, targetTimestamp: 10 + 2 * e)
        c.reset()
        // 30 s in the background: no frozen frame.
        c.frame(timestamp: 40, targetTimestamp: 40 + e)
        c.frame(timestamp: 40 + e, targetTimestamp: 40 + 2 * e)
        #expect(c.stats.total == 2)
        #expect(c.stats.frozen == 0)
    }

    @Test func badTimestampsAreIgnored() {
        var c = FrameCounter()
        c.frame(timestamp: 10, targetTimestamp: 10.016)
        c.frame(timestamp: 9, targetTimestamp: 9.016)
        c.frame(timestamp: 9.016, targetTimestamp: 9.016)
        #expect(c.stats.total == 0)
    }
}

@Suite struct AppStartTests {
    @Test func firstRuntimeIsColdFromProcessStart() {
        let info = AppStartInfo.resolve(firstRuntime: true, processStartMs: 1000, loadTimeMs: 1100, runtimeStartMs: 1500, prewarmed: false)
        #expect(info == AppStartInfo(type: .cold, startMs: 1000, prewarmed: false))
    }

    @Test func prewarmedColdStartIsFromImageLoad() {
        let info = AppStartInfo.resolve(firstRuntime: true, processStartMs: 1000, loadTimeMs: 90000, runtimeStartMs: 90500, prewarmed: true)
        #expect(info == AppStartInfo(type: .cold, startMs: 90000, prewarmed: true))
    }

    @Test func laterRuntimeIsWarmFromItsOwnStart() {
        let info = AppStartInfo.resolve(firstRuntime: false, processStartMs: 1000, loadTimeMs: 1100, runtimeStartMs: 60000, prewarmed: false)
        #expect(info == AppStartInfo(type: .warm, startMs: 60000, prewarmed: false))
    }

    @Test func unknownStartIsNil() {
        #expect(AppStartInfo.resolve(firstRuntime: true, processStartMs: -1, loadTimeMs: 1, runtimeStartMs: 1, prewarmed: false) == nil)
        #expect(AppStartInfo.resolve(firstRuntime: true, processStartMs: 1, loadTimeMs: -1, runtimeStartMs: 1, prewarmed: true) == nil)
    }

    @Test func kernelProcessStartIsBeforeNowAndBeforeTheImageLoad() {
        let now = Date().timeIntervalSince1970 * 1000
        let start = OuoVitals.processStartMs
        let load = OuoVitals.loadTimeMs
        #expect(start > now - 3_600_000)
        #expect(start <= now)
        #expect(load >= start)
        #expect(load <= now)
    }

    @Test func secondRuntimeOfTheProcessIsWarm() {
        let now = Date().timeIntervalSince1970 * 1000
        let first = OuoVitals.beginRuntime(at: now)
        let second = OuoVitals.beginRuntime(at: now + 5)
        #expect(first?.type == .cold)
        #expect(second == AppStartInfo(type: .warm, startMs: now + 5, prewarmed: false))
    }
}

@Suite struct FrameCostTests {
    /// The per-frame work on the main thread: lock, classify, feed the hang detector, unlock. Measured, with a bound far
    /// above it (debug build, shared CI machines) so the test only catches a regression in kind.
    @Test func perFrameCostIsNegligible() {
        let lock = UnfairLock()
        var c = FrameCounter()
        var h = HangDetector()
        let n = 200_000
        let e = 1.0 / 120
        var t = 1.0
        let start = DispatchTime.now().uptimeNanoseconds
        for i in 0..<n {
            t += i % 50 == 0 ? 0.03 : e
            lock.lock()
            c.frame(timestamp: t, targetTimestamp: t + e)
            h.frame(timestamp: t, targetTimestamp: t + e)
            lock.unlock()
        }
        let perFrameNs = Double(DispatchTime.now().uptimeNanoseconds - start) / Double(n)
        print("OuoVitals per-frame cost: \(String(format: "%.1f", perFrameNs)) ns")
        #expect(c.stats.total == n - 1)
        #expect(perFrameNs < 5_000)
    }
}
