package dev.ouo.replay

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Rect
import dev.ouo.replay.core.EpochMillis
import dev.ouo.replay.core.Logger
import dev.ouo.replay.core.ReplayEvent
import dev.ouo.replay.core.ReplayFormatAdapter
import dev.ouo.replay.core.ReplayFormatError
import dev.ouo.replay.core.ReplayJSON
import dev.ouo.replay.core.ReplayLook
import dev.ouo.replay.core.Touch
import dev.ouo.replay.core.VideoFrames
import dev.ouo.replay.core.VideoSegmenter
import dev.ouo.sentrycore.Mp4SegmentWriter
import java.io.File
import kotlin.math.roundToInt

/**
 * The video format, `ouo-video/1` (`replay.mode: "pixel/video"`): the same looks as `ouo-frames/3`
 * ([PixelLook]: the window copied by the frames recorder's capture loop, with the masks its two
 * walks agreed on), masked by the same painter ([ScreenCapturer.paintMasks]) and then scaled to one
 * pixel per dp and encoded by sentry-java's video encoder ([Mp4SegmentWriter]) into fixed-rate mp4
 * segments ([VideoSegmenter], 1 frame/s, 5 s). One segment is one chunk ([ReplayEvent.segment]):
 * a keyframe, a new segment index, `ouo.replay.encoding = identity` (RPL-25), and the body the iOS
 * `VideoFormatAdapter` writes: one JSON header line, a newline, then the mp4 bytes:
 *
 *     {"t":ms,"type":"video","end":ms,"w":px,"h":px,"scale":n,"fps":n,"frames":n,"mp4":bytes,
 *      "touches":[{"t":ms,"x":pt,"y":pt,"phase":"began|moved|ended"}]}\n<mp4>
 *
 * `mp4` is the byte length after the newline; `scale` is video pixels per point (dp); the touches
 * are those made during the segment, in points.
 *
 * Masking is the frames recorder's, decided before anything reaches the encoder: a look whose masks
 * moved during the copy never gets here, and a look that cannot be masked throws (the frame is
 * dropped, PRV-8). What a slot repeats is a frame already masked.
 *
 * Compose thread only (the stream calls it under its lock).
 */
internal class VideoFormatAdapter(
  private val capturer: ScreenCapturer,
  private val directory: File,
  private val debug: Boolean = false,
  private val logger: Logger = Logger.NONE,
  override val masked: Boolean = true,
) : ReplayFormatAdapter {
  override val formatId: String = VideoFrames.FORMAT
  override val encoding: String = VideoFrames.ENCODING
  private val filter = Paint(Paint.FILTER_BITMAP_FLAG)
  private val dst = Rect()

  /** Segments written, for the diagnostics. */
  @Volatile var segments = 0
    private set

  /** Size and frame count of a finished file, for its header. */
  private class Finished(val width: Int, val height: Int, val frames: Int)

  private inner class Mp4Encoder : VideoSegmenter.Encoder<Bitmap> {
    private var writer: Mp4SegmentWriter? = null
    val finished = ArrayDeque<Finished>()

    override fun begin(first: Bitmap) {
      abort()
      // One file per segment: the stream a session rotation ends may still be writing its own.
      writer = Mp4SegmentWriter(File(directory, "segment-${System.nanoTime()}.mp4"), first.width, first.height, debug = debug, log = { logger.log(it) }).also { it.start() }
    }

    override fun encode(frame: Bitmap) {
      val w = writer ?: error("no segment")
      w.encode(frame)
    }

    override fun finish(): ByteArray? {
      val w = writer ?: return null
      writer = null
      return w.finish()?.also {
        segments++
        finished.addLast(Finished(w.width, w.height, w.frameCount))
      }
    }

    override fun abort() {
      writer?.abort()
      writer = null
    }

    override fun release(frame: Bitmap) {
      try {
        if (!frame.isRecycled) frame.recycle()
      } catch (ignored: Throwable) {
      }
    }

    val size: Pair<Int, Int>? get() = writer?.let { it.width to it.height }
  }

  private val encoder = Mp4Encoder()
  private val segmenter = VideoSegmenter(encoder)
  private val touches = ArrayList<Touch>()
  /** Video pixels per point of the open segment's frames. */
  private var videoScale = 1.0

  /** Every segment starts with a keyframe already: nothing to do. */
  override fun requestKeyframe() {}

  /** Touches travel inside the header of the segment they were made in. */
  override fun touchEvent(touch: Touch): ReplayEvent? {
    if (touches.size >= MAX_TOUCHES) touches.removeAt(0)
    touches.add(touch)
    return null
  }

  override fun compress(payload: ByteArray): ByteArray = payload

  override fun events(look: ReplayLook, t: EpochMillis): List<ReplayEvent> {
    val l = look as? PixelLook ?: throw ReplayFormatError(ReplayFormatError.Kind.WRONG_LOOK)
    if (l.bitmap.isRecycled || l.bitmap.width <= 0 || l.bitmap.height <= 0 || !l.scale.isFinite() || l.scale <= 0 || !l.windowScale.isFinite() || l.windowScale <= 0f) {
      throw ReplayFormatError(ReplayFormatError.Kind.ENCODING_FAILED)
    }
    val frame = try {
      capturer.paintMasks(l.bitmap, l.rects, l.windowScale)
      scaled(l)
    } catch (e: Throwable) {
      // Whether the masks were painted is not known: nothing of this bitmap is kept (PRV-8).
      throw ReplayFormatError(ReplayFormatError.Kind.MASKING_FAILED)
    }
    return guarded {
      val out = ArrayList<ReplayEvent>(2)
      // A new size (rotation, split screen) cannot go on in the same file.
      val open = encoder.size
      if (open != null && open != frame.width to frame.height) out.addAll(wrap(segmenter.pending(t, closing = true)))
      videoScale = frame.width / (l.bitmap.width / l.scale)
      out.addAll(wrap(segmenter.add(frame, t)))
      out
    }
  }

  override fun pending(t: EpochMillis, closing: Boolean): List<ReplayEvent> = guarded { wrap(segmenter.pending(t, closing)) }

  /** The segmenter's mp4 files as `ouo-video/1` bodies: the header line, then the file. */
  private fun wrap(segments: List<ReplayEvent>): List<ReplayEvent> {
    if (segments.isEmpty()) return segments
    return segments.map { seg ->
      val f = encoder.finished.removeFirstOrNull() ?: throw ReplayFormatError(ReplayFormatError.Kind.ENCODING_FAILED)
      val mp4 = seg.json
      val inside = touches.filter { it.ts >= seg.t && it.ts < seg.end }
      touches.removeAll { it.ts < seg.end }
      val sb = StringBuilder(160 + 64 * inside.size)
      sb.append("{\"t\":").append(seg.t).append(",\"type\":\"video\",\"end\":").append(seg.end)
      sb.append(",\"w\":").append(f.width).append(",\"h\":").append(f.height).append(",\"scale\":").append(ReplayJSON.number(videoScale))
      sb.append(",\"fps\":").append(1000 / segmenter.stepMs).append(",\"frames\":").append(f.frames).append(",\"mp4\":").append(mp4.size).append(",\"touches\":[")
      inside.forEachIndexed { i, tc ->
        if (i > 0) sb.append(',')
        sb.append("{\"t\":").append(tc.ts).append(",\"x\":").append(ReplayJSON.number(tc.x)).append(",\"y\":").append(ReplayJSON.number(tc.y)).append(",\"phase\":\"").append(tc.phase.wire).append("\"}")
      }
      sb.append("]}\n")
      val header = sb.toString().toByteArray(Charsets.UTF_8)
      ReplayEvent.segment(seg.t, seg.end, header + mp4)
    }
  }

  /** Drops what is open without sending it (consent withdrawn). */
  fun reset() {
    try {
      segmenter.reset()
    } catch (ignored: Throwable) {
    }
    encoder.finished.clear()
    touches.clear()
  }

  /** The encoder failed: the open segment is lost (never half sent) and the next frame starts a new one. */
  private inline fun guarded(block: () -> List<ReplayEvent>): List<ReplayEvent> =
    try {
      block()
    } catch (e: Throwable) {
      reset()
      throw ReplayFormatError(ReplayFormatError.Kind.ENCODING_FAILED)
    }

  /** The masked look at one pixel per dp, sides in 16 px blocks (upstream's video size). */
  private fun scaled(l: PixelLook): Bitmap {
    val windowW = l.bitmap.width / l.windowScale
    val windowH = l.bitmap.height / l.windowScale
    val density = (l.scale / l.windowScale).toFloat()
    val (w, h) = Mp4SegmentWriter.recordingSize(windowW.roundToInt(), windowH.roundToInt(), density)
    val out = Bitmap.createBitmap(w, h, Bitmap.Config.RGB_565)
    dst.set(0, 0, w, h)
    Canvas(out).drawBitmap(l.bitmap, null, dst, filter)
    return out
  }

  companion object {
    /** Touches kept for the open segment (ERR-9); beyond it the oldest go. */
    const val MAX_TOUCHES = 2000
  }
}
