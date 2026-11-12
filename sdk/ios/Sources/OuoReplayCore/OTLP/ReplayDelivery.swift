import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// The replay queue of the OTLP path (spec 8, 11.4): one `DiskQueue` folder of its own, so a
/// replay backlog cannot delay telemetry (TRN-3). Each record is the final protobuf request body,
/// written to disk before its first send (RPL-15) and sent again byte for byte until the collector
/// answers (TRN-10), one record per request (TRN-5):
///
/// | Answer (TRN-6) | Action |
/// |---|---|
/// | 2xx, no `partial_success.rejected_log_records` | deleted |
/// | 2xx, rejected > 0 | deleted, counted `partialRejected` |
/// | 429, 503 | kept; retried after `Retry-After` capped at 300 s (TRN-8), else after the backoff |
/// | 502, 504, no answer | kept; exponential backoff with full jitter, 1 s to 300 s (TRN-7) |
/// | anything else | deleted, counted `rejectedStatus` |
///
/// Beyond `maxQueueBytes` the oldest records go first: the oldest chunks of the oldest segment,
/// whole (RPL-17). Every chunk lost after it was taken (evicted, rejected) is reported through
/// `onLoss` so its stream is marked partial. One delivery per folder per process.
public final class ReplayDelivery: ReplaySink {
    public struct Config: Sendable {
        public var maxQueueBytes: Int
        public var maxEntries: Int
        /// Wait before the nth retry in a row. Injected so tests do not wait.
        public var retryDelay: @Sendable (Int) -> TimeInterval
        public var retryAfterCap: TimeInterval

        public init(
            maxQueueBytes: Int = 20 * 1024 * 1024,
            maxEntries: Int = 2048,
            retryDelay: @escaping @Sendable (Int) -> TimeInterval = ReplayDelivery.fullJitter(),
            retryAfterCap: TimeInterval = 300
        ) {
            self.maxQueueBytes = maxQueueBytes
            self.maxEntries = maxEntries
            self.retryDelay = retryDelay
            self.retryAfterCap = retryAfterCap
        }
    }

    public struct Stats: Equatable, Sendable {
        /// Durably accepted (TRN-12).
        public var accepted = 0
        public var partialRejected = 0
        public var rejectedStatus = 0
        /// Dropped unsent by the queue's bounds (or unreadable).
        public var evicted = 0
        /// Not stored: the disk refused the write.
        public var refused = 0
    }

    /// Exponential backoff with full jitter (TRN-7): the nth retry waits a random time up to
    /// `initial * 2^(n-1)`, itself capped at `cap`, and never less than `initial`'s tenth so a
    /// failing endpoint is not hammered.
    public static func fullJitter(initial: TimeInterval = 1, cap: TimeInterval = 300, random: @escaping @Sendable () -> Double = { Double.random(in: 0...1) }) -> @Sendable (Int) -> TimeInterval {
        { n in
            let ceiling = min(cap, initial * pow(2, Double(min(max(1, n), 32) - 1)))
            let r = random()
            return max(initial / 10, ceiling * (r.isFinite ? min(max(r, 0), 1) : 1))
        }
    }

    /// Default folder: `Library/Application Support/ouo/replay/outbox-otlp`, beside the legacy outbox.
    public static var defaultDirectory: URL {
        ChunkSpool.defaultURL.deletingLastPathComponent().appendingPathComponent("outbox-otlp", isDirectory: true)
    }

    public let url: URL
    public let directory: URL
    private let queue: DiskQueue
    private let lock = NSLock()
    private var counters = Stats()
    private var lossHandler: ((String) -> Void)?
    private let notify = DispatchQueue(label: "dev.ouo.replay.delivery.notify")

    /// `authorization`: the `Authorization` header value, what the chunk uploader sends
    /// (`ChunkUploader.basicAuthorization`); empty sends none.
    public init(
        logsUrl: URL,
        authorization: String,
        directory: URL = ReplayDelivery.defaultDirectory,
        config: Config = Config(),
        transport: ChunkTransport = URLSessionTransport(),
        logger: ReplayLogger = ReplayLogger(enabled: false),
        now: @escaping () -> EpochMillis = { Clock.nowMillis() }
    ) {
        self.url = logsUrl
        self.directory = directory
        var bounds = DiskQueue.Config(maxBytes: config.maxQueueBytes, maxEntries: config.maxEntries, retryDelay: config.retryDelay)
        bounds.retryAfterCap = config.retryAfterCap
        queue = DiskQueue(directory: directory, config: bounds, transport: transport, logger: logger, now: now) { _, body in
            ReplayDelivery.makeRequest(url: logsUrl, authorization: authorization, body: body)
        }
        queue.onOutcome = { [weak self] entry, outcome in self?.finished(entry, outcome) }
    }

    /// One OTLP/HTTP request: binary protobuf, no `Content-Encoding` (the body inside the record is
    /// already compressed by the format; TRN-1, spec 8.1).
    public static func makeRequest(url: URL, authorization: String, body: Data) -> URLRequest {
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        if !authorization.isEmpty { request.setValue(authorization, forHTTPHeaderField: ChunkUploader.authorizationHeader) }
        request.setValue("application/x-protobuf", forHTTPHeaderField: "Content-Type")
        request.httpBody = body
        return request
    }

    /// Called (on a private queue) with the stream id of every chunk lost after `put` took it.
    public var onLoss: ((String) -> Void)? {
        get { lock.withLock { lossHandler } }
        set { lock.withLock { lossHandler = newValue } }
    }

    public var stats: Stats { lock.withLock { counters } }
    public var queuedCount: Int { queue.count }

    /// Writes the record to the queue folder before returning, then starts sending. False when the
    /// disk refused it: nothing is sent from memory, the caller stops capture (RPL-18).
    public func put(_ request: Data, streamId: String, sequence: Int?) -> Bool {
        let tag = sequence.map { "\(streamId).\($0).chunk.pb" } ?? "\(streamId).ended.pb"
        let ok = queue.put(request, tag: tag, sendIfRefused: false)
        if !ok { lock.withLock { counters.refused += 1 } }
        return ok
    }

    /// Tries to send what is queued (this process's records and those an earlier one left);
    /// `completion` runs once the folder is empty or its oldest record failed again.
    public func drain(completion: @escaping () -> Void) {
        queue.drain(completion: completion)
    }

    /// Deletes every record not yet accepted (consent withdrawn, an app-initiated clear: TRN-13,
    /// not counted as a loss and not reported to the stream). Returns how many were deleted. A
    /// request already on the wire may still arrive.
    @discardableResult
    public func discardPending() -> Int {
        let entries = queue.entries()
        entries.forEach { queue.remove($0) }
        return entries.count
    }

    /// The same for a folder no delivery was made for in this process.
    @discardableResult
    public static func discardPending(in directory: URL) -> Int {
        let urls = (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? []
        var removed = 0
        for url in urls where DiskQueue.Entry(url: url) != nil {
            if (try? FileManager.default.removeItem(at: url)) != nil { removed += 1 }
        }
        return removed
    }

    /// On the disk queue's serial queue: must not call back into it.
    private func finished(_ entry: DiskQueue.Entry, _ outcome: DiskQueue.Outcome) {
        var lost = false
        lock.withLock {
            switch outcome {
            case .sent(let response):
                if ReplayEnvelope.rejectedLogRecords(in: response.body) > 0 {
                    counters.partialRejected += 1
                    lost = true
                } else {
                    counters.accepted += 1
                }
            case .rejected:
                counters.rejectedStatus += 1
                lost = true
            case .dropped:
                counters.evicted += 1
                lost = true
            }
        }
        // `<stream id>.<sequence>.chunk.pb`: only a chunk leaves a hole in its stream.
        let parts = entry.tag.split(separator: ".")
        guard lost, parts.count == 4, parts[2] == "chunk", let handler = onLoss else { return }
        let streamId = String(parts[0])
        notify.async { handler(streamId) }
    }
}
