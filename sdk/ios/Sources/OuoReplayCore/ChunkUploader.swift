import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// What the receiver answered. An integer literal is a status without `Retry-After`.
public struct ChunkResponse: Equatable, ExpressibleByIntegerLiteral {
    public var status: Int
    /// `Retry-After` in seconds (the receiver sends whole seconds with 429 and 503).
    public var retryAfter: TimeInterval?

    public init(status: Int, retryAfter: TimeInterval? = nil) {
        self.status = status
        self.retryAfter = retryAfter
    }

    public init(integerLiteral status: Int) {
        self.init(status: status)
    }
}

/// Abstracts the HTTP send so tests can capture requests without a server.
public protocol ChunkTransport: AnyObject {
    /// Completes with the answer, or an error for transport failures.
    func send(_ request: URLRequest, completion: @escaping (Result<ChunkResponse, Swift.Error>) -> Void)
}

public final class URLSessionTransport: ChunkTransport {
    private let session: URLSession

    public init(session: URLSession = URLSessionTransport.makeSession()) {
        self.session = session
    }

    public static func makeSession() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 15
        config.waitsForConnectivity = false
        return URLSession(configuration: config)
    }

    public func send(_ request: URLRequest, completion: @escaping (Result<ChunkResponse, Swift.Error>) -> Void) {
        let task = session.dataTask(with: request) { _, response, error in
            if let error { completion(.failure(error)); return }
            let http = response as? HTTPURLResponse
            completion(.success(ChunkResponse(status: http?.statusCode ?? 0, retryAfter: http?.value(forHTTPHeaderField: "Retry-After").flatMap(TimeInterval.init))))
        }
        task.resume()
    }
}

/// Serialises chunks to gzip JSON and POSTs them to `${endpoint}/v1/replay/chunks` (the
/// collector's `ouoreplay` receiver) in order, with the headers the browser uploader sends plus
/// the project credential as HTTP Basic (ADR-0007).
///
/// The queue is a folder (docs/specs/mobile-replay.md, "Delivery"): each chunk is written there as
/// the gzip body it is sent with before anything is sent, and removed on a 2xx or a rejection
/// (any other status but 408, 429 and 5xx). Those and network errors leave it in place and retry
/// after a backoff (at least `Retry-After`),
/// on the next chunk, on `drain` and in the next process, so an outage or a kill mid-upload loses
/// nothing. Bounded like the spool: `maxQueueBytes` (oldest dropped first) and `ChunkSpool.maxAge`.
///
/// With `hold`, chunks go to `held/` instead and wait for `release(sessionId:keep:)`: the host
/// decides at the next launch whether a finished session's replay is sent (the keep/drop hook).
///
/// One uploader per folder per process: two would send the same files.
public final class ChunkUploader {
    public static let chunksPath = "/v1/replay/chunks"
    /// Header that carries the project credential on every ingest request (ADR-0007 section 2).
    public static let authorizationHeader = "Authorization"

    /// `Basic base64("<projectId>:<projectToken>")`: the value the collector's `basicauth`
    /// extension validates against its htpasswd file (user name = project id, password = token).
    public static func basicAuthorization(projectId: String, projectToken: String) -> String {
        "Basic " + Data("\(projectId):\(projectToken)".utf8).base64EncodedString()
    }

    /// Default folder: `Library/Application Support/ouo/replay/outbox`, next to the spool.
    public static var defaultDirectory: URL {
        ChunkSpool.defaultURL.deletingLastPathComponent().appendingPathComponent("outbox", isDirectory: true)
    }

    public struct Config: Sendable {
        /// Bytes kept on disk, per folder (queued, held); the oldest chunks are dropped beyond it.
        public var maxQueueBytes: Int
        /// A chunk queued longer ago than this is dropped unsent.
        public var maxAge: TimeInterval
        /// Wait before retrying after the nth failure in a row. Injected so tests do not wait.
        public var retryDelay: @Sendable (Int) -> TimeInterval
        /// Keep chunks in `held/` until `release(sessionId:keep:)`.
        public var hold: Bool

        public init(
            maxQueueBytes: Int = 10 * 1024 * 1024,
            maxAge: TimeInterval = ChunkSpool.maxAge,
            retryDelay: @escaping @Sendable (Int) -> TimeInterval = { n in min(pow(2, Double(n - 1)), 60) },
            hold: Bool = false
        ) {
            self.maxQueueBytes = maxQueueBytes
            self.maxAge = maxAge
            self.retryDelay = retryDelay
            self.hold = hold
        }
    }

    public enum UploadError: Swift.Error, Equatable {
        case httpStatus(Int)
    }

    /// A finished session's held chunks, for the keep/drop decision.
    public struct HeldSession: Equatable {
        public let sessionId: String
        public let chunks: Int
        public let bytes: Int
        /// When its first and last chunk were queued (epoch ms).
        public let firstAt: EpochMillis
        public let lastAt: EpochMillis
    }

    /// One file: `<queued at, 13 digits>-<counter>.<session id>.<seq>.json.gz`, so the name sorts
    /// in queue order and carries the request headers.
    struct Entry {
        let url: URL
        let sessionId: String
        let seq: Int
        let queuedAt: EpochMillis
        let bytes: Int

        init?(url: URL) {
            let parts = url.lastPathComponent.components(separatedBy: ".")
            guard parts.count >= 5, parts.suffix(2) == ["json", "gz"],
                  let at = Int64(parts[0].prefix(while: { $0 != "-" })),
                  let seq = Int(parts[parts.count - 3]) else { return nil }
            self.url = url
            self.sessionId = parts[1..<(parts.count - 3)].joined(separator: ".")
            self.seq = seq
            self.queuedAt = at
            self.bytes = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        }
    }

    public let url: URL
    public let projectId: String
    public let projectToken: String
    /// The `Authorization` header value sent on every request, built once from the credential.
    public let authorization: String
    public let config: Config
    public let directory: URL
    private let heldDirectory: URL
    private let transport: ChunkTransport
    private let logger: ReplayLogger
    private let now: () -> EpochMillis
    private let queue = DispatchQueue(label: "dev.ouo.replay.uploader")
    private var counter = 0
    /// The file being sent; nil when idle.
    private var inFlight: URL?
    private var failures = 0
    private var retryScheduled = false
    private var drainWaiters: [() -> Void] = []

    /// Counters for tests and debugging: sent, dropped (bound, age, disk), rejected by the server.
    public private(set) var uploaded = 0
    public private(set) var dropped = 0
    public private(set) var failed = 0

    public init(
        endpoint: URL,
        projectId: String,
        projectToken: String,
        directory: URL = ChunkUploader.defaultDirectory,
        config: Config = Config(),
        transport: ChunkTransport = URLSessionTransport(),
        logger: ReplayLogger = ReplayLogger(enabled: false),
        now: @escaping () -> EpochMillis = { Clock.nowMillis() }
    ) {
        var base = endpoint.absoluteString
        while base.hasSuffix("/") { base.removeLast() }
        self.url = URL(string: base + ChunkUploader.chunksPath) ?? endpoint
        self.projectId = projectId
        self.projectToken = projectToken
        self.authorization = ChunkUploader.basicAuthorization(projectId: projectId, projectToken: projectToken)
        self.config = config
        self.directory = directory
        self.heldDirectory = directory.appendingPathComponent("held", isDirectory: true)
        self.transport = transport
        self.logger = logger
        self.now = now
    }

    public static func makeRequest(url: URL, authorization: String, sessionId: String, seq: Int, gzipBody: Data) -> URLRequest {
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue(authorization, forHTTPHeaderField: ChunkUploader.authorizationHeader)
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.setValue("gzip", forHTTPHeaderField: "content-encoding")
        request.setValue(sessionId, forHTTPHeaderField: "x-ouo-session-id")
        request.setValue(String(seq), forHTTPHeaderField: "x-ouo-seq")
        request.httpBody = gzipBody
        return request
    }

    /// Encodes, compresses and writes the chunk to the queue folder before returning (the spool
    /// was cleared when it was cut), then starts sending. Safe from any thread.
    public func enqueue(_ chunk: FrameChunk) {
        let body: Data
        do {
            body = try Gzip.compress(try chunk.encodedJSON())
        } catch {
            logger.warn("could not encode chunk seq=\(chunk.seq): \(error)")
            return
        }
        queue.sync {
            let folder = config.hold ? heldDirectory : directory
            counter += 1
            let name = "\(Self.pad(now(), 13))-\(Self.pad(Int64(counter), 6)).\(chunk.sessionId).\(chunk.seq).json.gz"
            do {
                try Self.prepare(folder)
                try body.write(to: folder.appendingPathComponent(name), options: .atomic)
            } catch {
                // Disk full or not writable: one attempt from memory rather than nothing, unless the
                // chunk is held (its session's keep/drop decision has not been made).
                guard !config.hold else {
                    dropped += 1
                    logger.warn("could not hold chunk seq=\(chunk.seq) on disk (\(error)); dropped")
                    return
                }
                logger.warn("could not queue chunk seq=\(chunk.seq) on disk (\(error)); sending once from memory")
                let request = ChunkUploader.makeRequest(url: url, authorization: authorization, sessionId: chunk.sessionId, seq: chunk.seq, gzipBody: body)
                transport.send(request) { _ in }
                return
            }
            enforceBound(folder)
            logger.log("\(config.hold ? "held" : "queued") session=\(chunk.sessionId) seq=\(chunk.seq) \(chunk.frames.count) frames \(chunk.touches.count) touches \(body.count) bytes gzip")
        }
        queue.async { self.pump() }
    }

    /// Tries to send what is queued (this process's chunks and those an earlier one left) and
    /// calls `completion` once the folder is empty or its oldest chunk failed again (it stays
    /// on disk for the next try).
    public func drain(completion: @escaping () -> Void) {
        queue.async {
            self.drainWaiters.append(completion)
            self.pump()
        }
    }

    /// Chunks in the queue folder (not held).
    public var queuedCount: Int {
        queue.sync { entries(in: directory).count }
    }

    /// Sessions with held chunks, oldest first; expired chunks are removed here.
    public func heldSessions() -> [HeldSession] {
        queue.sync {
            var order: [String] = []
            var groups: [String: [Entry]] = [:]
            for e in liveEntries(in: heldDirectory) {
                if groups[e.sessionId] == nil { order.append(e.sessionId) }
                groups[e.sessionId, default: []].append(e)
            }
            return order.map { id in
                let es = groups[id]!
                return HeldSession(sessionId: id, chunks: es.count, bytes: es.reduce(0) { $0 + $1.bytes }, firstAt: es.first!.queuedAt, lastAt: es.last!.queuedAt)
            }
        }
    }

    /// Sends (`keep`) or deletes a held session's chunks.
    public func release(sessionId: String, keep: Bool) {
        queue.async {
            let es = self.entries(in: self.heldDirectory).filter { $0.sessionId == sessionId }
            for e in es {
                if keep {
                    try? Self.prepare(self.directory)
                    try? FileManager.default.moveItem(at: e.url, to: self.directory.appendingPathComponent(e.url.lastPathComponent))
                } else {
                    try? FileManager.default.removeItem(at: e.url)
                }
            }
            self.logger.log("\(keep ? "kept" : "dropped") \(es.count) held chunks of session=\(sessionId)")
            if keep {
                self.enforceBound(self.directory)
                self.pump()
            }
        }
    }

    // MARK: - internals (on `queue`)

    private static func pad(_ n: Int64, _ width: Int) -> String {
        let s = String(n)
        return String(repeating: "0", count: max(0, width - s.count)) + s
    }

    /// Creates the folder, excluded from device backups.
    private static func prepare(_ folder: URL) throws {
        var dir = folder
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? dir.setResourceValues(values)
    }

    /// The folder's chunks in queue order.
    private func entries(in folder: URL) -> [Entry] {
        let urls = (try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: [.fileSizeKey])) ?? []
        return urls.compactMap(Entry.init(url:)).sorted { $0.url.lastPathComponent < $1.url.lastPathComponent }
    }

    /// `entries(in:)` without, and after deleting, the chunks older than `maxAge`.
    private func liveEntries(in folder: URL) -> [Entry] {
        let cutoff = now() - EpochMillis(config.maxAge * 1000)
        return entries(in: folder).filter { e in
            guard e.queuedAt < cutoff else { return true }
            drop(e, why: "older than \(Int(config.maxAge / 3600)) h")
            return false
        }
    }

    private func enforceBound(_ folder: URL) {
        let es = entries(in: folder)
        var total = es.reduce(0) { $0 + $1.bytes }
        // Oldest first; never the newest, nor the one in flight (its answer removes it).
        for victim in es.dropLast() where total > config.maxQueueBytes && victim.url != inFlight {
            total -= victim.bytes
            drop(victim, why: "queue bound")
        }
    }

    private func drop(_ e: Entry, why: String) {
        try? FileManager.default.removeItem(at: e.url)
        dropped += 1
        logger.warn("dropped chunk session=\(e.sessionId) seq=\(e.seq) (\(why))")
    }

    private func pump() {
        guard inFlight == nil else { return }
        guard let head = liveEntries(in: directory).first else {
            failures = 0
            finishWaiters()
            return
        }
        guard let body = try? Data(contentsOf: head.url) else {
            drop(head, why: "unreadable")
            pump()
            return
        }
        inFlight = head.url
        let request = ChunkUploader.makeRequest(url: url, authorization: authorization, sessionId: head.sessionId, seq: head.seq, gzipBody: body)
        transport.send(request) { result in
            self.queue.async { self.finish(head, result) }
        }
    }

    private func finish(_ head: Entry, _ result: Result<ChunkResponse, Swift.Error>) {
        inFlight = nil
        switch result.map(\.status) {
        case .success(let status) where (200..<300).contains(status):
            try? FileManager.default.removeItem(at: head.url)
            uploaded += 1
            failures = 0
            logger.log("uploaded session=\(head.sessionId) seq=\(head.seq)")
            pump()
        case .success(let status) where status == 408 || status == 429 || status >= 500:
            retryLater(head, UploadError.httpStatus(status), retryAfter: (try? result.get())?.retryAfter)
        case .success(let status):
            try? FileManager.default.removeItem(at: head.url)
            failed += 1
            logger.warn("chunk session=\(head.sessionId) seq=\(head.seq) rejected: HTTP \(status)")
            pump()
        case .failure(let error):
            retryLater(head, error, retryAfter: nil)
        }
    }

    /// The head stays on disk; the next chunk, `drain`, the next process or this timer retries it.
    private func retryLater(_ head: Entry, _ error: Swift.Error, retryAfter: TimeInterval?) {
        failures += 1
        let delay = max(config.retryDelay(failures), retryAfter ?? 0)
        logger.warn("upload of seq=\(head.seq) failed (\(error)), kept on disk, retry in \(delay) s")
        finishWaiters()
        guard !retryScheduled else { return }
        retryScheduled = true
        queue.asyncAfter(deadline: .now() + delay) {
            self.retryScheduled = false
            self.pump()
        }
    }

    private func finishWaiters() {
        let waiters = drainWaiters
        drainWaiters = []
        waiters.forEach { $0() }
    }
}
