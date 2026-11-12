import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// A folder of requests waiting for the collector (mobile SDK spec C11): each body is a file written
/// before anything is sent and removed when the collector answers. Network errors and OTLP/HTTP's
/// retryable answers (429, 502, 503, 504: `retryable`) leave it in place and retry after a backoff
/// (at least `Retry-After`), on `drain` and in the next process, so an outage, a crash or a kill
/// mid-request loses nothing; what arrived just before a kill is sent again (at least once). Any
/// other answer is final: 2xx is sent, the rest is rejected (removed and counted), so a request the
/// collector answers 500 to every time costs one attempt instead of blocking the queue behind it
/// (checklist N55). Sent oldest first, one request at a time. Bounded by bytes and entries, the
/// oldest dropped first, never the one in flight nor the newest.
///
/// No age bound: an age needs a clock that both survives a reboot and cannot be moved, and a phone
/// has none (the wall clock is the user's to set, a monotonic one restarts at boot). An age on the
/// wall clock dropped everything queued when the clock moved a day forward (checklist N77). The
/// bounds already cap the disk; what is too old to ingest is the backend's call.
///
/// The replay chunk queue (`ChunkUploader`) and the OTLP outbox of `OuoSDK` are two of these. A
/// queue without a transport only holds (the replay chunks a host decides on at the next launch).
///
/// Files are `<stamp, 13 digits>-<counter, 6 digits>.<tag>`, so names sort in queue order and the
/// tag carries what the request needs (the signal, a session and seq). The stamp is the wall clock
/// when queued, raised above the newest name in the folder when the clock moved back, so the order
/// within a folder is the order of `put` whatever the clock does (an entry `move`d in keeps its
/// name, so its place). The stamp alone orders the names; the counter stays for the format of the
/// files already on devices. One queue per folder per process: two would send the same files.
public final class DiskQueue {
    public struct Config: Sendable {
        /// Bytes kept on disk (file sizes); the oldest entries are dropped beyond it.
        public var maxBytes: Int
        /// Entries kept on disk; the oldest are dropped beyond it.
        public var maxEntries: Int
        /// Wait before retrying after the nth failure in a row. Injected so tests do not wait.
        public var retryDelay: @Sendable (Int) -> TimeInterval
        /// Nil (the default): a retry waits the longer of `retryDelay` and `Retry-After`. Set
        /// (spec TRN-8, the OTLP replay queue): a 429 or 503 that carries `Retry-After` waits
        /// exactly that, capped at this many seconds; everything else waits `retryDelay`.
        public var retryAfterCap: TimeInterval?
        /// With `retryAfterCap`: no `Retry-After` waits less than this, so `Retry-After: 0` from a
        /// misbehaving proxy cannot drive back-to-back requests (a tenth of the 1 s initial backoff,
        /// the floor `ReplayDelivery.fullJitter` keeps too).
        public var minRetryDelay: TimeInterval = 0.1

        public init(maxBytes: Int, maxEntries: Int = .max, retryDelay: @escaping @Sendable (Int) -> TimeInterval) {
            self.maxBytes = maxBytes
            self.maxEntries = maxEntries
            self.retryDelay = retryDelay
        }

        /// 1 s doubling up to `cap`.
        public static func doubling(upTo cap: TimeInterval) -> @Sendable (Int) -> TimeInterval {
            { n in min(pow(2, Double(max(1, n) - 1)), cap) }
        }
    }

    public struct Entry: Equatable {
        public let url: URL
        /// What follows `<stamp>-<counter>.` in the file name.
        public let tag: String
        /// The name's stamp: when it was queued (epoch ms), unless the clock moved back since an
        /// older entry (then just above that one).
        public let queuedAt: EpochMillis
        public let bytes: Int

        public init?(url: URL) {
            let name = url.lastPathComponent
            guard let dot = name.firstIndex(of: ".") else { return nil }
            let head = name[..<dot].split(separator: "-", omittingEmptySubsequences: false)
            guard head.count == 2, let at = Int64(head[0]), Int(head[1]) != nil else { return nil }
            let tag = String(name[name.index(after: dot)...])
            guard !tag.isEmpty else { return nil }
            self.url = url
            self.tag = tag
            self.queuedAt = at
            self.bytes = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        }
    }

    public let directory: URL
    public let config: Config
    private let transport: ChunkTransport?
    private let request: (Entry, Data) -> URLRequest?
    private let logger: ReplayLogger
    private let now: () -> EpochMillis
    private let queue: DispatchQueue
    private var counter = 0
    /// The file being sent; nil when idle.
    private var inFlight: URL?
    private var failures = 0
    private var retryScheduled = false
    private var drainWaiters: [() -> Void] = []
    private var stats = (sent: 0, dropped: 0, rejected: 0)

    /// How an entry left the queue.
    public enum Outcome {
        /// A 2xx answer (its body may still reject records: the owner reads it).
        case sent(ChunkResponse)
        /// A final status that is not 2xx.
        case rejected(Int)
        /// Removed unsent: the queue's bounds, or a file that could not be read.
        case dropped(String)
    }

    /// Told when an entry leaves the queue. Runs on the queue's own serial queue, so it must not
    /// call back into this queue synchronously. Set it before the first `put`.
    public var onOutcome: ((Entry, Outcome) -> Void)?

    /// `request` builds what is sent for an entry and its body (nil drops the entry: it cannot be
    /// sent). Without `transport` the queue only holds.
    public init(
        directory: URL,
        config: Config,
        transport: ChunkTransport?,
        logger: ReplayLogger = ReplayLogger(enabled: false),
        now: @escaping () -> EpochMillis = { Clock.nowMillis() },
        request: @escaping (Entry, Data) -> URLRequest?
    ) {
        self.directory = directory
        self.config = config
        self.transport = transport
        self.logger = logger
        self.now = now
        self.request = request
        self.queue = DispatchQueue(label: "dev.ouo.disk-queue.\(directory.lastPathComponent)")
    }

    /// OTLP/HTTP's retryable answers: 429, 502, 503 and 504. Any other status is final.
    static func retryable(_ status: Int) -> Bool {
        status == 429 || status == 502 || status == 503 || status == 504
    }

    /// Sent (2xx), dropped (bounds, unreadable, `remove`) and rejected (a final status but 2xx) entries.
    public var sent: Int { queue.sync { stats.sent } }
    public var dropped: Int { queue.sync { stats.dropped } }
    public var rejected: Int { queue.sync { stats.rejected } }

    /// Writes `body` as the newest entry before returning, applies the bounds, then starts sending.
    /// When the disk refuses it (full, not writable, protected before the first unlock) it is sent
    /// once from memory, unless `sendIfRefused` is false (a held replay chunk waits for its
    /// session's decision), and false is returned.
    @discardableResult
    public func put(_ body: Data, tag: String, sendIfRefused: Bool = true) -> Bool {
        let ok: Bool = queue.sync {
            counter += 1
            let before = Self.list(directory)
            let stamp = max(now(), (before.last?.queuedAt ?? 0) + 1)
            let name = "\(Self.pad(stamp, 13))-\(Self.pad(Int64(counter % 1_000_000), 6)).\(tag)"
            let url = directory.appendingPathComponent(name)
            do {
                try Self.prepare(directory)
                try Self.write(body, to: url)
            } catch {
                logger.warn("could not queue \(tag) on disk (\(error))\(sendIfRefused ? ", sending it once from memory" : "")")
                if sendIfRefused, let transport, let entry = Entry(url: url), let req = request(entry, body) {
                    transport.send(req) { _ in }
                }
                return false
            }
            enforceBound(before + [Entry(url: url)].compactMap { $0 })
            return true
        }
        // During a backoff the new entry waits for the retry: an outage is not hammered once per put.
        if ok { queue.async { if !self.retryScheduled { self.pump() } } }
        return ok
    }

    /// Tries to send what is queued (this process's entries and those an earlier one left) and
    /// calls `completion` once the folder is empty or its oldest entry failed again (it stays on
    /// disk for the next try). Without a transport it completes at once.
    public func drain(completion: @escaping () -> Void) {
        queue.async {
            self.drainWaiters.append(completion)
            self.pump()
        }
    }

    /// Entries on disk, oldest first.
    public func entries() -> [Entry] {
        queue.sync { Self.list(directory) }
    }

    public var count: Int { queue.sync { Self.list(directory).count } }

    /// Deletes an entry unsent (a held replay the host decided to drop).
    public func remove(_ e: Entry) {
        queue.sync {
            try? FileManager.default.removeItem(at: e.url)
            stats.dropped += 1
        }
    }

    /// Deletes every entry unsent, in one step on the queue: no send starts between two deletes.
    /// A request already on the wire may still arrive. Returns how many were deleted.
    @discardableResult
    public func removeAll() -> Int {
        queue.sync {
            let es = Self.list(directory)
            for e in es { try? FileManager.default.removeItem(at: e.url) }
            stats.dropped += es.count
            return es.count
        }
    }

    /// Moves an entry into `other` under the same name (it keeps its place in the order), then lets
    /// `other` apply its bounds and send.
    public func move(_ e: Entry, to other: DiskQueue) {
        queue.sync {
            do {
                try Self.prepare(other.directory)
                try FileManager.default.moveItem(at: e.url, to: other.directory.appendingPathComponent(e.url.lastPathComponent))
            } catch {
                logger.warn("could not move \(e.tag): \(error)")
            }
        }
        other.queue.async {
            other.enforceBound()
            other.pump()
        }
    }

    // MARK: - files

    static func pad(_ n: Int64, _ width: Int) -> String {
        let s = String(n)
        return String(repeating: "0", count: max(0, width - s.count)) + s
    }

    /// Creates the folder, excluded from device backups.
    static func prepare(_ folder: URL) throws {
        var dir = folder
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? dir.setResourceValues(values)
    }

    /// Atomic (a kill mid-write leaves the old file or none), and readable after the first unlock
    /// also when the app's default protection is `complete`: a background launch or a flush after
    /// the device locked still reads it.
    public static func write(_ data: Data, to url: URL) throws {
        #if os(iOS) || os(tvOS) || os(visionOS) || os(watchOS)
        try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        #else
        try data.write(to: url, options: .atomic)
        #endif
    }

    /// The folder's entries in queue order.
    static func list(_ folder: URL) -> [Entry] {
        let urls = (try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: [.fileSizeKey])) ?? []
        return urls.compactMap(Entry.init(url:)).sorted { $0.url.lastPathComponent < $1.url.lastPathComponent }
    }

    // MARK: - internals (on `queue`)

    /// `es`: the folder's entries in queue order, when the caller has just listed them.
    private func enforceBound(_ listed: [Entry]? = nil) {
        let es = listed ?? Self.list(directory)
        var total = es.reduce(0) { $0 + $1.bytes }
        var count = es.count
        // Oldest first; never the newest, nor the one in flight (its answer removes it).
        for victim in es.dropLast() where (total > config.maxBytes || count > config.maxEntries) && victim.url != inFlight {
            total -= victim.bytes
            count -= 1
            drop(victim, why: "queue bound")
        }
    }

    private func drop(_ e: Entry, why: String) {
        try? FileManager.default.removeItem(at: e.url)
        stats.dropped += 1
        logger.warn("dropped \(e.tag) (\(why))")
        onOutcome?(e, .dropped(why))
    }

    private func pump() {
        guard let transport else {
            finishWaiters()
            return
        }
        guard inFlight == nil else { return }
        guard let head = Self.list(directory).first else {
            failures = 0
            finishWaiters()
            return
        }
        guard let body = try? Data(contentsOf: head.url), let req = request(head, body) else {
            drop(head, why: "unreadable")
            pump()
            return
        }
        inFlight = head.url
        transport.send(req) { result in
            self.queue.async { self.finish(head, result) }
        }
    }

    private func finish(_ head: Entry, _ result: Result<ChunkResponse, Swift.Error>) {
        inFlight = nil
        switch result.map(\.status) {
        case .success(let status) where (200..<300).contains(status):
            try? FileManager.default.removeItem(at: head.url)
            stats.sent += 1
            failures = 0
            logger.log("sent \(head.tag)")
            if let onOutcome, let response = try? result.get() { onOutcome(head, .sent(response)) }
            pump()
        case .success(let status) where Self.retryable(status):
            retryLater(head, "HTTP \(status)", status: status, retryAfter: (try? result.get())?.retryAfter)
        case .success(let status):
            try? FileManager.default.removeItem(at: head.url)
            stats.rejected += 1
            logger.warn("\(head.tag) rejected: HTTP \(status), dropped (not retryable)")
            onOutcome?(head, .rejected(status))
            pump()
        case .failure(let error):
            retryLater(head, "\(error)", status: nil, retryAfter: nil)
        }
    }

    /// Seconds before the next try after the `failures`th failure in a row. `status` is nil for a
    /// transport failure.
    static func delay(_ config: Config, failures: Int, status: Int?, retryAfter: TimeInterval?) -> TimeInterval {
        guard let cap = config.retryAfterCap else {
            return max(config.retryDelay(failures), retryAfter ?? 0)
        }
        if let retryAfter, retryAfter.isFinite, retryAfter >= 0, status == 429 || status == 503 {
            return max(minRetry(config), min(retryAfter, cap))
        }
        let backoff = config.retryDelay(failures)
        return backoff.isFinite ? min(max(0, backoff), cap) : cap
    }

    private static func minRetry(_ config: Config) -> TimeInterval {
        config.minRetryDelay.isFinite ? max(0, config.minRetryDelay) : 0.1
    }

    /// The head stays on disk; `drain`, the next process or this timer retries it.
    private func retryLater(_ head: Entry, _ why: String, status: Int?, retryAfter: TimeInterval?) {
        failures += 1
        let delay = Self.delay(config, failures: failures, status: status, retryAfter: retryAfter)
        logger.warn("sending \(head.tag) failed (\(why)), kept on disk, retry in \(delay) s")
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
