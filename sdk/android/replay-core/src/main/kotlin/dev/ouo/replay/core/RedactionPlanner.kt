package dev.ouo.replay.core

/** A rectangle in window pixels, origin top-left. */
data class Box(val left: Float, val top: Float, val right: Float, val bottom: Float) {
  val isEmpty: Boolean get() = right <= left || bottom <= top
  val width: Float get() = right - left
  val height: Float get() = bottom - top

  fun intersect(o: Box): Box = Box(maxOf(left, o.left), maxOf(top, o.top), minOf(right, o.right), minOf(bottom, o.bottom))

  fun intersects(o: Box): Boolean = !intersect(o).isEmpty

  fun union(o: Box): Box = Box(minOf(left, o.left), minOf(top, o.top), maxOf(right, o.right), maxOf(bottom, o.bottom))

  fun offset(dx: Float, dy: Float) = Box(left + dx, top + dy, right + dx, bottom + dy)
}

/**
 * Platform-neutral snapshot of one view, built by the Android walk (`ViewWalker`); tests build
 * trees by hand. [frame] is the view's bounds in window pixels.
 */
data class ViewNode(
  val className: String,
  /** Superclass names, nearest first, so a `ReactEditText` is masked by the `EditText` rule. */
  val superclassNames: List<String> = emptyList(),
  val frame: Box,
  val hidden: Boolean = false,
  val alpha: Float = 1f,
  /** The view's string tag (React Native `testID`, or `view.tag = "ouo-mask"` in a native app). */
  val tag: String? = null,
  /**
   * For text views: the box of every laid-out line in window pixels, so only the text is masked
   * and not the whole view (per-line text masks). Null when unknown: the whole frame is masked.
   * Empty when the view shows no text.
   */
  val textLines: List<Box>? = null,
  /** The walk stopped at its depth limit with children left unvisited: masked whole. */
  val truncated: Boolean = false,
  val children: List<ViewNode> = emptyList(),
)

/** Which classes get redacted (docs/specs/mobile-replay.md, capture rules for Android) and the override tags. */
data class RedactionRules(
  val maskText: Boolean = true,
  val maskInputs: Boolean = true,
  val maskImages: Boolean = true,
  val maskWebViews: Boolean = true,
  val extraClasses: Set<String> = emptySet(),
) {
  /** True when any rule masks (the chunk's `masked` flag). */
  val masksAnything: Boolean get() = maskText || maskInputs || maskImages || maskWebViews || extraClasses.isNotEmpty()

  companion object {
    const val MASK_TAG = "ouo-mask"
    const val UNMASK_TAG = "ouo-unmask"

    /** Text inputs, React Native's `ReactEditText` included (it extends `EditText`). Governed by `maskInputs` alone. */
    val inputClasses = setOf("android.widget.EditText")

    /**
     * Displayed text: `TextView` (React Native's `ReactTextView`, buttons and AppCompat views extend
     * it) and React Native's `PreparedLayoutTextView`, a `ViewGroup` that draws a text layout.
     * Jetpack Compose draws a whole hierarchy in one `AndroidComposeView` that the view walk cannot
     * see into: it is masked whole (fails closed) until the Compose semantics walk lands.
     */
    val textClasses = setOf(
      "android.widget.TextView",
      "com.facebook.react.views.text.PreparedLayoutTextView",
      "androidx.compose.ui.platform.AndroidComposeView",
    )

    /** `ImageView` covers React Native's `ReactImageView` (Fresco's `DraweeView` extends it). */
    val imageClasses = setOf("android.widget.ImageView")
    val webViewClasses = setOf("android.webkit.WebView")
  }
}

/**
 * Computes the rectangles (window pixels) to paint black before a frame is encoded. The rules of
 * the Swift `RedactionPlanner` of `sdk/ios` for the Android view classes, plus per-line text masks.
 * Masking fails closed in the recorder, which compares the plan before and after the copy and drops
 * the frame when a masked view moved.
 */
class RedactionPlanner(val rules: RedactionRules = RedactionRules()) {
  fun rects(root: ViewNode, window: Box): List<Box> {
    val out = mutableListOf<Box>()
    visit(root, window, out)
    return merge(out)
  }

  private fun visit(node: ViewNode, window: Box, out: MutableList<Box>) {
    if (node.hidden || node.alpha <= 0.01f) return
    // Opt-out covers the subtree too (a container marked ouo-unmask shows its labels).
    if (node.tag == RedactionRules.UNMASK_TAG) return
    val clipped = node.frame.intersect(window)
    val visible = !clipped.isEmpty
    val forced = node.tag == RedactionRules.MASK_TAG
    if (visible && (forced || node.truncated)) {
      out.add(clipped)
      return
    }
    // A masked view covers its subtree; text is masked per line and its children are still walked.
    val coversSubtree = when (kind(node)) {
      Kind.INPUT -> rules.maskInputs
      Kind.IMAGE -> rules.maskImages
      Kind.WEB -> rules.maskWebViews
      Kind.EXTRA -> true
      Kind.TEXT -> {
        if (rules.maskText) {
          val lines = node.textLines
          if (lines == null) {
            if (visible) out.add(clipped)
          } else {
            for (l in lines) l.intersect(clipped).takeUnless { it.isEmpty }?.let(out::add)
          }
        }
        false
      }
      Kind.OTHER -> false
    }
    if (coversSubtree) {
      if (visible) out.add(clipped)
      return
    }
    for (child in node.children) visit(child, window, out)
  }

  private enum class Kind { INPUT, TEXT, IMAGE, WEB, EXTRA, OTHER }

  private fun kind(node: ViewNode): Kind {
    fun isA(classes: Set<String>) = node.className in classes || node.superclassNames.any { it in classes }
    return when {
      // Inputs first: an EditText is also a TextView, and maskInputs alone governs it.
      isA(RedactionRules.inputClasses) -> Kind.INPUT
      isA(RedactionRules.textClasses) -> Kind.TEXT
      isA(RedactionRules.imageClasses) -> Kind.IMAGE
      isA(RedactionRules.webViewClasses) -> Kind.WEB
      rules.extraClasses.isNotEmpty() && isA(rules.extraClasses) -> Kind.EXTRA
      else -> Kind.OTHER
    }
  }

  companion object {
    /** Union-merges every pair of intersecting rectangles until none intersect. */
    fun merge(rects: List<Box>): List<Box> {
      val result = rects.toMutableList()
      var changed = true
      while (changed) {
        changed = false
        outer@ for (i in result.indices) {
          for (j in i + 1 until result.size) {
            if (result[i].intersects(result[j])) {
              result[i] = result[i].union(result[j])
              result.removeAt(j)
              changed = true
              break@outer
            }
          }
        }
      }
      return result
    }
  }
}
