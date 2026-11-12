package dev.ouo.replay.core

import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong
import kotlin.math.roundToInt

/**
 * One event of a replay format: a single JSON object, written as one line of the chunk body
 * (newline-delimited JSON), so the decompressed chunk bodies of a segment concatenate into a valid
 * payload (client SDK spec RPL-7). [keyframe]: the event decodes with nothing before it, so a
 * segment may start with it (RPL-6).
 */
class ReplayEvent(val t: EpochMillis, val keyframe: Boolean, val json: String)

/**
 * What is recorded (ADR-0019 decision 5, spec 11.6 RPL-27). The hierarchy, the chunking, the
 * envelope and the delivery ([ReplayStream], [OtlpReplayOutbox]) know nothing of the format beyond
 * this interface (RPL-23).
 *
 * - Format id: [formatId], sent as `ouo.replay.format`.
 * - Keyframe on request: after [requestKeyframe] the next event [capture] returns is a keyframe.
 * - Masking: everything [capture] returns is already masked ([masked]); when the masked state of
 *   the input cannot be established it throws or returns nothing, and the frame is dropped (PRV-8).
 * - Bounded output: events are lines; the stream cuts them into chunks and splits an oversized one.
 *
 * Driven from one thread (the recorder's compose thread).
 */
interface ReplayFormatAdapter<in I> {
  val formatId: String
  val masked: Boolean

  /** The next capture must produce a keyframe; a capturer that can choose (the pixel one) reads it. */
  val needsKeyframe: Boolean

  fun requestKeyframe()

  fun capture(input: I): List<ReplayEvent>

  /** A touch in absolute pixels of the captured window; the same event in every format. */
  fun touch(t: EpochMillis, x: Double, y: Double, phase: TouchPhase): ReplayEvent = ReplayEvents.touch(t, x, y, phase)
}

object ReplayEvents {
  fun touch(t: EpochMillis, x: Double, y: Double, phase: TouchPhase): ReplayEvent {
    val sb = StringBuilder(64)
    sb.append("{\"t\":").append(t).append(",\"type\":\"touch\",\"x\":")
    number(sb, x)
    sb.append(",\"y\":")
    number(sb, y)
    sb.append(",\"phase\":\"").append(phase.wire).append("\"}")
    return ReplayEvent(t, false, sb.toString())
  }

  /** A JSON number: whole values without a fraction, NaN and infinities as 0 (JSON has neither). */
  fun number(sb: StringBuilder, v: Double) {
    if (!v.isFinite()) sb.append('0')
    else if (v == Math.rint(v) && Math.abs(v) < 1e15) sb.append(v.toLong())
    else sb.append((v * 1000).roundToLong() / 1000.0)
  }

  private fun Double.roundToLong(): Long = Math.round(this)

  /** A JSON string with its quotes. Line breaks are escaped, so an event stays on one line. */
  fun quote(sb: StringBuilder, s: String) {
    sb.append('"')
    for (c in s) {
      when {
        c == '"' -> sb.append("\\\"")
        c == '\\' -> sb.append("\\\\")
        c == '\n' -> sb.append("\\n")
        c == '\r' -> sb.append("\\r")
        c == '\t' -> sb.append("\\t")
        c < ' ' || c == ' ' || c == ' ' -> sb.append("\\u").append(String.format("%04x", c.code))
        else -> sb.append(c)
      }
    }
    sb.append('"')
  }

  /** `#rrggbbaa` of an ARGB int. */
  fun color(argb: Int): String = String.format("#%06x%02x", argb and 0xffffff, argb ushr 24 and 0xff)
}

/** A captured window for the pixel format: the masked [frame] (full image or patches) of a [width] x [height] pixel window. */
class PixelCapture(val frame: Frame, val width: Int, val height: Int, val imageWidth: Int, val imageHeight: Int, val scale: Double)

/**
 * `ouo-frames/3`: today's capture (masked JPEG full frames, tile patches and touches) as
 * newline-delimited JSON.
 *
 * - `{"t":ms,"type":"frame","w":px,"h":px,"iw":px,"ih":px,"scale":n,"jpeg":"<base64>"}`: a keyframe.
 *   `w`/`h` are the window in screen pixels, `iw`/`ih` the image (downscaled), `scale` the display's
 *   pixels per dp.
 * - `{"t":ms,"type":"patch","patches":[{"x":..,"y":..,"w":..,"h":..,"jpeg":"<base64>"}]}`: rectangles
 *   in image pixels drawn over the frame before it.
 * - `{"t":ms,"type":"touch","x":px,"y":px,"phase":"began|moved|ended"}` in window pixels.
 *
 * The masks are painted into the bitmap before it is encoded (`ScreenCapturer.compose`), so the
 * [Frame] this adapter is given is already masked; it only refuses a patch when a keyframe is due.
 */
class PixelFormatAdapter(override val masked: Boolean) : ReplayFormatAdapter<PixelCapture> {
  override val formatId: String = FORMAT

  @Volatile override var needsKeyframe: Boolean = true
    private set

  override fun requestKeyframe() {
    needsKeyframe = true
  }

  override fun capture(input: PixelCapture): List<ReplayEvent> {
    val f = input.frame
    require(input.width > 0 && input.height > 0 && input.imageWidth > 0 && input.imageHeight > 0) { "empty frame" }
    val jpeg = f.jpeg
    if (jpeg != null) {
      val sb = StringBuilder(jpeg.length + 128)
      sb.append("{\"t\":").append(f.ts).append(",\"type\":\"frame\",\"w\":").append(input.width).append(",\"h\":").append(input.height)
      sb.append(",\"iw\":").append(input.imageWidth).append(",\"ih\":").append(input.imageHeight).append(",\"scale\":")
      ReplayEvents.number(sb, input.scale)
      sb.append(",\"jpeg\":\"").append(jpeg).append("\"}")
      needsKeyframe = false
      return listOf(ReplayEvent(f.ts, true, sb.toString()))
    }
    // A patch has nothing to draw over until the keyframe is there: dropped, the capturer sends a full image next.
    if (needsKeyframe) return emptyList()
    val patches = f.patches ?: return emptyList()
    val sb = StringBuilder(patches.sumOf { it.jpeg.length } + 64 * patches.size + 64)
    sb.append("{\"t\":").append(f.ts).append(",\"type\":\"patch\",\"patches\":[")
    patches.forEachIndexed { i, p ->
      if (i > 0) sb.append(',')
      sb.append("{\"x\":").append(p.x).append(",\"y\":").append(p.y).append(",\"w\":").append(p.w).append(",\"h\":").append(p.h)
      sb.append(",\"jpeg\":\"").append(p.jpeg).append("\"}")
    }
    sb.append("]}")
    return listOf(ReplayEvent(f.ts, false, sb.toString()))
  }

  companion object {
    const val FORMAT = "ouo-frames/3"
  }
}

/**
 * A walked window for the structure format: [root] with its frames in window pixels, the window's
 * size in pixels, the display's pixels per dp and the window's position on the screen.
 */
class TreeSnapshot(val t: EpochMillis, val root: ViewNode, val width: Int, val height: Int, val scale: Double, val offsetX: Float = 0f, val offsetY: Float = 0f)

/**
 * `ouo-wireframe/1`: the view tree as rectangles (the model of PostHog's and Datadog's mobile
 * wireframes, followed without their code). No pixel of the screen is ever read.
 *
 * `{"t":ms,"type":"full","w":px,"h":px,"scale":n,"nodes":[{"id":int,"parent":int,"kind":"view|text|input|image|web|secure",
 * "x":..,"y":..,"w":..,"h":..,"bg":"#rrggbbaa"?,"fg":"#rrggbbaa"?,"radius":n?,"border":{"width":n,"color":"#rrggbbaa"?}?,
 * "text":"***"?,"fontSize":n?,"align":"left|center|right"?,"masked":true?}]}`: the whole tree,
 * emitted when it changed since the last event (an unchanged tree emits nothing) or when a keyframe
 * was requested; every event is a keyframe. Rectangles are absolute screen pixels, clipped to the
 * window; `id` is the node's index in the event, `parent` -1 for the root. Plus the touch events.
 *
 * Masking (PRV-5 to PRV-8), with the class rules of [RedactionPlanner]:
 * - Text is the literal `***` whenever a mask applies: `maskText` for labels, `maskInputs` for inputs.
 * - A secure input is kind `secure` with `***`, whatever the rules, tags and overrides say.
 * - Images, web views, `TextureView` and `SurfaceView` are a kind and a rectangle, never content.
 * - A view masked by tag, override, extra class or the walk's depth limit is a rectangle with
 *   `"masked":true` and nothing of its subtree.
 * - A snapshot that cannot be read (no size, a failed walk) throws: the frame is dropped.
 */
class StructureFormatAdapter(val rules: RedactionRules = RedactionRules(), val maxNodes: Int = 4000, val maxTextChars: Int = 2000) : ReplayFormatAdapter<TreeSnapshot> {
  override val formatId: String = FORMAT
  override val masked: Boolean = true

  @Volatile override var needsKeyframe: Boolean = true
    private set

  private var last: String? = null

  override fun requestKeyframe() {
    needsKeyframe = true
  }

  override fun capture(input: TreeSnapshot): List<ReplayEvent> {
    require(input.width > 0 && input.height > 0) { "empty window" }
    val sb = StringBuilder(4096)
    sb.append("\"type\":\"full\",\"w\":").append(input.width).append(",\"h\":").append(input.height).append(",\"scale\":")
    ReplayEvents.number(sb, if (input.scale.isFinite() && input.scale > 0) input.scale else 1.0)
    sb.append(",\"nodes\":[")
    val walk = Walk(sb, Box(0f, 0f, input.width.toFloat(), input.height.toFloat()), input.offsetX, input.offsetY)
    walk.visit(input.root, -1, false)
    sb.append(']')
    if (walk.truncated) sb.append(",\"truncated\":true")
    sb.append('}')
    val body = sb.toString()
    if (!needsKeyframe && body == last) return emptyList()
    last = body
    needsKeyframe = false
    return listOf(ReplayEvent(input.t, true, "{\"t\":${input.t},$body"))
  }

  private inner class Walk(val sb: StringBuilder, val window: Box, val dx: Float, val dy: Float) {
    var count = 0
    var truncated = false

    fun visit(node: ViewNode, parent: Int, unmasked: Boolean) {
      if (node.hidden || node.alpha <= 0.01f) return
      if (count >= maxNodes) {
        truncated = true
        return
      }
      val clipped = node.frame.intersect(window)
      val visible = !clipped.isEmpty
      val kind = RedactionPlanner.kind(node, rules)
      val style = node.wire
      // The order of RedactionPlanner: secure, then mask (wins over unmask), then unmask, then the rules.
      val forced = node.tag == RedactionRules.MASK_TAG || node.maskOverride == true || node.truncated || kind == ViewKind.EXTRA
      val un = unmasked || node.tag == RedactionRules.UNMASK_TAG || node.maskOverride == false
      val leaf = node.secure || forced || kind == ViewKind.INPUT || kind == ViewKind.IMAGE || kind == ViewKind.WEB
      if (!visible) {
        // Off the window: nothing to draw, but a container may still hold views that are on it.
        if (!leaf) for (c in node.children) visit(c, parent, un)
        return
      }
      val id = count++
      if (id > 0) sb.append(',')
      val name = when {
        node.secure -> "secure"
        kind == ViewKind.INPUT -> "input"
        kind == ViewKind.TEXT -> "text"
        kind == ViewKind.IMAGE -> "image"
        kind == ViewKind.WEB -> "web"
        else -> "view"
      }
      sb.append("{\"id\":").append(id).append(",\"parent\":").append(parent).append(",\"kind\":\"").append(name).append('"')
      sb.append(",\"x\":").append((clipped.left + dx).roundToInt()).append(",\"y\":").append((clipped.top + dy).roundToInt())
      sb.append(",\"w\":").append(clipped.width.roundToInt()).append(",\"h\":").append(clipped.height.roundToInt())
      if (style != null) {
        style.bg?.let { sb.append(",\"bg\":\"").append(ReplayEvents.color(it)).append('"') }
        style.radius?.takeIf { it.isFinite() && it > 0f }?.let {
          sb.append(",\"radius\":")
          ReplayEvents.number(sb, it.toDouble())
        }
        style.borderWidth?.takeIf { it.isFinite() && it > 0f }?.let { bw ->
          sb.append(",\"border\":{\"width\":")
          ReplayEvents.number(sb, bw.toDouble())
          style.borderColor?.let { sb.append(",\"color\":\"").append(ReplayEvents.color(it)).append('"') }
          sb.append('}')
        }
      }
      val text: String? = when {
        node.secure -> MASK
        forced -> null
        kind == ViewKind.INPUT -> shown(node, rules.maskInputs && !un)
        kind == ViewKind.TEXT -> shown(node, rules.maskText && !un)
        else -> null
      }
      if (text != null) {
        sb.append(",\"text\":")
        ReplayEvents.quote(sb, text)
        if (style != null) {
          style.fg?.let { sb.append(",\"fg\":\"").append(ReplayEvents.color(it)).append('"') }
          style.fontSize?.takeIf { it.isFinite() && it > 0f }?.let {
            sb.append(",\"fontSize\":")
            ReplayEvents.number(sb, it.toDouble())
          }
          style.align?.takeIf { it == "left" || it == "center" || it == "right" }?.let { sb.append(",\"align\":\"").append(it).append('"') }
        }
      }
      if (forced && !node.secure) sb.append(",\"masked\":true")
      sb.append('}')
      if (!leaf) for (c in node.children) visit(c, id, un)
    }

    /** The text of a label or an input: `***` when masked, or when it is not known what the view shows. */
    private fun shown(node: ViewNode, mask: Boolean): String? {
      val source = node.wire?.text
      val unknown = source == null && node.textLines == null
      if (mask) return if (unknown || !source.isNullOrEmpty() || !node.textLines.isNullOrEmpty()) MASK else null
      if (source.isNullOrEmpty()) return null
      return if (source.length > maxTextChars) source.substring(0, maxTextChars) else source
    }
  }

  companion object {
    const val FORMAT = "ouo-wireframe/1"
    const val MASK = "***"
  }
}

/**
 * Counts what replay drops and every error an entry point caught (client SDK spec ERR-1, ERR-6,
 * ERR-7). Thread-safe. After [selfDisableThreshold] caught errors [disabled] turns true and the
 * recorder stops capturing for the rest of the process.
 */
class ReplayCounters(val selfDisableThreshold: Int = 20, private val logger: Logger = Logger.NONE) {
  private val counts = ConcurrentHashMap<String, AtomicLong>()
  private val errors = AtomicLong()

  val disabled: Boolean get() = errors.get() >= selfDisableThreshold
  val errorCount: Long get() = errors.get()

  fun count(reason: String, n: Long = 1) {
    counts.getOrPut(reason) { AtomicLong() }.addAndGet(n)
  }

  fun get(reason: String): Long = counts[reason]?.get() ?: 0

  /** An entry point caught [e]: counted under `error.<seam>`. Never throws. */
  fun error(seam: String, e: Throwable) {
    errors.incrementAndGet()
    count("error.$seam")
    try {
      logger.warn("$seam failed: ${e.javaClass.simpleName}")
    } catch (ignored: Throwable) {
    }
  }

  /** Runs [block]; whatever it throws is counted and swallowed (returns null). */
  inline fun <T> guard(seam: String, block: () -> T): T? =
    try {
      block()
    } catch (e: Throwable) {
      error(seam, e)
      null
    }

  fun snapshot(): Map<String, Long> = counts.entries.associate { it.key to it.value.get() }
}
