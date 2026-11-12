package dev.ouo.replay.core

/**
 * The one customer option that picks the recorder, `replay.mode` (ADR-0021 decision 5). There is no
 * shorthand: `pixel` alone is not a value. The format id each one puts on the wire is the
 * recorder's (`ouo.replay.format`).
 */
enum class ReplayRecorderMode(val wire: String) {
  /** ouo's own recorder: masked JPEG frames and tile patches, `ouo-frames/3`. The default. */
  PIXEL_FRAMES("pixel/frames"),

  /** Sentry's recorder core (sentry-java's video encoder) behind ouo's capture and masks: `ouo-video/1`, Android 8 or later. */
  PIXEL_VIDEO("pixel/video"),

  /** `ouo-wireframe/1`. Not in this build. */
  STRUCTURE_WIREFRAME("structure/wireframe");

  companion object {
    /** What this build of the Android SDK can record. */
    val supported: Set<ReplayRecorderMode> = setOf(PIXEL_FRAMES, PIXEL_VIDEO)

    fun of(wire: String?): ReplayRecorderMode? = entries.firstOrNull { it.wire == wire }
  }
}

/**
 * The OTLP replay options of `start(endpoint, options)`, read from what JavaScript passed (ADR-0021
 * decision 5). Reading never throws (ERR-1): a value of the wrong type or out of range falls back
 * to its default and is listed in `problems`. A missing or unusable `otlp.logsUrl`, or a `mode`
 * this build does not record, leaves replay off. The Swift `ReplayOTLPOptions` of `sdk/ios`, ported.
 *
 * | Key | Type | Default | |
 * |---|---|---|---|
 * | `otlp.logsUrl` | string | required | http(s) URL of `/v1/logs` |
 * | `otlp.resource` | object of string, number, boolean | `{}` | resource attributes, written in key order |
 * | `otlp.schemaUrl`, `otlp.scopeVersion` | string | `""` | on ScopeLogs and the scope |
 * | `otlp.previousExit` | `crash` or `background_kill` | `background_kill` | end reason of a stream the last run left open |
 * | `mode` | string | `pixel/frames` | the recorder |
 * | `cadence` | `auto`, `session`, `navigation` | `auto` | when to look (what `mode` meant before) |
 * | `buffer` | `{ seconds }` | absent | present: keep a ring and send on `capture(trigger)`; absent: record the whole session |
 * | `replayId` | 32 lowercase hex | generated | |
 * | `keyframeIntervalMs` | number | 300000 | 1000 to 3600000 |
 * | `chunkMaxBytes` | number | 262144 | 4096 to 1048576 |
 */
data class ReplayOTLPOptions(
  val logsUrl: String,
  val scope: ReplayScope,
  val recorder: ReplayRecorderMode = ReplayRecorderMode.PIXEL_FRAMES,
  /** When to look: the pacing the legacy path calls `mode`. */
  val cadence: ReplayMode = ReplayMode.AUTO,
  /** Seconds the ring holds; null records the whole session. */
  val bufferSeconds: Double? = null,
  /** 32 lowercase hex characters, null to generate one. */
  val replayId: String? = null,
  val keyframeIntervalMs: Long = 300_000,
  val chunkMaxBytes: Int = 256 * 1024,
  /** What ended the previous process, for the `ouo.replay.ended` of a stream it left open. */
  val previousExit: ReplayEndReason = ReplayEndReason.BACKGROUND_KILL,
) {
  val streamConfig: ReplayStreamConfig
    get() = ReplayStreamConfig(
      mode = if (bufferSeconds == null) ReplayCaptureMode.SESSION else ReplayCaptureMode.BUFFER,
      bufferSeconds = bufferSeconds ?: DEFAULT_BUFFER_SECONDS,
      keyframeIntervalMs = keyframeIntervalMs,
      chunkMaxBytes = chunkMaxBytes,
    )

  sealed class Parsed {
    /** No `otlp` key: the caller wants the upload path that existed before, with its options read as before. */
    object Legacy : Parsed()

    class Otlp(val options: ReplayOTLPOptions, val problems: List<String>) : Parsed()

    /** OTLP was asked for but replay cannot run: nothing starts, nothing throws. */
    class Off(val problems: List<String>) : Parsed()
  }

  /**
   * The start options that are not about OTLP (credential, session, pacing, masking), read with
   * the same leniency for the OTLP path.
   */
  data class Common(
    val sessionId: String = "",
    val projectId: String = "",
    val projectToken: String = "",
    val frameInterval: Double = 1.0,
    val maskText: Boolean = true,
    val maskInputs: Boolean = true,
    val maskImages: Boolean = true,
    val maskWebViews: Boolean = true,
    val debug: Boolean = false,
  ) {
    companion object {
      /** `problems` lists every value that was there but not usable. A mask option that is not a boolean masks (the safe side). */
      fun parse(raw: Map<String, Any?>?): Pair<Common, List<String>> {
        val o = raw ?: emptyMap()
        val problems = ArrayList<String>()
        fun text(key: String): String {
          val v = o[key] ?: return ""
          if (v !is String) {
            problems.add("$key is not a string")
            return ""
          }
          return v.trim().take(MAX_STRING_LENGTH)
        }
        fun flag(key: String, fallback: Boolean): Boolean {
          val v = o[key] ?: return fallback
          if (v !is Boolean) {
            problems.add("$key is not a boolean")
            return fallback
          }
          return v
        }
        var frameInterval = 1.0
        o["frameInterval"]?.let { v ->
          val n = number(v)
          if (n == null) problems.add("frameInterval is not a finite number")
          else {
            if (n < 0.1 || n > 60.0) problems.add("frameInterval is out of range, clamped")
            frameInterval = n.coerceIn(0.1, 60.0)
          }
        }
        return Common(
          sessionId = text("sessionId"),
          projectId = text("projectId"),
          projectToken = text("projectToken"),
          frameInterval = frameInterval,
          maskText = flag("maskText", true),
          maskInputs = flag("maskInputs", true),
          maskImages = flag("maskImages", true),
          maskWebViews = flag("maskWebViews", true),
          debug = flag("debug", false),
        ) to problems
      }
    }
  }

  companion object {
    const val MAX_RESOURCE_ATTRIBUTES = 128
    const val MAX_STRING_LENGTH = 2048
    const val DEFAULT_BUFFER_SECONDS = 60.0

    /** A finite number. A boolean is not a number. */
    fun number(value: Any?): Double? {
      if (value !is Number) return null
      val d = value.toDouble()
      return if (d.isFinite()) d else null
    }

    /** A resource value: a string, a boolean, or a number (a Long when it is integral and exact in a double, else a Double). */
    fun attribute(value: Any?): Any? {
      if (value is String) return value.take(MAX_STRING_LENGTH)
      if (value is Boolean) return value
      val n = number(value) ?: return null
      return if (n == Math.rint(n) && Math.abs(n) <= 9_007_199_254_740_992.0) n.toLong() else n
    }

    fun parse(raw: Map<String, Any?>?): Parsed =
      try {
        read(raw ?: emptyMap())
      } catch (e: Throwable) {
        // Whatever a map from JavaScript can throw at us: replay stays off, the app goes on.
        if (raw?.containsKey("otlp") == true) Parsed.Off(listOf("options could not be read")) else Parsed.Legacy
      }

    private fun read(raw: Map<String, Any?>): Parsed {
      val rawOtlp = raw["otlp"] ?: return Parsed.Legacy
      val problems = ArrayList<String>()
      val otlp = rawOtlp as? Map<*, *> ?: return Parsed.Off(listOf("otlp is not an object"))
      val logs = (otlp["logsUrl"] as? String)?.trim()
      val uri = logs?.let { runCatching { java.net.URI(it) }.getOrNull() }
      val scheme = uri?.scheme?.lowercase()
      if (logs == null || uri == null || (scheme != "http" && scheme != "https") || uri.host.isNullOrEmpty()) {
        return Parsed.Off(listOf("otlp.logsUrl is missing or not an http(s) URL"))
      }

      fun text(key: String, map: Map<*, *>, path: String): String? {
        val v = map[key] ?: return null
        if (v !is String) {
          problems.add("$path is not a string")
          return null
        }
        return v.take(MAX_STRING_LENGTH)
      }
      fun clamped(value: Any?, path: String, min: Double, max: Double): Double? {
        if (value == null) return null
        val n = number(value)
        if (n == null) {
          problems.add("$path is not a finite number")
          return null
        }
        if (n < min || n > max) problems.add("$path is out of range, clamped")
        return n.coerceIn(min, max)
      }

      // The recorder first: a mode this build cannot record leaves replay off (never a guess).
      var recorder = ReplayRecorderMode.PIXEL_FRAMES
      raw["mode"]?.let { rawMode ->
        val mode = ReplayRecorderMode.of(rawMode as? String) ?: return Parsed.Off(listOf("mode is not a replay mode (pixel/frames, pixel/video, structure/wireframe)"))
        if (mode !in ReplayRecorderMode.supported) return Parsed.Off(listOf("mode ${mode.wire} is not supported by this build"))
        recorder = mode
      }

      val resource = ArrayList<Pair<String, Any>>()
      otlp["resource"]?.let { rawResource ->
        val dict = rawResource as? Map<*, *>
        if (dict == null) {
          problems.add("otlp.resource is not an object")
        } else {
          for (key in dict.keys.filterIsInstance<String>().sorted()) {
            if (resource.size >= MAX_RESOURCE_ATTRIBUTES) {
              problems.add("otlp.resource has more than $MAX_RESOURCE_ATTRIBUTES attributes, the rest are left out")
              break
            }
            val value = attribute(dict[key])
            if (key.isEmpty() || value == null) {
              problems.add("otlp.resource.${key.take(64)} is not a string, number or boolean")
              continue
            }
            resource.add(key.take(256) to value)
          }
        }
      }

      var options = ReplayOTLPOptions(
        logsUrl = logs,
        scope = ReplayScope(resource, text("scopeVersion", otlp, "otlp.scopeVersion") ?: "", text("schemaUrl", otlp, "otlp.schemaUrl") ?: ""),
        recorder = recorder,
      )
      text("cadence", raw, "cadence")?.let { cadence ->
        val c = ReplayMode.entries.firstOrNull { it.wire == cadence }
        if (c != null) options = options.copy(cadence = c) else problems.add("cadence is not auto, session or navigation")
      }
      // `buffer` absent, null or false: the whole session. An object: its seconds. Anything else
      // still asks for a buffer, so it gets the default rather than a full recording.
      val rawBuffer = raw["buffer"]
      if (rawBuffer != null && rawBuffer != false) {
        val buffer = rawBuffer as? Map<*, *>
        if (buffer != null) {
          options = options.copy(bufferSeconds = clamped(buffer["seconds"], "buffer.seconds", 5.0, 600.0) ?: DEFAULT_BUFFER_SECONDS)
        } else {
          problems.add("buffer is not an object, ${DEFAULT_BUFFER_SECONDS.toInt()} seconds assumed")
          options = options.copy(bufferSeconds = DEFAULT_BUFFER_SECONDS)
        }
      }
      text("replayId", raw, "replayId")?.takeIf { it.isNotEmpty() }?.let { id ->
        if (ReplayStream.isValidId(id)) options = options.copy(replayId = id) else problems.add("replayId is not 32 lowercase hex characters, a new one is generated")
      }
      text("previousExit", otlp, "otlp.previousExit")?.let { exit ->
        if (exit == ReplayEndReason.CRASH.wire) options = options.copy(previousExit = ReplayEndReason.CRASH)
        else if (exit != ReplayEndReason.BACKGROUND_KILL.wire) problems.add("otlp.previousExit is not crash or background_kill")
      }
      clamped(raw["keyframeIntervalMs"], "keyframeIntervalMs", 1000.0, 3_600_000.0)?.let { options = options.copy(keyframeIntervalMs = it.toLong()) }
      clamped(raw["chunkMaxBytes"], "chunkMaxBytes", 4096.0, ReplayStreamConfig.HARD_LIMIT_BYTES.toDouble())?.let { options = options.copy(chunkMaxBytes = it.toInt()) }
      return Parsed.Otlp(options, problems)
    }
  }
}
