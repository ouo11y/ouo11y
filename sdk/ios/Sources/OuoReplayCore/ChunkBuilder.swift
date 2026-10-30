import Foundation

/// Accumulates frames and touches into `FrameChunk`s and cuts a chunk when any flush trigger
/// fires: `flushInterval` elapsed since the chunk started, `maxFrames` frames, or an explicit
/// `flush()` (pause, background, rotation). With a `spool`, the open chunk is also on disk so the
/// next launch can send it after a crash. Not thread-safe by itself: the UIKit target drives it
/// from its capture queue, tests from one thread.
public final class ChunkBuilder {
    public struct Config: Sendable {
        public var flushInterval: TimeInterval
        public var maxFrames: Int
        public var platform: String
        public var masked: Bool

        public init(flushInterval: TimeInterval = 5, maxFrames: Int = 10, platform: String = "ios", masked: Bool = true) {
            self.flushInterval = flushInterval
            self.maxFrames = maxFrames
            self.platform = platform
            self.masked = masked
        }
    }

    public let config: Config
    private let sessionId: () -> String
    private let seqStore: SeqStore
    private let now: () -> EpochMillis
    private let onChunk: (FrameChunk) -> Void
    private let spool: ChunkSpool?

    /// Viewport reported with every chunk; the capturer updates it when the window size changes.
    public var viewport: Viewport

    private var frames: [Frame] = []
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

    public func add(_ frame: Frame) {
        open(at: frame.ts)
        frames.append(frame)
        if let spool {
            spool.append(Array(touches[spooledTouches...]))
            spooledTouches = touches.count
            spool.append(frame, viewport: viewport)
        }
        lastTs = max(lastTs, frame.ts)
        if frames.count >= config.maxFrames {
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

    /// Cuts the open chunk (if any) and hands it to `onChunk`.
    public func flush() {
        guard let chunk = cut() else { return }
        onChunk(chunk)
    }

    /// Pure cut: returns the open chunk and resets the buffer, nil when nothing is buffered.
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
            frames: frames,
            touches: touches,
            masked: config.masked
        )
        frames = []
        touches = []
        spooledTouches = 0
        chunkSessionId = nil
        spool?.clear()
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
        spool?.begin(.init(sessionId: sid, seq: chunkSeq, startedAt: ts, viewport: viewport, platform: config.platform, masked: config.masked))
    }
}
