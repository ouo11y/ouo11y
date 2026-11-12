package dev.ouo.replay.core

import java.io.ByteArrayOutputStream
import java.io.File
import java.security.SecureRandom
import org.json.JSONObject

/** `ouo.replay.mode` (client SDK spec 9.1). */
enum class ReplayCaptureMode(val wire: String) {
  /** Every chunk is sent as it closes. */
  SESSION("session"),

  /** Chunks wait in a memory ring until `capture(trigger)`; from then on as `session`. */
  BUFFER("buffer"),
}

/** `ouo.replay.end_reason` (spec 11.5), without the web-only `pagehide`. */
enum class ReplayEndReason(val wire: String) {
  SESSION_END("session_end"),
  STOP("stop"),
  CONSENT("consent"),
  BACKGROUND_KILL("background_kill"),
  CRASH("crash"),
  MAX_SIZE("max_size"),
  ERROR("error"),
}

/** `ouo.replay.trigger` (spec 11.3). */
enum class ReplayTrigger(val wire: String) {
  ERROR("error"),
  CRASH("crash"),
  ANR("anr"),
  HANG("hang"),
  MANUAL("manual");

  companion object {
    fun of(wire: String?): ReplayTrigger? = entries.firstOrNull { it.wire == wire }
  }
}

/** Every value is brought inside what the contract allows: absurd input never throws. */
class ReplayStreamConfig(
  val mode: ReplayCaptureMode = ReplayCaptureMode.SESSION,
  bufferSeconds: Double = 60.0,
  keyframeIntervalMs: Long = 300_000,
  chunkMaxBytes: Int = 256 * 1024,
  chunkMaxMs: Long = 5_000,
  ringMaxBytes: Int = 16 shl 20,
  maxEventBytes: Int = 8 shl 20,
  selfDisableThreshold: Int = 20,
  /** RPL-10, RPL-11: no chunk body is larger than this. Only tests lower it. */
  hardLimitBytes: Int = HARD_LIMIT_BYTES,
) {
  /** SMP-10: the ring holds at least this much. */
  val bufferSeconds: Double = if (bufferSeconds.isFinite()) bufferSeconds.coerceIn(1.0, 3600.0) else 60.0

  /** RPL-9: a new segment and keyframe at least this often. */
  val keyframeIntervalMs: Long = keyframeIntervalMs.coerceIn(1_000, 86_400_000)
  val hardLimitBytes: Int = hardLimitBytes.coerceIn(64, HARD_LIMIT_BYTES)

  /** RPL-10: a chunk closes when its compressed body reaches this. */
  val chunkMaxBytes: Int = chunkMaxBytes.coerceIn(minOf(1024, this.hardLimitBytes), this.hardLimitBytes)

  /** RPL-10: a chunk closes this long after its first event. */
  val chunkMaxMs: Long = chunkMaxMs.coerceIn(100, 600_000)

  /** ERR-9: the ring's compressed bytes. Beyond it the oldest whole segments go early. */
  val ringMaxBytes: Int = maxOf(ringMaxBytes, 1 shl 16)

  /** ERR-9: an event larger than this is refused (the adapter misbehaves). */
  val maxEventBytes: Int = maxOf(maxEventBytes, 1024)

  /** ERR-6: internal errors after which the stream ends with reason `error`. */
  val selfDisableThreshold: Int = maxOf(selfDisableThreshold, 1)

  /** How often a segment starts while the ring buffers: a quarter of the window, so the ring holds between `bufferSeconds` and five quarters of it. */
  val ringSegmentMs: Long get() = minOf(this.keyframeIntervalMs, maxOf(1000L, (this.bufferSeconds * 250).toLong()))

  companion object {
    const val HARD_LIMIT_BYTES = 1 shl 20
  }
}

/**
 * Where a finished record goes: the replay disk queue ([ReplayDelivery]). [request] is the final
 * protobuf request body; [sequence] is null for the end record. False: the record could not be
 * stored (RPL-18).
 */
interface ReplaySink {
  fun put(request: ByteArray, streamId: String, sequence: Int?): Boolean
}

/** What the next launch needs to end a stream a kill left open (RPL-20). */
data class ReplayStreamState(
  val sessionId: String,
  val replayId: String,
  val streamId: String,
  /** Highest sequence produced, null when none. */
  val lastSequence: Int?,
  val partial: Boolean,
  val scope: ReplayScope,
)

interface ReplayStateStore {
  /** False when the state could not be written. */
  fun save(state: ReplayStreamState): Boolean

  fun load(): ReplayStreamState?

  fun clear()
}

/** The open stream in one small JSON file, written atomically (temp file and rename). */
class FileReplayStateStore(val file: File) : ReplayStateStore {
  override fun save(state: ReplayStreamState): Boolean =
    try {
      file.parentFile?.mkdirs()
      val o = JSONObject().put("sessionId", state.sessionId).put("replayId", state.replayId).put("streamId", state.streamId)
        .put("partial", state.partial).put("scope", state.scope.toJson())
      state.lastSequence?.let { o.put("lastSequence", it) }
      val tmp = File(file.path + ".tmp")
      tmp.writeText(o.toString())
      if (tmp.renameTo(file)) true else {
        tmp.delete()
        false
      }
    } catch (e: Exception) {
      false
    }

  override fun load(): ReplayStreamState? {
    val text = try {
      if (!file.isFile) return null
      file.readText()
    } catch (e: Exception) {
      return null
    }
    return try {
      val o = JSONObject(text)
      ReplayStreamState(
        o.getString("sessionId"), o.getString("replayId"), o.getString("streamId"),
        if (o.has("lastSequence")) o.getInt("lastSequence") else null,
        o.optBoolean("partial", true), ReplayScope.fromJson(o.getJSONObject("scope")),
      )
    } catch (e: Exception) {
      // Unreadable: nothing can be said about that stream; do not trip over it again.
      clear()
      null
    }
  }

  override fun clear() {
    try {
      file.delete()
    } catch (e: Exception) {
    }
  }

  companion object {
    const val FILE_NAME = "open-stream.json"
  }
}

/** Counters of one stream (ERR-7: everything dropped is counted, by reason). */
data class ReplayStreamStats(
  /** Looks the adapter refused (masking or encoding failed). */
  val framesDropped: Int = 0,
  /** Events left out: before the keyframe of a new segment, or malformed. */
  val eventsDropped: Int = 0,
  /** Internal errors (ERR-6 counts these). */
  val errors: Int = 0,
  /** Chunks given a sequence. */
  val chunks: Int = 0,
  /** Chunks cut again because their body passed the hard limit. */
  val splits: Int = 0,
  /** Segments the ring let go (never sent, never numbered). */
  val ringEvictedSegments: Int = 0,
  /** Records the sink refused. */
  val refused: Int = 0,
  /** Chunks of this stream the queue lost after taking them (evicted or rejected). */
  val lost: Int = 0,
  /** Open-stream state writes that failed. */
  val stateFailures: Int = 0,
)

/**
 * One stream of one replay (client SDK spec 11.1): turns the events of a format adapter into
 * numbered chunks, each wrapped in its OTLP request and handed to the sink, and ends with
 * `ouo.replay.ended`. Nothing here depends on the format (RPL-23). The Swift `ReplayStream` of
 * `sdk/ios`, ported rule for rule.
 *
 * - **Segments** (RPL-6, RPL-8, RPL-9): a segment starts with a keyframe: at the start, after a
 *   gap or a local loss, on the return to the foreground and every `keyframeIntervalMs`. Until the
 *   adapter delivers that keyframe, other events are dropped.
 * - **Chunks** (RPL-4, RPL-10, RPL-11): a chunk closes at `chunkMaxBytes` compressed, `chunkMaxMs`,
 *   the end of the stream or the background. A body over the hard limit is cut in two, between
 *   lines where it can, inside a line where it must: the pieces still concatenate to the same bytes
 *   (RPL-7). The sequence rises by one per chunk and never resets.
 * - **Buffer mode** (SMP-10 to SMP-12): until [capture] closed chunks wait unnumbered in a ring of
 *   whole segments covering at least `bufferSeconds`; only whole segments leave it. The trigger
 *   numbers them from 0 and sends them, and the stream goes on as in session mode.
 * - **Partial** (RPL-17, RPL-18, RPL-21): a chunk the queue lost or refused marks the stream
 *   partial and starts a new segment; a refusal also ends the stream (`max_size`).
 *
 * Thread-safe: one lock around everything, the adapter included. No method throws: what the
 * adapter, the sink or the store throws is counted as an error (ERR-1), and after
 * `selfDisableThreshold` of them the stream ends with reason `error` (ERR-6).
 */
class ReplayStream(
  val sessionId: String,
  replayId: String? = null,
  private val scope: ReplayScope,
  val config: ReplayStreamConfig = ReplayStreamConfig(),
  private val adapter: ReplayFormatAdapter,
  private val sink: ReplaySink,
  private val store: ReplayStateStore? = null,
  private val logger: Logger = Logger.NONE,
  private val now: () -> EpochMillis = System::currentTimeMillis,
) {
  /** 32 lowercase hex characters from the caller, or a fresh one for null or anything else. */
  val replayId: String = replayId?.takeIf { isValidId(it) } ?: randomId()

  /** Always fresh: one per process lifetime and replay (RPL-5). */
  val streamId: String = randomId()

  private class Pending(val body: ByteArray, val start: EpochMillis, val end: EpochMillis, val keyframe: Boolean, val viewId: String?)

  private class Open(val start: EpochMillis, val keyframe: Boolean, val viewId: String?, var nextTrialAt: Int) {
    val data = ByteArrayOutputStream(16 * 1024)
    var end: EpochMillis = start
  }

  private class RingSegment(val startedAt: EpochMillis) {
    val chunks = ArrayList<Pending>()
  }

  private val lock = Any()
  private var open: Open? = null
  private val ring = ArrayList<RingSegment>()
  private var ringBytes = 0L
  private var needSegment = true
  private var segmentStartedAt = 0L
  private var segmentIndex = -1
  private var nextSequence = 0
  private var partial = false
  private var ended = false
  private var triggered = false
  private var trigger: ReplayTrigger? = null
  private var viewId: String? = null
  private var counters = ReplayStreamStats()

  // ---- state ----

  /** False once the stream ended (stopped, refused by the store, or disabled by its own errors). */
  val isActive: Boolean get() = synchronized(lock) { !ended }
  val isPartial: Boolean get() = synchronized(lock) { partial }
  val stats: ReplayStreamStats get() = synchronized(lock) { counters }

  /** Chunks waiting in the ring (buffer mode before its trigger). */
  val bufferedChunks: Int get() = synchronized(lock) { ring.sumOf { it.chunks.size } }

  /** The next sequence: the number of chunks produced so far. */
  val producedChunks: Int get() = synchronized(lock) { nextSequence }

  private val buffering: Boolean get() = config.mode == ReplayCaptureMode.BUFFER && !triggered

  // ---- input ----

  /** One look at the screen. The adapter masks and encodes it; a look it refuses is dropped. */
  fun look(look: ReplayLook, t: EpochMillis) = locked {
    if (ended) return@locked
    if (needSegment || segmentDue(t)) {
      needSegment = true
      adapter.requestKeyframe()
    }
    val events = try {
      adapter.events(look, t)
    } catch (e: Throwable) {
      counters = counters.copy(framesDropped = counters.framesDropped + 1)
      warn("frame dropped: ${e.javaClass.simpleName}")
      // A masking failure is the format doing its job (PRV-8), not an SDK error.
      if ((e as? ReplayFormatError)?.kind != ReplayFormatError.Kind.MASKING_FAILED) noteError()
      return@locked
    }
    append(events)
  }

  fun touch(touch: Touch) = locked {
    if (ended) return@locked
    val event = adapter.touchEvent(touch) ?: return@locked
    append(listOf(event))
  }

  /** Call about once a second: closes a chunk that is old enough and lets the ring go of what it no longer needs. */
  fun tick(t: EpochMillis = now()) = locked {
    if (ended) return@locked
    closeIfOld(t)
    if (buffering) evictRing(t)
  }

  /** Closes the open chunk now (a host flush). */
  fun flush() = locked { closeChunk() }

  /** The app left the foreground (or capture paused): the chunk closes and whatever comes next starts a new segment with a keyframe (RPL-9, RPL-10). */
  fun background() = locked {
    closeChunk()
    needSegment = true
  }

  /** Capture lost something (a dropped event, a stall): the next look starts a new segment. */
  fun markGap() = locked { needSegment = true }

  /** The queue lost a chunk of [streamId] after taking it (evicted by its bound, rejected by the collector). Ignored for another stream's chunk. */
  fun chunkLost(streamId: String) = locked {
    if (streamId != this.streamId || ended) return@locked
    counters = counters.copy(lost = counters.lost + 1)
    partial = true
    needSegment = true
    persist()
  }

  fun setViewId(id: String?) = locked { viewId = id?.takeIf { it.isNotEmpty() }?.take(256) }

  /**
   * Buffer mode: sends the ring and goes on as session mode (SMP-12). Returns the number of chunks
   * flushed, null when there was nothing to trigger (session mode, already triggered, ended).
   */
  fun capture(trigger: ReplayTrigger): Int? = locked {
    if (ended || !buffering) return@locked null
    closeChunk()
    triggered = true
    this.trigger = trigger
    var flushed = 0
    val segments = ArrayList(ring)
    ring.clear()
    ringBytes = 0
    var lastHadChunks = false
    for (segment in segments) {
      lastHadChunks = segment.chunks.isNotEmpty()
      if (!lastHadChunks) continue
      segmentIndex++
      for (chunk in segment.chunks) {
        if (ended) break
        emit(chunk)
        flushed++
      }
    }
    // The segment in progress goes on; with nothing in it the next look starts one.
    if (!lastHadChunks) needSegment = true
    persist()
    log("buffer triggered (${trigger.wire}): $flushed chunks flushed")
    flushed
  }

  /**
   * Ends the stream: closes the chunk and sends `ouo.replay.ended`. A buffer that was never
   * triggered sent nothing, so it ends without a record. Later calls do nothing.
   */
  fun end(reason: ReplayEndReason) = locked { finish(reason) }

  /** Ends the stream without a record and forgets its state (consent withdrawn, PRV-4: nothing further is emitted). What it buffered is dropped. */
  fun abandon() = locked {
    ended = true
    open = null
    ring.clear()
    ringBytes = 0
    store?.clear()
  }

  // ---- internals (under `lock`) ----

  /** Runs [block] under the lock; whatever it throws is counted, never rethrown (ERR-1). */
  private inline fun <T> locked(block: () -> T): T? = synchronized(lock) {
    try {
      block()
    } catch (e: Throwable) {
      try {
        warn("replay stream error: ${e.javaClass.simpleName}")
        noteError()
      } catch (ignored: Throwable) {
      }
      null
    }
  }

  private fun log(message: String) {
    try {
      logger.log(message)
    } catch (ignored: Throwable) {
    }
  }

  private fun warn(message: String) {
    try {
      logger.warn(message)
    } catch (ignored: Throwable) {
    }
  }

  private fun segmentDue(t: EpochMillis): Boolean {
    val interval = if (buffering) config.ringSegmentMs else config.keyframeIntervalMs
    return t < segmentStartedAt || elapsed(segmentStartedAt, t) >= interval
  }

  private fun noteError() {
    counters = counters.copy(errors = counters.errors + 1)
    if (counters.errors >= config.selfDisableThreshold && !ended) {
      warn("replay disabled after ${counters.errors} internal errors")
      try {
        finish(ReplayEndReason.ERROR)
      } catch (e: Throwable) {
        ended = true
      }
    }
  }

  private fun valid(event: ReplayEvent?): Boolean {
    val json = event?.json ?: return false
    if (json.size < 2 || json.size > config.maxEventBytes || json[0] != '{'.code.toByte() || json[json.size - 1] != '}'.code.toByte()) return false
    return json.none { it == '\n'.code.toByte() }
  }

  private fun append(events: List<ReplayEvent>?) {
    for (event in events ?: emptyList()) {
      if (ended) return
      if (!valid(event)) {
        // What the adapter thinks it sent is not in the payload: later events may build on it.
        counters = counters.copy(eventsDropped = counters.eventsDropped + 1)
        needSegment = true
        adapter.requestKeyframe()
        noteError()
        continue
      }
      if (needSegment) {
        if (!event.keyframe) {
          counters = counters.copy(eventsDropped = counters.eventsDropped + 1)
          continue
        }
        closeChunk()
        if (ended) return
        if (buffering) ring.add(RingSegment(event.t)) else segmentIndex++
        needSegment = false
        segmentStartedAt = event.t
        open = Open(event.t, true, viewId, config.chunkMaxBytes)
      }
      val o = open ?: Open(event.t, false, viewId, config.chunkMaxBytes).also { open = it }
      o.data.write(event.json, 0, event.json.size)
      o.data.write('\n'.code)
      if (event.t > o.end) o.end = event.t
      closeIfFull()
      closeIfOld(event.t)
    }
  }

  /**
   * The compressed size is only known by compressing: the body is tried when its uncompressed
   * bytes reach the limit, and again once enough was added that it could have reached it.
   */
  private fun closeIfFull() {
    val o = open ?: return
    if (o.data.size() < o.nextTrialAt) return
    val compressed = try {
      adapter.compress(o.data.toByteArray())
    } catch (e: Throwable) {
      return closeChunk()
    }
    if (compressed.size >= config.chunkMaxBytes) closeChunk(compressed) else o.nextTrialAt = o.data.size() + (config.chunkMaxBytes - compressed.size)
  }

  private fun closeIfOld(t: EpochMillis) {
    val o = open ?: return
    if (t < o.start || elapsed(o.start, t) >= config.chunkMaxMs) closeChunk()
  }

  private fun closeChunk(compressed: ByteArray? = null) {
    val o = open ?: return
    open = null
    if (o.data.size() == 0 || ended) return
    val bodies = try {
      split(o.data.toByteArray(), compressed)
    } catch (e: Throwable) {
      // Its events are gone: nothing was numbered, so no hole, but a gap in what was seen.
      warn("chunk dropped, compression failed: ${e.javaClass.simpleName}")
      counters = counters.copy(eventsDropped = counters.eventsDropped + 1)
      needSegment = true
      noteError()
      return
    }
    if (bodies.size > 1) counters = counters.copy(splits = counters.splits + bodies.size - 1)
    bodies.forEachIndexed { i, body ->
      if (ended) return
      val chunk = Pending(body, o.start, o.end, o.keyframe && i == 0, o.viewId)
      if (buffering) {
        if (ring.isEmpty()) return@forEachIndexed
        ring[ring.size - 1].chunks.add(chunk)
        ringBytes += body.size
        evictRing(o.end)
      } else {
        emit(chunk)
      }
    }
  }

  /**
   * The compressed bodies of [payload], each within the hard limit (RPL-11). A body over it is cut
   * in two at the line break nearest its middle, or in the middle of a line when it has none, and
   * each half is compressed on its own.
   */
  private fun split(payload: ByteArray, compressed: ByteArray? = null): List<ByteArray> {
    val body = compressed ?: adapter.compress(payload)
    if (body.isEmpty()) throw ReplayFormatError(ReplayFormatError.Kind.ENCODING_FAILED)
    if (body.size <= config.hardLimitBytes || payload.size < 2) return listOf(body)
    val mid = payload.size / 2
    var cut = mid
    val newline = '\n'.code.toByte()
    for (distance in 0 until mid) {
      // A cut after a newline keeps whole lines on both sides.
      if (payload[mid + distance] == newline && mid + distance + 1 < payload.size) {
        cut = mid + distance + 1
        break
      }
      if (payload[mid - distance - 1] == newline && mid - distance > 0) {
        cut = mid - distance
        break
      }
    }
    return split(payload.copyOfRange(0, cut)) + split(payload.copyOfRange(cut, payload.size))
  }

  /**
   * Only whole segments leave the ring, and only while what stays still covers the window: the
   * oldest goes once the one after it started `bufferSeconds` ago or earlier.
   */
  private fun evictRing(t: EpochMillis) {
    val window = (config.bufferSeconds * 1000).toLong()
    while (ring.size > 1 && elapsed(ring[1].startedAt, t) >= window) dropOldestSegment()
    while (ring.size > 1 && ringBytes > config.ringMaxBytes) dropOldestSegment()
    if (ringBytes > config.ringMaxBytes) {
      // One segment alone is over the bound: it goes whole, and capture starts over.
      dropOldestSegment()
      open = null
      needSegment = true
    }
  }

  private fun dropOldestSegment() {
    if (ring.isEmpty()) return
    val first = ring.removeAt(0)
    ringBytes -= first.chunks.sumOf { it.body.size.toLong() }
    counters = counters.copy(ringEvictedSegments = counters.ringEvictedSegments + 1)
  }

  private fun emit(chunk: Pending) {
    if (ended) return
    val sequence = nextSequence++
    counters = counters.copy(chunks = counters.chunks + 1)
    val meta = ReplayChunkMeta(
      sessionId = sessionId, replayId = replayId, streamId = streamId,
      segmentIndex = maxOf(0, segmentIndex), sequence = sequence, keyframe = chunk.keyframe,
      startTime = chunk.start, endTime = maxOf(chunk.start, chunk.end),
      format = adapter.formatId, encoding = adapter.encoding, masked = adapter.masked,
      mode = config.mode.wire, trigger = if (config.mode == ReplayCaptureMode.BUFFER) (trigger ?: ReplayTrigger.MANUAL).wire else null,
      viewId = chunk.viewId,
    )
    val stored = try {
      sink.put(ReplayEnvelope.chunkRequest(scope, meta, chunk.body, now()), streamId, sequence)
    } catch (e: Throwable) {
      false
    }
    if (stored) {
      persist()
      return
    }
    // RPL-18: the store cannot take more. The sequence is spent, so the stream has a hole.
    counters = counters.copy(refused = counters.refused + 1)
    partial = true
    persist()
    warn("replay store refused chunk $sequence: capture stops")
    finish(ReplayEndReason.MAX_SIZE)
  }

  private fun persist() {
    val s = store ?: return
    if (ended || buffering) return
    val ok = try {
      s.save(ReplayStreamState(sessionId, replayId, streamId, if (nextSequence > 0) nextSequence - 1 else null, partial, scope))
    } catch (e: Throwable) {
      false
    }
    if (!ok) counters = counters.copy(stateFailures = counters.stateFailures + 1)
  }

  private fun finish(reason: ReplayEndReason) {
    if (ended) return
    if (buffering) {
      ended = true
      open = null
      ring.clear()
      ringBytes = 0
      return
    }
    closeChunk()
    if (ended) return
    ended = true
    val record = ReplayEnded(sessionId, replayId, streamId, if (partial) "partial" else "complete", if (nextSequence > 0) nextSequence - 1 else null, reason.wire)
    val stored = try {
      sink.put(ReplayEnvelope.endedRequest(scope, record, now()), streamId, null)
    } catch (e: Throwable) {
      false
    }
    if (stored) {
      try {
        store?.clear()
      } catch (ignored: Throwable) {
      }
    } else {
      // The state stays: the next launch ends the stream (as partial).
      counters = counters.copy(refused = counters.refused + 1)
    }
    log("stream $streamId ended: ${record.endState}, ${reason.wire}, $nextSequence chunks")
  }

  companion object {
    private val random = SecureRandom()

    /** 128 random bits as 32 lowercase hex characters. */
    fun randomId(): String {
      val b = ByteArray(16)
      while (true) {
        random.nextBytes(b)
        if (b.any { it != 0.toByte() }) return ReplayEnvelope.hex(b)
      }
    }

    /** 32 lowercase hex characters, not all zero. */
    fun isValidId(id: String?): Boolean = id != null && id.length == 32 && id.all { it in '0'..'9' || it in 'a'..'f' } && id.any { it != '0' }

    /** `to - from`, saturating: a clock can hand over any pair of times. */
    private fun elapsed(from: EpochMillis, to: EpochMillis): Long {
      val d = to - from
      // Overflow: the signs of the operands differ and the result's differs from `to`'s.
      return if (((to xor from) and (to xor d)) < 0) (if (to > from) Long.MAX_VALUE else Long.MIN_VALUE) else d
    }

    /**
     * Ends the stream a kill left open in an earlier process (RPL-20): `ouo.replay.ended` with
     * `partial`. Call before this process's stream produces a chunk. True when a record was sent.
     */
    fun endOpenStream(store: ReplayStateStore, sink: ReplaySink, reason: ReplayEndReason = ReplayEndReason.BACKGROUND_KILL, now: EpochMillis = System.currentTimeMillis()): Boolean =
      try {
        val state = store.load()
        if (state == null) false
        else {
          val ended = ReplayEnded(state.sessionId, state.replayId, state.streamId, "partial", state.lastSequence, reason.wire)
          if (sink.put(ReplayEnvelope.endedRequest(state.scope, ended, now), state.streamId, null)) {
            store.clear()
            true
          } else false
        }
      } catch (e: Throwable) {
        false
      }
  }
}
