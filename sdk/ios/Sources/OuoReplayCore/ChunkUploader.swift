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
/// The queue is a `DiskQueue` folder (docs/specs/mobile-replay.md, "Delivery"): each chunk is
/// written there as the gzip body it is sent with before anything is sent, and removed on a 2xx or
/// a rejection; an outage or a kill mid-upload loses nothing. Bounded by `maxQueueBytes` (oldest
/// dropped first).
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
        /// Wait before retrying after the nth failure in a row. Injected so tests do not wait.
        public var retryDelay: @Sendable (Int) -> TimeInterval
        /// Keep chunks in `held/` until `release(sessionId:keep:)`.
        public var hold: Bool

        public init(
            maxQueueBytes: Int = 10 * 1024 * 1024,
            retryDelay: @escaping @Sendable (Int) -> TimeInterval = DiskQueue.Config.doubling(upTo: 60),
            hold: Bool = false
        ) {
            self.maxQueueBytes = maxQueueBytes
            self.retryDelay = retryDelay
            self.hold = hold
        }
    }

    /// A finished session's held chunks, for the keep/drop decision.
    public struct HeldSession: Equatable {
        public let sessionId: String
        public let chunks: Int
        public let bytes: Int
        /// When its first and last chunk were queued (epoch ms): the names' stamps
        /// (`DiskQueue.Entry.queuedAt`), so after the clock moved back they can lie ahead of it.
        public let firstAt: EpochMillis
        public let lastAt: EpochMillis
    }

    /// One file: `<stamp, 13 digits>-<counter>.<session id>.<seq>.json.gz`, so the name sorts
    /// in queue order and carries the request headers.
    struct Entry {
        let entry: DiskQueue.Entry
        let sessionId: String
        let seq: Int
        var queuedAt: EpochMillis { entry.queuedAt }

        init?(url: URL) {
            guard let e = DiskQueue.Entry(url: url) else { return nil }
            self.init(e)
        }

        init?(_ e: DiskQueue.Entry) {
            let parts = e.tag.components(separatedBy: ".")
            guard parts.count >= 4, parts.suffix(2) == ["json", "gz"], let seq = Int(parts[parts.count - 3]) else { return nil }
            self.entry = e
            self.sessionId = parts[0..<(parts.count - 3)].joined(separator: ".")
            self.seq = seq
        }
    }

    public let url: URL
    public let projectId: String
    public let projectToken: String
    /// The `Authorization` header value sent on every request, built once from the credential.
    public let authorization: String
    public let config: Config
    public let directory: URL
    private let queued: DiskQueue
    private let held: DiskQueue
    private let logger: ReplayLogger
    private let lock = NSLock()
    private var droppedHere = 0

    /// Chunks sent, dropped (bound, disk, a dropped held session) and rejected by the server.
    public var uploaded: Int { queued.sent }
    public var dropped: Int { queued.dropped + held.dropped + lock.withLock { droppedHere } }
    public var failed: Int { queued.rejected }

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
        let url = URL(string: base + ChunkUploader.chunksPath) ?? endpoint
        let authorization = ChunkUploader.basicAuthorization(projectId: projectId, projectToken: projectToken)
        self.url = url
        self.projectId = projectId
        self.projectToken = projectToken
        self.authorization = authorization
        self.config = config
        self.directory = directory
        self.logger = logger
        let bounds = DiskQueue.Config(maxBytes: config.maxQueueBytes, retryDelay: config.retryDelay)
        self.queued = DiskQueue(directory: directory, config: bounds, transport: transport, logger: logger, now: now) { e, body in
            Entry(e).map { ChunkUploader.makeRequest(url: url, authorization: authorization, sessionId: $0.sessionId, seq: $0.seq, gzipBody: body) }
        }
        self.held = DiskQueue(directory: directory.appendingPathComponent("held", isDirectory: true), config: bounds, transport: nil, logger: logger, now: now) { _, _ in nil }
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
    /// is cleared after this returns), then starts sending. Safe from any thread.
    public func enqueue(_ chunk: FrameChunk) {
        let body: Data
        do {
            body = try Gzip.compress(try chunk.encodedJSON())
        } catch {
            logger.warn("could not encode chunk seq=\(chunk.seq): \(error)")
            return
        }
        // Disk full or not writable: the queue sends it once from memory rather than nothing; a
        // held chunk is dropped instead (its session's keep/drop decision has not been made).
        let tag = "\(chunk.sessionId).\(chunk.seq).json.gz"
        if config.hold {
            guard held.put(body, tag: tag, sendIfRefused: false) else {
                lock.withLock { droppedHere += 1 }
                return
            }
        } else if !queued.put(body, tag: tag) {
            return
        }
        logger.log("\(config.hold ? "held" : "queued") session=\(chunk.sessionId) seq=\(chunk.seq) \(chunk.frames.count) frames \(chunk.touches.count) touches \(body.count) bytes gzip")
    }

    /// Tries to send what is queued (this process's chunks and those an earlier one left) and
    /// calls `completion` once the folder is empty or its oldest chunk failed again (it stays
    /// on disk for the next try).
    public func drain(completion: @escaping () -> Void) {
        queued.drain(completion: completion)
    }

    /// Chunks in the queue folder (not held).
    public var queuedCount: Int { queued.count }

    /// Sessions with held chunks, oldest first.
    public func heldSessions() -> [HeldSession] {
        var order: [String] = []
        var groups: [String: [Entry]] = [:]
        for e in held.entries().compactMap(Entry.init) {
            if groups[e.sessionId] == nil { order.append(e.sessionId) }
            groups[e.sessionId, default: []].append(e)
        }
        return order.map { id in
            let es = groups[id]!
            return HeldSession(sessionId: id, chunks: es.count, bytes: es.reduce(0) { $0 + $1.entry.bytes }, firstAt: es.first!.queuedAt, lastAt: es.last!.queuedAt)
        }
    }

    /// Sends (`keep`) or deletes a held session's chunks.
    public func release(sessionId: String, keep: Bool) {
        let es = held.entries().compactMap(Entry.init).filter { $0.sessionId == sessionId }
        for e in es {
            if keep { held.move(e.entry, to: queued) } else { held.remove(e.entry) }
        }
        logger.log("\(keep ? "kept" : "dropped") \(es.count) held chunks of session=\(sessionId)")
    }
}
