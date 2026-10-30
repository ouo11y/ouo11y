import Foundation

/// Accumulates frames and touches into `FrameChunk`s and cuts a chunk when any flush trigger
/// fires: `flushInterval` elapsed since the chunk started, its images reached `maxImageBytes`, the
/// viewport changed (`update(viewport:)`), or an explicit `flush()` (pause, background, rotation).
/// The first frame of a chunk must be a full image (ADR-0014): `needsFullFrame` tells the capturer,
/// and a patch frame offered first is dropped. With a `spool`, the open chunk is also on disk so
/// the next launch can send it after a crash. Not thread-safe by itself: the UIKit target drives
/// it from its capture queue, tests from one thread.
public final class ChunkBuilder {
    public struct Config: Sendable {
        public var flushInterval: TimeInterval
        /// Base64 characters of images after which the chunk is cut (1 MiB).
        public var maxImageBytes: Int
        public var platform: String
        public var masked: Bool
        /// The session's capture mode, written on every chunk.
        public var mode: String

        public init(flushInterval: TimeInterval = 5, maxImageBytes: Int = 1 << 20, platform: String = "ios", masked: Bool = true, mode: String = "session") {
            self.flushInterval = flushInterval
            self.maxImageBytes = maxImageBytes
            self.platform = platform
            self.masked = masked
            self.mode = mode
        }
    }

    public let config: Config
    private let sessionId: () -> String
    private let seqStore: SeqStore
    private let now: () -> EpochMillis
    private let onChunk: (FrameChunk) -> Void
    private let spool: ChunkSpool?

    /// Viewport reported with every chunk; `update(viewport:)` changes it.
    public private(set) var viewport: Viewport

    private var frames: [Frame] = []
    private var imageBytes = 0
    private var touches: [Touch] = []
    /// Touches not written to the spool yet (they go with the next frame line).
    private var spooledTouches = 0
    private var chunkSessionId: String?
    private var chunkSeq = 0
    private var startedAt: EpochMillis = 0
    private var lastTs: EpochMillis = 0

    public init(
        config: Config = Config(),
        viewport: Viewport,
        sessionId: @escaping () -> String,
        seqStore: SeqStore,
        now: @escaping () -> EpochMillis = Clock.nowMillis,
        spool: ChunkSpool? = nil,
        onChunk: @escaping (FrameChunk) -> Void
    ) {
        self.config = config
        self.viewport = viewport
        self.sessionId = sessionId
        self.seqStore = seqStore
        self.now = now
        self.spool = spool
        self.onChunk = onChunk
    }

    public var frameCount: Int { frames.count }
    public var touchCount: Int { touches.count }
    public var isEmpty: Bool { frames.isEmpty && touches.isEmpty }
    /// The next frame must be a full image: the open chunk has none yet.
    public var needsFullFrame: Bool { frames.isEmpty }

    /// The window size or frame scale changed: patches cannot span it, so the open chunk is cut.
    public func update(viewport: Viewport) {
        guard viewport != self.viewport else { return }
        flush()
        self.viewport = viewport
    }

    public func add(_ frame: Frame) {
        // A patch frame has nothing to apply to in a new chunk; the capturer never offers one.
        guard frame.isFull || !frames.isEmpty else { return }
        open(at: frame.ts)
        frames.append(frame)
        imageBytes += frame.imageBytes
        if let spool {
            spool.append(Array(touches[spooledTouches...]))
            spooledTouches = touches.count
            spool.append(frame, viewport: viewport)
        }
        lastTs = max(lastTs, frame.ts)
        if imageBytes >= config.maxImageBytes {
            flush()
        } else {
            flushIfDue()
        }
    }

    public func add(_ touch: Touch) {
        open(at: touch.ts)
        touches.append(touch)
        lastTs = max(lastTs, touch.ts)
        flushIfDue()
    }

    /// Flushes when the open chunk is older than `flushInterval`. The scheduler calls this once
    /// per tick so a chunk holding only touches (or deduplicated frames) still goes out.
    @discardableResult
    public func flushIfDue() -> Bool {
        guard chunkSessionId != nil else { return false }
        let age = Double(now() - startedAt) / 1000
        if age >= config.flushInterval {
            flush()
            return true
        }
        return false
    }

    /// Cuts the open chunk (if any) and hands it to `onChunk`. The spool is cleared only after
    /// `onChunk` returned (the uploader has it on disk by then), so a kill in between loses nothing.
    public func flush() {
        guard let chunk = cut() else { return }
        onChunk(chunk)
        spool?.clear()
    }

    /// Returns the open chunk and resets the buffer, nil when nothing is buffered. The spool still
    /// holds it until `flush()` clears it.
    public func cut() -> FrameChunk? {
        guard let sid = chunkSessionId, !isEmpty else {
            chunkSessionId = nil
            return nil
        }
        let chunk = FrameChunk(
            sessionId: sid,
            seq: chunkSeq,
            startedAt: startedAt,
            endedAt: max(lastTs, startedAt),
            viewport: viewport,
            platform: config.platform,
            mode: config.mode,
            frames: frames,
            touches: touches,
            masked: config.masked
        )
        frames = []
        imageBytes = 0
        touches = []
        spooledTouches = 0
        chunkSessionId = nil
        return chunk
    }

    /// Session rotation: flush what belongs to the old session, then restart seq at 0 for the new id.
    public func sessionDidRotate(newId: String) {
        flush()
        seqStore.reset(sessionId: newId)
    }

    /// Reserves the seq and session id the moment the first item arrives, so a rotation that
    /// happens mid-chunk does not relabel buffered frames.
    private func open(at ts: EpochMillis) {
        guard chunkSessionId == nil else { return }
        let sid = sessionId()
        chunkSessionId = sid
        chunkSeq = seqStore.next(sessionId: sid)
        startedAt = ts
        lastTs = ts
        spool?.begin(.init(sessionId: sid, seq: chunkSeq, startedAt: ts, viewport: viewport, platform: config.platform, masked: config.masked, mode: config.mode))
    }
}
