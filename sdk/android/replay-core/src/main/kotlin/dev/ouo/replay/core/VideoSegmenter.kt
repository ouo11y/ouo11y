package dev.ouo.replay.core

/**
 * The video format, `ouo-video/1` (`replay.mode: "pixel/video"`, ADR-0021 decision 5): every chunk
 * is one self-contained mp4 segment (H.264, starts with a keyframe), the body is the mp4 bytes
 * alone and `ouo.replay.encoding` is `identity` (mp4 does not compress further). Touches are not in
 * the body: a file has no room for lines.
 */
object VideoFrames {
  const val FORMAT = "ouo-video/1"
  const val ENCODING = "identity"
}

/**
 * Turns masked frames taken whenever the screen changed into fixed-rate video segments, the way
 * sentry-java's `ReplayCache.createVideoOf` fills its 1 frame/s slots (a slot shows the newest frame
 * taken before it ends, or repeats the one before), but as frames come instead of from a store on
 * disk, so no frame waits in memory beyond the one on screen. Plain Kotlin: the encoder is behind
 * [Encoder], so the timing is tested on the JVM.
 *
 * - A segment starts with the first frame after a pause (or the carried frame of the segment before)
 *   and holds [segmentMs] / [stepMs] slots; full, it is finished and handed out.
 * - A segment that received no new frame (a static screen) is dropped instead of sent: the screen
 *   is what the last segment ended on, like `ouo-frames/3`, which sends nothing for an unchanged screen.
 * - [pending] with `closing` finishes what is open at once (flush, background, end).
 *
 * Not thread-safe: the stream calls it under its lock (through the adapter).
 */
class VideoSegmenter<F : Any>(
  private val encoder: Encoder<F>,
  val stepMs: Long = 1000,
  val segmentMs: Long = 5000,
) {
  /** One mp4 being written. Every method may throw: the segment is then lost, never half sent. */
  interface Encoder<F> {
    /** Opens a new file for frames like [first]. */
    fun begin(first: F)

    /** Appends one slot showing [frame]. */
    fun encode(frame: F)

    /** Finishes the file and returns its bytes; null when it holds nothing playable. */
    fun finish(): ByteArray?

    /** Drops the file being written. Never throws. */
    fun abort()

    /** [frame] is no longer needed (replaced or dropped). Never throws. */
    fun release(frame: F)
  }

  private var start = 0L
  private var open = false
  private var slots = 0
  /** New frames in the open segment, beyond the carried one. */
  private var fresh = 0
  private var last: F? = null

  /** Slots per segment. */
  val slotsPerSegment: Int get() = maxOf(1, (segmentMs / stepMs).toInt())

  /** A new masked frame taken at [t]. Returns the segments it completed. */
  fun add(frame: F, t: EpochMillis): List<ReplayEvent> {
    val out = ArrayList<ReplayEvent>(1)
    if (open) fill(t, out)
    val previous = last
    last = frame
    if (previous != null && previous !== frame) encoder.release(previous)
    if (!open) {
      begin(t)
      fresh = 1
    } else {
      fresh++
    }
    return out
  }

  /** What is complete at [t]; with [closing], everything open, complete or not (the frame on screen ends it). */
  fun pending(t: EpochMillis, closing: Boolean): List<ReplayEvent> {
    val out = ArrayList<ReplayEvent>(1)
    if (!open) {
      if (closing) drop()
      return out
    }
    fill(t, out)
    if (closing && open) {
      // The frame on screen gets its slot even when the slot is not over yet.
      if (slots == 0 || t > start + slots * stepMs) slot()
      close(out, carry = false)
    }
    if (closing) drop()
    return out
  }

  /** Forgets everything open (consent withdrawn, the stream ended without its record). */
  fun reset() {
    if (open) encoder.abort()
    open = false
    drop()
  }

  /** Writes every slot that ended by [t]; a full segment closes and the next one carries the frame on screen. */
  private fun fill(t: EpochMillis, out: MutableList<ReplayEvent>) {
    while (open && start + (slots + 1) * stepMs <= t) {
      slot()
      if (slots >= slotsPerSegment) {
        val hadNew = fresh > 0
        close(out, carry = hadNew)
        // A segment with nothing new is the end of activity: wait for the next frame.
        if (!hadNew) {
          drop()
          return
        }
      }
    }
  }

  private fun begin(t: EpochMillis) {
    val first = last ?: return
    start = t
    slots = 0
    fresh = 0
    encoder.begin(first)
    open = true
  }

  private fun slot() {
    val frame = last ?: return
    encoder.encode(frame)
    slots++
  }

  private fun close(out: MutableList<ReplayEvent>, carry: Boolean) {
    val end = start + slots * stepMs
    open = false
    val worthSending = fresh > 0 && slots > 0
    if (!worthSending) {
      encoder.abort()
    } else {
      val bytes = try {
        encoder.finish()
      } catch (e: Throwable) {
        encoder.abort()
        throw e
      }
      if (bytes != null && bytes.isNotEmpty()) out.add(ReplayEvent.segment(start, end, bytes))
    }
    if (carry && last != null) {
      begin(end)
    }
  }

  private fun drop() {
    last?.let { encoder.release(it) }
    last = null
  }
}
