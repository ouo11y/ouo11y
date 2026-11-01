package dev.ouo.replay

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.os.Build
import android.os.Handler
import android.view.PixelCopy
import dev.ouo.replay.core.Box
import dev.ouo.replay.core.Frame
import dev.ouo.replay.core.FrameReason
import dev.ouo.replay.core.Patch
import dev.ouo.replay.core.TileDiffer
import java.io.ByteArrayOutputStream
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * Copies a window into an RGB_565 bitmap at the frame size and turns it into a frame.
 *
 * - [copy] (main thread): `PixelCopy.request(Window)` (Android 8+): the GPU reads the window's
 *   surface and scales it into the bitmap, so the main thread only issues the request. RGB_565 is
 *   half the memory and half the bytes to hash of ARGB_8888. Before Android 8, or for a root
 *   without a `Window`, the view tree is drawn into the bitmap in software.
 * - [compose] (compose thread): paints the masks black, hashes the 64 px tiles against the last
 *   frame sent and encodes a full JPEG or one JPEG per changed rectangle (ADR-0014).
 */
internal class ScreenCapturer(private val maxLongestSide: Int, private val jpegQuality: Int) {
  private var bitmap: Bitmap? = null
  private var pixels = ByteArray(0)
  private val black = Paint().apply { color = 0xFF000000.toInt() }

  /** Frame pixels per window pixel for a window of [w] x [h]. */
  fun scale(w: Int, h: Int): Float = minOf(1f, maxLongestSide.toFloat() / max(w, h))

  /** The bitmap a copy of a [w] x [h] window lands in, reused while the size stays. */
  fun bitmapFor(w: Int, h: Int): Bitmap {
    val s = scale(w, h)
    val fw = max(1, (w * s).roundToInt())
    val fh = max(1, (h * s).roundToInt())
    bitmap?.let { if (it.width == fw && it.height == fh) return it }
    bitmap?.recycle()
    return Bitmap.createBitmap(fw, fh, Bitmap.Config.RGB_565).also { bitmap = it }
  }

  /** Copies [target] into [dest]; [done] runs on [handler] with whether it worked. */
  fun copy(target: WindowSpy.Target, dest: Bitmap, handler: Handler, done: (Boolean) -> Unit) {
    val window = target.window
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && window != null) {
      try {
        PixelCopy.request(window, dest, { result -> done(result == PixelCopy.SUCCESS) }, handler)
        return
      } catch (e: IllegalArgumentException) {
        // The window has no surface yet (being created or torn down): drop this frame.
        handler.post { done(false) }
        return
      }
    }
    val ok = runCatching {
      val canvas = Canvas(dest)
      canvas.scale(dest.width.toFloat() / target.root.width, dest.height.toFloat() / target.root.height)
      target.root.draw(canvas)
    }.isSuccess
    handler.post { done(ok) }
  }

  sealed class Result {
    class Made(val frame: Frame) : Result()

    object Unchanged : Result()

    object Failed : Result()
  }

  /** Masks, diffs and encodes [bmp]. [rects] are in window pixels; [scale] is frame per window pixel. */
  fun compose(bmp: Bitmap, rects: List<Box>, scale: Float, differ: TileDiffer, forceFull: Boolean, ts: Long, reason: FrameReason): Result {
    if (rects.isNotEmpty()) {
      val canvas = Canvas(bmp)
      for (r in rects) canvas.drawRect(r.left * scale, r.top * scale, r.right * scale, r.bottom * scale, black)
    }
    val size = bmp.rowBytes * bmp.height
    if (pixels.size != size) pixels = ByteArray(size)
    bmp.copyPixelsToBuffer(java.nio.ByteBuffer.wrap(pixels))
    val frame = when (val d = differ.diff(pixels, bmp.width, bmp.height, bmp.rowBytes, 2, forceFull)) {
      TileDiffer.Decision.Unchanged -> return Result.Unchanged
      TileDiffer.Decision.Full -> Frame.full(ts, jpeg(bmp) ?: return Result.Failed, reason)
      is TileDiffer.Decision.Patches -> {
        val patches = d.rects.map { r ->
          val tile = Bitmap.createBitmap(bmp, r.x, r.y, r.w, r.h)
          val bytes = jpeg(tile)
          if (tile !== bmp) tile.recycle()
          Patch(r, bytes ?: return Result.Failed)
        }
        Frame.patches(ts, patches, reason)
      }
    }
    differ.commit()
    return Result.Made(frame)
  }

  private fun jpeg(bmp: Bitmap): ByteArray? {
    val out = ByteArrayOutputStream(64 * 1024)
    return if (bmp.compress(Bitmap.CompressFormat.JPEG, jpegQuality, out)) out.toByteArray() else null
  }
}
