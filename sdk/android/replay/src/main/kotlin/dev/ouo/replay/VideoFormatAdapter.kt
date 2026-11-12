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
 * a keyframe, a new segment index, the mp4 bytes alone with `ouo.replay.encoding = identity` (RPL-25).
 *
 * Masking is the frames recorder's, decided before anything reaches the encoder: a look whose masks
 * moved during the copy never gets here, and a look that cannot be masked throws (the frame is
 * dropped, PRV-8). What a slot repeats is a frame already masked. Touches are not recorded.
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

  private inner class Mp4Encoder : VideoSegmenter.Encoder<Bitmap> {
    private var writer: Mp4SegmentWriter? = null

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
      return w.finish()?.also { segments++ }
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

  /** Every segment starts with a keyframe already: nothing to do. */
  override fun requestKeyframe() {}

  override fun touchEvent(touch: Touch): ReplayEvent? = null

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
      if (open != null && open != frame.width to frame.height) out.addAll(segmenter.pending(t, closing = true))
      out.addAll(segmenter.add(frame, t))
      out
    }
  }

  override fun pending(t: EpochMillis, closing: Boolean): List<ReplayEvent> = guarded { segmenter.pending(t, closing) }

  /** Drops what is open without sending it (consent withdrawn). */
  fun reset() {
    try {
      segmenter.reset()
    } catch (ignored: Throwable) {
    }
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
}
