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
  /**
   * A password or other secure input (or one whose kind could not be read). Under
   * [RedactionRules.strict] it is masked whatever the rules, tags and overrides say (PRV-7).
   */
  val secure: Boolean = false,
  /**
   * View-level masking set by the host for this view (the React Native `mask(reactTag)` and
   * `unmask(reactTag)`), as [ReplayMaskRegistry] resolved it: true masks the view, false unmasks
   * its subtree, null follows the rules. Mask wins.
   */
  val maskOverride: Boolean? = null,
)

/** What a view is to the masking rules. */
enum class ViewKind { INPUT, TEXT, IMAGE, WEB, EXTRA, OTHER }

/** Which classes get redacted (docs/specs/mobile-replay.md, capture rules for Android) and the override tags. */
data class RedactionRules(
  val maskText: Boolean = true,
  val maskInputs: Boolean = true,
  val maskImages: Boolean = true,
  val maskWebViews: Boolean = true,
  val extraClasses: Set<String> = emptySet(),
  /**
   * The OTLP path (client SDK spec PRV-6, PRV-7): a secure input is always masked, and an unmasked
   * subtree is still walked so that a mask or a secure input inside it wins. False (the default)
   * keeps the behaviour the native SDK shipped with: `ouo-unmask` opts its whole subtree out.
   */
  val strict: Boolean = false,
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

    /**
     * `ImageView` covers React Native's `ReactImageView` (Fresco's `DraweeView` extends it).
     * `TextureView` (video, maps, camera previews) is in the window copy; `SurfaceView` is a hole in
     * it, masked anyway so a platform that composites it never leaks it.
     */
    val imageClasses = setOf("android.widget.ImageView", "android.view.TextureView", "android.view.SurfaceView")
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
    visit(root, window, out, false)
    return merge(out)
  }

  private fun visit(node: ViewNode, window: Box, out: MutableList<Box>, unmasked: Boolean) {
    if (node.hidden || node.alpha <= 0.01f) return
    val clipped = node.frame.intersect(window)
    val visible = !clipped.isEmpty
    // Mask wins over unmask, and under `strict` a secure input is masked whatever anything says (PRV-7).
    val forced = node.tag == RedactionRules.MASK_TAG || node.maskOverride == true || (rules.strict && node.secure)
    if (visible && (forced || node.truncated)) {
      out.add(clipped)
      return
    }
    // Opt-out covers the subtree too (a container marked ouo-unmask shows its labels). Under
    // `strict` the subtree is still walked: a mask or a secure input inside it wins.
    if (unmasked || node.tag == RedactionRules.UNMASK_TAG || node.maskOverride == false) {
      if (rules.strict) for (child in node.children) visit(child, window, out, true)
      return
    }
    // A masked view covers its subtree; text is masked per line and its children are still walked.
    val coversSubtree = when (kind(node, rules)) {
      ViewKind.INPUT -> rules.maskInputs
      ViewKind.IMAGE -> rules.maskImages
      ViewKind.WEB -> rules.maskWebViews
      ViewKind.EXTRA -> true
      ViewKind.TEXT -> {
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
      ViewKind.OTHER -> false
    }
    if (coversSubtree) {
      if (visible) out.add(clipped)
      return
    }
    for (child in node.children) visit(child, window, out, false)
  }

  companion object {
    /** The class rules, shared with the structure format so both formats mask the same views. */
    fun kind(node: ViewNode, rules: RedactionRules): ViewKind {
      fun isA(classes: Set<String>) = node.className in classes || node.superclassNames.any { it in classes }
      return when {
        // Inputs first: an EditText is also a TextView, and maskInputs alone governs it.
        isA(RedactionRules.inputClasses) -> ViewKind.INPUT
        isA(RedactionRules.textClasses) -> ViewKind.TEXT
        isA(RedactionRules.imageClasses) -> ViewKind.IMAGE
        isA(RedactionRules.webViewClasses) -> ViewKind.WEB
        rules.extraClasses.isNotEmpty() && isA(rules.extraClasses) -> ViewKind.EXTRA
        else -> ViewKind.OTHER
      }
    }

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
