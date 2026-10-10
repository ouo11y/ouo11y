import Foundation
import Testing
@testable import OuoReplayCore

@Suite struct SeqStoreTests {
    @Test func InMemoryRestartsOnNewSession() {
        let s = InMemorySeqStore()
        #expect(s.next(sessionId: "a") == 0)
        #expect(s.next(sessionId: "a") == 1)
        #expect(s.next(sessionId: "b") == 0)
        s.reset(sessionId: "b")
        #expect(s.next(sessionId: "b") == 0)
    }

    @Test func UserDefaultsPersistsAcrossInstances() {
        let suite = "ouo.replay.tests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }

        let first = UserDefaultsSeqStore(defaults: defaults)
        #expect(first.next(sessionId: "s1") == 0)
        #expect(first.next(sessionId: "s1") == 1)

        // "App restart" within the same session: a fresh instance continues the sequence.
        let second = UserDefaultsSeqStore(defaults: defaults)
        #expect(second.next(sessionId: "s1") == 2)
        // A new session starts at 0; reset forces 0 too.
        #expect(second.next(sessionId: "s2") == 0)
        second.reset(sessionId: "s3")
        #expect(UserDefaultsSeqStore(defaults: defaults).next(sessionId: "s3") == 0)
    }
}
