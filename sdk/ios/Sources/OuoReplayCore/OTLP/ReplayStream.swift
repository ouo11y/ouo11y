import Foundation

/// `ouo.replay.mode` (spec 9.1).
public enum ReplayCaptureMode: String, Codable, Sendable {
    /// Every chunk is sent as it closes.
    case session
    /// Chunks wait in a memory ring until `capture(trigger:)`; from then on as `session`.
    case buffer
}

/// `ouo.replay.end_reason` (spec 11.5), without the web-only `pagehide`.
public enum ReplayEndReason: String, Sendable {
    case sessionEnd = "session_end"
    case stop
    case consent
    case backgroundKill = "background_kill"
    case crash
    case maxSize = "max_size"
    case error
}

/// `ouo.replay.trigger` (spec 11.3).
public enum ReplayTrigger: String, Sendable, CaseIterable {
    case error, crash, anr, hang, manual
}

public struct ReplayStreamConfig: Sendable {
    /// RPL-10, RPL-11: no chunk body is larger than this, whatever `chunkMaxBytes` says.
    public static let hardLimitBytes = 1 << 20

    public var mode: ReplayCaptureMode
    /// SMP-10: the ring holds at least this much.
    public var bufferSeconds: Double
    /// RPL-9: a new segment and keyframe at least this often.
    public var keyframeIntervalMs: Int64
    /// RPL-10: a chunk closes when its compressed body reaches this.
    public var chunkMaxBytes: Int
    /// RPL-10: a chunk closes this long after its first event.
    public var chunkMaxMs: Int64
    /// ERR-9: the ring's compressed bytes. Beyond it the oldest whole segments go early.
    public var ringMaxBytes: Int
    /// ERR-9: an event larger than this is refused (the adapter misbehaves).
    public var maxEventBytes: Int
    /// ERR-6: internal errors after which the stream ends with reason `error`.
    public var selfDisableThreshold: Int

    public init(mode: ReplayCaptureMode = .session, bufferSeconds: Double = 60, keyframeIntervalMs: Int64 = 300_000, chunkMaxBytes: Int = 256 * 1024, chunkMaxMs: Int64 = 5000, ringMaxBytes: Int = 16 << 20, maxEventBytes: Int = 8 << 20, selfDisableThreshold: Int = 20) {
        self.mode = mode
        self.bufferSeconds = bufferSeconds.isFinite ? min(max(bufferSeconds, 1), 3600) : 60
        self.keyframeIntervalMs = min(max(keyframeIntervalMs, 1000), 86_400_000)
        self.chunkMaxBytes = min(max(chunkMaxBytes, 1024), Self.hardLimitBytes)
        self.chunkMaxMs = min(max(chunkMaxMs, 100), 600_000)
        self.ringMaxBytes = max(ringMaxBytes, 1 << 16)
        self.maxEventBytes = max(maxEventBytes, 1024)
        self.selfDisableThreshold = max(selfDisableThreshold, 1)
    }

    /// How often a segment starts while the ring buffers: a quarter of the window, so the ring
    /// holds between `bufferSeconds` and five quarters of it.
    var ringSegmentMs: Int64 {
        min(keyframeIntervalMs, max(1000, Int64(bufferSeconds * 250)))
    }
}

/// Where a finished record goes: the replay disk queue (`ReplayDelivery`). `request` is the final
/// protobuf request body; `sequence` is nil for the end record. False: the record could not be
/// stored (RPL-18).
public protocol ReplaySink: AnyObject {
    func put(_ request: Data, streamId: String, sequence: Int?) -> Bool
}

/// What the next launch needs to end a stream a kill left open (RPL-20).
public struct ReplayStreamState: Codable, Equatable, Sendable {
    public var sessionId: String
    public var replayId: String
    public var streamId: String
    /// Highest sequence produced, nil when none.
    public var lastSequence: Int?
    public var partial: Bool
    public var scope: ReplayScope
}

public protocol ReplayStateStore: AnyObject {
    /// False when the state could not be written.
    func save(_ state: ReplayStreamState) -> Bool
    func load() -> ReplayStreamState?
    func clear()
}

/// The open stream in one small JSON file, written atomically.
public final class FileReplayStateStore: ReplayStateStore {
    public let url: URL

    /// Default file: `Library/Application Support/ouo/replay/open-stream.json`.
    public static var defaultURL: URL {
        ChunkSpool.defaultURL.deletingLastPathComponent().appendingPathComponent("open-stream.json")
    }

    public init(url: URL = FileReplayStateStore.defaultURL) {
        self.url = url
    }

    public func save(_ state: ReplayStreamState) -> Bool {
        do {
            try DiskQueue.prepare(url.deletingLastPathComponent())
            try DiskQueue.write(try JSONEncoder().encode(state), to: url)
            return true
        } catch {
            return false
        }
    }

    public func load() -> ReplayStreamState? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        guard let state = try? JSONDecoder().decode(ReplayStreamState.self, from: data) else {
            // Unreadable: nothing can be said about that stream; do not trip over it again.
            clear()
            return nil
        }
        return state
    }

    public func clear() {
        try? FileManager.default.removeItem(at: url)
    }
}

/// Counters of one stream (ERR-7: everything dropped is counted, by reason).
public struct ReplayStreamStats: Equatable, Sendable {
    /// Looks the adapter refused (masking or encoding failed).
    public var framesDropped = 0
    /// Events left out: before the keyframe of a new segment, or malformed.
    public var eventsDropped = 0
    /// Internal errors (ERR-6 counts these).
    public var errors = 0
    /// Chunks given a sequence.
    public var chunks = 0
    /// Chunks cut again because their body passed the hard limit.
    public var splits = 0
    /// Segments the ring let go (never sent, never numbered).
    public var ringEvictedSegments = 0
    /// Records the sink refused.
    public var refused = 0
    /// Chunks of this stream the queue lost after taking them (evicted or rejected).
    public var lost = 0
    /// Open-stream state writes that failed.
    public var stateFailures = 0
}

/// One stream of one replay (spec 11.1): turns the events of a format adapter into numbered
/// chunks, each wrapped in its OTLP request and handed to the sink, and ends with
/// `ouo.replay.ended`. Nothing here depends on the format (RPL-23).
///
/// - **Segments** (RPL-6, RPL-8, RPL-9): a segment starts with a keyframe: at the start, after a
///   gap or a local loss, on the return to the foreground and every `keyframeIntervalMs`. Until
///   the adapter delivers that keyframe, other events are dropped.
/// - **Chunks** (RPL-4, RPL-10, RPL-11): a chunk closes at `chunkMaxBytes` compressed,
///   `chunkMaxMs`, the end of the stream or the background. A body over the hard limit is cut in
///   two, between lines where it can, inside a line where it must: the pieces still concatenate
///   to the same bytes (RPL-7). The sequence rises by one per chunk and never resets.
/// - **Buffer mode** (SMP-10 to SMP-12): until `capture(trigger:)` closed chunks wait unnumbered
///   in a ring of whole segments covering at least `bufferSeconds`; only whole segments leave it.
///   The trigger numbers them from 0 and sends them, and the stream goes on as in session mode.
/// - **Partial** (RPL-17, RPL-18, RPL-21): a chunk the queue lost or refused marks the stream
///   partial and starts a new segment; a refusal also ends the stream (`max_size`).
///
/// Thread-safe: one lock around everything, the adapter included.
public final class ReplayStream {
    public let sessionId: String
    public let replayId: String
    public let streamId: String
    public let config: ReplayStreamConfig

    private let scope: ReplayScope
    private let adapter: ReplayFormatAdapter
    private let sink: ReplaySink
    private let store: ReplayStateStore?
    private let now: () -> EpochMillis
    private let logger: ReplayLogger
    private let lock = NSLock()

    private struct Pending {
        var body: Data
        var start: EpochMillis
        var end: EpochMillis
        var keyframe: Bool
        var viewId: String?
    }

    private struct Open {
        var data = Data()
        var start: EpochMillis
        var end: EpochMillis
        var keyframe: Bool
        var viewId: String?
        /// Uncompressed bytes at which the body is compressed to see how large it is.
        var nextTrialAt: Int
    }

    private struct RingSegment {
        var startedAt: EpochMillis
        var chunks: [Pending] = []
    }

    private var open: Open?
    private var ring: [RingSegment] = []
    private var ringBytes = 0
    private var needSegment = true
    private var segmentStartedAt: EpochMillis = 0
    private var segmentIndex = -1
    private var nextSequence = 0
    private var partial = false
    private var ended = false
    private var triggered = false
    private var trigger: ReplayTrigger?
    private var viewId: String?
    private var counters = ReplayStreamStats()

    /// `replayId`: 32 lowercase hex characters from the caller, or nil (or anything else) for a
    /// fresh one. The stream id is always fresh: one per process lifetime (RPL-5).
    public init(
        sessionId: String,
        replayId: String? = nil,
        scope: ReplayScope,
        config: ReplayStreamConfig = ReplayStreamConfig(),
        adapter: ReplayFormatAdapter,
        sink: ReplaySink,
        store: ReplayStateStore? = nil,
        logger: ReplayLogger = ReplayLogger(enabled: false),
        now: @escaping () -> EpochMillis = { Clock.nowMillis() }
    ) {
        self.sessionId = sessionId
        self.replayId = replayId.flatMap { Self.isValidId($0) ? $0 : nil } ?? Self.randomId()
        self.streamId = Self.randomId()
        self.scope = scope
        self.config = config
        self.adapter = adapter
        self.sink = sink
        self.store = store
        self.logger = logger
        self.now = now
    }

    /// 128 random bits as 32 lowercase hex characters.
    public static func randomId() -> String {
        var generator = SystemRandomNumberGenerator()
        var bytes = Data(count: 16)
        for i in 0..<16 { bytes[i] = UInt8.random(in: 0...255, using: &generator) }
        return ReplayEnvelope.hex(bytes)
    }

    public static func isValidId(_ id: String) -> Bool {
        id.utf8.count == 32 && id.utf8.allSatisfy { ($0 >= 48 && $0 <= 57) || ($0 >= 97 && $0 <= 102) } && id.utf8.contains { $0 != 48 }
    }

    // MARK: state

    /// False once the stream ended (stopped, refused by the store, or disabled by its own errors).
    public var isActive: Bool { lock.withLock { !ended } }
    public var isPartial: Bool { lock.withLock { partial } }
    public var stats: ReplayStreamStats { lock.withLock { counters } }
    /// Chunks waiting in the ring (buffer mode before its trigger).
    public var bufferedChunks: Int { lock.withLock { ring.reduce(0) { $0 + $1.chunks.count } } }
    /// The next sequence: the number of chunks produced so far.
    public var producedChunks: Int { lock.withLock { nextSequence } }

    private var buffering: Bool { config.mode == .buffer && !triggered }

    // MARK: input

    /// One look at the screen. The adapter masks and encodes it; a look it refuses is dropped.
    public func look(_ look: ReplayLook, at t: EpochMillis) {
        lock.withLock {
            guard !ended else { return }
            if needSegment || segmentDue(t) {
                needSegment = true
                adapter.requestKeyframe()
            }
            let events: [ReplayEvent]
            do {
                events = try adapter.events(for: look, at: t)
            } catch {
                counters.framesDropped += 1
                logger.warn("frame dropped: \(error)")
                // A masking failure is the format doing its job (PRV-8), not an SDK error.
                if (error as? ReplayFormatError) != .maskingFailed { noteError() }
                return
            }
            append(events)
        }
    }

    public func touch(_ touch: Touch) {
        lock.withLock {
            guard !ended, let event = adapter.touchEvent(touch) else { return }
            append([event])
        }
    }

    /// Call about once a second: closes a chunk that is old enough and lets the ring go of what
    /// it no longer needs.
    public func tick(now t: EpochMillis) {
        lock.withLock {
            guard !ended else { return }
            closeIfOld(t)
            if buffering { evictRing(now: t) }
        }
    }

    /// Closes the open chunk now (a host flush).
    public func flush() {
        lock.withLock { closeChunk() }
    }

    /// The app left the foreground (or capture paused): the chunk closes and whatever comes next
    /// starts a new segment with a keyframe (RPL-9, RPL-10).
    public func background() {
        lock.withLock {
            closeChunk()
            needSegment = true
        }
    }

    /// Capture lost something (a dropped event, a stall): the next look starts a new segment.
    public func markGap() {
        lock.withLock { needSegment = true }
    }

    /// The queue lost a chunk of `streamId` after taking it (evicted by its bound, rejected by the
    /// collector). Ignored for another stream's chunk.
    public func chunkLost(streamId: String) {
        lock.withLock {
            guard streamId == self.streamId, !ended else { return }
            counters.lost += 1
            partial = true
            needSegment = true
            persist()
        }
    }

    public func setViewId(_ id: String?) {
        lock.withLock { viewId = id.flatMap { $0.isEmpty ? nil : String($0.prefix(256)) } }
    }

    /// Buffer mode: sends the ring and goes on as session mode (SMP-12). Returns the number of
    /// chunks flushed, nil when there was nothing to trigger (session mode, already triggered,
    /// ended).
    @discardableResult
    public func capture(trigger: ReplayTrigger) -> Int? {
        lock.withLock {
            guard !ended, buffering else { return nil }
            closeChunk()
            triggered = true
            self.trigger = trigger
            var flushed = 0
            let segments = ring
            ring = []
            ringBytes = 0
            var lastHadChunks = false
            for segment in segments {
                lastHadChunks = !segment.chunks.isEmpty
                guard lastHadChunks else { continue }
                segmentIndex += 1
                for chunk in segment.chunks where !ended {
                    emit(chunk)
                    flushed += 1
                }
            }
            // The segment in progress goes on; with nothing in it the next look starts one.
            if !lastHadChunks { needSegment = true }
            persist()
            logger.log("buffer triggered (\(trigger.rawValue)): \(flushed) chunks flushed")
            return flushed
        }
    }

    /// Ends the stream: closes the chunk and sends `ouo.replay.ended`. A buffer that was never
    /// triggered sent nothing, so it ends without a record. Later calls do nothing.
    public func end(reason: ReplayEndReason) {
        lock.withLock { finish(reason) }
    }

    /// Ends the stream a kill left open in an earlier process (RPL-20): `ouo.replay.ended` with
    /// `partial`. Call before this process's stream produces a chunk. True when a record was sent.
    @discardableResult
    public static func endOpenStream(store: ReplayStateStore, sink: ReplaySink, reason: ReplayEndReason = .backgroundKill, now: EpochMillis = Clock.nowMillis()) -> Bool {
        guard let state = store.load() else { return false }
        let ended = ReplayEnded(sessionId: state.sessionId, replayId: state.replayId, streamId: state.streamId, endState: "partial", lastSequence: state.lastSequence, endReason: reason.rawValue)
        guard sink.put(ReplayEnvelope.endedRequest(scope: state.scope, ended: ended, time: now), streamId: state.streamId, sequence: nil) else { return false }
        store.clear()
        return true
    }

    // MARK: internals (under `lock`)

    private func segmentDue(_ t: EpochMillis) -> Bool {
        let interval = buffering ? config.ringSegmentMs : config.keyframeIntervalMs
        return t < segmentStartedAt || t - segmentStartedAt >= interval
    }

    private func noteError() {
        counters.errors += 1
        if counters.errors >= config.selfDisableThreshold, !ended {
            logger.warn("replay disabled after \(counters.errors) internal errors")
            finish(.error)
        }
    }

    private func valid(_ event: ReplayEvent) -> Bool {
        let json = event.json
        guard json.count >= 2, json.count <= config.maxEventBytes,
              json.first == UInt8(ascii: "{"), json.last == UInt8(ascii: "}") else { return false }
        return !json.contains(UInt8(ascii: "\n"))
    }

    private func append(_ events: [ReplayEvent]) {
        for event in events {
            guard !ended else { return }
            guard valid(event) else {
                // What the adapter thinks it sent is not in the payload: later events may build on it.
                counters.eventsDropped += 1
                needSegment = true
                adapter.requestKeyframe()
                noteError()
                continue
            }
            if needSegment {
                guard event.keyframe else {
                    counters.eventsDropped += 1
                    continue
                }
                closeChunk()
                guard !ended else { return }
                if buffering {
                    ring.append(RingSegment(startedAt: event.t))
                } else {
                    segmentIndex += 1
                }
                needSegment = false
                segmentStartedAt = event.t
                open = Open(start: event.t, end: event.t, keyframe: true, viewId: viewId, nextTrialAt: config.chunkMaxBytes)
            }
            if open == nil {
                open = Open(start: event.t, end: event.t, keyframe: false, viewId: viewId, nextTrialAt: config.chunkMaxBytes)
            }
            open?.data.append(event.json)
            open?.data.append(UInt8(ascii: "\n"))
            if let end = open?.end, event.t > end { open?.end = event.t }
            closeIfFull()
            closeIfOld(event.t)
        }
    }

    /// The compressed size is only known by compressing: the body is tried when its uncompressed
    /// bytes reach the limit, and again once enough was added that it could have reached it.
    private func closeIfFull() {
        guard let o = open, o.data.count >= o.nextTrialAt else { return }
        do {
            let compressed = try adapter.compress(o.data)
            if compressed.count >= config.chunkMaxBytes {
                closeChunk(compressed: compressed)
            } else {
                open?.nextTrialAt = o.data.count + (config.chunkMaxBytes - compressed.count)
            }
        } catch {
            closeChunk()
        }
    }

    private func closeIfOld(_ t: EpochMillis) {
        guard let o = open else { return }
        if t < o.start || t - o.start >= config.chunkMaxMs { closeChunk() }
    }

    private func closeChunk(compressed: Data? = nil) {
        guard let o = open else { return }
        open = nil
        guard !o.data.isEmpty, !ended else { return }
        let bodies: [Data]
        do {
            bodies = try split(o.data, compressed: compressed)
        } catch {
            // Its events are gone: nothing was numbered, so no hole, but a gap in what was seen.
            logger.warn("chunk dropped, compression failed: \(error)")
            counters.eventsDropped += 1
            needSegment = true
            noteError()
            return
        }
        if bodies.count > 1 { counters.splits += bodies.count - 1 }
        for (i, body) in bodies.enumerated() where !ended {
            let chunk = Pending(body: body, start: o.start, end: o.end, keyframe: o.keyframe && i == 0, viewId: o.viewId)
            if buffering {
                guard !ring.isEmpty else { continue }
                ring[ring.count - 1].chunks.append(chunk)
                ringBytes += body.count
                evictRing(now: o.end)
            } else {
                emit(chunk)
            }
        }
    }

    /// The compressed bodies of `payload`, each within the hard limit (RPL-11). A body over it is
    /// cut in two at the line break nearest its middle, or in the middle of a line when it has
    /// none, and each half is compressed on its own.
    private func split(_ payload: Data, compressed: Data? = nil) throws -> [Data] {
        let body = try compressed ?? adapter.compress(payload)
        guard !body.isEmpty else { throw ReplayFormatError.encodingFailed }
        if body.count <= ReplayStreamConfig.hardLimitBytes || payload.count < 2 { return [body] }
        let bytes = [UInt8](payload)
        let mid = bytes.count / 2
        var cut = mid
        for distance in 0..<mid {
            // A cut after a newline keeps whole lines on both sides.
            if bytes[mid + distance] == UInt8(ascii: "\n"), mid + distance + 1 < bytes.count {
                cut = mid + distance + 1
                break
            }
            if bytes[mid - distance - 1] == UInt8(ascii: "\n"), mid - distance > 0 {
                cut = mid - distance
                break
            }
        }
        return try split(Data(bytes[..<cut])) + split(Data(bytes[cut...]))
    }

    /// Only whole segments leave the ring, and only while what stays still covers the window: the
    /// oldest goes once the one after it started `bufferSeconds` ago or earlier.
    private func evictRing(now t: EpochMillis) {
        let window = Int64(config.bufferSeconds * 1000)
        while ring.count > 1, ring[1].startedAt <= t - window {
            dropOldestSegment()
        }
        while ring.count > 1, ringBytes > config.ringMaxBytes {
            dropOldestSegment()
        }
        if ringBytes > config.ringMaxBytes {
            // One segment alone is over the bound: it goes whole, and capture starts over.
            dropOldestSegment()
            open = nil
            needSegment = true
        }
    }

    private func dropOldestSegment() {
        guard let first = ring.first else { return }
        ringBytes -= first.chunks.reduce(0) { $0 + $1.body.count }
        ring.removeFirst()
        counters.ringEvictedSegments += 1
    }

    private func emit(_ chunk: Pending) {
        guard !ended else { return }
        let sequence = nextSequence
        nextSequence += 1
        counters.chunks += 1
        let meta = ReplayChunkMeta(
            sessionId: sessionId, replayId: replayId, streamId: streamId,
            segmentIndex: max(0, segmentIndex), sequence: sequence, keyframe: chunk.keyframe,
            startTime: chunk.start, endTime: max(chunk.start, chunk.end),
            format: adapter.formatId, encoding: adapter.encoding, masked: adapter.masked,
            mode: config.mode.rawValue, trigger: config.mode == .buffer ? (trigger ?? .manual).rawValue : nil,
            viewId: chunk.viewId
        )
        let request = ReplayEnvelope.chunkRequest(scope: scope, meta: meta, body: chunk.body, observedTime: now())
        if sink.put(request, streamId: streamId, sequence: sequence) {
            persist()
            return
        }
        // RPL-18: the store cannot take more. The sequence is spent, so the stream has a hole.
        counters.refused += 1
        partial = true
        persist()
        logger.warn("replay store refused chunk \(sequence): capture stops")
        finish(.maxSize)
    }

    private func persist() {
        guard let store, !ended, !buffering else { return }
        let state = ReplayStreamState(sessionId: sessionId, replayId: replayId, streamId: streamId, lastSequence: nextSequence > 0 ? nextSequence - 1 : nil, partial: partial, scope: scope)
        if !store.save(state) { counters.stateFailures += 1 }
    }

    private func finish(_ reason: ReplayEndReason) {
        guard !ended else { return }
        if buffering {
            ended = true
            open = nil
            ring = []
            ringBytes = 0
            return
        }
        closeChunk()
        guard !ended else { return }
        ended = true
        let record = ReplayEnded(
            sessionId: sessionId, replayId: replayId, streamId: streamId,
            endState: partial ? "partial" : "complete",
            lastSequence: nextSequence > 0 ? nextSequence - 1 : nil,
            endReason: reason.rawValue
        )
        if sink.put(ReplayEnvelope.endedRequest(scope: scope, ended: record, time: now()), streamId: streamId, sequence: nil) {
            store?.clear()
        } else {
            // The state stays: the next launch ends the stream (as partial).
            counters.refused += 1
        }
        logger.log("stream \(streamId) ended: \(record.endState), \(reason.rawValue), \(nextSequence) chunks")
    }
}
