package dev.ouo.signals.core

import org.json.JSONArray
import org.json.JSONObject

/**
 * One frame of a JVM stack in the report, with Sentry's Java frame field names (`module` is the
 * class, `function` the method), so a later R8 / ProGuard symbolication reads them as they are.
 */
data class JvmFrame(val module: String, val function: String, val filename: String?, val lineno: Int?) {
  fun toJson(): JSONObject {
    val o = JSONObject().put("module", module).put("function", function)
    if (filename != null) o.put("filename", filename)
    if (lineno != null && lineno >= 0) o.put("lineno", lineno)
    return o
  }

  companion object {
    fun of(e: StackTraceElement) = JvmFrame(e.className, e.methodName, e.fileName, e.lineNumber.takeIf { it >= 0 })

    fun fromJson(o: JSONObject) = JvmFrame(o.getString("module"), o.getString("function"), o.optString("filename").ifEmpty { null }, if (o.has("lineno")) o.getInt("lineno") else null)
  }
}

/**
 * The native report the React Native SDK reads (`sdk/react-native/src/crash.ts`, the format of
 * `project/kb/ios-native-crashes.md`), for the Android mechanisms: `jvm` (an uncaught Java or Kotlin
 * exception), `hang` (the main thread stopped answering for 2 s or more) and `termination` (the
 * previous run was killed in the foreground without a crash report). Frames are JVM frames.
 */
data class Report(
  val mechanism: String,
  val timestampMs: Long,
  val sessionId: String,
  val sessionStartedMs: Long? = null,
  val exceptionName: String? = null,
  val exceptionReason: String? = null,
  val mainThread: Boolean? = null,
  val frames: List<JvmFrame> = emptyList(),
  val hangDurationMs: Long? = null,
  val hangFullyBlocking: Boolean? = null,
  val terminationCause: String? = null,
) {
  fun toJson(): String {
    val o = JSONObject()
      .put("version", 1)
      .put("platform", "android")
      .put("mechanism", mechanism)
      .put("timestamp_ms", timestampMs)
      .put("session_id", sessionId)
      .put("frames", JSONArray(frames.map { it.toJson() }))
      .put("images", JSONArray())
    if (sessionStartedMs != null && sessionStartedMs > 0) o.put("session_started_ms", sessionStartedMs)
    if (exceptionName != null) o.put("exception", JSONObject().put("name", exceptionName).put("reason", exceptionReason ?: ""))
    if (mainThread != null) o.put("thread", JSONObject().put("main", mainThread))
    if (hangDurationMs != null) o.put("hang", JSONObject().put("duration_ms", hangDurationMs).put("fully_blocking", hangFullyBlocking == true))
    if (terminationCause != null) o.put("termination", JSONObject().put("cause", terminationCause))
    return o.toString()
  }

  companion object {
    /** At most this many frames of a stack (the top ones): a stack overflow has thousands. */
    const val MAX_FRAMES = 100

    fun frames(stack: Array<StackTraceElement>): List<JvmFrame> = stack.take(MAX_FRAMES).map(JvmFrame::of)

    /**
     * The exception's own name and message, with each cause appended (`Caused by: Name: message`):
     * React Native and coroutines wrap the exception that says what happened.
     */
    fun describe(t: Throwable): Pair<String, String> {
      val parts = mutableListOf(t.message ?: "")
      var cause = t.cause
      var depth = 0
      while (cause != null && cause !== t && depth < 5) {
        parts.add("Caused by: ${cause.javaClass.name}: ${cause.message ?: ""}")
        cause = cause.cause
        depth++
      }
      return t.javaClass.name to parts.filter { it.isNotEmpty() }.joinToString("\n")
    }
  }
}
