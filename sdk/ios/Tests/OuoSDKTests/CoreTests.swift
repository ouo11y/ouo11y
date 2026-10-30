import Foundation
import Testing
import OuoVitals
@testable import OuoReplayCore
@testable import OuoSDK

/// The pipeline end to end: what the collector receives.
@Suite struct CoreTests {
    private func started(_ h: Harness, _ configure: (OuoConfig) -> Void = { _ in }, report: NativeReport? = nil, background: Bool = false,
                         appStart: AppStartInfo? = nil, frames: @escaping () -> FrameStats? = { nil }, sessionChanged: @escaping (SessionRecord) -> Void = { _ in }) -> Core {
        let c = h.core(configure, frames: frames, sessionChanged: sessionChanged)
        c.start(previousReport: report, background: background, appStart: appStart)
        return c
    }

    /// Rule 2 and 3: session ids on every record and span, the resource once per request.
    @Test func EveryRecordCarriesTheSessionAndTheResource() async throws {
        let h = Harness()
        let c = started(h)
        let id = c.sessionId
        c.event("custom", ["k": "v"])
        let span = OuoSpan(core: c, name: "work", kind: .internal, attributes: [:], parent: nil, start: h.clock.now)
        span.end()
        await flush(c)
        let logs = h.sink.logs
        #expect(logs.map(\.name) == ["session.start", "custom"])
        for r in logs {
            #expect(r.s("session.id") == id)
            #expect(r.s("user.id") == c.userId)
            #expect(r.b("ouo.user.anonymous") == true)
            #expect(r.s("ouo.platform") == "mobile")
            #expect(r.s("service.version") == "1.0.0")
            #expect(r.severity == 9)
        }
        let s = try #require(h.sink.spans.first)
        #expect(s.name == "work")
        #expect(s.s("session.id") == id)
        let resource = try #require(h.sink.resources.first)
        #expect(resource["service.name"] as? String == "native-test")
        #expect(resource["deployment.environment.name"] as? String == "production")
        #expect(resource["ouo.sdk.name"] as? String == "ouo11y-ios")
        #expect(resource["device.manufacturer"] as? String == "Apple")
        #expect(resource["os.version"] != nil)
        #expect(resource["device.model.identifier"] != nil)
        // C11.2: every OTLP request is gzip with the credential.
        for r in h.sink.requests {
            #expect(r.value(forHTTPHeaderField: "content-encoding") == "gzip")
            #expect(r.value(forHTTPHeaderField: "Authorization") == "Basic ZGVtbzpwdF90ZXN0")
        }
        #expect(Set(h.sink.requests.map { $0.url!.absoluteString }) == ["http://localhost:4318/v1/logs", "http://localhost:4318/v1/traces"])
    }

    /// C1: sampling decided once per session from its id; an unsampled session sends nothing.
    @Test func AnUnsampledSessionSendsNothing() async {
        let h = Harness()
        let c = started(h) { $0.sessionSampleRate = 0 }
        c.event("custom", [:])
        OuoSpan(core: c, name: "x", kind: .internal, attributes: [:], parent: nil, start: h.clock.now).end()
        await flush(c)
        #expect(h.sink.count == 0)
    }

    /// C1.1 through the lifecycle: background > 30 s, foreground: two sessions; `app.lifecycle` lands
    /// in the session it belongs to.
    @Test func BackgroundRotationAndLifecycleEvents() async {
        let h = Harness()
        var changed: [String] = []
        let c = started(h, sessionChanged: { changed.append($0.id) })
        let first = c.sessionId
        c.willResignActive()
        c.didEnterBackground()
        h.clock.advance(31_000)
        c.didBecomeActive()
        let second = c.sessionId
        #expect(second != first)
        #expect(changed == [first, second], "OuoCrash and replay are told about both")
        await flush(c)
        let logs = h.sink.logs
        #expect(logs.map(\.name) == ["session.start", "app.lifecycle", "app.lifecycle", "session.end", "session.start", "app.lifecycle"])
        #expect(logs.filter { $0.name == "app.lifecycle" }.map { $0.s("ouo.app.state")! } == ["inactive", "background", "foreground"])
        #expect(logs[2].s("session.id") == first, "background in the old session")
        #expect(logs[5].s("session.id") == second, "foreground in the new one")
        #expect(logs[4].s("session.previous_id") == first)
        #expect(logs[5].s("session.previous_id") == first)
        #expect(logs[3].s("ouo.session.end_reason") == "background")
    }

    @Test func LaunchStateIsNoLifecycleEventAndLifecycleEventsCanBeOff() async {
        let h = Harness()
        let c = started(h)
        c.didBecomeActive()
        let h2 = Harness()
        let off = started(h2) { $0.lifecycleEvents = false }
        off.willResignActive()
        off.didEnterBackground()
        await flush(c)
        await flush(off)
        #expect(h.sink.events("app.lifecycle").isEmpty)
        #expect(h2.sink.events("app.lifecycle").isEmpty)
    }

    /// C2: an exception carries the screen, the last events before it (1 to 20), the locale, memory
    /// and network now.
    @Test func ExceptionsCarryTheirContext() async throws {
        let h = Harness()
        let c = started(h)
        c.trackScreen("Home")
        c.trackScreen("Cart")
        for i in 0..<25 { c.event("step", [:], body: "step \(i)") }
        c.captureError(type: "CartError", message: "empty", attrs: ["k": "v"], stack: ([], []))
        await flush(c)
        let e = try #require(h.sink.events("exception").first)
        #expect(e.severity == 17)
        #expect(e.s("app.screen.name") == "Cart")
        #expect(e.s("ouo.exception.kind") == "captured")
        #expect(e.b("ouo.exception.handled") == true)
        #expect(e.b("ouo.exception.fatal") == false)
        #expect(e.s("exception.stacktrace")?.hasPrefix("CartError: empty\nThread (") == true)
        #expect(e.s("network.connection.type") == "wifi")
        #expect(e.i("ouo.memory.app_bytes") == 1000)
        #expect(e.s("ouo.device.locale") != nil)
        #expect(e.s("k") == "v")
        let last = try JSONDecoder().decode([RecentEvent].self, from: Data(e.s("ouo.last_events")!.utf8))
        #expect(last.count == 20)
        #expect(last.last?.body == "step 24")
        #expect(!last.contains { $0.name == "exception" }, "the events before it")
    }

    /// C2.2: the previous run's crash: its session ends with `crash` at the crash time, then the fatal
    /// exception of that session, with the screen and events that run persisted.
    @Test func APreviousCrashIsSentWithThePersistedContext() async throws {
        let dir = tempDir()
        let first = Harness(dir: dir)
        let c1 = started(first)
        let crashed = c1.sessionId
        c1.trackScreen("Home")
        c1.event("ui.tap", ["ouo.ui.target": "buy"], body: "Tap buy on Home")
        // The process dies here: no flush, no background. The context was written at once.
        let crashAt = first.clock.now + 500
        let report = try #require(NativeReport.parse("""
        {"version":1,"mechanism":"signal","timestamp_ms":\(Int64(crashAt)),"session_id":"\(crashed)","session_started_ms":\(Int64(first.clock.now)),"arch":"arm64",
         "thread":{"main":true},"signal":{"number":11,"name":"SIGSEGV","mach_exception":"EXC_BAD_ACCESS","address":"0x10"},
         "frames":[{"instruction_addr":"0x100001010","image_addr":"0x100000000"}],
         "images":[{"code_file":"/app/Demo","debug_id":"AB","image_addr":"0x100000000","image_size":4096,"image_vmaddr":"0x100000000"}]}
        """))
        first.clock.advance(60_000)
        let second = Harness(dir: dir, clock: first.clock)
        let c2 = started(second, report: report)
        await flush(c2)
        let logs = second.sink.logs
        let end = try #require(logs.first { $0.name == "session.end" })
        #expect(end.s("session.id") == crashed)
        #expect(end.s("ouo.session.end_reason") == "crash")
        #expect(end.time == crashAt)
        let e = try #require(logs.first { $0.name == "exception" })
        #expect(e.s("session.id") == crashed)
        #expect(e.time == crashAt)
        #expect(e.b("ouo.exception.fatal") == true)
        #expect(e.s("ouo.exception.kind") == "native")
        #expect(e.s("exception.type") == "SIGSEGV")
        #expect(e.s("app.screen.name") == "Home")
        #expect(e.s("ouo.last_events")?.contains("Tap buy on Home") == true)
        #expect(e.s("ouo.crash.frames")?.contains("0x100001010") == true)
        #expect(e.s("ouo.memory.app_bytes") == nil, "not measured at the crash")
        #expect(e.s("network.connection.type") == nil)
        #expect(e.s("service.version") == "1.0.0")
        #expect(logs.first { $0.name == "session.start" }?.s("session.previous_id") == crashed)
    }

    /// C3.2: a termination report is fatal and ends the session with `crash`.
    @Test func ATerminationReport() async throws {
        let dir = tempDir()
        let first = Harness(dir: dir)
        let id = started(first).sessionId
        let report = try #require(NativeReport.parse(#"{"version":1,"mechanism":"termination","timestamp_ms":\#(Int64(first.clock.now + 1000)),"session_id":"\#(id)","termination":{"cause":"memory"}}"#))
        let second = Harness(dir: dir, clock: first.clock)
        let c = started(second, report: report)
        await flush(c)
        let e = try #require(second.sink.events("exception").first)
        #expect(e.s("ouo.exception.kind") == "termination")
        #expect(e.s("ouo.termination.cause") == "memory")
        #expect(e.s("exception.type") == "WatchdogTermination")
        #expect(e.s("exception.stacktrace") == nil, "no stack outside a hang")
        #expect(second.sink.events("session.end").first?.s("ouo.session.end_reason") == "crash")
    }

    /// C3.1: a hang report becomes one non-fatal `hang` exception of the current session.
    @Test func AHangReport() async throws {
        let h = Harness()
        let c = started(h)
        c.trackScreen("Cart")
        c.hang(#"{"version":1,"mechanism":"hang","timestamp_ms":1760000000100,"arch":"arm64","thread":{"main":true},"hang":{"duration_ms":3012.5,"fully_blocking":true},"frames":[],"images":[]}"#)
        c.hang("not json")
        await flush(c)
        let hangs = h.sink.events("exception")
        #expect(hangs.count == 1)
        let e = try #require(hangs.first)
        #expect(e.s("ouo.exception.kind") == "hang")
        #expect(e.b("ouo.exception.fatal") == false)
        #expect(e.attrs["ouo.hang.duration_ms"] as? Double == 3012.5)
        #expect(e.s("app.screen.name") == "Cart")
        #expect(e.s("session.id") == c.sessionId)
        #expect(e.s("exception.message") == "App hanging for 3.0 s")
    }

    /// C7: one `navigation` per screen change, the same screen again is none.
    @Test func Screens() async {
        let h = Harness()
        let c = started(h)
        for s in ["Home", "Home", "Products", "Cart", " "] { c.trackScreen(s) }
        await flush(c)
        let nav = h.sink.events("navigation")
        #expect(nav.map { $0.s("url.path")! } == ["/Home", "/Products", "/Cart"])
        #expect(nav.map { $0.s("ouo.navigation.from") } == [nil, "/Home", "/Products"])
        #expect(nav.allSatisfy { $0.s("ouo.navigation.kind") == "screen" })
    }

    /// The context is on disk at once after a navigation, a tap or an exception; after other records
    /// within 5 s.
    @Test func ContextPersistence() throws {
        let h = Harness()
        let c = started(h)
        let url = h.dir.appendingPathComponent("context.json")
        c.trackScreen("Home")
        #expect(ScreenContext.load(url)?.screen == "Home")
        c.event("other", [:], body: "other step")
        #expect(ScreenContext.load(url)?.events.contains { $0.name == "other" } == false)
        h.clock.advance(5000)
        h.manual.fireDue()
        #expect(ScreenContext.load(url)?.events.contains { $0.name == "other" } == true)
        #expect(ScreenContext.load(url)?.sessionId == c.sessionId)
    }

    /// C4: app start once the first frame and the session exist; TTID per screen; frames per window.
    @Test func Vitals() async throws {
        let h = Harness()
        var stats = frameStats(total: 0)
        let processStart = h.clock.now - 800
        let c = started(h, appStart: AppStartInfo.resolve(firstRuntime: true, processStartMs: processStart, loadTimeMs: 0, runtimeStartMs: 0, prewarmed: false),
                        frames: { stats })
        h.clock.advance(100)
        c.firstFrame(h.clock.now)
        stats = frameStats(total: 60, slow: 2)
        c.trackScreen("Home")
        h.clock.advance(50)
        h.manual.drawFrame()
        c.reportFullyDisplayed()
        h.clock.advance(150)
        h.manual.drawFrame()
        stats = frameStats(total: 120, slow: 3, frozen: 1)
        c.didEnterBackground()
        await flush(c)
        let start = try #require(h.sink.events("ouo.app.start").first)
        #expect(start.s("ouo.app.start.type") == "cold")
        #expect(start.attrs["ouo.app.start.duration_ms"] as? Double == 900)
        let display = try #require(h.sink.events("ouo.screen.display").first)
        #expect(display.s("app.screen.name") == "Home")
        #expect(display.attrs["ouo.screen.ttid_ms"] as? Double == 950, "the first screen from the process start")
        #expect(display.attrs["ouo.screen.ttfd_ms"] as? Double == 1100)
        let jank = h.sink.events("app.jank")
        #expect(jank.map { $0.s("ouo.vital.window") } == ["app_start", "screen"])
        #expect(jank[1].i("ouo.frames.total") == 60)
        #expect(jank[1].i("app.jank.frame_count") == 2)
        #expect(jank.allSatisfy { $0.s("ouo.vital.source") == "ouo" })
    }

    /// A launch in the background has no app start, and its first screen no TTID.
    @Test func ABackgroundLaunchHasNoAppStart() async {
        let h = Harness()
        let c = started(h, background: true, appStart: AppStartInfo.resolve(firstRuntime: true, processStartMs: h.clock.now - 500, loadTimeMs: 0, runtimeStartMs: 0, prewarmed: false))
        c.firstFrame(h.clock.now)
        c.trackScreen("Home")
        h.manual.drawFrame()
        c.didEnterBackground()
        await flush(c)
        #expect(h.sink.events("ouo.app.start").isEmpty)
        #expect(h.sink.events("ouo.screen.display").isEmpty)
    }

    /// C9: log lines and spans, and `withSpan` parenting.
    @Test func LogsAndSpans() async throws {
        let h = Harness()
        let c = started(h)
        let parent = OuoSpan(core: c, name: "checkout", kind: .internal, attributes: [:], parent: nil, start: h.clock.now)
        OuoSpan.push(parent)
        c.logLine(.warn, String(repeating: "x", count: 2000), ["a": 1], span: nil)
        let child = OuoSpan(core: c, name: "child", kind: .internal, attributes: [:], parent: OuoSpan.active, start: h.clock.now)
        OuoSpan.pop(parent)
        child.end()
        parent.setError("boom")
        parent.end()
        parent.end()
        await flush(c)
        let line = try #require(h.sink.events("log").first)
        #expect(line.severity == 13)
        #expect(line.body.count == 2000)
        #expect(line.s("message")?.count == 1024)
        #expect(line.traceId == parent.traceId)
        #expect(line.spanId == parent.spanId)
        let spans = h.sink.spans
        #expect(spans.count == 2)
        #expect(spans.first { $0.name == "child" }?.parentSpanId == parent.spanId)
        #expect(spans.first { $0.name == "child" }?.traceId == parent.traceId)
        #expect(spans.first { $0.name == "checkout" }?.statusError == "boom")
        #expect(OuoSpan.active == nil)
    }

    /// C11.1: a run with the collector unreachable loses nothing; the next launch sends it.
    @Test func AnOfflineRunIsSentByTheNextLaunch() async {
        let dir = tempDir()
        let offline = Sink()
        offline.responses = Array(repeating: .failure(URLError(.notConnectedToInternet)), count: 50)
        let first = Harness(dir: dir, sink: offline)
        let c1 = started(first)
        let id = c1.sessionId
        c1.trackScreen("Home")
        c1.event("custom", [:])
        await flush(c1)
        #expect(c1.exporter.queue.count >= 1, "kept on disk")

        let online = Sink()
        let second = Harness(dir: dir, clock: first.clock, sink: online)
        let c2 = started(second)
        await flush(c2)
        let names = online.logs.filter { $0.s("session.id") == id }.map(\.name)
        #expect(names.contains("navigation"))
        #expect(names.contains("custom"))
        #expect(names.contains("session.end"), "the offline session ended by the next launch")
        #expect(c2.exporter.queue.count == 0)
    }

    /// Threading: records, lifecycle, user changes, spans and flushes from many threads at once lose
    /// nothing and never deadlock (the lock is never held while a hook or app code runs).
    @Test func ConcurrentUseLosesNothing() async {
        let h = Harness()
        let c = started(h)
        DispatchQueue.concurrentPerform(iterations: 400) { i in
            switch i % 8 {
            case 0: c.didEnterBackground()
            case 1: c.didBecomeActive()
            case 2: c.trackScreen("S\(i % 3)")
            case 3: OuoSpan(core: c, name: "s", kind: .internal, attributes: [:], parent: nil, start: h.clock.now).end()
            case 4: c.flush {}
            case 5: c.setUser("u\(i % 2)")
            default: c.event("e", ["i": .int(Int64(i))])
            }
        }
        await flush(c)
        let es = h.sink.events("e").compactMap { $0.i("i") }
        #expect(es.count == 100 && Set(es).count == 100)
        #expect(h.sink.spans.count == 50)
        let starts = h.sink.events("session.start").count
        let ends = h.sink.events("session.end").count
        #expect(starts == ends + 1, "every session but the current one ended")
    }
}
