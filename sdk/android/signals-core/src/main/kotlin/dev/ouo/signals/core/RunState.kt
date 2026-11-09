package dev.ouo.signals.core

import org.json.JSONArray
import org.json.JSONObject

/**
 * What a run leaves for the next launch to judge its end (mobile SDK spec C3.2): the process, the
 * session it served, the last memory warning, and the hang in progress with the stack read at its
 * detection. `ApplicationExitInfo` says how the process died and when; this says what it was doing.
 */
data class RunState(
  val pid: Int,
  val sessionId: String = "",
  val sessionStartedMs: Long = 0,
  val memoryWarningMs: Long? = null,
  val hangStartedMs: Long? = null,
  val hangFrames: List<JvmFrame> = emptyList(),
) {
  fun toJson(): String {
    val o = JSONObject().put("pid", pid).put("sessionId", sessionId).put("sessionStartedMs", sessionStartedMs)
    if (memoryWarningMs != null) o.put("memoryWarningMs", memoryWarningMs)
    if (hangStartedMs != null) {
      o.put("hangStartedMs", hangStartedMs)
      o.put("hangFrames", JSONArray(hangFrames.map { it.toJson() }))
    }
    return o.toString()
  }

  companion object {
    fun parse(raw: String?): RunState? =
      runCatching {
        val o = JSONObject(raw ?: return null)
        val frames = o.optJSONArray("hangFrames")
        RunState(
          pid = o.getInt("pid"),
          sessionId = o.optString("sessionId"),
          sessionStartedMs = o.optLong("sessionStartedMs"),
          memoryWarningMs = if (o.has("memoryWarningMs")) o.getLong("memoryWarningMs") else null,
          hangStartedMs = if (o.has("hangStartedMs")) o.getLong("hangStartedMs") else null,
          hangFrames = frames?.let { a -> (0 until a.length()).map { JvmFrame.fromJson(a.getJSONObject(it)) } } ?: emptyList(),
        )
      }.getOrNull()
  }
}

/**
 * How a process died, as `ApplicationExitInfo` (Android 11+) reports it: [reason] is its
 * `REASON_*` code, [importance] the process importance when it died, [signal] the signal of a
 * `REASON_SIGNALED` exit, [timestampMs] when it died.
 */
data class Exit(val pid: Int, val reason: Int, val importance: Int, val signal: Int, val timestampMs: Long)

/** The spec's foreground termination heuristic on Android (C3.2), pure so the cases are tested. */
object Termination {
  // ApplicationExitInfo.REASON_* and RunningAppProcessInfo.IMPORTANCE_*, copied: they are API 30 constants.
  const val REASON_EXIT_SELF = 1
  const val REASON_SIGNALED = 2
  const val REASON_LOW_MEMORY = 3
  const val REASON_CRASH = 4
  const val REASON_CRASH_NATIVE = 5
  const val REASON_ANR = 6
  const val REASON_INITIALIZATION_FAILURE = 7
  const val REASON_PERMISSION_CHANGE = 8
  const val REASON_EXCESSIVE_RESOURCE_USAGE = 9
  const val REASON_USER_REQUESTED = 10
  const val REASON_USER_STOPPED = 11
  const val REASON_DEPENDENCY_DIED = 12
  const val REASON_OTHER = 13
  const val REASON_FREEZER = 14
  const val REASON_PACKAGE_STATE_CHANGE = 15
  const val REASON_PACKAGE_UPDATED = 16
  const val IMPORTANCE_FOREGROUND = 100
  const val IMPORTANCE_VISIBLE = 200
  const val SIGKILL = 9

  /** A memory warning this close before the death makes a kill a memory termination (as on iOS). */
  const val MEMORY_WARNING_WINDOW_MS = 60_000L

  /**
   * The termination report of the previous run, or null when it ended another way. [exit] is the
   * exit record of the previous run's process ([previous] names its pid); [crashReported]: the run
   * left a crash report, which wins.
   *
   * A termination is a death while the app was in the foreground (importance foreground or visible,
   * nothing else: a foreground service of a backgrounded app is 125) that no handler saw: the
   * low-memory killer (`memory`), an ANR (`watchdog`), excessive resource use (`cpu`), an NDK crash
   * without a readable tombstone (`unknown`: Android 11, or no tombstone written; with one,
   * [NativeCrash.decide] reports the crash and [crashReported] is true), and a `SIGKILL` (`memory` after a memory warning in the
   * last minute, `watchdog` during a hang, else `unknown`). A user's force stop or swipe, `exit()`, a
   * package update, a permission change and any death in the background are not.
   */
  fun decide(previous: RunState?, exit: Exit?, crashReported: Boolean): Report? {
    if (previous == null || exit == null || crashReported || exit.pid != previous.pid) return null
    if (exit.importance != IMPORTANCE_FOREGROUND && exit.importance != IMPORTANCE_VISIBLE) return null
    val cause = when (exit.reason) {
      REASON_LOW_MEMORY -> "memory"
      REASON_ANR -> "watchdog"
      REASON_EXCESSIVE_RESOURCE_USAGE -> "cpu"
      REASON_CRASH_NATIVE -> "unknown"
      REASON_SIGNALED ->
        if (exit.signal != SIGKILL) return null
        else if (previous.memoryWarningMs != null && exit.timestampMs - previous.memoryWarningMs in 0..MEMORY_WARNING_WINDOW_MS) "memory"
        else if (previous.hangStartedMs != null) "watchdog"
        else "unknown"
      else -> return null
    }
    return Report(
      mechanism = "termination",
      timestampMs = exit.timestampMs,
      sessionId = previous.sessionId,
      sessionStartedMs = previous.sessionStartedMs.takeIf { it > 0 },
      mainThread = if (previous.hangStartedMs != null) true else null,
      frames = if (previous.hangStartedMs != null) previous.hangFrames else emptyList(),
      terminationCause = cause,
    )
  }
}
