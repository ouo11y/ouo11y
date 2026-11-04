package dev.ouo.signals.core

/**
 * Slow and frozen frames (docs/specs/mobile-vitals.md) from the frames a window rendered, as
 * `FrameMetrics` reports them: a frame is slow when it took longer than its deadline (the
 * display's frame duration) and frozen from 700 ms, the definitions of Android vitals and Sentry.
 * Counts rendered frames only (an idle screen renders none). Cumulative: the JavaScript diffs two
 * snapshots. Thread-safe: `FrameMetrics` listeners run on a background thread.
 */
class FrameCounter {
  private var total = 0L
  private var slow = 0L
  private var frozen = 0L
  private var delayMs = 0.0
  private var expectedMs = 1000.0 / 60

  /** One rendered frame of [durationMs]; [deadlineMs] its budget (the refresh interval). */
  @Synchronized
  fun frame(durationMs: Double, deadlineMs: Double) {
    if (durationMs <= 0 || deadlineMs <= 0) return
    expectedMs = deadlineMs
    total++
    if (durationMs >= FROZEN_MS) frozen++ else if (durationMs > deadlineMs) slow++
    if (durationMs > deadlineMs) delayMs += durationMs - deadlineMs
  }

  /** `{ total, slow, frozen, delayMs, expectedFrameMs }`, null before the first frame (nothing measured). */
  @Synchronized
  fun snapshot(): Map<String, Double>? =
    if (total == 0L) null
    else mapOf("total" to total.toDouble(), "slow" to slow.toDouble(), "frozen" to frozen.toDouble(), "delayMs" to delayMs, "expectedFrameMs" to expectedMs)

  companion object {
    const val FROZEN_MS = 700.0
  }
}

/**
 * The start of a launch for `ouo.app.start` (docs/specs/mobile-vitals.md): a cold start runs from
 * the process start, but only when the process was started to show the app. A process the system
 * started earlier for a broadcast receiver, a service, a content provider or a job was alive
 * before the user opened the app: that launch is warm, from the JS runtime's start.
 */
object AppStart {
  /** A process started longer than this before the JS runtime was not started for this launch (Android < 15). */
  const val COLD_WINDOW_MS = 10_000L

  /**
   * [processStartMs] and [runtimeStartMs] are epoch ms; [firstRuntime]: the first JS runtime of
   * the process; [startedForActivity]: Android 15's `ApplicationStartInfo` says the process was
   * started for an activity (null where unknown, then the 10 s window decides).
   */
  fun of(processStartMs: Long, runtimeStartMs: Long, firstRuntime: Boolean, startedForActivity: Boolean?): Pair<String, Long> {
    if (!firstRuntime) return "warm" to runtimeStartMs
    val cold = startedForActivity ?: (runtimeStartMs - processStartMs in 0..COLD_WINDOW_MS)
    return if (cold) "cold" to processStartMs else "warm" to runtimeStartMs
  }
}
