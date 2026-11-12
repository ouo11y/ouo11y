package dev.ouo.replay

import android.graphics.Bitmap
import android.graphics.Color
import android.media.MediaMetadataRetriever
import android.os.Handler
import android.os.Looper
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import dev.ouo.replay.core.Box
import dev.ouo.replay.core.FrameReason
import dev.ouo.replay.core.RedactionPlanner
import dev.ouo.replay.core.RedactionRules
import dev.ouo.replay.core.ReplayMaskRegistry
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The pixel test of `pixel/video` (spec C8): the frames recorder's walk, plan and `PixelCopy`, then
 * [VideoFormatAdapter] (the shared mask painter, the scale to dp, sentry-java's encoder), and the
 * mp4 decoded back. Masking parity: what `MaskPixelTest` finds masked in a JPEG frame is masked in
 * the video, including a `mask(reactTag)` override through [ReplayMaskRegistry].
 */
@RunWith(AndroidJUnit4::class)
class VideoMaskPixelTest {
  private val dir = File(InstrumentationRegistry.getInstrumentation().targetContext.cacheDir, "video-mask-test")

  private class Shot(val frame: Bitmap, val scale: Float)

  private fun record(activity: MaskActivity): Shot {
    val main = Handler(Looper.getMainLooper())
    val done = CountDownLatch(1)
    var shot: Shot? = null
    var failure: Throwable? = null
    main.post {
      val target = WindowSpy.captureTarget(activity)!!
      val root = target.root
      val rects = RedactionPlanner(RedactionRules(strict = true)).rects(ViewWalker().walk(root), Box(0f, 0f, root.width.toFloat(), root.height.toFloat()))
      val capturer = ScreenCapturer(1000, 50)
      val bmp = capturer.bitmapFor(root.width, root.height)
      val windowScale = bmp.width.toFloat() / root.width
      val density = activity.resources.displayMetrics.density
      capturer.copy(target, bmp, main) { ok ->
        try {
          assertTrue("PixelCopy failed", ok)
          val adapter = VideoFormatAdapter(capturer, dir)
          assertTrue(adapter.events(PixelLook(bmp, rects, windowScale, windowScale * density.toDouble(), FrameReason.TIMER), 10_000).isEmpty())
          val seg = adapter.pending(11_500, closing = true).single()
          assertTrue(seg.segment && seg.keyframe)
          assertEquals("ftyp", String(seg.json, 4, 4, Charsets.US_ASCII))
          val f = File(dir, "out.mp4").apply { writeBytes(seg.json) }
          val r = MediaMetadataRetriever()
          r.setDataSource(f.path)
          val frame = r.getFrameAtIndex(0)!!
          r.release()
          f.delete()
          shot = Shot(frame, frame.width.toFloat() / root.width)
        } catch (e: Throwable) {
          failure = e
        }
        done.countDown()
      }
    }
    assertTrue(done.await(20, TimeUnit.SECONDS))
    failure?.let { throw it }
    return shot!!
  }

  private fun mean(s: Shot, l: Int, t: Int, r: Int, b: Int): Double {
    val x0 = ((l + (r - l) / 4) * s.scale).toInt()
    val x1 = ((r - (r - l) / 4) * s.scale).toInt()
    val y0 = ((t + (b - t) / 4) * s.scale).toInt()
    val y1 = ((b - (b - t) / 4) * s.scale).toInt()
    var sum = 0.0
    var n = 0
    for (y in y0 until maxOf(y0 + 1, y1)) for (x in x0 until maxOf(x0 + 1, x1)) {
      val c = s.frame.getPixel(x.coerceAtMost(s.frame.width - 1), y.coerceAtMost(s.frame.height - 1))
      sum += (Color.red(c) + Color.green(c) + Color.blue(c)) / (3 * 255.0)
      n++
    }
    return sum / n
  }

  private fun box(v: android.view.View): IntArray {
    val loc = IntArray(2)
    v.getLocationInWindow(loc)
    return intArrayOf(loc[0], loc[1], loc[0] + v.width, loc[1] + v.height)
  }

  @Test
  fun masksLikeTheFramesRecorderInTheDecodedVideo() {
    ReplayMaskRegistry.shared.reset()
    ActivityScenario.launch(MaskActivity::class.java).use { scenario ->
      Thread.sleep(1000)
      var activity: MaskActivity? = null
      scenario.onActivity { activity = it }
      val a = activity!!
      val s = record(a)
      val label = box(a.label)
      val layout = a.label.layout
      val top = label[1] + a.label.totalPaddingTop
      val line1End = label[0] + a.label.totalPaddingLeft + layout.getLineRight(0).toInt()
      assertTrue(mean(s, label[0], top + layout.getLineTop(0), line1End, top + layout.getLineBottom(0)) < 0.15)
      val input = box(a.input)
      assertTrue(mean(s, input[0], input[1], input[2], input[3]) < 0.15)
      val image = box(a.image)
      assertTrue(mean(s, image[0], image[1], image[2], image[3]) < 0.15)
      val open = box(a.open)
      assertTrue("ouo-unmask stays visible", mean(s, open[0], open[1], open[2], open[3]) > 0.5)
    }
  }

  @Test
  fun maskByReactTagWinsOverTheUnmaskTag() {
    ReplayMaskRegistry.shared.reset()
    ActivityScenario.launch(MaskActivity::class.java).use { scenario ->
      Thread.sleep(1000)
      var activity: MaskActivity? = null
      scenario.onActivity {
        activity = it
        it.open.id = 4242
        ReplayMaskRegistry.shared.mask(4242)
      }
      Thread.sleep(300)
      val a = activity!!
      val s = record(a)
      val open = box(a.open)
      assertTrue("mask(reactTag) masks an ouo-unmask view", mean(s, open[0], open[1], open[2], open[3]) < 0.15)
    }
    ReplayMaskRegistry.shared.reset()
  }
}
