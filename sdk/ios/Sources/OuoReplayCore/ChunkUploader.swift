import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Abstracts the HTTP send so tests can capture requests without a server.
public protocol ChunkTransport: AnyObject {
    /// Completes with the HTTP status code, or an error for transport failures.
    func send(_ request: URLRequest, completion: @escaping (Result<Int, Swift.Error>) -> Void)
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

    public func send(_ request: URLRequest, completion: @escaping (Result<Int, Swift.Error>) -> Void) {
        let task = session.dataTask(with: request) { _, response, error in
            if let error { completion(.failure(error)); return }
            completion(.success((response as? HTTPURLResponse)?.statusCode ?? 0))
        }
        task.resume()
    }
}

/// Serialises chunks to gzip JSON and POSTs them to `${endpoint}/v1/replay/chunks` in order, with
/// the headers the browser uploader sends. Mirrors `sdk/browser/src/replay/chunker.ts`: retry up
/// to `maxAttempts` with 1 s, 2 s backoff; a bounded queue (`maxQueueBytes`) drops the oldest
/// chunk when the app is offline for long.
public final class ChunkUploader {
    public static let chunksPath = "/v1/replay/chunks"

    public struct Config: Sendable {
        public var maxAttempts: Int
        public var maxQueueBytes: Int
        /// Retry delay for attempt n (1-based). Injected so tests do not wait.
        public var retryDelay: @Sendable (Int) -> TimeInterval

        public init(
            maxAttempts: Int = 3,
            maxQueueBytes: Int = 2 * 1024 * 1024,
            retryDelay: @escaping @Sendable (Int) -> TimeInterval = { attempt in pow(2, Double(attempt - 1)) }
        ) {
            self.maxAttempts = maxAttempts
            self.maxQueueBytes = maxQueueBytes
            self.retryDelay = retryDelay
        }
    }

    public enum UploadError: Swift.Error, Equatable {
        case httpStatus(Int)
    }

    private struct Pending {
        let sessionId: String
        let seq: Int
        let body: Data
        var attempts: Int
    }

    public let url: URL
    public let config: Config
    private let transport: ChunkTransport
    private let logger: ReplayLogger
    private let queue = DispatchQueue(label: "dev.ouo.replay.uploader")
    private var pending: [Pending] = []
    private var queuedBytes = 0
    private var sending = false
    private var drainWaiters: [() -> Void] = []

    /// Counters for tests and debugging.
    public private(set) var uploaded = 0
    public private(set) var dropped = 0
    public private(set) var failed = 0

    public init(endpoint: URL, config: Config = Config(), transport: ChunkTransport = URLSessionTransport(), logger: ReplayLogger = ReplayLogger(enabled: false)) {
        var base = endpoint.absoluteString
        while base.hasSuffix("/") { base.removeLast() }
        self.url = URL(string: base + ChunkUploader.chunksPath) ?? endpoint
        self.config = config
        self.transport = transport
        self.logger = logger
    }

    public static func makeRequest(url: URL, sessionId: String, seq: Int, gzipBody: Data) -> URLRequest {
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.setValue("gzip", forHTTPHeaderField: "content-encoding")
        request.setValue(sessionId, forHTTPHeaderField: "x-ouo-session-id")
        request.setValue(String(seq), forHTTPHeaderField: "x-ouo-seq")
        request.httpBody = gzipBody
        return request
    }

    /// Encodes, compresses and queues the chunk; starts draining if idle. Safe from any thread.
    public func enqueue(_ chunk: FrameChunk) {
        let body: Data
        do {
            body = try Gzip.compress(try chunk.encodedJSON())
        } catch {
            logger.warn("could not encode chunk seq=\(chunk.seq): \(error)")
            return
        }
        queue.async {
            self.pending.append(Pending(sessionId: chunk.sessionId, seq: chunk.seq, body: body, attempts: 0))
            self.queuedBytes += body.count
            self.enforceBound()
            self.logger.log("queued session=\(chunk.sessionId) seq=\(chunk.seq) \(chunk.frames.count) frames \(chunk.touches.count) touches \(body.count) bytes gzip")
            self.drainLocked()
        }
    }

    /// Calls `completion` once every queued chunk was sent, given up on, or dropped.
    public func drain(completion: @escaping () -> Void) {
        queue.async {
            if self.pending.isEmpty && !self.sending {
                completion()
            } else {
                self.drainWaiters.append(completion)
                self.drainLocked()
            }
        }
    }

    public var queuedCount: Int {
        queue.sync { pending.count }
    }

    // MARK: - internals (on `queue`)

    private func enforceBound() {
        while queuedBytes > config.maxQueueBytes, pending.count > 1 {
            let victim = pending.removeFirst()
            queuedBytes -= victim.body.count
            dropped += 1
            logger.warn("dropped queued chunk seq=\(victim.seq) (queue bound)")
        }
    }

    private func drainLocked() {
        guard !sending else { return }
        guard let head = pending.first else {
            let waiters = drainWaiters
            drainWaiters = []
            waiters.forEach { $0() }
            return
        }
        sending = true
        let request = ChunkUploader.makeRequest(url: url, sessionId: head.sessionId, seq: head.seq, gzipBody: head.body)
        transport.send(request) { result in
            self.queue.async { self.finish(head: head, result: result) }
        }
    }

    private func finish(head: Pending, result: Result<Int, Swift.Error>) {
        sending = false
        guard let index = pending.firstIndex(where: { $0.seq == head.seq && $0.sessionId == head.sessionId }) else {
            drainLocked()
            return
        }
        let outcome: Result<Void, Swift.Error>
        switch result {
        case .success(let status) where (200..<300).contains(status):
            outcome = .success(())
        case .success(let status):
            outcome = .failure(UploadError.httpStatus(status))
        case .failure(let error):
            outcome = .failure(error)
        }
        switch outcome {
        case .success:
            pending.remove(at: index)
            queuedBytes -= head.body.count
            uploaded += 1
            logger.log("uploaded seq=\(head.seq)")
            drainLocked()
        case .failure(let error):
            pending[index].attempts += 1
            let attempts = pending[index].attempts
            if attempts >= config.maxAttempts {
                pending.remove(at: index)
                queuedBytes -= head.body.count
                failed += 1
                logger.warn("giving up on seq=\(head.seq) after \(attempts) attempts: \(error)")
                drainLocked()
            } else {
                let delay = config.retryDelay(attempts)
                logger.warn("upload of seq=\(head.seq) failed (\(error)), retry in \(delay) s")
                queue.asyncAfter(deadline: .now() + delay) { self.drainLocked() }
            }
        }
    }
}
