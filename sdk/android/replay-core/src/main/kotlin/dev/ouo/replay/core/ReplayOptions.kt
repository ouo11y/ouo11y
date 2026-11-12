package dev.ouo.replay.core

/**
 * The options of `start(endpoint, options)` as they arrive from JavaScript, read without trusting
 * any of them (client SDK spec ERR-1: configuration never throws). A missing key, a wrong type or
 * an absurd number (`jpegQuality: 1000`, `NaN`, a negative interval) becomes the default or the
 * nearest allowed value and is listed in [problems]; nothing here throws.
 */
class ReplayOptions private constructor(
  val sessionId: String,
  val projectId: String,
  val projectToken: String,
  /** Pacing: "auto", "session" or "navigation". */
  val mode: String,
  val frameInterval: Double,
  val maskText: Boolean,
  val maskInputs: Boolean,
  val maskImages: Boolean,
  val maskWebViews: Boolean,
  val debug: Boolean,
  val holdUploads: Boolean,
  val jpegQuality: Int,
  val maxLongestSide: Int,
  /** Null: the legacy upload (`/v1/replay/chunks`). */
  val otlp: Otlp?,
  /** `otlp` was given but cannot be used: replay must not start (it would otherwise fall back to the legacy wire unasked). */
  val otlpInvalid: Boolean,
  /** "pixel" or "structure". */
  val format: String,
  val delivery: ReplayDelivery,
  val bufferSeconds: Int,
  val replayId: String?,
  val keyframeIntervalMs: Long,
  val chunkMaxBytes: Int,
  val problems: List<String>,
) {
  class Otlp(val logsUrl: String, val resource: List<Pair<String, Any>>, val schemaUrl: String, val scopeVersion: String)

  companion object {
    const val FORMAT_PIXEL = "pixel"
    const val FORMAT_STRUCTURE = "structure"

    fun parse(raw: Map<String, Any?>?): ReplayOptions {
      val o = raw ?: emptyMap()
      val problems = ArrayList<String>()

      fun str(key: String, default: String): String {
        val v = o[key] ?: return default
        if (v is String) return v
        problems.add(key)
        return default
      }

      fun bool(key: String, default: Boolean): Boolean {
        val v = o[key] ?: return default
        if (v is Boolean) return v
        problems.add(key)
        return default
      }

      fun num(key: String, default: Double, min: Double, max: Double): Double {
        val v = o[key] ?: return default
        val d = (v as? Number)?.toDouble()
        if (d == null || d.isNaN()) {
          problems.add(key)
          return default
        }
        if (d < min || d > max) problems.add(key)
        return d.coerceIn(min, max)
      }

      var otlp: Otlp? = null
      var otlpInvalid = false
      if (o["otlp"] != null) {
        val m = o["otlp"] as? Map<*, *>
        val url = (m?.get("logsUrl") as? String)?.trim()
        if (m == null || url == null || !(url.startsWith("http://") || url.startsWith("https://")) || url.length > 2048) {
          otlpInvalid = true
          problems.add("otlp")
        } else {
          val resource = ArrayList<Pair<String, Any>>()
          val r = m["resource"]
          if (r is Map<*, *>) {
            for ((k, v) in r) {
              if (resource.size >= 128) break
              if (k !is String || k.isEmpty()) continue
              when (v) {
                is String -> resource.add(k to (if (v.length > 4096) v.substring(0, 4096) else v))
                is Boolean -> resource.add(k to v)
                is Int, is Long, is Short, is Byte -> resource.add(k to (v as Number).toLong())
                is Number -> if (v.toDouble().isFinite()) resource.add(k to v.toDouble()) else problems.add("otlp.resource.$k")
                else -> problems.add("otlp.resource.$k")
              }
            }
          } else if (r != null) {
            problems.add("otlp.resource")
          }
          fun text(key: String): String {
            val v = m[key] ?: return ""
            if (v is String) return v
            problems.add("otlp.$key")
            return ""
          }
          otlp = Otlp(url, resource, text("schemaUrl"), text("scopeVersion"))
        }
      }

      val format = when (o["format"]) {
        null, FORMAT_PIXEL -> FORMAT_PIXEL
        FORMAT_STRUCTURE -> FORMAT_STRUCTURE
        else -> FORMAT_PIXEL.also { problems.add("format") }
      }
      val delivery = when (o["replayMode"]) {
        null, "session" -> ReplayDelivery.SESSION
        "buffer" -> ReplayDelivery.BUFFER
        else -> ReplayDelivery.SESSION.also { problems.add("replayMode") }
      }
      val replayId = (o["replayId"] as? String)?.lowercase()?.takeIf { Hex.isId(it) }
      if (o["replayId"] != null && replayId == null) problems.add("replayId")

      return ReplayOptions(
        sessionId = str("sessionId", ""),
        projectId = str("projectId", "").trim(),
        projectToken = str("projectToken", "").trim(),
        mode = str("mode", "auto"),
        frameInterval = num("frameInterval", 1.0, 0.1, 3600.0),
        maskText = bool("maskText", true),
        maskInputs = bool("maskInputs", true),
        maskImages = bool("maskImages", true),
        maskWebViews = bool("maskWebViews", true),
        debug = bool("debug", false),
        holdUploads = bool("holdUploads", false),
        jpegQuality = num("jpegQuality", 50.0, 1.0, 100.0).toInt(),
        maxLongestSide = num("maxLongestSide", 1000.0, 64.0, 4096.0).toInt(),
        otlp = otlp,
        otlpInvalid = otlpInvalid,
        format = format,
        delivery = delivery,
        bufferSeconds = num("bufferSeconds", 60.0, 5.0, 600.0).toInt(),
        replayId = replayId,
        keyframeIntervalMs = num("keyframeIntervalMs", 300_000.0, 5_000.0, 3_600_000.0).toLong(),
        chunkMaxBytes = num("chunkMaxBytes", 256.0 * 1024, 4.0 * 1024, 1024.0 * 1024).toInt(),
        problems = problems,
      )
    }
  }
}
