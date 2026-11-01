package dev.ouo.replay.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class DiffAndPlanTest {
  /** RGB_565 frame: 2 bytes per pixel, rows padded to [rowBytes]. */
  private fun frame(w: Int, h: Int, rowBytes: Int = w * 2, paint: (Int, Int) -> Int = { _, _ -> 0 }): ByteArray {
    val b = ByteArray(rowBytes * h)
    for (y in 0 until h) for (x in 0 until w) {
      val v = paint(x, y)
      b[y * rowBytes + x * 2] = v.toByte()
      b[y * rowBytes + x * 2 + 1] = (v shr 8).toByte()
    }
    return b
  }

  @Test
  fun unchangedFullAndPatches() {
    val d = TileDiffer()
    val w = 300
    val h = 600
    val a = frame(w, h)
    assertEquals(TileDiffer.Decision.Full, d.diff(a, w, h, w * 2, 2, forceFull = false))
    d.commit()
    assertEquals(TileDiffer.Decision.Unchanged, d.diff(a, w, h, w * 2, 2, forceFull = false))
    // One pixel in the second tile row, and a block across two tiles of the last (partial) column.
    val b = frame(w, h) { x, y -> if ((x == 10 && y == 70) || (x in 260..299 && y in 130..140)) 0xffff else 0 }
    val dec = d.diff(b, w, h, w * 2, 2, forceFull = false)
    assertEquals(TileDiffer.Decision.Patches(listOf(PixelRect(0, 64, 64, 64), PixelRect(256, 128, 44, 64))), dec)
    assertEquals("forceFull turns a change into a full image", TileDiffer.Decision.Full, d.diff(b, w, h, w * 2, 2, forceFull = true))
    // Not committed: the next frame is still compared with `a`.
    assertTrue(d.diff(b, w, h, w * 2, 2, forceFull = false) is TileDiffer.Decision.Patches)
    d.commit()
    assertEquals(TileDiffer.Decision.Unchanged, d.diff(b, w, h, w * 2, 2, forceFull = false))
  }

  @Test
  fun largeChangesPaddingAndSizeChanges() {
    val d = TileDiffer()
    val w = 256
    val h = 256
    // Row padding must not count: the same pixels with different padding bytes are unchanged.
    d.diff(frame(w, h, rowBytes = w * 2 + 8), w, h, w * 2 + 8, 2, false)
    d.commit()
    val padded = frame(w, h, rowBytes = w * 2 + 8).also { for (y in 0 until h) it[y * (w * 2 + 8) + w * 2] = 7 }
    assertEquals(TileDiffer.Decision.Unchanged, d.diff(padded, w, h, w * 2 + 8, 2, false))
    val most = frame(w, h, rowBytes = w * 2 + 8) { _, y -> if (y < 200) 1 else 0 }
    assertEquals("more than half changed: full", TileDiffer.Decision.Full, d.diff(most, w, h, w * 2 + 8, 2, false))
    assertEquals("a new size is a full image", TileDiffer.Decision.Full, d.diff(frame(128, 128), 128, 128, 256, 2, false))
  }

  @Test
  fun mergeMakesNonOverlappingRectangles() {
    // 4 x 3 tiles: an L shape and a lone tile.
    val c = booleanArrayOf(
      true, true, false, false,
      true, true, false, true,
      true, false, false, false,
    )
    assertEquals(listOf(PixelRect(0, 0, 2, 2), PixelRect(3, 1, 1, 1), PixelRect(0, 2, 1, 1)).sortedWith(compareBy({ it.y }, { it.x })), TileDiffer.merge(c, 4, 3))
  }

  private val window = Box(0f, 0f, 1080f, 2400f)

  private fun node(cls: String, box: Box, supers: List<String> = emptyList(), tag: String? = null, lines: List<Box>? = null, children: List<ViewNode> = emptyList(), hidden: Boolean = false) =
    ViewNode(cls, supers, box, hidden = hidden, tag = tag, textLines = lines, children = children)

  @Test
  fun plannerMasksTextPerLineAndInputsWhole() {
    val text = node(
      "com.facebook.react.views.text.ReactTextView", Box(0f, 100f, 1000f, 300f),
      supers = listOf("androidx.appcompat.widget.AppCompatTextView", "android.widget.TextView"),
      lines = listOf(Box(10f, 100f, 400f, 150f), Box(10f, 150f, 200f, 200f)),
    )
    val input = node("com.facebook.react.views.textinput.ReactEditText", Box(0f, 400f, 1000f, 500f), supers = listOf("androidx.appcompat.widget.AppCompatEditText", "android.widget.EditText", "android.widget.TextView"))
    val image = node("com.facebook.react.views.image.ReactImageView", Box(0f, 600f, 500f, 900f), supers = listOf("android.widget.ImageView"))
    val root = node("android.widget.FrameLayout", window, children = listOf(text, input, image))
    assertEquals(
      listOf(Box(10f, 100f, 400f, 150f), Box(10f, 150f, 200f, 200f), Box(0f, 400f, 1000f, 500f), Box(0f, 600f, 500f, 900f)),
      RedactionPlanner().rects(root, window),
    )
    // maskText off keeps inputs masked; maskInputs off keeps labels masked.
    assertEquals(listOf(Box(0f, 400f, 1000f, 500f), Box(0f, 600f, 500f, 900f)), RedactionPlanner(RedactionRules(maskText = false)).rects(root, window))
    assertEquals(2, RedactionPlanner(RedactionRules(maskInputs = false, maskImages = false)).rects(root, window).size)
    // Unknown layout: the whole text view; no text: nothing.
    assertEquals(listOf(Box(0f, 100f, 1000f, 300f)), RedactionPlanner().rects(text.copy(textLines = null), window))
    assertEquals(emptyList<Box>(), RedactionPlanner().rects(text.copy(textLines = emptyList()), window))
  }

  @Test
  fun plannerOverridesAndVisibility() {
    val label = node("android.widget.TextView", Box(0f, 0f, 100f, 50f), lines = listOf(Box(0f, 0f, 80f, 50f)))
    val forced = node("android.view.ViewGroup", Box(0f, 100f, 300f, 200f), tag = "ouo-mask", children = listOf(label.copy(frame = Box(0f, 100f, 100f, 150f))))
    val unmasked = node("android.view.ViewGroup", Box(0f, 300f, 300f, 400f), tag = "ouo-unmask", children = listOf(label))
    val hidden = node("android.widget.ImageView", Box(0f, 500f, 100f, 600f), hidden = true)
    val offscreen = node("android.widget.ImageView", Box(-200f, 500f, -100f, 600f))
    val clipped = node("android.webkit.WebView", Box(1000f, 2300f, 1200f, 2600f))
    val video = node("com.example.VideoView", Box(0f, 700f, 500f, 900f), supers = listOf("android.view.TextureView"))
    val root = node("android.widget.FrameLayout", window, children = listOf(forced, unmasked, hidden, offscreen, clipped, video))
    assertEquals(
      listOf(Box(0f, 100f, 300f, 200f), Box(1000f, 2300f, 1080f, 2400f), Box(0f, 700f, 500f, 900f)),
      RedactionPlanner(RedactionRules(maskText = false)).rects(root, window),
    )
    // A truncated subtree is masked whole, whatever the rules.
    val deep = node("android.view.ViewGroup", Box(0f, 0f, 50f, 50f)).copy(truncated = true)
    assertEquals(listOf(Box(0f, 0f, 50f, 50f)), RedactionPlanner(RedactionRules(false, false, false, false)).rects(deep, window))
    // Compose draws in one view the walk cannot see into: masked whole with text, not with text off.
    val compose = node("androidx.compose.ui.platform.AndroidComposeView", Box(0f, 0f, 1080f, 1200f), supers = listOf("android.view.ViewGroup"))
    assertEquals(listOf(Box(0f, 0f, 1080f, 1200f)), RedactionPlanner().rects(compose, window))
    assertEquals(emptyList<Box>(), RedactionPlanner(RedactionRules(maskText = false)).rects(compose, window))
    // Overlapping rectangles are merged.
    assertEquals(listOf(Box(0f, 0f, 20f, 20f)), RedactionPlanner.merge(listOf(Box(0f, 0f, 10f, 10f), Box(5f, 5f, 20f, 20f))))
  }
}
