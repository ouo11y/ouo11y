import Foundation
import Testing
@testable import OuoSDK

/// User and session attributes (docs/specs/attributes.md, gap F1).
@Suite struct AttributesTests {
    private func started(_ h: Harness) -> Core {
        let c = h.core()
        c.start(previousReport: nil, background: false, appStart: nil)
        return c
    }

    private func attrs(_ r: Sent) -> [String: Any] { r.attrs.filter { $0.key.hasPrefix("ouo.attr.") } }

    // MARK: - validation (section 3)

    @Test func KeysFollowTheRule() {
        for good in ["a", "tenant", "A_b9", "plan_tier", String(repeating: "k", count: 40)] {
            #expect(CustomAttributes.validKey(good), "\(good)")
        }
        for bad in ["", "1a", "_a", "a.b", "a-b", "a b", "é", "aé", "tenant!", String(repeating: "k", count: 41)] {
            #expect(!CustomAttributes.validKey(bad), "\(bad)")
        }
    }

    @Test func ValuesAreStringsFiniteNumbersAndBooleans() {
        #expect(CustomAttributes.value("s") == "s")
        #expect(CustomAttributes.value(3) == .int(3))
        #expect(CustomAttributes.value(Int8(-2)) == .int(-2))
        #expect(CustomAttributes.value(2.5) == .double(2.5))
        #expect(CustomAttributes.value(Float(1.5)) == .double(1.5))
        #expect(CustomAttributes.value(true) == .bool(true))
        #expect(CustomAttributes.value(NSNumber(value: false)) == .bool(false))
        #expect(CustomAttributes.value(NSNumber(value: 1)) == .int(1))
        #expect(CustomAttributes.value("x" as NSString) == "x")
        let none: String? = nil
        for bad: Any in [Double.nan, Double.infinity, -Double.infinity, Float.nan, NSNull(), [1, 2], ["a": 1], Date(),
                         URL(string: "https://x")!, none as Any, AttributeValue.double(.nan)] {
            #expect(CustomAttributes.value(bad) == nil, "\(bad)")
        }
    }

    @Test func LongStringsAreCutTo128() {
        #expect(CustomAttributes.value(String(repeating: "x", count: 200)) == .string(String(repeating: "x", count: 128)))
        #expect(CustomAttributes.value(String(repeating: "x", count: 128)) == .string(String(repeating: "x", count: 128)))
        let emoji = String(repeating: "\u{1F600}", count: 130)
        #expect(CustomAttributes.value(emoji) == .string(String(repeating: "\u{1F600}", count: 128)))
    }

    @Test func CleanDropsBadEntriesAndKeepsTheRest() {
        let (kept, dropped) = CustomAttributes.clean(["plan": "pro", "a.b": "x", "n": Double.nan, "seats": 3, "obj": ["k": 1]])
        #expect(kept == ["plan": "pro", "seats": .int(3)])
        #expect(dropped.count == 3)
    }

    /// 20 distinct keys in both sets together; a new key beyond is dropped, an existing one changes.
    @Test func AtMost20KeysAndAnExistingKeyAlwaysChanges() async throws {
        let h = Harness()
        let c = started(h)
        var app: [String: Any] = [:]
        for i in 0..<12 { app[String(format: "app%02d", i)] = i }
        c.setAttributes(app)
        var user: [String: Any] = [:]
        for i in 0..<10 { user[String(format: "usr%02d", i)] = i }
        c.setUser("alice", attributes: user) // 12 + 8 fit: usr08 and usr09 are dropped (key order)
        c.setAttributes(["zzz": 1])          // 20 already: dropped
        c.setAttributes(["app05": "changed", "usr03": "app wins"])
        c.event("probe", [:])
        await flush(c)
        let a = attrs(try #require(h.sink.events("probe").first))
        #expect(a.count == 20)
        #expect(a["ouo.attr.usr08"] == nil && a["ouo.attr.usr09"] == nil)
        #expect(a["ouo.attr.usr07"] as? Int64 == 7)
        #expect(a["ouo.attr.zzz"] == nil)
        #expect(a["ouo.attr.app05"] as? String == "changed")
        #expect(a["ouo.attr.usr03"] as? String == "app wins")
    }

    /// Replacing the user's set counts the app's keys, not the old user's.
    @Test func AReplacedUserSetDoesNotCountTheOldOne() async throws {
        let h = Harness()
        let c = started(h)
        var first: [String: Any] = [:]
        for i in 0..<20 { first["a\(i)"] = i }
        c.setUser("alice", attributes: first)
        var second: [String: Any] = [:]
        for i in 0..<20 { second["b\(i)"] = i }
        c.setUser("alice", attributes: second)
        c.event("probe", [:])
        await flush(c)
        let a = attrs(try #require(h.sink.events("probe").first))
        #expect(a.count == 20)
        #expect(a.keys.allSatisfy { $0.hasPrefix("ouo.attr.b") })
    }

    // MARK: - stamping (section 4)

    @Test func StampedOnEveryLaterRecordAndSpan() async throws {
        let h = Harness()
        let c = started(h)
        c.event("before", [:])
        c.setAttributes(["tenant": "acme", "seats": 3, "ratio": 0.5, "beta": true, "bad.key": "x", "nested": [1]])
        c.event("custom", [:])
        c.logLine(.info, "line", [:], span: nil)
        let span = OuoSpan(core: c, name: "work", kind: .internal, attributes: [:], parent: nil, start: h.clock.now)
        span.end()
        c.trackScreen("Home")
        await flush(c)
        #expect(attrs(try #require(h.sink.events("before").first)).isEmpty)
        #expect(attrs(try #require(h.sink.events("session.start").first)).isEmpty)
        for r in h.sink.events("custom") + h.sink.events("log") + h.sink.events("navigation") + h.sink.spans {
            #expect(r.s("ouo.attr.tenant") == "acme", "\(r.name)")
            #expect(r.i("ouo.attr.seats") == 3)
            #expect(r.attrs["ouo.attr.ratio"] as? Double == 0.5)
            #expect(r.b("ouo.attr.beta") == true)
            #expect(attrs(r).count == 4, "the invalid ones are dropped")
            #expect(r.s("user.id") == c.userId)
        }
        #expect(h.sink.spans.count == 1)
    }

    @Test func TheAppSetWinsAndRemoveAttributeRemovesFromBoth() async throws {
        let h = Harness()
        let c = started(h)
        c.setUser("alice", attributes: ["plan": "user", "tier": "gold"])
        c.setAttributes(["plan": "app"])
        c.event("both", [:])
        c.removeAttribute("plan")
        c.removeAttribute("missing")
        c.event("removed", [:])
        await flush(c)
        let both = try #require(h.sink.events("both").first)
        #expect(both.s("ouo.attr.plan") == "app")
        #expect(both.s("ouo.attr.tier") == "gold")
        let removed = try #require(h.sink.events("removed").first)
        #expect(removed.attrs["ouo.attr.plan"] == nil, "gone from the app set and the user set")
        #expect(removed.s("ouo.attr.tier") == "gold")
    }

    // MARK: - setUser and clearUser (section 2)

    @Test func SetUserReplacesKeepsAndEmpties() async throws {
        let h = Harness()
        let c = started(h)
        c.setUser("alice", attributes: ["tier": "gold"])
        c.event("e1", [:])
        c.setUser("alice")                       // same user, no attributes: kept
        c.event("e2", [:])
        c.setUser("alice", attributes: nil)      // the same
        c.event("e3", [:])
        c.setUser("alice", attributes: ["org": "acme"]) // replaced
        c.event("e4", [:])
        c.setUser("bob")                         // another user, no attributes: emptied
        c.event("e5", [:])
        c.setUser("bob", attributes: ["tier": "silver"])
        c.event("e6", [:])
        c.clearUser()                            // logout: emptied
        c.event("e7", [:])
        await flush(c)
        func a(_ n: String) throws -> [String: String] {
            attrs(try #require(h.sink.events(n).first)).mapValues { $0 as? String ?? "?" }
        }
        #expect(try a("e1") == ["ouo.attr.tier": "gold"])
        #expect(try a("e2") == ["ouo.attr.tier": "gold"])
        #expect(try a("e3") == ["ouo.attr.tier": "gold"])
        #expect(try a("e4") == ["ouo.attr.org": "acme"])
        #expect(try a("e5") == [:])
        #expect(try a("e6") == ["ouo.attr.tier": "silver"])
        #expect(try a("e7") == [:])
        #expect(h.sink.events("session.end").count == 2, "alice to bob, then the logout")
    }

    @Test func AnonymousToIdentifiedKeepsTheSessionAndTakesTheSet() async throws {
        let h = Harness()
        let c = started(h)
        let id = c.sessionId
        c.setUser("alice", attributes: ["tier": "gold"])
        #expect(c.sessionId == id)
        c.event("e", [:])
        await flush(c)
        #expect(try #require(h.sink.events("e").first).s("ouo.attr.tier") == "gold")
    }

    /// The set is swapped with the user: the old session's end carries the old set, the new
    /// session's start the new one.
    @Test func AUserChangeRotationCarriesEachUsersSet() async throws {
        let h = Harness()
        let c = started(h)
        c.setAttributes(["cohort": "b"])
        c.setUser("alice", attributes: ["tier": "gold"])
        c.setUser("bob", attributes: ["tier": "silver", "org": "beta"])
        await flush(c)
        let end = try #require(h.sink.events("session.end").first)
        #expect(end.s("ouo.session.end_reason") == "user_change")
        #expect(end.s("user.id") == "alice")
        #expect(end.s("ouo.attr.tier") == "gold")
        #expect(end.attrs["ouo.attr.org"] == nil)
        #expect(end.s("ouo.attr.cohort") == "b")
        let start = try #require(h.sink.events("session.start").last)
        #expect(start.s("user.id") == "bob")
        #expect(start.s("ouo.attr.tier") == "silver")
        #expect(start.s("ouo.attr.org") == "beta")
        #expect(start.s("ouo.attr.cohort") == "b")
    }

    @Test func ALogoutRotationEndsWithTheSetAndStartsWithout() async throws {
        let h = Harness()
        let c = started(h)
        c.setUser("alice", attributes: ["tier": "gold"])
        c.clearUser()
        await flush(c)
        #expect(try #require(h.sink.events("session.end").first).s("ouo.attr.tier") == "gold")
        #expect(attrs(try #require(h.sink.events("session.start").last)).isEmpty)
    }

    // MARK: - persistence

    /// The user's set survives a relaunch with the user; the app's does not.
    @Test func TheUserSetIsPersistedTheAppSetIsNot() async throws {
        let dir = tempDir()
        let first = Harness(dir: dir)
        let c1 = started(first)
        c1.setUser("alice", attributes: ["tier": "gold", "seats": 3])
        c1.setAttributes(["cohort": "b"])
        let id = c1.sessionId
        await flush(c1)

        first.clock.advance(1000)
        let second = Harness(dir: dir, clock: first.clock)
        let c2 = started(second)
        c2.event("after", [:])
        await flush(c2)
        let end = try #require(second.sink.events("session.end").first { $0.s("session.id") == id })
        #expect(end.s("user.id") == "alice")
        #expect(end.s("ouo.attr.tier") == "gold")
        #expect(end.i("ouo.attr.seats") == 3)
        let after = try #require(second.sink.events("after").first)
        #expect(after.s("user.id") == "alice")
        #expect(after.s("ouo.attr.tier") == "gold")
        #expect(after.i("ouo.attr.seats") == 3, "an int stays an int")
        #expect(after.attrs["ouo.attr.cohort"] == nil, "the app set lives for the process")
    }

    @Test func SessionManagerPersistsTheSetWithTheUser() {
        let store = SessionManagerTests.Memory()
        let clock = TestClock()
        func manager() -> SessionManager {
            SessionManager(store: store, now: { clock.now }, serviceVersion: "1", emit: { _, _, _ in }, onRotate: { _ in })
        }
        let m1 = manager()
        m1.start(crash: nil, background: false)
        m1.setUser("alice", attributes: ["tier": "gold", "ratio": .double(2), "on": true])
        #expect(store.state?.user?.attributes == ["tier": "gold", "ratio": .double(2), "on": true])
        m1.removeUserAttribute("on")
        #expect(store.state?.user?.attributes == ["tier": "gold", "ratio": .double(2)])
        let m2 = manager()
        m2.start(crash: nil, background: false)
        #expect(m2.user == UserRecord(id: "alice", anonymous: false, attributes: ["tier": "gold", "ratio": .double(2)]))
        m2.clearUser()
        #expect(store.state?.user?.attributes == nil)
    }

    /// Through the file: a set round-trips with its types; a file of an older version (no set) and a
    /// set this version cannot read keep the user and the session.
    @Test func TheSessionFileReadsOldAndUnreadableSets() throws {
        let url = tempDir().appendingPathComponent("session.json")
        let store = FileSessionStore(url: url)
        let user = UserRecord(id: "alice", anonymous: false, attributes: ["s": "x", "i": 3, "d": .double(3), "b": false])
        store.save(PersistedSession(session: nil, user: user, deviceId: "d1"))
        #expect(store.load() == .state(PersistedSession(session: nil, user: user, deviceId: "d1")))

        try Data(#"{"user":{"id":"bob","anonymous":false},"deviceId":"d2"}"#.utf8).write(to: url)
        #expect(store.load() == .state(PersistedSession(session: nil, user: UserRecord(id: "bob", anonymous: false), deviceId: "d2")))

        try Data(#"{"user":{"id":"bob","anonymous":false,"attributes":{"k":{"x":[1]}}},"deviceId":"d3"}"#.utf8).write(to: url)
        #expect(store.load() == .state(PersistedSession(session: nil, user: UserRecord(id: "bob", anonymous: false), deviceId: "d3")))
    }

    // MARK: - containment

    @Test func CallsBeforeStartAndOddInputDoNothing() {
        Ouo.setAttributes(["a": 1])
        Ouo.removeAttribute("a")
        Ouo.setUser("x", attributes: ["a": NSNull()])
        let h = Harness()
        let c = started(h)
        c.setUser("", attributes: ["tier": "gold"])
        #expect(c.userId != "")
        c.setAttributes([:])
        c.removeAttribute("")
    }
}
