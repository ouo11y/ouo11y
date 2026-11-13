import Foundation
import Testing
@testable import OuoReplayCore

@Suite struct CaptureStatsTests {
    @Test func captureStats() {
        let s = CaptureStats(capacity: 3)
        for ms in [4.0, 1, 3, 2] { s.record(millis: ms) }
        let snap = s.snapshot()
        #expect(snap.count == 4)
        #expect(snap.totalMillis == 10)
        #expect(snap.samples == [1, 3, 2])
        #expect(snap.percentile(0.5) == 2)
        #expect(snap.percentile(1) == 3)
        s.reset()
        #expect(s.snapshot().count == 0)
    }
}
