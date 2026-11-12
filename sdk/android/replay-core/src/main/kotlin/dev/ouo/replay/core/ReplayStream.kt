package dev.ouo.replay.core

import java.io.ByteArrayOutputStream
import java.io.File
import org.json.JSONObject

/** `ouo.replay.mode`: the whole session, or a ring that is sent only once something triggers it. */
enum class ReplayDelivery(val wire: String) {
  SESSION("session"),
  BUFFER("buffer");

  companion object {
    fun of(wire: String?): ReplayDelivery = entries.firstOrNull { it.wire == wire } ?: SESSION
  }
}

/** One chunk record (client SDK spec 11.3): the attributes of `ouo.replay.chunk` and its compressed body. */
class ReplayChunk(
  val sessionId: String,
  val replayId: String,
  val streamId: String,
  val segmentIndex: Int,
  val sequence: Int,
  val keyframe: Boolean,
  val startTime: EpochMillis,
  val endTime: EpochMillis,
  val format: String,
  val encoding: String,
  val sha256: String,
  val masked: Boolean,
  val mode: String,
  val trigger: String?,
  val viewId: String?,
  val body: ByteArray,
) {
  val byteSize: Int get() = body.size
}

/** The end record of a stream (client SDK spec 11.5). [lastSequence] null when the stream produced no chunk. */
class ReplayEnded(
  val sessionId: String,
  val replayId: String,
  val streamId: String,
  val complete: Boolean,
  val lastSequence: Int?,
  val reason: String,
  val time: EpochMillis,
)

/** The open stream on disk, so the next launch can end a stream a kill left open (RPL-20). */
class StreamStateStore(private val file: File) {
  class State(val sessionId: String, val replayId: String, val streamId: String, val lastSequence: Int, val partial: Boolean, val sent: Boolean)

  /** False when the disk refused it. */
  fun write(s: State): Boolean =
    try {
      file.parentFile?.mkdirs()
      val tmp = File(file.path + ".tmp")
      tmp.writeText(
        JSONObject().put("session_id", s.sessionId).put("replay_id", s.replayId).put("stream_id", s.streamId)
          .put("last_sequence", s.lastSequence).put("partial", s.partial).put("sent", s.sent).toString()
      )
      if (tmp.renameTo(file)) true else {
        tmp.delete()
        false
      }
    } catch (e: Exception) {
      false
    }

  /** Null when there is none or it cannot be read (a corrupt file is removed). */
  fun read(): State? {
    val text = try {
      if (!file.isFile) return null
      file.readText()
    } catch (e: Exception) {
      return null
    }
    return try {
      val o = JSONObject(text)
      State(o.getString("session_id"), o.getString("replay_id"), o.getString("stream_id"), o.optInt("last_sequence", -1), o.optBoolean("partial", true), o.optBoolean("sent", true))
    } catch (e: Exception) {
      clear()
      null
    }
  }

  fun clear() {
    try {
      file.delete()
    } catch (e: Exception) {
    }
  }
}

/**
 * The replay contract of client SDK spec 11, independent of the format (RPL-23): one stream of one
 * replay, cut into segments and chunks.
 *
 * - **Hierarchy.** Replay id (given or random) → stream id (random, this object) → segment index
 *   (from 0) → sequence (from 0, +1 per chunk, never reset at a segment boundary: RPL-4).
 * - **Segments.** A segment starts with a keyframe and decodes alone (RPL-6). A new one starts at
 *   the first event, after a gap or a local loss ([markGap], a chunk the store refused or evicted:
 *   RPL-8), on return to the foreground ([foreground]) and every [Config.keyframeIntervalMs] (RPL-9).
 *   Until the adapter delivers the keyframe, events are dropped: nothing is sent that cannot be decoded.
 * - **Chunks.** The open chunk closes at the earliest of [Config.chunkMaxBytes] compressed,
 *   [Config.chunkMaxMs], the end of the stream and the background (RPL-10). The body is the gzip of
 *   its events as newline-delimited JSON, compressed once; a body above [Config.hardLimitBytes] is
 *   split in two until every part fits, never truncated (RPL-11): the parts decompress on their own
 *   and concatenate back into the same lines (RPL-7).
 * - **Buffer mode** (SMP-10 to SMP-12). Closed chunks wait unnumbered in a memory ring of whole
 *   segments covering at least the last [Config.bufferSeconds]; only whole segments are evicted, so
 *   the ring always starts with a keyframe. [trigger] numbers and sends the ring, and the stream goes
 *   on as in session mode with `ouo.replay.mode=buffer` and the trigger. An untriggered ring never
 *   reaches the disk and sends no end record.
 * - **End** ([end]): `ouo.replay.ended`, `complete` only when every sequence up to the last was
 *   handed to the store and none is known lost or rejected (RPL-21).
 *
 * Not thread-safe: the recorder drives it from its compose thread. Only [reportLoss] may be called
 * from another thread. No method throws.
 */
class ReplayStream(
  val config: Config,
  private val adapter: ReplayFormatAdapter<*>,
  private val sessionId: () -> String,
  private val sink: Sink,
  private val state: StreamStateStore? = null,
  private val counters: ReplayCounters = ReplayCounters(),
  private val now: () -> EpochMillis = System::currentTimeMillis,
  newId: () -> String = Hex::randomId,
) {
  data class Config(
    /** 32 lowercase hex characters; anything else is replaced by a random id. */
    val replayId: String? = null,
    val delivery: ReplayDelivery = ReplayDelivery.SESSION,
    val bufferSeconds: Int = 60,
    val keyframeIntervalMs: Long = 300_000,
    /** Compressed bytes after which the open chunk is closed. */
    val chunkMaxBytes: Int = 256 * 1024,
    val chunkMaxMs: Long = 5_000,
    /** No body is larger than this (compressed). */
    val hardLimitBytes: Int = 1024 * 1024,
    /** Memory bound of the ring; past it the oldest whole segments go even inside the window (counted). */
    val ringMaxBytes: Long = 24L * 1024 * 1024,
    /** Consecutive chunks the store may refuse before capture stops (RPL-18). */
    val maxRefusals: Int = 3,
  ) {
    /** The same config with every value inside what the contract allows; absurd input never throws. */
    fun sane(): Config {
      val hard = HARD_LIMIT
      return copy(
        replayId = replayId?.takeIf { Hex.isId(it) },
        bufferSeconds = bufferSeconds.coerceIn(5, 600),
        keyframeIntervalMs = keyframeIntervalMs.coerceIn(5_000, 3_600_000),
        chunkMaxBytes = chunkMaxBytes.coerceIn(4 * 1024, hard),
        chunkMaxMs = chunkMaxMs.coerceIn(500, 60_000),
        hardLimitBytes = hardLimitBytes.coerceIn(1024, hard),
        ringMaxBytes = ringMaxBytes.coerceIn(1L * 1024 * 1024, 256L * 1024 * 1024),
        maxRefusals = maxRefusals.coerceIn(1, 100),
      )
    }
  }

  /** Where records go: the outbox. False when the store did not take it (the stream becomes partial). */
  interface Sink {
    fun chunk(chunk: ReplayChunk): Boolean

    fun ended(ended: ReplayEnded): Boolean
  }

  private class Pending(val body: ByteArray, val keyframe: Boolean, val start: EpochMillis, val end: EpochMillis, val sessionId: String, val viewId: String?)

  private class RingSegment(val start: EpochMillis) {
    val chunks = ArrayList<Pending>()
    var bytes = 0L
  }

  private val cfg = config.sane()
  val replayId: String = cfg.replayId ?: newId()
  val streamId: String = newId()
  val delivery: ReplayDelivery = cfg.delivery

  /** Sent with the chunks opened after it is set (`ouo.view.id`). Any thread. */
  @Volatile var viewId: String? = null

  // The open chunk.
  private val raw = ByteArrayOutputStream(64 * 1024)
  private var chunkStart = 0L
  private var chunkEnd = 0L
  private var chunkOpenedAt = 0L
  private var chunkKeyframe = false
  private var chunkSession = ""
  private var chunkView: String? = null
  private var nextSizeCheck = 0

  // The segment.
  private var needSegment = true
  private var segmentDue = false
  private var segmentStartedAt = 0L
  private var segmentIndex = -1
  private var nextSequence = 0

  // Buffer mode.
  private val ring = ArrayList<RingSegment>()
  private var ringBytes = 0L
  var trigger: String? = null
    private set
  val triggered: Boolean get() = delivery == ReplayDelivery.SESSION || trigger != null

  private var refusals = 0
  private var lastSession: String? = null
  @Volatile private var lossReported = false

  /** A chunk of this stream is known lost, refused or rejected: the end record says `partial`. */
  @Volatile var partial = false
    private set

  @Volatile var ended = false
    private set

  /** Highest sequence produced, -1 when none. */
  val lastSequence: Int get() = nextSequence - 1
  val segments: Int get() = segmentIndex + 1

  /** Chunks waiting in the ring (buffer mode, before a trigger). */
  val ringChunks: Int get() = ring.sumOf { it.chunks.size }
  val ringSegments: Int get() = ring.size

  init {
    safely("adapter.requestKeyframe") { adapter.requestKeyframe() }
    persist()
  }

  /** The outbox lost a chunk of this stream (evicted, rejected, refused by the receiver). Any thread. */
  fun reportLoss() {
    lossReported = true
  }

  /**
   * The events of one capture, in order. Invalid events (not one JSON object on one line) are
   * dropped and counted, and a new segment is asked for: the payload after them could not be trusted.
   */
  fun append(events: List<ReplayEvent>?) = safely("stream.append") {
    if (ended || events == null) return@safely
    absorbLoss()
    for (e in events) {
      if (!valid(e)) {
        counters.count("replay.invalid_event")
        gap()
        continue
      }
      if (needSegment || segmentDue) {
        if (e.keyframe) {
          closeChunk()
          needSegment = false
          segmentDue = false
          segmentStartedAt = now()
          chunkKeyframe = true
        } else if (needSegment) {
          counters.count("replay.dropped.awaiting_keyframe")
          continue
        }
      }
      write(e)
      if (ended) return@safely
    }
  }

  /** Once a second or so: closes a chunk that is old enough and asks for the periodic keyframe. */
  fun tick() = safely("stream.tick") {
    if (ended) return@safely
    absorbLoss()
    val t = now()
    if (raw.size() > 0 && elapsed(chunkOpenedAt, t) >= cfg.chunkMaxMs) closeChunk()
    if (!needSegment && !segmentDue && elapsed(segmentStartedAt, t) >= segmentIntervalMs()) {
      segmentDue = true
      adapter.requestKeyframe()
    }
  }

  /** Capture stopped for a while or something was lost: what follows starts a new segment with a keyframe (RPL-8). */
  fun markGap() = safely("stream.gap") {
    if (!ended) gap()
  }

  /** The app left the foreground: the open chunk is closed (RPL-10). */
  fun background() = safely("stream.background") {
    if (!ended) closeChunk()
  }

  /** Back in the foreground: a new segment and keyframe (RPL-9). */
  fun foreground() = markGap()

  /** Closes the open chunk now (a flush asked by the host). */
  fun flush() = safely("stream.flush") {
    if (!ended) closeChunk()
  }

  /**
   * Buffer mode: sends the ring and goes on as session mode (SMP-12). [reason] is one of `error`,
   * `crash`, `anr`, `hang`, `manual`; anything else is `manual`. Returns whether this call triggered.
   */
  fun trigger(reason: String?): Boolean = safely("stream.trigger") {
    if (ended || delivery != ReplayDelivery.BUFFER || trigger != null) return@safely false
    closeChunk()
    trigger = if (reason in TRIGGERS) reason else "manual"
    val waiting = ring.flatMap { it.chunks }
    ring.clear()
    ringBytes = 0
    for (p in waiting) {
      emit(p)
      if (ended) break
    }
    persist()
    true
  } ?: false

  /**
   * Ends the stream: closes the open chunk and sends `ouo.replay.ended` (RPL-20). [reason] is one
   * of [END_REASONS], anything else is `error`. A buffer that never triggered sent nothing and ends
   * silently. Further calls do nothing.
   */
  fun end(reason: String) = safely("stream.end") {
    if (ended) return@safely
    if (triggered) closeChunk()
    finish(if (reason in END_REASONS) reason else "error")
  }

  private fun finish(reason: String) {
    if (ended) return
    ended = true
    absorbLoss()
    raw.reset()
    ring.clear()
    ringBytes = 0
    if (triggered) {
      val record = ReplayEnded(lastSession ?: currentSession(), replayId, streamId, !partial, if (nextSequence > 0) nextSequence - 1 else null, reason, now())
      val ok = try {
        sink.ended(record)
      } catch (e: Throwable) {
        counters.error("sink.ended", e)
        false
      }
      if (!ok) counters.count("replay.ended.refused")
    }
    state?.clear()
  }

  private fun gap() {
    closeChunk()
    needSegment = true
    segmentDue = false
    safely("adapter.requestKeyframe") { adapter.requestKeyframe() }
  }

  private fun absorbLoss() {
    if (!lossReported) return
    lossReported = false
    if (!partial) {
      partial = true
      persist()
    }
    if (!ended) gap()
  }

  private fun segmentIntervalMs(): Long =
    if (triggered) cfg.keyframeIntervalMs
    // A ring of whole segments holds up to one segment more than the window: keep segments short.
    else minOf(cfg.keyframeIntervalMs, maxOf(cfg.chunkMaxMs, cfg.bufferSeconds * 1000L / 2))

  private fun elapsed(since: EpochMillis, t: EpochMillis): Long = if (t >= since) t - since else Long.MAX_VALUE // the clock went back: due

  private fun valid(e: ReplayEvent?): Boolean {
    val s = e?.json ?: return false
    return s.length >= 2 && s[0] == '{' && s[s.length - 1] == '}' && s.indexOf('\n') < 0 && s.indexOf('\r') < 0
  }

  private fun currentSession(): String = try {
    sessionId()
  } catch (e: Throwable) {
    counters.error("sessionId", e)
    ""
  }

  private fun write(e: ReplayEvent) {
    if (raw.size() == 0) {
      chunkStart = e.t
      chunkEnd = e.t
      chunkOpenedAt = now()
      chunkSession = currentSession()
      chunkView = viewId
      nextSizeCheck = cfg.chunkMaxBytes
    }
    val bytes = e.json.toByteArray(Charsets.UTF_8)
    raw.write(bytes, 0, bytes.size)
    raw.write('\n'.code)
    if (e.t < chunkStart) chunkStart = e.t
    if (e.t > chunkEnd) chunkEnd = e.t
    if (raw.size() >= nextSizeCheck) {
      // The limit is on compressed bytes: compress what there is; when it is not there yet, look
      // again a quarter of the limit later.
      val body = Gzip.compress(raw.toByteArray())
      if (body.size >= cfg.chunkMaxBytes) closeChunk(body) else nextSizeCheck = raw.size() + maxOf(1024, cfg.chunkMaxBytes / 4)
    }
  }

  private fun closeChunk(compressed: ByteArray? = null) {
    if (raw.size() == 0) return
    val data = raw.toByteArray()
    raw.reset()
    val keyframe = chunkKeyframe
    chunkKeyframe = false
    val bodies = ArrayList<ByteArray>()
    split(data, compressed, bodies)
    bodies.forEachIndexed { i, body ->
      if (ended) return
      val p = Pending(body, keyframe && i == 0, chunkStart, chunkEnd, chunkSession, chunkView)
      if (triggered) emit(p) else hold(p)
    }
  }

  /** [data] as one body, or as halves (and their halves) when its gzip is above the hard limit. */
  private fun split(data: ByteArray, compressed: ByteArray?, out: MutableList<ByteArray>) {
    val body = compressed ?: Gzip.compress(data)
    if (body.size <= cfg.hardLimitBytes || data.size <= 1) {
      out.add(body)
      return
    }
    counters.count("replay.chunk.split")
    val half = data.size / 2
    split(data.copyOfRange(0, half), null, out)
    split(data.copyOfRange(half, data.size), null, out)
  }

  private fun emit(p: Pending) {
    if (p.keyframe) segmentIndex++
    // A ring cut mid-segment cannot happen (whole segments only), but never send index -1.
    if (segmentIndex < 0) segmentIndex = 0
    val sequence = nextSequence++
    lastSession = p.sessionId
    val chunk = ReplayChunk(
      sessionId = p.sessionId,
      replayId = replayId,
      streamId = streamId,
      segmentIndex = segmentIndex,
      sequence = sequence,
      keyframe = p.keyframe,
      startTime = p.start,
      endTime = maxOf(p.end, p.start),
      format = adapter.formatId,
      encoding = "gzip",
      sha256 = Hex.sha256(p.body),
      masked = adapter.masked,
      mode = delivery.wire,
      trigger = if (delivery == ReplayDelivery.BUFFER) trigger else null,
      viewId = p.viewId,
      body = p.body,
    )
    val ok = try {
      sink.chunk(chunk)
    } catch (e: Throwable) {
      counters.error("sink.chunk", e)
      false
    }
    if (ok) {
      refusals = 0
      counters.count("replay.chunk.produced")
    } else {
      // The sequence is spent (never renumbered: RPL-17); the stream is partial and restarts at a keyframe.
      refusals++
      partial = true
      counters.count("replay.chunk.refused")
      needSegment = true
      segmentDue = false
      safely("adapter.requestKeyframe") { adapter.requestKeyframe() }
    }
    persist()
    if (!ok && refusals >= cfg.maxRefusals) {
      // The queue and the store take nothing more: capture stops (RPL-18).
      counters.count("replay.stopped.store_full")
      finish("max_size")
    }
  }

  private fun hold(p: Pending) {
    if (p.keyframe || ring.isEmpty()) ring.add(RingSegment(p.start))
    val seg = ring[ring.size - 1]
    seg.chunks.add(p)
    seg.bytes += p.body.size
    ringBytes += p.body.size
    // Whole segments only, and only while the rest still covers the window (SMP-10).
    val horizon = now() - cfg.bufferSeconds * 1000L
    while (ring.size > 1 && ring[1].start <= horizon) evict("replay.ring.evicted")
    while (ring.size > 1 && ringBytes > cfg.ringMaxBytes) evict("replay.ring.evicted_bytes")
    if (ringBytes > cfg.ringMaxBytes && !segmentDue && !needSegment) {
      // One segment alone is over the bound: start the next one so this one can go.
      segmentDue = true
      safely("adapter.requestKeyframe") { adapter.requestKeyframe() }
    }
  }

  private fun evict(reason: String) {
    val s = ring.removeAt(0)
    ringBytes -= s.bytes
    counters.count(reason, s.chunks.size.toLong())
  }

  private fun persist() {
    val st = state ?: return
    if (ended) return
    val ok = st.write(StreamStateStore.State(lastSession ?: currentSession(), replayId, streamId, nextSequence - 1, partial, triggered))
    if (!ok) counters.count("replay.state.write_failed")
  }

  private inline fun <T> safely(seam: String, block: () -> T): T? =
    try {
      block()
    } catch (e: Throwable) {
      counters.error(seam, e)
      null
    }

  companion object {
    const val HARD_LIMIT = 1024 * 1024
    val TRIGGERS = setOf("error", "crash", "anr", "hang", "manual")
    val END_REASONS = setOf("session_end", "stop", "consent", "background_kill", "crash", "max_size", "error")

    /**
     * The next launch: ends, as `partial`, the stream the previous process left open (RPL-20), then
     * forgets it. [reason] is `background_kill` unless the host knows the process crashed. A buffer
     * that never triggered sent nothing and gets no end record.
     */
    fun endOpenStream(state: StreamStateStore, sink: Sink, reason: String = "background_kill", now: EpochMillis = System.currentTimeMillis()): Boolean {
      val s = state.read() ?: return false
      var sent = false
      if (s.sent) {
        sent = try {
          sink.ended(ReplayEnded(s.sessionId, s.replayId, s.streamId, false, if (s.lastSequence >= 0) s.lastSequence else null, if (reason in END_REASONS) reason else "background_kill", now))
        } catch (e: Throwable) {
          false
        }
      }
      state.clear()
      return sent
    }
  }
}
