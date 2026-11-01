package dev.ouo.replay.core

import org.json.JSONArray
import org.json.JSONObject

/** Epoch milliseconds in the device clock. */
typealias EpochMillis = Long

/** Why a frame was captured (docs/specs/mobile-replay.md): informational free text on the wire. */
enum class FrameReason(val wire: String) {
  TIMER("timer"),
  NAVIGATION("navigation"),
  RESUME("resume");

  companion object {
    fun of(wire: String?): FrameReason = entries.firstOrNull { it.wire == wire } ?: TIMER
  }
}

enum class TouchPhase(val wire: String) {
  BEGAN("began"),
  MOVED("moved"),
  ENDED("ended");

  companion object {
    fun of(wire: String?): TouchPhase = entries.firstOrNull { it.wire == wire } ?: MOVED
  }
}

/** A rectangle in frame pixels, origin top-left (a schema 2 patch). */
data class PixelRect(val x: Int, val y: Int, val w: Int, val h: Int) {
  val area: Int get() = w * h
}

/** A rectangle of a patch frame in pixels of the chunk's full image, with its own JPEG (base64). */
data class Patch(val x: Int, val y: Int, val w: Int, val h: Int, val jpeg: String) {
  constructor(rect: PixelRect, jpegBytes: ByteArray) : this(rect.x, rect.y, rect.w, rect.h, base64(jpegBytes))

  fun toJson(): JSONObject = JSONObject().put("x", x).put("y", y).put("w", w).put("h", h).put("jpeg", jpeg)

  companion object {
    fun fromJson(o: JSONObject) = Patch(o.getInt("x"), o.getInt("y"), o.getInt("w"), o.getInt("h"), o.getString("jpeg"))
  }
}

/**
 * One captured screen (schema 2, ADR-0014): exactly one of [jpeg] (a full image, base64) and
 * [patches] (rectangles drawn over the frame before it in the same chunk).
 */
data class Frame(val ts: EpochMillis, val jpeg: String?, val patches: List<Patch>?, val reason: FrameReason) {
  val isFull: Boolean get() = jpeg != null

  /** Base64 characters of its images (what the chunk's 1 MiB cut counts). */
  val imageBytes: Int get() = (jpeg?.length ?: 0) + (patches ?: emptyList()).sumOf { it.jpeg.length }

  fun toJson(): JSONObject {
    val o = JSONObject().put("ts", ts).put("reason", reason.wire)
    if (jpeg != null) o.put("jpeg", jpeg) else o.put("patches", JSONArray(patches!!.map { it.toJson() }))
    return o
  }

  companion object {
    fun full(ts: EpochMillis, jpegBytes: ByteArray, reason: FrameReason) = Frame(ts, base64(jpegBytes), null, reason)

    fun patches(ts: EpochMillis, patches: List<Patch>, reason: FrameReason): Frame {
      require(patches.isNotEmpty()) { "a patch frame needs at least one patch" }
      return Frame(ts, null, patches, reason)
    }

    fun fromJson(o: JSONObject): Frame {
      val ps = o.optJSONArray("patches")
      return Frame(
        ts = o.getLong("ts"),
        jpeg = if (o.has("jpeg")) o.getString("jpeg") else null,
        patches = ps?.let { a -> (0 until a.length()).map { Patch.fromJson(a.getJSONObject(it)) } },
        reason = FrameReason.of(o.optString("reason")),
      )
    }
  }
}

/** One touch sample in points (dp on Android) of the unscaled viewport. */
data class Touch(val ts: EpochMillis, val x: Double, val y: Double, val phase: TouchPhase) {
  fun toJson(): JSONObject = JSONObject().put("ts", ts).put("x", x).put("y", y).put("phase", phase.wire)

  companion object {
    fun fromJson(o: JSONObject) = Touch(o.getLong("ts"), o.getDouble("x"), o.getDouble("y"), TouchPhase.of(o.optString("phase")))
  }
}

/** Viewport in points (dp) plus the pixels-per-point scale the frames were rendered at. */
data class Viewport(val width: Double, val height: Double, val scale: Double) {
  fun toJson(): JSONObject = JSONObject().put("width", width).put("height", height).put("scale", scale)

  companion object {
    fun fromJson(o: JSONObject) = Viewport(o.getDouble("width"), o.getDouble("height"), o.getDouble("scale"))
  }
}

/** The chunk posted to `POST /v1/replay/chunks`, keys exactly as docs/specs/mobile-replay.md shows. */
data class FrameChunk(
  val sessionId: String,
  val seq: Int,
  val startedAt: EpochMillis,
  val endedAt: EpochMillis,
  val viewport: Viewport,
  val platform: String = "android",
  val mode: String = "session",
  val frames: List<Frame>,
  val touches: List<Touch>,
  val masked: Boolean,
) {
  fun toJson(): JSONObject =
    JSONObject()
      .put("kind", KIND)
      .put("schema_version", SCHEMA_VERSION)
      .put("session_id", sessionId)
      .put("seq", seq)
      .put("started_at", startedAt)
      .put("ended_at", endedAt)
      .put("viewport", viewport.toJson())
      .put("platform", platform)
      .put("mode", mode)
      .put("frames", JSONArray(frames.map { it.toJson() }))
      .put("touches", JSONArray(touches.map { it.toJson() }))
      .put("masked", masked)

  fun encodedJson(): ByteArray = toJson().toString().toByteArray(Charsets.UTF_8)

  companion object {
    const val KIND = "frames"
    const val SCHEMA_VERSION = 2

    fun decode(bytes: ByteArray): FrameChunk {
      val o = JSONObject(String(bytes, Charsets.UTF_8))
      val fs = o.getJSONArray("frames")
      val ts = o.getJSONArray("touches")
      return FrameChunk(
        sessionId = o.getString("session_id"),
        seq = o.getInt("seq"),
        startedAt = o.getLong("started_at"),
        endedAt = o.getLong("ended_at"),
        viewport = Viewport.fromJson(o.getJSONObject("viewport")),
        platform = o.getString("platform"),
        mode = o.optString("mode", "session"),
        frames = (0 until fs.length()).map { Frame.fromJson(fs.getJSONObject(it)) },
        touches = (0 until ts.length()).map { Touch.fromJson(ts.getJSONObject(it)) },
        masked = o.getBoolean("masked"),
      )
    }
  }
}

private val ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".toCharArray()

/**
 * Standard base64 with padding and no line breaks. Hand-written because `java.util.Base64` needs
 * Android 8 (API 26) and `android.util.Base64` is not on the JVM the core's tests run on.
 */
fun base64(bytes: ByteArray): String {
  val out = CharArray((bytes.size + 2) / 3 * 4)
  var i = 0
  var o = 0
  while (i + 3 <= bytes.size) {
    val n = (bytes[i].toInt() and 0xff shl 16) or (bytes[i + 1].toInt() and 0xff shl 8) or (bytes[i + 2].toInt() and 0xff)
    out[o++] = ALPHABET[n ushr 18 and 63]
    out[o++] = ALPHABET[n ushr 12 and 63]
    out[o++] = ALPHABET[n ushr 6 and 63]
    out[o++] = ALPHABET[n and 63]
    i += 3
  }
  val rest = bytes.size - i
  if (rest > 0) {
    val n = (bytes[i].toInt() and 0xff shl 16) or (if (rest == 2) bytes[i + 1].toInt() and 0xff shl 8 else 0)
    out[o++] = ALPHABET[n ushr 18 and 63]
    out[o++] = ALPHABET[n ushr 12 and 63]
    out[o++] = if (rest == 2) ALPHABET[n ushr 6 and 63] else '='
    out[o] = '='
  }
  return String(out)
}
