package dev.ouo.replay

import android.graphics.Matrix
import android.graphics.RectF
import android.text.Layout
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.TextView
import dev.ouo.replay.core.Box
import dev.ouo.replay.core.ViewNode

/**
 * Walks a window's view tree on the main thread into the platform-neutral [ViewNode] tree the
 * [dev.ouo.replay.core.RedactionPlanner] reads: every view's bounds in window pixels through its
 * parents' offsets, scroll and transforms (a moving `Animated` transform moves its mask), its
 * visibility, alpha and string tag, and for text views the box of each laid-out line, so a label
 * is masked line by line instead of as one block (per-line text masks).
 */
internal class ViewWalker(private val maxDepth: Int = 64) {
  private val superclasses = HashMap<Class<*>, List<String>>()

  fun walk(root: View): ViewNode = visit(root, Matrix(), 0)

  private fun visit(view: View, parent: Matrix, depth: Int): ViewNode {
    val m = Matrix(parent)
    if (depth > 0) {
      val p = view.parent as? View
      m.preTranslate((view.left - (p?.scrollX ?: 0)).toFloat(), (view.top - (p?.scrollY ?: 0)).toFloat())
      if (!view.matrix.isIdentity) m.preConcat(view.matrix)
    }
    val frame = map(m, 0f, 0f, view.width.toFloat(), view.height.toFloat())
    val hidden = view.visibility != View.VISIBLE
    val group = view as? ViewGroup
    val truncated = depth >= maxDepth && group != null && group.childCount > 0
    val children =
      if (hidden || truncated || group == null) emptyList()
      else (0 until group.childCount).mapNotNull { i -> group.getChildAt(i)?.let { visit(it, m, depth + 1) } }
    return ViewNode(
      className = view.javaClass.name,
      superclassNames = superclassNames(view.javaClass),
      frame = frame,
      hidden = hidden,
      alpha = view.alpha,
      tag = view.tag as? String,
      textLines = if (hidden) null else textLines(view, m),
      truncated = truncated,
      children = children,
    )
  }

  private fun superclassNames(cls: Class<*>): List<String> =
    superclasses.getOrPut(cls) {
      val out = mutableListOf<String>()
      var c: Class<*>? = cls.superclass
      while (c != null && c != View::class.java && c != Any::class.java) {
        out.add(c.name)
        c = c.superclass
      }
      out
    }

  /** Line boxes in window pixels; null when the layout is unknown (the whole view is masked). */
  private fun textLines(view: View, m: Matrix): List<Box>? {
    if (view is EditText) return null
    if (view is TextView) {
      if (view.text.isNullOrEmpty()) return if (view.hint.isNullOrEmpty()) emptyList() else null
      val layout = view.layout ?: return null
      // getTotalPaddingTop includes the offset of the vertical gravity, as onDraw translates.
      return lines(layout, m, (view.totalPaddingLeft - view.scrollX).toFloat(), (view.totalPaddingTop - view.scrollY).toFloat())
    }
    if (view.javaClass.name == PREPARED_TEXT) {
      // React Native's PreparedLayoutTextView (internal): it draws `preparedLayout.layout` at
      // (paddingLeft, paddingTop + verticalOffset).
      return runCatching {
        val prepared = view.javaClass.getMethod("getPreparedLayout").invoke(view) ?: return emptyList()
        val layout = prepared.javaClass.getMethod("getLayout").invoke(prepared) as Layout
        val dy = prepared.javaClass.getMethod("getVerticalOffset").invoke(prepared) as Float
        lines(layout, m, view.paddingLeft.toFloat(), view.paddingTop + dy)
      }.getOrNull()
    }
    return null
  }

  private fun lines(layout: Layout, m: Matrix, dx: Float, dy: Float): List<Box> =
    (0 until layout.lineCount).mapNotNull { i ->
      val l = layout.getLineLeft(i)
      val r = layout.getLineRight(i)
      if (r <= l) null
      else map(m, dx + l - LINE_SLOP, dy + layout.getLineTop(i), dx + r + LINE_SLOP, dy + layout.getLineBottom(i))
    }

  private fun map(m: Matrix, l: Float, t: Float, r: Float, b: Float): Box {
    val rect = RectF(l, t, r, b)
    m.mapRect(rect)
    return Box(rect.left, rect.top, rect.right, rect.bottom)
  }

  companion object {
    const val PREPARED_TEXT = "com.facebook.react.views.text.PreparedLayoutTextView"

    /** Pixels added on both sides of a line: italic overhang and anti-aliasing reach past the advance. */
    const val LINE_SLOP = 2f
  }
}
