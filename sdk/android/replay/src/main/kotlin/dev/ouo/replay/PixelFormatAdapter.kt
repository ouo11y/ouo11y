package dev.ouo.replay

import android.graphics.Bitmap
import dev.ouo.replay.core.Box
import dev.ouo.replay.core.EpochMillis
import dev.ouo.replay.core.FrameReason
import dev.ouo.replay.core.PixelFrames
import dev.ouo.replay.core.ReplayEvent
import dev.ouo.replay.core.ReplayFormatAdapter
import dev.ouo.replay.core.ReplayFormatError
import dev.ouo.replay.core.ReplayLook
import dev.ouo.replay.core.TileDiffer

/**
 * One look of the pixel format: the window as it was copied (unredacted), the rectangles the
 * redaction plan wants painted (window pixels) and the scales of the bitmap. The raw image never
 * leaves the adapter.
 */
internal class PixelLook(
  val bitmap: Bitmap,
  val rects: List<Box>,
  /** Bitmap pixels per window pixel (the frame is downscaled to `maxLongestSide`). */
  val windowScale: Float,
  /** Bitmap pixels per point (dp): the `scale` of the frame event. */
  val scale: Double,
  val reason: FrameReason,
) : ReplayLook

/**
 * The pixel format, `ouo-frames/3` ([PixelFrames]): masked JPEG full frames and tile patches as
 * newline-delimited JSON events. The Android twin of the Swift `PixelFormatAdapter`.
 *
 * Masking: the rectangles are painted black on the bitmap before anything is hashed or encoded
 * ([ScreenCapturer.compose]); when that or the encoding fails the look throws and the frame is
 * dropped (PRV-8). The recorder has already dropped a look whose masks moved while the GPU copied.
 * Compose thread only (the stream calls it under its lock).
 */
internal class PixelFormatAdapter(private val capturer: ScreenCapturer, override val masked: Boolean = true) : ReplayFormatAdapter {
  override val formatId: String = PixelFrames.FORMAT
  private val differ = TileDiffer()

  /** The differ forgets the last frame sent, so the next one is a full image even when unchanged. */
  override fun requestKeyframe() = differ.reset()

  override fun events(look: ReplayLook, t: EpochMillis): List<ReplayEvent> {
    val l = look as? PixelLook ?: throw ReplayFormatError(ReplayFormatError.Kind.WRONG_LOOK)
    if (l.bitmap.isRecycled || l.bitmap.width <= 0 || l.bitmap.height <= 0 || !l.scale.isFinite() || l.scale <= 0) throw ReplayFormatError(ReplayFormatError.Kind.ENCODING_FAILED)
    val result = try {
      capturer.compose(l.bitmap, l.rects, l.windowScale, differ, false, t, l.reason)
    } catch (e: Throwable) {
      // Whether the masks were painted is not known: nothing of this bitmap is sent (PRV-8). Counted as an error (ERR-6).
      throw ReplayFormatError(ReplayFormatError.Kind.ENCODING_FAILED)
    }
    return when (result) {
      is ScreenCapturer.Result.Made -> listOf(PixelFrames.event(result.frame, l.bitmap.width, l.bitmap.height, l.scale))
      ScreenCapturer.Result.Unchanged -> emptyList()
      ScreenCapturer.Result.Failed -> throw ReplayFormatError(ReplayFormatError.Kind.ENCODING_FAILED)
    }
  }
}
