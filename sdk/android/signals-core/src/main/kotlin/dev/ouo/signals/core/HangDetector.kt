package dev.ouo.signals.core

/**
 * App hangs on Android (mobile SDK spec C3.1), the rules without the threads: a watchdog thread
 * asks every 200 ms when the main thread last answered (a message it posts to the main looper and
 * the main thread runs), so a hang's start and end are known within one tick. The main thread is hung once it has not answered for
 * [thresholdMs] (2 s, the spec's and Sentry's timeout). The hang is over when it answers again;
 * it started at its last answer before, so its duration is the whole blocked time. One hang per
 * block, however long, and none for [quietMs] after one ended.
 *
 * Android has no display link that ticks while idle (a screen that does not change draws no
 * frames), so the iOS rules on frame delays do not carry over; a ping is what Android's own ANR
 * detection and Sentry's Android watchdog use. A gap in the watchdog's own ticks (the process was
 * frozen, a debugger stopped it) is not a hang: measuring restarts.
 */
class HangDetector(val thresholdMs: Long = 2_000, val quietMs: Long = 2_000) {
  sealed class Event {
    /** The main thread is hung since [startedAt]: read its stack now. */
    data class Started(val startedAt: Long) : Event()

    /** The hang is over: report it. */
    data class Ended(val startedAt: Long, val endedAt: Long) : Event() {
      val durationMs: Long get() = endedAt - startedAt
    }
  }

  private var hangStartedAt: Long? = null
  private var quietUntil = Long.MIN_VALUE
  private var lastTick: Long? = null

  val inHang: Boolean get() = hangStartedAt != null

  /**
   * One watchdog tick at [now]; [lastAnswer] is when the main thread last ran the watchdog's
   * message. Returns what happened, if anything.
   */
  fun tick(now: Long, lastAnswer: Long): Event? {
    val previousTick = lastTick
    lastTick = now
    // The watchdog itself did not run for a while: the process was frozen or stopped. A hang in
    // progress ends at its last answer seen; nothing starts from this tick.
    if (previousTick != null && now - previousTick > thresholdMs) {
      val start = hangStartedAt ?: return null
      hangStartedAt = null
      quietUntil = previousTick + quietMs
      return Event.Ended(start, maxOf(start, previousTick))
    }
    val start = hangStartedAt
    if (start != null) {
      if (lastAnswer <= start) return null
      hangStartedAt = null
      quietUntil = lastAnswer + quietMs
      return Event.Ended(start, lastAnswer)
    }
    if (now - lastAnswer >= thresholdMs && now >= quietUntil) {
      hangStartedAt = lastAnswer
      return Event.Started(lastAnswer)
    }
    return null
  }

  /**
   * Measuring stops at [now] (the app left the foreground, a debugger attached); it restarts with
   * the next [tick]. A hang in progress ends: at the main thread's answer after it ([lastAnswer])
   * when there was one, else at [now], since leaving the foreground ran on the main thread. As on
   * iOS, a hang the user left the app during is still reported.
   */
  fun interrupt(now: Long, lastAnswer: Long): Event.Ended? {
    lastTick = null
    val start = hangStartedAt ?: return null
    hangStartedAt = null
    val end = if (lastAnswer > start) lastAnswer else maxOf(start, now)
    quietUntil = end + quietMs
    return Event.Ended(start, end)
  }
}
