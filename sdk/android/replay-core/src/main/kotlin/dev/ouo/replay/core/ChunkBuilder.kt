package dev.ouo.replay.core

/**
 * Accumulates frames and touches into [FrameChunk]s and cuts a chunk when any flush trigger fires:
 * [Config.flushIntervalMs] elapsed since the chunk started, its images reached
 * [Config.maxImageBytes], the viewport changed ([updateViewport]), or an explicit [flush] (pause,
 * background, rotation). The first frame of a chunk must be a full image (ADR-0014):
 * [needsFullFrame] tells the capturer, and a patch frame offered first is dropped. With a [spool],
 * the open chunk is also on disk so the next launch can send it after a crash. Not thread-safe:
 * the recorder drives it from its compose thread. The Swift `ChunkBuilder` of `sdk/ios`, ported.
 */
class ChunkBuilder(
  val config: Config = Config(),
  viewport: Viewport,
  private val sessionId: () -> String,
  private val seqStore: SeqStore,
  private val now: () -> EpochMillis = System::currentTimeMillis,
  private val spool: ChunkSpool? = null,
  private val onChunk: (FrameChunk) -> Unit,
) {
  data class Config(
    val flushIntervalMs: Long = 5_000,
    /** Base64 characters of images after which the chunk is cut (1 MiB). */
    val maxImageBytes: Int = 1 shl 20,
    val platform: String = "android",
    val masked: Boolean = true,
    /** The session's capture mode, written on every chunk. */
    val mode: String = "session",
  )

  var viewport: Viewport = viewport
    private set

  private var frames = mutableListOf<Frame>()
  private var imageBytes = 0
  private var touches = mutableListOf<Touch>()
  private var spooledTouches = 0
  private var chunkSessionId: String? = null
  private var chunkSeq = 0
  private var startedAt = 0L
  private var lastTs = 0L

  val frameCount: Int get() = frames.size
  val touchCount: Int get() = touches.size
  val isEmpty: Boolean get() = frames.isEmpty() && touches.isEmpty()

  /** The next frame must be a full image: the open chunk has none yet. */
  val needsFullFrame: Boolean get() = frames.isEmpty()

  /** The window size or frame scale changed: patches cannot span it, so the open chunk is cut. */
  fun updateViewport(viewport: Viewport) {
    if (viewport == this.viewport) return
    flush()
    this.viewport = viewport
  }

  fun add(frame: Frame) {
    // A patch frame has nothing to apply to in a new chunk; the capturer never offers one.
    if (!frame.isFull && frames.isEmpty()) return
    open(frame.ts)
    frames.add(frame)
    imageBytes += frame.imageBytes
    spool?.let {
      it.append(touches.subList(spooledTouches, touches.size).toList())
      spooledTouches = touches.size
      it.append(frame, viewport)
    }
    lastTs = maxOf(lastTs, frame.ts)
    if (imageBytes >= config.maxImageBytes) flush() else flushIfDue()
  }

  fun add(touch: Touch) {
    open(touch.ts)
    touches.add(touch)
    lastTs = maxOf(lastTs, touch.ts)
    flushIfDue()
  }

  /** Flushes when the open chunk is older than the flush interval; the recorder calls it once per tick. */
  fun flushIfDue(): Boolean {
    if (chunkSessionId == null) return false
    if (now() - startedAt >= config.flushIntervalMs) {
      flush()
      return true
    }
    return false
  }

  /**
   * Cuts the open chunk (if any) and hands it to `onChunk`. The spool is cleared only after
   * `onChunk` returned (the uploader has it on disk by then), so a kill in between loses nothing.
   */
  fun flush() {
    val chunk = cut() ?: return
    onChunk(chunk)
    spool?.clear()
  }

  /** Returns the open chunk and resets the buffer, null when nothing is buffered. */
  fun cut(): FrameChunk? {
    val sid = chunkSessionId
    if (sid == null || isEmpty) {
      chunkSessionId = null
      return null
    }
    val chunk = FrameChunk(
      sessionId = sid,
      seq = chunkSeq,
      startedAt = startedAt,
      endedAt = maxOf(lastTs, startedAt),
      viewport = viewport,
      platform = config.platform,
      mode = config.mode,
      frames = frames,
      touches = touches,
      masked = config.masked,
    )
    frames = mutableListOf()
    imageBytes = 0
    touches = mutableListOf()
    spooledTouches = 0
    chunkSessionId = null
    return chunk
  }

  /**
   * Session rotation: flush what belongs to the old session. The new id's seq starts at 0 because
   * the id is new ([SeqStore.next]); no reset here: the host may already have switched the id, and a
   * chunk opened in between holds seq 0 of the new session, which a reset would hand out again.
   */
  @Suppress("UNUSED_PARAMETER")
  fun sessionDidRotate(newId: String) = flush()

  /** Reserves the seq and session id when the first item arrives, so a rotation mid-chunk does not relabel it. */
  private fun open(ts: EpochMillis) {
    if (chunkSessionId != null) return
    val sid = sessionId()
    chunkSessionId = sid
    chunkSeq = seqStore.next(sid)
    startedAt = ts
    lastTs = ts
    spool?.begin(ChunkSpool.Header(sid, chunkSeq, ts, viewport, config.platform, config.masked, config.mode))
  }
}
