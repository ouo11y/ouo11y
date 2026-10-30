import Foundation
import Testing
import OuoVitals
@testable import OuoReplayCore
@testable import OuoSDK

func tempDir(_ name: String = "ouo-sdk") -> URL {
    FileManager.default.temporaryDirectory.appendingPathComponent("\(name)-\(UUID().uuidString)", isDirectory: true)
}

/// A clock the test moves.
final class TestClock: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Double
    init(_ start: Double = 1_760_000_000_000) { value = start }
    var now: Double { lock.withLock { value } }
    func advance(_ ms: Double) { lock.withLock { value += ms } }
}

/// Timers and frames the test fires by hand (never synchronously: Core calls them under its lock).
final class Manual: @unchecked Sendable {
    private let lock = NSLock()
    private var timers: [(id: Int, at: Double, block: () -> Void)] = []
    private var frames: [(Double) -> Void] = []
    private var next = 0
    let clock: TestClock
    init(_ clock: TestClock) { self.clock = clock }

    func after(_ ms: Double, _ block: @escaping () -> Void) -> () -> Void {
        let id = lock.withLock { () -> Int in
            next += 1
            timers.append((next, clock.now + ms, block))
            return next
        }
        return { [weak self] in self?.lock.withLock { self?.timers.removeAll { $0.id == id } } }
    }

    func nextFrame(_ cb: @escaping (Double) -> Void) { lock.withLock { frames.append(cb) } }

    /// Draws a frame at the clock's time: every waiting callback gets it.
    func drawFrame() {
        let cbs = lock.withLock { () -> [(Double) -> Void] in defer { frames = [] }; return frames }
        cbs.forEach { $0(clock.now) }
    }

    var pendingFrames: Int { lock.withLock { frames.count } }

    /// Runs the timers due at the clock's time.
    func fireDue() {
        let due = lock.withLock { () -> [() -> Void] in
            let d = timers.filter { $0.at <= clock.now }
            timers.removeAll { $0.at <= clock.now }
            return d.map(\.block)
        }
        due.forEach { $0() }
    }
}

/// One decoded OTLP log record or span.
struct Sent {
    var name: String
    var time: Double
    var body: String
    var severity: Int
    var attrs: [String: Any]
    var traceId: String?
    var spanId: String?
    var parentSpanId: String?
    var kind: Int?
    var statusError: String?

    func s(_ k: String) -> String? { attrs[k] as? String }
    func i(_ k: String) -> Int64? { attrs[k] as? Int64 }
    func b(_ k: String) -> Bool? { attrs[k] as? Bool }
}

/// Answers every request (202 unless scripted), keeps the decoded records, and the raw requests.
final class Sink: ChunkTransport, @unchecked Sendable {
    private let lock = NSLock()
    private(set) var requests: [URLRequest] = []
    var responses: [Result<ChunkResponse, Error>] = []

    func send(_ request: URLRequest, completion: @escaping (Result<ChunkResponse, Error>) -> Void) {
        let r: Result<ChunkResponse, Error> = lock.withLock {
            requests.append(request)
            return responses.isEmpty ? .success(202) : responses.removeFirst()
        }
        DispatchQueue.global().async { completion(r) }
    }

    var count: Int { lock.withLock { requests.count } }

    /// Log records of the requests answered 2xx so far... and of every request (duplicates included).
    var logs: [Sent] { decoded("resourceLogs", "scopeLogs", "logRecords") }
    var spans: [Sent] { decoded("resourceSpans", "scopeSpans", "spans") }
    func events(_ name: String) -> [Sent] { logs.filter { $0.name == name } }

    var resources: [[String: Any]] {
        bodies().flatMap { ($0["resourceLogs"] as? [[String: Any]] ?? []) + ($0["resourceSpans"] as? [[String: Any]] ?? []) }
            .map { attrs(($0["resource"] as? [String: Any])?["attributes"]) }
    }

    private func bodies() -> [[String: Any]] {
        lock.withLock { requests }.compactMap { r in
            guard let body = r.httpBody else { return nil }
            let json = r.value(forHTTPHeaderField: "content-encoding") == "gzip" ? (try? Gzip.decompress(body)) : body
            return json.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
        }
    }

    private func decoded(_ a: String, _ b: String, _ c: String) -> [Sent] {
        var out: [Sent] = []
        for body in bodies() {
            for rl in body[a] as? [[String: Any]] ?? [] {
                for sl in rl[b] as? [[String: Any]] ?? [] {
                    for r in sl[c] as? [[String: Any]] ?? [] {
                        let attrs = attrs(r["attributes"])
                        let time = Double((r["timeUnixNano"] ?? r["startTimeUnixNano"]) as? String ?? "0") ?? 0
                        out.append(Sent(
                            name: (attrs["event.name"] as? String) ?? (r["name"] as? String) ?? "",
                            time: time / 1_000_000,
                            body: ((r["body"] as? [String: Any])?["stringValue"] as? String) ?? "",
                            severity: r["severityNumber"] as? Int ?? 0,
                            attrs: attrs,
                            traceId: r["traceId"] as? String,
                            spanId: r["spanId"] as? String,
                            parentSpanId: r["parentSpanId"] as? String,
                            kind: r["kind"] as? Int,
                            statusError: (r["status"] as? [String: Any])?["message"] as? String
                        ))
                    }
                }
            }
        }
        return out.sorted { $0.time < $1.time }
    }

    private func attrs(_ raw: Any?) -> [String: Any] {
        var out: [String: Any] = [:]
        for kv in raw as? [[String: Any]] ?? [] {
            guard let k = kv["key"] as? String, let v = kv["value"] as? [String: Any] else { continue }
            if let s = v["stringValue"] as? String { out[k] = s }
            else if let i = v["intValue"] as? String { out[k] = Int64(i) }
            else if let b = v["boolValue"] as? Bool { out[k] = b }
            else if let d = v["doubleValue"] as? Double { out[k] = d }
        }
        return out
    }
}

/// A Core on a temp folder with a test clock, manual timers and frames, and a sink.
struct Harness {
    let dir: URL
    let clock: TestClock
    let manual: Manual
    let sink: Sink
    var sessions: [String] = []

    init(dir: URL = tempDir(), clock: TestClock = TestClock(), sink: Sink = Sink()) {
        self.dir = dir
        self.clock = clock
        self.manual = Manual(clock)
        self.sink = sink
    }

    func core(_ configure: (OuoConfig) -> Void = { _ in }, frames: @escaping () -> FrameStats? = { nil }, sessionChanged: @escaping (SessionRecord) -> Void = { _ in }) -> Core {
        let config = OuoConfig(endpoint: URL(string: "http://localhost:4318")!, projectId: "demo", projectToken: "pt_test", serviceName: "native-test")
        config.serviceVersion = "1.0.0"
        configure(config)
        var hooks = Core.Hooks()
        hooks.now = { [clock] in clock.now }
        hooks.transport = sink
        hooks.after = { [manual] ms, block in manual.after(ms, block) }
        hooks.nextFrame = { [manual] cb in manual.nextFrame(cb) }
        hooks.frameStats = frames
        hooks.deviceContext = { ["network.connection.type": "wifi", "ouo.memory.app_bytes": 1000] }
        hooks.sessionChanged = sessionChanged
        return Core(config: config, directory: dir, hooks: hooks)
    }
}

func frameStats(total: Int, slow: Int = 0, frozen: Int = 0, delayMs: Double = 0) -> FrameStats {
    var s = FrameStats()
    s.total = total
    s.slow = slow
    s.frozen = frozen
    s.delayMs = delayMs
    s.expectedFrameMs = 16.7
    return s
}

/// Flushes and waits for the outbox to drain.
func flush(_ core: Core) async {
    await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in core.flush { c.resume() } }
}
