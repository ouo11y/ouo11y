import Foundation
import OuoReplayCore

/// OTLP/HTTP JSON delivery for logs and traces (mobile SDK spec C11, ADR-0016): records are batched
/// in memory for at most a second (or 64 of a kind), then each batch is written to the outbox, a
/// `DiskQueue` folder, before it is sent gzip with the project credential. The outbox keeps what the
/// collector has not accepted across outages, kills and launches: 5 MB of uncompressed JSON, 500
/// requests, 24 h, the oldest dropped first; retried after 1 s doubling to 30 s (at least
/// `Retry-After`), on foreground, on `flush` and on the next launch. Delivery is at least once.
///
/// What is lost: the records of the last second before a crash or a kill (not yet in a batch).
final class Exporter {
    static let maxBatch = 64
    static let batchDelay: TimeInterval = 1
    /// Records kept in memory waiting for a batch; beyond it the oldest are dropped.
    static let maxPendingLogs = 2048
    static let maxPendingSpans = 1024
    static let outbox = DiskQueue.Config(maxBytes: 5 * 1024 * 1024, maxEntries: 500, maxAge: 24 * 3600, retryDelay: DiskQueue.Config.doubling(upTo: 30))

    let logsURL: URL
    let tracesURL: URL
    let queue: DiskQueue
    private let resource: Attributes
    private let transport: ChunkTransport
    private let headers: [String: String]
    private let log: Log
    private let lock = NSLock()
    private var logs: [LogRecord] = []
    private var spans: [SpanRecord] = []
    private var scheduled = false
    private let timerQueue = DispatchQueue(label: "dev.ouo.export", qos: .utility)

    init(endpoint: URL, authorization: String, directory: URL, resource: Attributes, transport: ChunkTransport, log: Log,
         config: DiskQueue.Config = Exporter.outbox, now: @escaping () -> EpochMillis = { Clock.nowMillis() }) {
        let base = Exporter.trim(endpoint)
        let logsURL = URL(string: base + "/v1/logs")!
        let tracesURL = URL(string: base + "/v1/traces")!
        let headers = ["Authorization": authorization, "content-type": "application/json"]
        self.logsURL = logsURL
        self.tracesURL = tracesURL
        self.resource = resource
        self.transport = transport
        self.headers = headers
        self.log = log
        self.queue = DiskQueue(directory: directory, config: config, transport: transport, logger: ReplayLogger(enabled: log.enabled), now: now) { entry, body in
            switch entry.tag {
            case "logs.json": return Exporter.request(logsURL, headers, body)
            case "traces.json": return Exporter.request(tracesURL, headers, body)
            default: return nil
            }
        }
    }

    static func trim(_ url: URL) -> String {
        var s = url.absoluteString
        while s.hasSuffix("/") { s.removeLast() }
        return s
    }

    /// POST with `content-encoding: gzip` (the stored body is the JSON; it is compressed when sent).
    static func request(_ url: URL, _ headers: [String: String], _ json: Data) -> URLRequest {
        var r = URLRequest(url: url)
        r.httpMethod = "POST"
        for (k, v) in headers { r.setValue(v, forHTTPHeaderField: k) }
        if let gz = try? Gzip.compress(json) {
            r.setValue("gzip", forHTTPHeaderField: "content-encoding")
            r.httpBody = gz
        } else {
            r.httpBody = json
        }
        return r
    }

    func add(_ record: LogRecord) {
        let full: Bool = lock.withLock {
            logs.append(record)
            if logs.count > Self.maxPendingLogs { logs.removeFirst(logs.count - Self.maxPendingLogs) }
            return logs.count >= Self.maxBatch
        }
        schedule(now: full)
    }

    func add(_ span: SpanRecord) {
        let full: Bool = lock.withLock {
            spans.append(span)
            if spans.count > Self.maxPendingSpans { spans.removeFirst(spans.count - Self.maxPendingSpans) }
            return spans.count >= Self.maxBatch
        }
        schedule(now: full)
    }

    /// Writes every pending record to the outbox before returning (background, `flush`).
    func flush() {
        let (l, s): ([LogRecord], [SpanRecord]) = lock.withLock {
            defer { logs = []; spans = [] }
            return (logs, spans)
        }
        for batch in stride(from: 0, to: l.count, by: Self.maxBatch).map({ Array(l[$0..<min($0 + Self.maxBatch, l.count)]) }) {
            put(OTLP.logsBody(batch, resource: resource), tag: "logs.json", url: logsURL)
        }
        for batch in stride(from: 0, to: s.count, by: Self.maxBatch).map({ Array(s[$0..<min($0 + Self.maxBatch, s.count)]) }) {
            put(OTLP.tracesBody(batch, resource: resource), tag: "traces.json", url: tracesURL)
        }
    }

    /// Sends what the outbox holds; `completion` once it is empty or its oldest request failed again.
    func drain(completion: @escaping () -> Void = {}) {
        queue.drain(completion: completion)
    }

    private func put(_ body: Data, tag: String, url: URL) {
        guard !queue.put(body, tag: tag) else { return }
        // The disk refused it (full, or protected before the first unlock): one attempt from memory.
        log.warn("could not store \(tag) on disk; sending it once from memory")
        transport.send(Self.request(url, headers, body)) { _ in }
    }

    private func schedule(now: Bool) {
        let go: Bool = lock.withLock {
            if scheduled && !now { return false }
            scheduled = true
            return true
        }
        guard go else { return }
        timerQueue.asyncAfter(deadline: .now() + (now ? 0 : Self.batchDelay)) {
            self.lock.withLock { self.scheduled = false }
            self.flush()
        }
    }
}
