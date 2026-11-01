package dev.ouo.replay

import android.app.Activity
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.view.Gravity
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.widget.EditText
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.ouo.replay.core.Box
import dev.ouo.replay.core.FrameReason
import dev.ouo.replay.core.RedactionPlanner
import dev.ouo.replay.core.TileDiffer
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/** A white screen with a two-line label, an input, an image and an unmasked label (`ouo-unmask`). */
class MaskActivity : Activity() {
  lateinit var label: TextView
  lateinit var input: EditText
  lateinit var image: ImageView
  lateinit var open: TextView

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    fun text(t: String) = TextView(this).apply {
      text = t
      textSize = 28f
      setTextColor(Color.BLACK)
      gravity = Gravity.START
    }
    label = text("Secret label text\nab")
    input = EditText(this).apply { setText("typed secret") }
    image = ImageView(this).apply { setImageDrawable(ColorDrawable(Color.RED)) }
    open = text("Public text").apply { tag = "ouo-unmask" }
    setContentView(
      LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        setBackgroundColor(Color.WHITE)
        addView(label, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
        addView(input, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
        addView(image, LinearLayout.LayoutParams(300, 300))
        addView(open, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
      }
    )
  }
}

/**
 * The pixel test of the capture (spec C8: no masked content is readable in a frame): the real
 * walk, plan, `PixelCopy` into RGB_565 and JPEG encoding on a device, then the decoded frame is
 * measured where each view is. Runs on an emulator (`./gradlew :replay:connectedAndroidTest`).
 */
@RunWith(AndroidJUnit4::class)
class MaskPixelTest {
  private class Shot(val frame: Bitmap, val scale: Float, val rects: List<Box>)

  private fun capture(activity: MaskActivity): Shot {
    val main = Handler(Looper.getMainLooper())
    val done = CountDownLatch(1)
    var shot: Shot? = null
    main.post {
      val target = WindowSpy.captureTarget(activity)!!
      val root = target.root
      val rects = RedactionPlanner().rects(ViewWalker().walk(root), Box(0f, 0f, root.width.toFloat(), root.height.toFloat()))
      val capturer = ScreenCapturer(1000, 50)
      val bmp = capturer.bitmapFor(root.width, root.height)
      assertEquals(Bitmap.Config.RGB_565, bmp.config)
      val scale = bmp.width.toFloat() / root.width
      capturer.copy(target, bmp, main) { ok ->
        assertTrue("PixelCopy failed", ok)
        val made = capturer.compose(bmp, rects, scale, TileDiffer(), true, 0L, FrameReason.TIMER) as ScreenCapturer.Result.Made
        val bytes = Base64.decode(made.frame.jpeg, Base64.DEFAULT)
        assertEquals(0xFF.toByte(), bytes[0])
        assertEquals(0xD8.toByte(), bytes[1])
        shot = Shot(BitmapFactory.decodeByteArray(bytes, 0, bytes.size), scale, rects)
        done.countDown()
      }
    }
    assertTrue(done.await(10, TimeUnit.SECONDS))
    return shot!!
  }

  /** Mean brightness 0 (black) to 1 (white) of a window rectangle's centre half in the frame. */
  private fun mean(s: Shot, l: Int, t: Int, r: Int, b: Int): Double {
    val x0 = ((l + (r - l) / 4) * s.scale).toInt()
    val x1 = ((r - (r - l) / 4) * s.scale).toInt()
    val y0 = ((t + (b - t) / 4) * s.scale).toInt()
    val y1 = ((b - (b - t) / 4) * s.scale).toInt()
    var sum = 0.0
    var n = 0
    for (y in y0 until maxOf(y0 + 1, y1)) for (x in x0 until maxOf(x0 + 1, x1)) {
      val c = s.frame.getPixel(x, y)
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
  fun masksTextPerLineInputsAndImagesButNotUnmaskedViews() {
    ActivityScenario.launch(MaskActivity::class.java).use { scenario ->
      Thread.sleep(1000)
      var activity: MaskActivity? = null
      scenario.onActivity { activity = it }
      val a = activity!!
      val s = capture(a)
      assertNotNull(s.frame)
      val label = box(a.label)
      val layout = a.label.layout
      val top = label[1] + a.label.totalPaddingTop
      val line1End = label[0] + a.label.totalPaddingLeft + layout.getLineRight(0).toInt()
      val line2End = label[0] + a.label.totalPaddingLeft + layout.getLineRight(1).toInt()
      // Both lines of the label are black where their text is.
      assertTrue(mean(s, label[0], top + layout.getLineTop(0), line1End, top + layout.getLineBottom(0)) < 0.15)
      assertTrue(mean(s, label[0], top + layout.getLineTop(1), line2End, top + layout.getLineBottom(1)) < 0.15)
      // Per-line masks: right of the short second line the white background stays visible.
      assertTrue(mean(s, line2End + 40, top + layout.getLineTop(1), label[2] - 40, top + layout.getLineBottom(1)) > 0.85)
      // The input and the image are masked whole.
      val input = box(a.input)
      assertTrue(mean(s, input[0], input[1], input[2], input[3]) < 0.15)
      val image = box(a.image)
      assertTrue(mean(s, image[0], image[1], image[2], image[3]) < 0.15)
      // The ouo-unmask label is not masked: mostly white with dark glyphs.
      val open = box(a.open)
      assertTrue(mean(s, open[0], open[1], open[2], open[3]) > 0.5)
    }
  }
}
