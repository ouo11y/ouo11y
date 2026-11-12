package dev.ouo.replay

import android.graphics.Matrix
import android.graphics.RectF
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.text.InputType
import android.text.Layout
import android.text.method.PasswordTransformationMethod
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.TextView
import dev.ouo.replay.core.Box
import dev.ouo.replay.core.MaskRegistry
import dev.ouo.replay.core.RedactionRules
import dev.ouo.replay.core.ViewNode
import dev.ouo.replay.core.WireStyle
import java.lang.reflect.Method

/**
 * Walks a window's view tree on the main thread into the platform-neutral [ViewNode] tree the
 * [dev.ouo.replay.core.RedactionPlanner] reads: every view's bounds in window pixels through its
 * parents' offsets, scroll and transforms (a moving `Animated` transform moves its mask), its
 * visibility, alpha and string tag, and for text views the box of each laid-out line, so a label
 * is masked line by line instead of as one block (per-line text masks).
 *
 * Every walk also marks secure inputs (password input types, a password `TransformationMethod`,
 * password / card / one-time-code autofill hints), which no rule unmasks, and the host's view-level
 * masks ([masks], by view id: a React tag in React Native).
 *
 * With [wireRules] (the structure format) it also collects what a wireframe draws: background
 * colour, corner radius and border (plain drawables, and React Native's through its public
 * `BackgroundStyleApplicator`), text colour, size and alignment. The source text is copied only
 * where no mask can apply to it (a label with `maskText` off, an input with `maskInputs` off, or
 * inside an unmasked subtree; never a secure input), so masked text is not even in the snapshot.
 */
internal class ViewWalker(private val maxDepth: Int = 64, private val masks: MaskRegistry? = null, private val wireRules: RedactionRules? = null) {
  private val superclasses = HashMap<Class<*>, List<String>>()

  fun walk(root: View): ViewNode = visit(root, Matrix(), 0, false)

  private fun visit(view: View, parent: Matrix, depth: Int, unmaskedAbove: Boolean): ViewNode {
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
    val tag = view.tag as? String
    val override = masks?.of(view.id)
    val secure = isSecure(view)
    val masked = tag == RedactionRules.MASK_TAG || override == true
    val unmasked = !masked && (unmaskedAbove || tag == RedactionRules.UNMASK_TAG || override == false)
    val children =
      if (hidden || truncated || group == null) emptyList()
      else (0 until group.childCount).mapNotNull { i -> group.getChildAt(i)?.let { visit(it, m, depth + 1, unmasked) } }
    return ViewNode(
      className = view.javaClass.name,
      superclassNames = superclassNames(view.javaClass),
      frame = frame,
      hidden = hidden,
      alpha = view.alpha,
      tag = tag,
      textLines = if (hidden) null else textLines(view, m),
      truncated = truncated,
      children = children,
      secure = secure,
      maskOverride = override,
      wire = wireRules?.takeIf { !hidden }?.let { rules -> runCatching { style(view, m, rules, secure || masked, unmasked) }.getOrNull() },
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

  /** A password or other secure field. When it cannot be read, it is one (fails closed). */
  private fun isSecure(view: View): Boolean {
    if (view !is TextView) return false
    return try {
      val type = view.inputType
      val cls = type and InputType.TYPE_MASK_CLASS
      val variation = type and InputType.TYPE_MASK_VARIATION
      val password =
        (cls == InputType.TYPE_CLASS_TEXT &&
          (variation == InputType.TYPE_TEXT_VARIATION_PASSWORD ||
            variation == InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD ||
            variation == InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD)) ||
          (cls == InputType.TYPE_CLASS_NUMBER && variation == InputType.TYPE_NUMBER_VARIATION_PASSWORD)
      password || view.transformationMethod is PasswordTransformationMethod || hasSecureHint(view)
    } catch (e: Throwable) {
      true
    }
  }

  private fun hasSecureHint(view: View): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return false
    val hints = view.autofillHints ?: return false
    return hints.any { h -> SECURE_HINTS.any { h.contains(it, ignoreCase = true) } }
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

  // ---- the structure format ----

  private fun style(view: View, m: Matrix, rules: RedactionRules, alwaysMasked: Boolean, unmasked: Boolean): WireStyle {
    // Lengths of the view's own space, in window pixels (a scaled view scales its text and border).
    val k = m.mapRadius(1f).takeIf { it.isFinite() && it > 0f } ?: 1f
    var text: String? = null
    var fg: Int? = null
    var fontSize: Float? = null
    var align: String? = null
    if (view is TextView) {
      val isInput = view is EditText
      val source = view.text
      // Masked text never enters the snapshot; an empty one is known to be empty.
      text = when {
        source.isNullOrEmpty() -> ""
        alwaysMasked -> null
        unmasked || !(if (isInput) rules.maskInputs else rules.maskText) -> source.toString().take(MAX_TEXT)
        else -> null
      }
      fg = view.currentTextColor
      fontSize = view.textSize * k
      align = when (Gravity.getAbsoluteGravity(view.gravity, view.layoutDirection) and Gravity.HORIZONTAL_GRAVITY_MASK) {
        Gravity.CENTER_HORIZONTAL -> "center"
        Gravity.RIGHT -> "right"
        else -> if (view.textAlignment == View.TEXT_ALIGNMENT_CENTER) "center" else "left"
      }
    } else if (view.javaClass.name == PREPARED_TEXT) {
      runCatching {
        val prepared = view.javaClass.getMethod("getPreparedLayout").invoke(view)
        val layout = prepared?.let { it.javaClass.getMethod("getLayout").invoke(it) as Layout }
        if (layout != null) {
          val source = layout.text
          text = when {
            source.isNullOrEmpty() -> ""
            alwaysMasked -> null
            unmasked || !rules.maskText -> source.toString().take(MAX_TEXT)
            else -> null
          }
          fg = layout.paint.color
          fontSize = layout.paint.textSize * k
          align = when (layout.alignment) {
            Layout.Alignment.ALIGN_CENTER -> "center"
            Layout.Alignment.ALIGN_OPPOSITE -> "right"
            else -> "left"
          }
        }
      }
    }
    var bg: Int? = null
    var radius: Float? = null
    var borderWidth: Float? = null
    var borderColor: Int? = null
    val background = view.background
    when {
      background == null -> {}
      background is ColorDrawable -> bg = background.color
      background is GradientDrawable -> {
        bg = background.color?.defaultColor
        radius = runCatching { background.cornerRadius * k }.getOrNull()
      }
      background.javaClass.name.startsWith("com.facebook.react.") -> ReactStyle.get()?.let { rn ->
        bg = rn.backgroundColor(view)
        val density = view.resources.displayMetrics.density
        radius = rn.borderRadius(view, minOf(view.width, view.height) / density)?.let { it * density * k }
        borderWidth = rn.borderWidth(view)?.let { it * density * k }
        borderColor = rn.borderColor(view)
      }
    }
    return WireStyle(text, bg?.takeIf { it ushr 24 != 0 }, fg, radius, borderWidth, borderColor, fontSize, align)
  }

  /**
   * React Native's `BackgroundStyleApplicator` (public API since 0.76), reached by reflection: this
   * module does not link React Native. Every getter is null when the class, the method or the value
   * is not there.
   */
  private class ReactStyle(private val applicator: Class<*>) {
    private val getBackgroundColor: Method? = method("getBackgroundColor", 1)
    private val getBorderRadius: Method? = method("getBorderRadius", 2)
    private val getBorderWidth: Method? = method("getBorderWidth", 2)
    private val getBorderColor: Method? = method("getBorderColor", 2)
    private val uniformRadius: Any? = constant("com.facebook.react.uimanager.style.BorderRadiusProp", "BORDER_RADIUS")
    private val allEdges: Any? = constant("com.facebook.react.uimanager.style.LogicalEdge", "ALL")

    private fun method(name: String, params: Int): Method? = runCatching { applicator.methods.firstOrNull { it.name == name && it.parameterTypes.size == params } }.getOrNull()

    private fun constant(cls: String, name: String): Any? = runCatching { Class.forName(cls).enumConstants?.firstOrNull { (it as Enum<*>).name == name } }.getOrNull()

    fun backgroundColor(view: View): Int? = runCatching { getBackgroundColor?.invoke(null, view) as? Int }.getOrNull()

    /** Dp. */
    fun borderRadius(view: View, referenceDp: Float): Float? = runCatching {
      val length = getBorderRadius?.invoke(null, view, uniformRadius ?: return null) ?: return null
      length.javaClass.methods.firstOrNull { it.name == "resolve" && it.parameterTypes.size == 1 }?.invoke(length, referenceDp) as? Float
    }.getOrNull()

    /** Dp. */
    fun borderWidth(view: View): Float? = runCatching { getBorderWidth?.invoke(null, view, allEdges ?: return null) as? Float }.getOrNull()

    fun borderColor(view: View): Int? = runCatching { getBorderColor?.invoke(null, view, allEdges ?: return null) as? Int }.getOrNull()

    companion object {
      private var resolved = false
      private var instance: ReactStyle? = null

      /** Main thread only. */
      fun get(): ReactStyle? {
        if (!resolved) {
          resolved = true
          instance = runCatching { ReactStyle(Class.forName("com.facebook.react.uimanager.BackgroundStyleApplicator")) }.getOrNull()
        }
        return instance
      }
    }
  }

  companion object {
    const val PREPARED_TEXT = "com.facebook.react.views.text.PreparedLayoutTextView"

    /** Pixels added on both sides of a line: italic overhang and anti-aliasing reach past the advance. */
    const val LINE_SLOP = 2f

    /** Characters of an unmasked text kept in a snapshot. */
    const val MAX_TEXT = 2000

    /** Substrings of the autofill hints that mark a field secure (password, card data, one-time codes). */
    val SECURE_HINTS = listOf("password", "creditCard", "smsOTPCode", "otp", "2faAppOTPCode")
  }
}
