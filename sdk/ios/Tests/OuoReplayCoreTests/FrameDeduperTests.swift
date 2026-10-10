import Foundation
import Testing
@testable import OuoReplayCore

@Suite struct FrameDeduperTests {
    @Test func DropsIdenticalConsecutiveFrames() {
        let d = FrameDeduper()
        let a = Data([1, 2, 3, 4])
        let b = Data([1, 2, 3, 5])
        #expect(d.shouldKeep(a))
        #expect(!(d.shouldKeep(a)))
        #expect(!(d.shouldKeep(Data([1, 2, 3, 4]))))
        #expect(d.shouldKeep(b))
        #expect(d.shouldKeep(a), "A-B-A keeps the third frame: only the previous one counts")
    }

    @Test func ResetKeepsNextFrame() {
        let d = FrameDeduper()
        let a = Data([9])
        #expect(d.shouldKeep(a))
        d.reset()
        #expect(d.shouldKeep(a))
    }

    @Test func InjectableHasher() {
        var calls = 0
        let d = FrameDeduper(hasher: { _ in calls += 1; return 42 })
        #expect(d.shouldKeep(Data([1])))
        #expect(!(d.shouldKeep(Data([2]))), "the injected hasher decides equality")
        #expect(calls == 2)
    }

    @Test func FNV1aKnownVector() {
        // FNV-1a 64 of "a" is 0xaf63dc4c8601ec8c.
        #expect(FrameDeduper.fnv1a(Data("a".utf8)) == 0xaf63_dc4c_8601_ec8c)
        #expect(FrameDeduper.fnv1a(Data()) == 0xcbf2_9ce4_8422_2325)
    }
}
