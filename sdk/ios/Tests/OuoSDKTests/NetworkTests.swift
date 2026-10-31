import Foundation
import Testing
@testable import OuoSDK

/// Answers by path: `/ok` 200, `/fail` 503, `/down` a connection error, anything else 404; keeps
/// the requests it saw (what the server would receive).
final class StubProtocol: URLProtocol {
    nonisolated(unsafe) static var seen: [URLRequest] = []
    static let lock = NSLock()

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.lock.withLock { Self.seen.append(request) }
        let path = request.url?.path ?? ""
        if path == "/down" {
            client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost))
            return
        }
        let status = path == "/ok" ? 200 : path == "/fail" ? 503 : 404
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data("ok".utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    static func header(_ name: String, url: String) -> String? {
        lock.withLock { seen.last { $0.url?.absoluteString == url }?.value(forHTTPHeaderField: name) }
    }
}

/// C5 through a real URLSession: the swizzled `resume`, the headers the server receives, the span
/// and events. Serialized: the hook is process-wide.
@Suite(.serialized) struct NetworkTests {
    private func session() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubProtocol.self]
        return URLSession(configuration: config)
    }

    private func run(_ s: URLSession, _ url: String, headers: [String: String] = [:]) async {
        var r = URLRequest(url: URL(string: url)!)
        headers.forEach { r.setValue($1, forHTTPHeaderField: $0) }
        _ = try? await s.data(for: r)
    }

    private func started(_ h: Harness) -> Core {
        let c = h.core {
            $0.propagateTo = ["https://api.example.com"]
            $0.ignoreUrls = ["https://api.example.com/health"]
        }
        c.start(previousReport: nil, background: false, appStart: nil)
        URLSessionHook.install { [weak c] task in c?.taskWillResume(task) }
        return c
    }

    @Test func SpansHeadersAndEvents() async throws {
        let h = Harness()
        let c = started(h)
        defer { URLSessionHook.install(nil) }
        let s = session()
        await run(s, "https://api.example.com/ok", headers: ["baggage": "app=1,session.id=spoofed"])
        await run(s, "https://api.example.com/fail")
        await run(s, "https://api.example.com/down")
        await run(s, "https://other.example.net/ok")
        await run(s, "https://api.example.com/health")
        await run(s, "https://api.example.com.evil.net/ok")
        // The span ends on the session's queue just after the answer: wait for the five.
        for _ in 0..<100 where h.sink.spans.count < 5 {
            await flush(c)
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
        let spans = h.sink.spans
        #expect(spans.count == 5, "the ignored URL has none")
        #expect(spans.allSatisfy { $0.kind == 3 && $0.name == "HTTP GET" && $0.s("session.id") == c.sessionId })

        let ok = try #require(spans.first { $0.s("url.full") == "https://api.example.com/ok" })
        #expect(ok.i("http.response.status_code") == 200)
        #expect(ok.s("server.address") == "api.example.com")
        #expect(ok.i("server.port") == 443)
        #expect(ok.statusError == nil)
        // What the backend received: the client span as parent, the session in the baggage.
        let tp = try #require(StubProtocol.header("traceparent", url: "https://api.example.com/ok"))
        #expect(tp == "00-\(ok.traceId!)-\(ok.spanId!)-01")
        let baggage = try #require(StubProtocol.header("baggage", url: "https://api.example.com/ok"))
        #expect(baggage.contains("app=1"))
        #expect(baggage.contains("session.id=\(c.sessionId)"))
        #expect(!baggage.contains("spoofed"))
        #expect(baggage.contains("ouo.platform=mobile"))

        let fail = try #require(spans.first { $0.s("url.full") == "https://api.example.com/fail" })
        #expect(fail.statusError == "HTTP 503")
        let down = try #require(spans.first { $0.s("url.full") == "https://api.example.com/down" })
        #expect(down.s("error.type")?.hasPrefix("NSURLErrorDomain") == true)

        let failed = h.sink.events("http.request.failed")
        #expect(Set(failed.map { $0.s("url.full")! }) == ["https://api.example.com/fail", "https://api.example.com/down"])
        #expect(failed.allSatisfy { $0.severity == 17 })
        let f503 = try #require(failed.first { $0.i("http.response.status_code") == 503 })
        #expect(f503.traceId == fail.traceId)
        #expect(f503.spanId == fail.spanId)
        let answered = h.sink.events("http.request")
        #expect(Set(answered.map { $0.s("url.full")! }) == ["https://api.example.com/ok", "https://other.example.net/ok", "https://api.example.com.evil.net/ok"])

        // Only the listed origin gets the headers, matched at a boundary.
        #expect(StubProtocol.lock.withLock { StubProtocol.seen.filter { $0.url?.host != "api.example.com" } }.allSatisfy { $0.value(forHTTPHeaderField: "traceparent") == nil })
    }

    /// The SDK's own uploads are never traced, and an app's own `traceparent` is kept.
    @Test func IngestURLsAreNotTracedAndAnExistingTraceparentWins() async {
        let h = Harness()
        let c = started(h)
        defer { URLSessionHook.install(nil) }
        let s = session()
        await run(s, "http://localhost:4318/v1/logs")
        await run(s, "http://localhost:4319/v1/replay/chunks")
        let own = "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01"
        await run(s, "https://api.example.com/ok", headers: ["traceparent": own])
        #expect(StubProtocol.header("traceparent", url: "https://api.example.com/ok") == own)
        for _ in 0..<100 where h.sink.spans.isEmpty {
            await flush(c)
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
        #expect(h.sink.spans.map { $0.s("url.full") } == ["https://api.example.com/ok"])
    }

    /// Inside `withSpan` on the calling thread, the request joins the span's trace.
    @Test func ARequestInsideASpanIsItsChild() async throws {
        let h = Harness()
        let c = started(h)
        defer { URLSessionHook.install(nil) }
        let parent = OuoSpan(core: c, name: "checkout", kind: .internal, attributes: [:], parent: nil, start: h.clock.now)
        OuoSpan.push(parent)
        let task = session().dataTask(with: URL(string: "https://api.example.com/ok")!)
        task.resume()
        OuoSpan.pop(parent)
        parent.end()
        for _ in 0..<100 where h.sink.spans.count < 2 {
            await flush(c)
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
        let child = try #require(h.sink.spans.first { $0.kind == 3 })
        #expect(child.traceId == parent.traceId)
        #expect(child.parentSpanId == parent.spanId)
    }

    @Test func URLPrefixesMatchAtABoundary() {
        let p = ["https://api.example.com", "https://cdn.example.com/v1/"]
        #expect(URLMatch.matches("https://api.example.com", p))
        #expect(URLMatch.matches("https://api.example.com/x?y", p))
        #expect(URLMatch.matches("https://api.example.com?q", p))
        #expect(!URLMatch.matches("https://api.example.com.evil.net/x", p))
        #expect(!URLMatch.matches("https://api.example.com:8443/x", p))
        #expect(URLMatch.matches("https://cdn.example.com/v1/a", p))
        #expect(!URLMatch.matches("https://x", [""]))
    }

    @Test func BaggageIsMergedAndEncoded() {
        let b = Propagation.baggage(existing: " a=1 , session.id=old,,b=2;p", [("session.id", "s 1,%"), ("user.id", "ü")])
        #expect(b == "a=1,b=2;p,session.id=s%201%2C%25,user.id=%C3%BC")
        #expect(Propagation.traceparent(traceId: "t", spanId: "s") == "00-t-s-01")
    }
}
