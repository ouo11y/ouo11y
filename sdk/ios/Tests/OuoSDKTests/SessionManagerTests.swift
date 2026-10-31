import Foundation
import Testing
@testable import OuoSDK

/// docs/specs/session-lifecycle.md "Test cases every SDK must cover", mobile rules, and C1.
@Suite struct SessionManagerTests {
    final class Memory: SessionStore {
        var state: PersistedSession?
        var saves = 0
        /// Before the first unlock: the state is there and cannot be read or written.
        var locked = false
        func load() -> StoredSession { locked ? .unreadable : state.map(StoredSession.state) ?? .missing }
        func save(_ s: PersistedSession) {
            guard !locked else { return }
            state = s
            saves += 1
        }
    }

    final class Run {
        let clock: TestClock
        let store: Memory
        var events: [(name: String, attrs: Attributes, at: Double)] = []
        var rotations: [String] = []
        lazy var manager = SessionManager(store: store, now: { [clock] in clock.now }, serviceVersion: "1.0.0",
                                          emit: { [unowned self] n, a, t in self.events.append((n, a, t)) },
                                          onRotate: { [unowned self] r in self.rotations.append(r.id) })
        init(clock: TestClock = TestClock(), store: Memory = Memory()) {
            self.clock = clock
            self.store = store
        }
        func named(_ n: String) -> [(name: String, attrs: Attributes, at: Double)] { events.filter { $0.name == n } }
    }

    /// The next launch on the same disk.
    private func relaunch(_ r: Run, after ms: Double = 1000, crash: CrashMarker? = nil, background: Bool = false) -> Run {
        r.clock.advance(ms)
        let next = Run(clock: r.clock, store: r.store)
        next.manager.start(crash: crash, background: background)
        return next
    }

    @Test func FreshStartEmitsSessionStart() {
        let r = Run()
        r.manager.start(crash: nil, background: false)
        let s = r.named("session.start")
        #expect(s.count == 1)
        #expect(s[0].attrs["session.id"] == .string(r.manager.current!.id))
        #expect(s[0].attrs["session.previous_id"] == nil)
        #expect(s[0].attrs["ouo.session.started_at"] == .int(1_760_000_000_000))
        #expect(s[0].attrs["device.id"] == .string(r.manager.deviceId))
        #expect(r.rotations == [r.manager.current!.id])
        #expect(r.store.state?.session?.id == r.manager.current!.id, "persisted at once")
    }

    @Test func ColdStartEndsThePreviousSessionTerminated() {
        let first = Run()
        first.manager.start(crash: nil, background: false)
        first.clock.advance(5000)
        first.manager.touch()
        let old = first.manager.current!
        let next = relaunch(first, after: 10_000)
        let end = next.named("session.end")
        #expect(end.count == 1)
        #expect(end[0].attrs["session.id"] == .string(old.id))
        #expect(end[0].attrs["ouo.session.end_reason"] == "terminated")
        #expect(end[0].at == old.lastActivity, "ended at its last known activity")
        #expect(end[0].attrs["ouo.session.duration_ms"] == .int(5000))
        #expect(next.named("session.start")[0].attrs["session.previous_id"] == .string(old.id))
        #expect(next.events.map(\.name) == ["session.end", "session.start"])
    }

    @Test func ColdStartAfterInactivityEndsWithInactivity() {
        let first = Run()
        first.manager.start(crash: nil, background: false)
        let old = first.manager.current!
        let next = relaunch(first, after: 31 * 60 * 1000)
        let end = next.named("session.end")[0]
        #expect(end.attrs["ouo.session.end_reason"] == "inactivity")
        #expect(end.at == old.lastActivity + 30 * 60 * 1000)
    }

    @Test func ActivityAfterMaxDurationRotates() {
        let r = Run()
        r.manager.start(crash: nil, background: false)
        let first = r.manager.current!.id
        for _ in 0..<17 {
            r.clock.advance(15 * 60 * 1000)
            r.manager.touch()
        }
        let end = r.named("session.end")
        #expect(end.count == 1)
        #expect(end[0].attrs["ouo.session.end_reason"] == "max_duration")
        #expect(end[0].at == 1_760_000_000_000 + 4 * 3600 * 1000)
        #expect(r.manager.current!.previousId == first)
    }

    /// C1.1: background longer than the timeout, then foreground: two sessions linked by previous_id.
    @Test func BackgroundLongerThanTheTimeoutRotates() {
        let r = Run()
        r.manager.start(crash: nil, background: false)
        let first = r.manager.current!.id
        r.manager.background()
        #expect(r.store.state?.session?.backgroundAt != nil, "persisted at once")
        r.clock.advance(31_000)
        r.manager.foreground()
        let end = r.named("session.end")
        #expect(end.count == 1)
        #expect(end[0].attrs["ouo.session.end_reason"] == "background")
        #expect(end[0].at == 1_760_000_000_000 + 30_000)
        let start = r.named("session.start")
        #expect(start.count == 2)
        #expect(start[1].attrs["session.previous_id"] == .string(first))
        #expect(r.rotations.count == 2)
    }

    @Test func ShortBackgroundKeepsTheSession() {
        let r = Run()
        r.manager.start(crash: nil, background: false)
        let id = r.manager.current!.id
        r.manager.background()
        r.clock.advance(29_000)
        r.manager.foreground()
        #expect(r.manager.current!.id == id)
        #expect(r.manager.current!.backgroundAt == nil)
        #expect(r.named("session.end").isEmpty)
    }

    /// A process launched in the background (a push, a fetch) whose app is never opened in time.
    @Test func BackgroundLaunchEndsWithBackground() {
        let r = Run()
        r.manager.start(crash: nil, background: true)
        let id = r.manager.current!.id
        r.clock.advance(60_000)
        r.manager.foreground()
        #expect(r.named("session.end").first?.attrs["ouo.session.end_reason"] == "background")
        #expect(r.manager.current!.id != id)
        #expect(r.manager.current!.backgroundAt == nil)
    }

    /// A record while in the background past the timeout starts the next session in the background
    /// too, so it does not run on into the foreground.
    @Test func ASessionCreatedInTheBackgroundIsMarkedSo() {
        let r = Run()
        r.manager.start(crash: nil, background: false)
        r.manager.background()
        r.clock.advance(40_000)
        r.manager.ensure()
        #expect(r.manager.current!.backgroundAt == r.clock.now)
    }

    /// Spec case 6 and C2.2: the crash report names the persisted session: it ends with `crash` at the crash.
    @Test func ACrashReportEndsTheSessionAtTheCrash() {
        let first = Run()
        first.manager.start(crash: nil, background: false)
        let old = first.manager.current!
        let crashAt = first.clock.now + 3000
        let next = relaunch(first, after: 60_000, crash: CrashMarker(sessionId: old.id, at: crashAt, startedAt: old.startedAt))
        let end = next.named("session.end")[0]
        #expect(end.attrs["ouo.session.end_reason"] == "crash")
        #expect(end.at == crashAt)
        #expect(end.attrs["ouo.session.started_at"] == .int(Int64(old.startedAt)))
    }

    /// C2.3 / N52: a crash in the first second, before the session file was written.
    @Test func ACrashOfASessionTheFileNeverSawStillEndsFromItsStart() {
        let r = Run()
        r.store.state = PersistedSession(session: nil, user: UserRecord(id: "u1", anonymous: true), deviceId: "d1")
        r.clock.advance(10_000)
        let crash = CrashMarker(sessionId: "lost", at: 1_760_000_000_200, startedAt: 1_760_000_000_000)
        r.manager.start(crash: crash, background: false)
        let end = r.named("session.end")
        #expect(end.count == 1)
        #expect(end[0].attrs["session.id"] == "lost")
        #expect(end[0].attrs["ouo.session.end_reason"] == "crash")
        #expect(end[0].attrs["ouo.session.started_at"] == .int(1_760_000_000_000))
        #expect(end[0].at == 1_760_000_000_200)
        #expect(r.named("session.start")[0].attrs["session.previous_id"] == "lost")
        #expect(r.manager.deviceId == "d1")
    }

    /// Both: the file's session ended normally earlier, the crash names a later one.
    @Test func APersistedEndedSessionAndALostCrashedOne() {
        let first = Run()
        first.manager.start(crash: nil, background: false)
        first.manager.endSession()
        let next = relaunch(first, crash: CrashMarker(sessionId: "lost", at: first.clock.now - 10, startedAt: nil))
        #expect(next.named("session.end").map { $0.attrs["session.id"] } == ["lost"])
        #expect(next.manager.current!.previousId == "lost")
    }

    /// A report without a session id (the crash came before the first session was set).
    @Test func ACrashReportWithoutSessionIdBlamesThePersistedSession() {
        let first = Run()
        first.manager.start(crash: nil, background: false)
        let next = relaunch(first, crash: CrashMarker(sessionId: "", at: first.clock.now, startedAt: nil))
        #expect(next.named("session.end")[0].attrs["ouo.session.end_reason"] == "crash")
    }

    /// Spec case 8.
    @Test func UserChangeRules() {
        let r = Run()
        r.manager.start(crash: nil, background: false)
        let anon = r.manager.user.id
        let first = r.manager.current!.id
        #expect(r.manager.user.anonymous)
        r.manager.setUser("alice")
        #expect(r.manager.current!.id == first, "anonymous to identified keeps the session")
        #expect(r.manager.current!.userId == "alice")
        r.manager.setUser("alice")
        #expect(r.named("session.end").isEmpty)
        r.manager.setUser("bob")
        let end = r.named("session.end")
        #expect(end.count == 1)
        #expect(end[0].attrs["ouo.session.end_reason"] == "user_change")
        #expect(end[0].attrs["user.id"] == "alice", "the end carries the previous user")
        #expect(r.manager.current!.userId == "bob")
        #expect(r.manager.current!.previousId == first)
        r.manager.clearUser()
        #expect(r.named("session.end").count == 2)
        #expect(r.manager.user.anonymous)
        #expect(r.manager.user.id != anon, "a fresh anonymous id")
        r.manager.clearUser()
        #expect(r.named("session.end").count == 2, "already anonymous: nothing")
    }

    /// Spec case 9.
    @Test func EndSessionIsManualAndTheNextActivityStartsANewOne() {
        let r = Run()
        r.manager.start(crash: nil, background: false)
        let first = r.manager.current!.id
        r.manager.endSession()
        #expect(r.named("session.end")[0].attrs["ouo.session.end_reason"] == "manual")
        #expect(r.manager.current == nil)
        r.manager.touch()
        #expect(r.manager.current!.previousId == first)
        #expect(r.named("session.start").count == 2)
    }

    /// Spec case 10.
    @Test func DeviceIdSurvivesRotationLoginLogoutAndRelaunch() {
        let r = Run()
        r.manager.start(crash: nil, background: false)
        let device = r.manager.deviceId
        r.manager.setUser("a")
        r.manager.setUser("b")
        r.manager.clearUser()
        let next = relaunch(r)
        #expect(next.manager.deviceId == device)
        #expect(next.events.allSatisfy { $0.attrs["device.id"] == .string(device) })
    }

    @Test func TheUserPersistsAcrossLaunches() {
        let r = Run()
        r.manager.start(crash: nil, background: false)
        r.manager.setUser("carol")
        let next = relaunch(r)
        #expect(next.manager.user == UserRecord(id: "carol", anonymous: false))
        #expect(next.manager.current!.userId == "carol")
    }

    @Test func ActivityIsPersistedAtMostOncePerSecond() {
        let r = Run()
        r.manager.start(crash: nil, background: false)
        let saves = r.store.saves
        for _ in 0..<10 {
            r.clock.advance(100)
            r.manager.touch()
        }
        #expect(r.store.saves - saves == 1)
        #expect(r.manager.current!.lastActivity == r.clock.now)
    }

    /// A clock set back during the run: no negative duration.
    @Test func NoNegativeDuration() {
        let first = Run()
        first.manager.start(crash: nil, background: false)
        first.clock.advance(-3_600_000)
        first.manager.endSession()
        #expect(first.named("session.end")[0].attrs["ouo.session.duration_ms"] == .int(0))
    }

    @Test func AnUnreadableFileIsAFreshStart() throws {
        let dir = tempDir()
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent("session.json")
        try Data("{not json".utf8).write(to: url)
        let r = Run()
        let m = SessionManager(store: FileSessionStore(url: url), now: { r.clock.now }, serviceVersion: "1", emit: { n, a, t in r.events.append((n, a, t)) }, onRotate: { _ in })
        m.start(crash: nil, background: false)
        #expect(r.events.map(\.name) == ["session.start"])
        guard case .state(let saved) = FileSessionStore(url: url).load() else { Issue.record("not saved"); return }
        #expect(saved.session?.id == m.current!.id, "a corrupt file is replaced")
    }

    /// B2, on a real file: before the first unlock the file exists and cannot be read (`chmod 000`
    /// stands in for data protection class C). It is not a fresh install: nothing is written over it,
    /// and once it can be read the previous session ends as a cold start would end it, and the
    /// device and the user stay.
    @Test func AFileThatCannotBeReadYetIsAdoptedOnceItCan() throws {
        let dir = tempDir()
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent("session.json")
        let clock = TestClock()
        let first = Run(clock: clock)
        let m1 = SessionManager(store: FileSessionStore(url: url), now: { clock.now }, serviceVersion: "1", emit: { _, _, _ in }, onRotate: { _ in })
        m1.start(crash: nil, background: false)
        let old = m1.current!.id
        let device = m1.deviceId
        let user = m1.user
        let before = try Data(contentsOf: url)

        try FileManager.default.setAttributes([.posixPermissions: 0o000], ofItemAtPath: url.path)
        defer { try? FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: url.path) }
        #expect(FileSessionStore(url: url).load() == .unreadable)
        clock.advance(60_000)
        let m2 = SessionManager(store: FileSessionStore(url: url), now: { clock.now }, serviceVersion: "1",
                                emit: { n, a, t in first.events.append((n, a, t)) }, onRotate: { _ in })
        m2.start(crash: nil, background: true)
        m2.touch()
        m2.persistNow()
        #expect(m2.storeUnreadable)
        #expect(first.named("session.end").isEmpty, "nothing to end yet")

        try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: url.path)
        #expect(try Data(contentsOf: url) == before, "never written over while unreadable")
        m2.retryStore()
        #expect(!m2.storeUnreadable)
        let end = first.named("session.end")
        #expect(end.count == 1)
        #expect(end.first?.attrs["session.id"] == .string(old))
        #expect(end.first?.attrs["ouo.session.end_reason"] == "terminated")
        #expect(end.first?.attrs["device.id"] == .string(device))
        #expect(m2.deviceId == device)
        #expect(m2.user == user)
        #expect(m2.current!.userId == user.id)
        guard case .state(let saved) = FileSessionStore(url: url).load() else { Issue.record("not saved"); return }
        #expect(saved.session?.id == m2.current!.id)
        #expect(saved.deviceId == device)
    }

    /// The same through activity: the first save after the unlock adopts the file; an app's
    /// identified user is kept over the stored anonymous one.
    @Test func AdoptionHappensOnTheNextSaveAndKeepsAnIdentifiedUser() {
        let store = Memory()
        store.state = PersistedSession(session: SessionRecord(id: "old", startedAt: 1_760_000_000_000 - 120_000, lastActivity: 1_760_000_000_000 - 60_000, userId: "anon-1"),
                                       user: UserRecord(id: "anon-1", anonymous: true), deviceId: "device-1")
        store.locked = true
        let r = Run(store: store)
        r.manager.start(crash: nil, background: false)
        r.manager.setUser("alice")
        #expect(store.saves == 0)
        store.locked = false
        r.clock.advance(2000)
        r.manager.touch()
        #expect(r.named("session.end").map { $0.attrs["session.id"] } == ["old"])
        #expect(r.manager.deviceId == "device-1")
        #expect(r.manager.user.id == "alice")
        #expect(store.state?.deviceId == "device-1")
        #expect(store.state?.session?.id == r.manager.current!.id)
    }
}
