package dev.ouo.replay.core

/**
 * One event of a replay payload: a single JSON object (no newline inside), written as one line of
 * the chunk body. The formats are newline-delimited JSON, so the decompressed bodies of a segment's
 * chunks concatenate into a valid payload (client SDK spec RPL-7).
 */
class ReplayEvent(
  /** Epoch milliseconds, the event's `t`. */
  val t: EpochMillis,
  /** The event alone restores the whole screen: a segment can start with it (RPL-6). */
  val keyframe: Boolean,
  /** The JSON object, UTF-8, without the trailing newline. */
  val json: ByteArray,
) {
  constructor(t: EpochMillis, keyframe: Boolean, json: String) : this(t, keyframe, json.toByteArray(Charsets.UTF_8))
}

/**
 * What one look at the screen saw, handed from the capture side to the format adapter. Each format
 * has its own (the Android `PixelLook` for `ouo-frames/3`); an adapter given another one drops the frame.
 */
interface ReplayLook

/** Why an adapter refused a look: the frame is dropped. */
class ReplayFormatError(val kind: Kind) : Exception(kind.name) {
  enum class Kind {
    /** The look is not the one this format reads. */
    WRONG_LOOK,

    /** Masking could not be applied or its result could not be established (PRV-8). */
    MASKING_FAILED,
    ENCODING_FAILED,
  }
}

/**
 * The seam between "when to look" and "what is recorded" (client SDK spec 11.6, RPL-27; ADR-0021
 * decision 5). Everything above it (replay, stream, segment, sequence, chunk attributes, delivery,
 * end record) is the same for every format (RPL-23). The Swift `ReplayFormatAdapter`, ported.
 *
 * | Capability (RPL-27) | Here |
 * |---|---|
 * | Format id and version | [formatId] |
 * | Keyframe on request | [requestKeyframe]: the next look yields a keyframe event |
 * | Encoding and compression | [encoding], [compress] |
 * | Masking | applied inside [events]; an event never carries unmasked content, and a look whose masked state is unknown throws |
 * | Bounded output | events are lines: the stream cuts a chunk between them, or inside one that alone exceeds the hard limit |
 *
 * Not thread-safe: [ReplayStream] calls it under its own lock.
 */
interface ReplayFormatAdapter {
  /** `ouo.replay.format`, for example `ouo-frames/3`. */
  val formatId: String

  /** `ouo.replay.encoding`. */
  val encoding: String get() = "gzip"

  /** `ouo.replay.masked`: masking ran on this content. */
  val masked: Boolean

  /** The next look must produce a keyframe, even when the screen did not change. */
  fun requestKeyframe()

  /** The events of one look, already masked: none when nothing changed. Throws when the frame must be dropped. */
  fun events(look: ReplayLook, t: EpochMillis): List<ReplayEvent>

  /**
   * `{"t":ms,"type":"touch","x":..,"y":..,"phase":"began|moved|ended"}`, the same in every format.
   * `x` and `y` are points (dp) of the viewport: pixels of a frame divided by its `scale`. Null
   * when the format does not record touches.
   */
  fun touchEvent(touch: Touch): ReplayEvent? =
    ReplayEvent(touch.ts, false, "{\"t\":${touch.ts},\"type\":\"touch\",\"x\":${ReplayJSON.number(touch.x)},\"y\":${ReplayJSON.number(touch.y)},\"phase\":\"${touch.phase.wire}\"}")

  /** Compresses the bytes of a chunk ([encoding]), once. Each result decompresses on its own. */
  fun compress(payload: ByteArray): ByteArray = Gzip.compress(payload)
}

/** The JSON the formats write by hand: fixed key order and no escaping surprises. */
object ReplayJSON {
  /** An integer when the value is one, else two decimals. Never `NaN` or an infinity. */
  fun number(value: Double): String {
    if (!value.isFinite()) return "0"
    val clamped = value.coerceIn(-9_007_199_254_740_992.0, 9_007_199_254_740_992.0)
    val rounded = Math.round(clamped * 100) / 100.0
    if (rounded == Math.rint(rounded)) return rounded.toLong().toString()
    return String.format(java.util.Locale.ROOT, "%.2f", rounded)
  }

  /** A JSON string literal, quotes included. Control characters, U+2028, U+2029 and DEL are escaped, so the result never holds a raw newline. */
  fun string(value: String): String {
    val sb = StringBuilder(value.length + 2)
    sb.append('"')
    for (c in value) {
      when {
        c == '"' -> sb.append("\\\"")
        c == '\\' -> sb.append("\\\\")
        c == '\n' -> sb.append("\\n")
        c == '\r' -> sb.append("\\r")
        c == '\t' -> sb.append("\\t")
        c < ' ' || c.code == 0x7f || c == ' ' || c == ' ' -> sb.append("\\u").append(String.format(java.util.Locale.ROOT, "%04x", c.code))
        else -> sb.append(c)
      }
    }
    sb.append('"')
    return sb.toString()
  }
}

/**
 * The events of the pixel format, `ouo-frames/3`: what the recorder captured before (masked JPEG
 * full frames and tile patches, ADR-0014) as newline-delimited JSON events instead of one JSON
 * document. The same lines as the Swift `PixelFormatAdapter` writes:
 *
 * - `{"t":ms,"type":"frame","w":px,"h":px,"scale":n,"reason":"timer|navigation|resume","jpeg":"<base64>"}`:
 *   a full image, a keyframe. `w` and `h` are the image's pixels, `scale` its pixels per point (dp).
 * - `{"t":ms,"type":"patch","reason":"..","patches":[{"x":px,"y":px,"w":px,"h":px,"jpeg":"<base64>"}]}`:
 *   rectangles, in pixels of that image, drawn over the frame before it.
 * - the shared `touch` event ([ReplayFormatAdapter.touchEvent]).
 *
 * The adapter that paints the masks and encodes the JPEGs is the Android module's
 * (`dev.ouo.replay.PixelFormatAdapter`); this is the part that needs no bitmap.
 */
object PixelFrames {
  const val FORMAT = "ouo-frames/3"

  /** A JPEG quality the encoder accepts (1..100), whatever the host passed: `Bitmap.compress` throws outside 0..100. */
  fun jpegQuality(asked: Int): Int = asked.coerceIn(1, 100)

  /** The event of a masked [frame] whose full image is [width] x [height] pixels at [scale] pixels per point. */
  fun event(frame: Frame, width: Int, height: Int, scale: Double): ReplayEvent {
    val jpeg = frame.jpeg
    if (jpeg != null) {
      val sb = StringBuilder(jpeg.length + 128)
      sb.append("{\"t\":").append(frame.ts).append(",\"type\":\"frame\",\"w\":").append(width).append(",\"h\":").append(height)
      sb.append(",\"scale\":").append(ReplayJSON.number(scale)).append(",\"reason\":\"").append(frame.reason.wire).append("\",\"jpeg\":\"").append(jpeg).append("\"}")
      return ReplayEvent(frame.ts, true, sb.toString())
    }
    val patches = frame.patches ?: throw ReplayFormatError(ReplayFormatError.Kind.ENCODING_FAILED)
    val sb = StringBuilder(patches.sumOf { it.jpeg.length } + 64 * patches.size + 64)
    sb.append("{\"t\":").append(frame.ts).append(",\"type\":\"patch\",\"reason\":\"").append(frame.reason.wire).append("\",\"patches\":[")
    patches.forEachIndexed { i, p ->
      if (i > 0) sb.append(',')
      sb.append("{\"x\":").append(p.x).append(",\"y\":").append(p.y).append(",\"w\":").append(p.w).append(",\"h\":").append(p.h)
      sb.append(",\"jpeg\":\"").append(p.jpeg).append("\"}")
    }
    sb.append("]}")
    return ReplayEvent(frame.ts, false, sb.toString())
  }
}
