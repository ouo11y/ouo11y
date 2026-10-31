import Foundation
import Testing
@testable import OuoReplayCore
@testable import OuoSDK

@Suite struct ReportTests {
    @Test func SignalReportAttributesAndStack() throws {
        let r = try #require(NativeReport.parse("""
        {"version":1,"mechanism":"signal","timestamp_ms":1760000000123,"session_id":"s1","session_started_ms":1760000000000,"arch":"arm64",
         "thread":{"main":false},"signal":{"number":11,"name":"SIGSEGV","mach_exception":"EXC_BAD_ACCESS","code_name":"KERN_INVALID_ADDRESS","address":"0x0"},
         "frames":[{"instruction_addr":"0x104a1c2f0","image_addr":"0x104a00000"},{"instruction_addr":"0x1"}],
         "images":[{"code_file":"/private/var/App.app/App","debug_id":"ABCD-EF","image_addr":"0x104a00000","image_size":65536,"image_vmaddr":"0x100000000"}]}
        """))
        #expect(r.crashMarker == CrashMarker(sessionId: "s1", at: 1_760_000_000_123, startedAt: 1_760_000_000_000))
        let a = r.attributes
        #expect(a["exception.type"] == "SIGSEGV")
        #expect(a["exception.message"] == "EXC_BAD_ACCESS (SIGSEGV) KERN_INVALID_ADDRESS at 0x0")
        #expect(a["ouo.exception.kind"] == "native")
        #expect(a["ouo.exception.fatal"] == true)
        #expect(a["ouo.exception.handled"] == false)
        #expect(a["ouo.crash.signal"] == "SIGSEGV")
        #expect(a["ouo.crash.mach_exception"] == "EXC_BAD_ACCESS")
        #expect(a["ouo.crash.address"] == "0x0")
        #expect(a["ouo.crash.thread_main"] == false)
        #expect(a["ouo.crash.timestamp"] == .int(1_760_000_000_123))
        #expect(a["session.id"] == "s1")
        // The React Native SDK's formatNativeStack, line for line.
        #expect(a["exception.stacktrace"]?.text == """
        SIGSEGV: EXC_BAD_ACCESS (SIGSEGV) KERN_INVALID_ADDRESS at 0x0
        Thread (background thread) crashed, arm64:
        0   App                             0x0000000104a1c2f0 0x104a00000 + 115440
        1   ???                             0x0000000000000001

        Binary Images:
        0x104a00000 - 0x104a0ffff App arm64 <abcd-ef> /private/var/App.app/App
        """)
        let frames = try JSONSerialization.jsonObject(with: Data(a["ouo.crash.frames"]!.text.utf8)) as? [[String: String]]
        #expect(frames?.first?["instruction_addr"] == "0x104a1c2f0")
        let images = try JSONSerialization.jsonObject(with: Data(a["ouo.crash.images"]!.text.utf8)) as? [[String: Any]]
        #expect(images?.first?["debug_id"] as? String == "ABCD-EF")
    }

    @Test func OtherMechanisms() throws {
        let ns = try #require(NativeReport.parse(#"{"mechanism":"nsexception","timestamp_ms":1,"exception":{"name":"NSRangeException","reason":"index 3"}}"#))
        #expect(ns.title == ("NSRangeException", "index 3"))
        let hang = try #require(NativeReport.parse(#"{"mechanism":"hang","timestamp_ms":1,"hang":{"duration_ms":4750,"fully_blocking":false}}"#))
        #expect(hang.title.message == "App hanging for 4.8 s (not fully blocking)")
        #expect(hang.attributes["ouo.exception.fatal"] == false)
        #expect(hang.attributes["ouo.hang.fully_blocking"] == false)
        let watchdog = try #require(NativeReport.parse(#"{"mechanism":"termination","timestamp_ms":1,"termination":{"cause":"watchdog"},"thread":{"main":true},"frames":[{"instruction_addr":"0x10"}],"images":[]}"#))
        #expect(watchdog.attributes["ouo.termination.cause"] == "watchdog")
        #expect(watchdog.attributes["exception.stacktrace"]?.text.contains("Thread (main thread) hung") == true, "died during a hang: its stack")
        let odd = try #require(NativeReport.parse(#"{"mechanism":"termination","timestamp_ms":1,"termination":{"cause":"gremlins"},"session_started_ms":0}"#))
        #expect(odd.attributes["ouo.termination.cause"] == "unknown")
        #expect(odd.session_started_ms == nil)
        #expect(NativeReport.parse(#"{"mechanism":"other","timestamp_ms":1}"#) == nil)
        #expect(NativeReport.parse(#"{"mechanism":"hang","timestamp_ms":1}"#) == nil)
        #expect(NativeReport.parse("{\"mechanism\":\"signal\"") == nil)
    }

    /// A captured error carries this process's stack in the crash report's fields.
    @Test func TheCurrentStackHasFramesAndImages() {
        let s = Stack.current()
        #expect(s.frames.count > 3)
        #expect(!s.images.isEmpty)
        #expect(s.frames.allSatisfy { $0.instruction_addr.hasPrefix("0x") })
    }
}

@Suite struct OTLPTests {
    @Test func LogsJSON() throws {
        let r = LogRecord(timeMs: 1_760_000_000_123.456, severity: OuoLogLevel.error, body: "b", attributes: ["event.name": "exception", "n": 42, "d": 1.5, "t": true, "nan": .double(.nan)], traceId: "ab", spanId: "cd")
        let o = try #require(try JSONSerialization.jsonObject(with: OTLP.logsBody([r], resource: ["service.name": "x"])) as? [String: Any])
        let rl = try #require((o["resourceLogs"] as? [[String: Any]])?.first)
        let res = try #require((rl["resource"] as? [String: Any])?["attributes"] as? [[String: Any]])
        #expect(res.first?["key"] as? String == "service.name")
        let sl = try #require((rl["scopeLogs"] as? [[String: Any]])?.first)
        #expect((sl["scope"] as? [String: Any])?["name"] as? String == "ouo11y-ios")
        let log = try #require((sl["logRecords"] as? [[String: Any]])?.first)
        #expect(log["timeUnixNano"] as? String == "1760000000123456000")
        #expect(log["severityNumber"] as? Int == 17)
        #expect(log["severityText"] as? String == "ERROR")
        #expect(log["eventName"] as? String == "exception")
        #expect(log["traceId"] as? String == "ab")
        let attrs = Dictionary(uniqueKeysWithValues: (log["attributes"] as! [[String: Any]]).map { ($0["key"] as! String, $0["value"] as! [String: Any]) })
        #expect(attrs["n"]?["intValue"] as? String == "42")
        #expect(attrs["d"]?["doubleValue"] as? Double == 1.5)
        #expect(attrs["t"]?["boolValue"] as? Bool == true)
        #expect(attrs["nan"]?["stringValue"] as? String == "nan", "JSON has no NaN")
    }

    @Test func TracesJSON() throws {
        let s = SpanRecord(traceId: Ids.trace(), spanId: Ids.span(), parentSpanId: "p", name: "HTTP GET", kind: .client, startMs: 10, endMs: 5, attributes: [:], error: "HTTP 503")
        let o = try #require(try JSONSerialization.jsonObject(with: OTLP.tracesBody([s], resource: [:])) as? [String: Any])
        let span = try #require(((((o["resourceSpans"] as? [[String: Any]])?.first?["scopeSpans"]) as? [[String: Any]])?.first?["spans"] as? [[String: Any]])?.first)
        #expect(span["kind"] as? Int == 3)
        #expect(span["parentSpanId"] as? String == "p")
        #expect(span["endTimeUnixNano"] as? String == span["startTimeUnixNano"] as? String, "never before its start")
        #expect((span["status"] as? [String: Any])?["code"] as? Int == 2)
        #expect((span["traceId"] as? String)?.count == 32)
        #expect((span["spanId"] as? String)?.count == 16)
    }
}

@Suite struct ExporterTests {
    private func exporter(_ dir: URL, _ sink: Sink, retry: @escaping @Sendable (Int) -> TimeInterval = { _ in 3600 }) -> Exporter {
        var config = Exporter.outbox
        config.retryDelay = retry
        return Exporter(endpoint: URL(string: "https://otel.example.com/")!, authorization: "Basic x", directory: dir, resource: [:], transport: sink, log: Log(enabled: false), config: config)
    }

    private func record(_ i: Int) -> LogRecord {
        LogRecord(timeMs: Double(i), severity: .info, body: "\(i)", attributes: ["event.name": "e"], traceId: nil, spanId: nil)
    }

    private func drain(_ e: Exporter) async {
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in e.drain { c.resume() } }
    }

    @Test func BatchesOf64WrittenBeforeTheyAreSent() async {
        let sink = Sink()
        let e = exporter(tempDir(), sink)
        #expect(e.logsURL.absoluteString == "https://otel.example.com/v1/logs")
        for i in 0..<130 { e.add(record(i)) }
        e.flush()
        await drain(e)
        #expect(sink.count == 3)
        #expect(sink.logs.count == 130)
        #expect(sink.logs.map(\.body) == (0..<130).map(String.init), "in order")
    }

    /// The outbox stops sending during a backoff: new batches wait for the retry, not one request each.
    @Test func AnOutageIsNotHammered() async {
        let sink = Sink()
        sink.responses = Array(repeating: .success(503), count: 20)
        let dir = tempDir()
        let e = exporter(dir, sink)
        e.add(record(0))
        e.flush()
        await drain(e)
        for i in 1..<5 {
            e.add(record(i))
            e.flush()
        }
        try? await Task.sleep(nanoseconds: 100_000_000)
        #expect(sink.count == 1)
        #expect(e.queue.count == 5)
        // The next launch sends all five, oldest first.
        let online = Sink()
        let next = exporter(dir, online)
        await drain(next)
        #expect(online.logs.map(\.body) == ["0", "1", "2", "3", "4"])
    }

    @Test func BoundsAre5MB500Requests24h() {
        #expect(Exporter.outbox.maxBytes == 5 * 1024 * 1024)
        #expect(Exporter.outbox.maxEntries == 500)
        #expect(Exporter.outbox.maxAge == 24 * 3600)
        #expect(Exporter.outbox.retryDelay(1) == 1)
        #expect(Exporter.outbox.retryDelay(3) == 4)
        #expect(Exporter.outbox.retryDelay(10) == 30)
    }

    /// A batch arrives on its own within a second.
    @Test func TheTimerFlushes() async {
        let sink = Sink()
        let e = exporter(tempDir(), sink)
        e.add(record(7))
        for _ in 0..<40 where sink.count == 0 { try? await Task.sleep(nanoseconds: 50_000_000) }
        #expect(sink.logs.map(\.body) == ["7"])
    }
}

@Suite struct HelperTests {
    /// The same vectors as `samplingHash` of the React Native SDK (computed with Node).
    @Test func SamplingHashMatchesJavaScript() {
        #expect(Sampling.hash("session:3f2a") == 3_078_599_890)
        #expect(Sampling.hash("replay:abc-123") == 581_472_999)
        #expect(Sampling.hash("session:pröjekt🙂") == 3_449_383_321)
        #expect(Sampling.hash("") == 2_872_998_923)
        #expect(Sampling.sampled("x", rate: 1, salt: "session"))
        #expect(!Sampling.sampled("x", rate: 0, salt: "session"))
        #expect(!Sampling.sampled("x", rate: .nan, salt: "session"))
        let ids = (0..<2000).map { _ in UUID().uuidString.lowercased() }
        let share = Double(ids.filter { Sampling.sampled($0, rate: 0.25, salt: "session") }.count) / 2000
        #expect(share > 0.2 && share < 0.3)
    }

    @Test func AttributeValuesFromAppValues() {
        #expect(AttributeValue(any: "s") == "s")
        #expect(AttributeValue(any: 3) == .int(3))
        #expect(AttributeValue(any: 2.5) == .double(2.5))
        #expect(AttributeValue(any: true) == .bool(true))
        #expect(AttributeValue(any: NSNumber(value: 1)) == .int(1))
        #expect(AttributeValue(any: NSNumber(value: false)) == .bool(false))
        #expect(AttributeValue(any: Double.infinity) == nil)
        #expect(AttributeValue(any: URL(string: "https://x")!) == "https://x")
    }

    @Test func CutUtf8LikeTheBridge() {
        #expect(cutUtf8("abc", 3) == "abc")
        #expect(cutUtf8("abcd", 3) == "abc…")
        #expect(cutUtf8("aé", 2) == "a…")
        #expect(cutUtf8("🙂🙂", 5) == "🙂…")
    }

    @Test func RecentEventSteps() {
        #expect(RecentEvents.summary("navigation", "navigation", ["url.path": "/Cart"]) == "/Cart")
        #expect(RecentEvents.summary("exception", "exception", ["exception.type": "E", "exception.message": "m"]) == "E: m")
        #expect(RecentEvents.summary("http.request", "GET u", ["http.request.method": "GET", "url.full": "u", "http.response.status_code": 200]) == "GET u 200")
        #expect(RecentEvents.summary("ui.tap", "Tap buy on Home", [:]) == "Tap buy on Home")
        #expect(RecentEvents.summary("custom", "custom", [:]) == "")
        var r = RecentEvents()
        r.add(LogRecord(timeMs: 20, severity: .info, body: "late", attributes: ["session.id": "a", "event.name": "x"]))
        r.add(LogRecord(timeMs: 10, severity: .info, body: "early", attributes: ["session.id": "a", "event.name": "x"]))
        r.add(LogRecord(timeMs: 15, severity: .info, body: "other", attributes: ["session.id": "b", "event.name": "x"]))
        #expect(r.read("a").map(\.body) == ["early", "late"], "oldest first by ts, this session only")
    }

}

@Suite(.serialized) struct PublicAPITests {
    @Test func ConfigProblemsAndDefaults() {
        let ok = OuoConfig(endpoint: URL(string: "http://localhost:4318")!, projectId: " demo ", projectToken: "t", serviceName: "s")
        #expect(ok.problem == nil)
        #expect(ok.projectId == "demo")
        #expect(ok.resolvedReplayEndpoint.absoluteString == "http://localhost:4319")
        #expect(ok.backgroundTimeout == 30)
        #expect(ok.replaySampleRate == 0)
        let proxy = OuoConfig(endpoint: URL(string: "https://otel.example.com")!, projectId: "p", projectToken: "t", serviceName: "s")
        #expect(proxy.resolvedReplayEndpoint.absoluteString == "https://otel.example.com")
        #expect(OuoConfig(endpoint: URL(string: "ftp://x")!, projectId: "p", projectToken: "t", serviceName: "s").problem != nil)
        #expect(OuoConfig(endpoint: URL(string: "https://x")!, projectId: "", projectToken: "t", serviceName: "s").problem != nil)
        #expect(OuoConfig(endpoint: URL(string: "https://x")!, projectId: "a:b", projectToken: "t", serviceName: "s").problem != nil)
        #expect(OuoConfig(endpoint: URL(string: "https://x")!, projectId: "p", projectToken: "t", serviceName: "").problem != nil)
    }

    /// Before `start` every call is a no-op, and a bad config does not start anything.
    @Test func CallsBeforeStartDoNothing() async {
        #expect(!Ouo.start(OuoConfig(endpoint: URL(string: "https://x")!, projectId: "", projectToken: "", serviceName: "s")))
        #expect(Ouo.sessionId == nil)
        Ouo.addEvent("x")
        Ouo.log(.info, "m")
        Ouo.trackScreen("Home")
        Ouo.captureError(URLError(.badURL))
        let span = Ouo.startSpan("s")
        span.end()
        let v = Ouo.withSpan("w") { _ in 42 }
        #expect(v == 42)
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in Ouo.flush { c.resume() } }
    }
}
