package dev.ouo.replay.core

/** What the recorder captures (docs/specs/mobile-replay.md, "Modes"). */
enum class ReplayMode(val wire: String) {
  /** One frame per `frameInterval` while the screen changes. */
  SESSION("session"),

  /** One frame per screen: on start, resume and every `screenDidChange()`. The low-end default. */
  NAVIGATION("navigation"),

  /** [NAVIGATION] on devices with less than [LOW_END_MEMORY] of RAM, [SESSION] otherwise. */
  AUTO("auto");

  fun resolved(totalMemory: Long): ReplayMode = if (this != AUTO) this else if (totalMemory in 1 until LOW_END_MEMORY) NAVIGATION else SESSION

  companion object {
    /** 3.5 GiB, the iOS threshold: Android devices with 3 GB or less count as low end. */
    const val LOW_END_MEMORY: Long = 3L * 1024 * 1024 * 1024 + 512L * 1024 * 1024

    fun of(wire: String?): ReplayMode = entries.firstOrNull { it.wire == wire } ?: AUTO
  }
}

/**
 * Decides on the main thread whether a frame is captured now. A pure state machine on monotonic
 * seconds, so the rules are unit tested without Android; the Swift `CapturePacer` of `sdk/ios`
 * with the Android signals:
 *
 * - **Interval**: at most one frame per [interval] in `session` mode, and only when the window
 *   drew since the last frame (the recorder's `OnDrawListener` dirty flag: a static screen costs
 *   nothing); in `navigation` mode only when a screen change (or start / resume) is pending,
 *   [settleDelay] after it was signalled.
 * - **Settle**: nothing is due until [settleTime] after the last [motion] (a capture dropped
 *   because a masked view moved).
 * - **Time bank** (Datadog): the main-thread part of capturing may spend [budgetPerSecond] per
 *   second, banked up to [budgetPerSecond]. While the bank is negative nothing is captured, which
 *   is also the backoff on slow devices.
 * - **Retry**: a requested frame (resume, a new screen) that was dropped is asked for again
 *   [retryDelay] later, at most [maxRetries] times.
 */
class CapturePacer(mode: ReplayMode, interval: Double) {
  sealed class Decision {
    data class Capture(val reason: FrameReason) : Decision()

    object Wait : Decision()
  }

  val mode: ReplayMode = if (mode == ReplayMode.AUTO) ReplayMode.SESSION else mode
  val interval: Double = maxOf(0.1, interval)
  var settleDelay = 0.4
  var settleTime = 0.25
  var budgetPerSecond = 0.1
  var retryDelay = 0.5
  var maxRetries = 3

  private var lastCaptureAt: Double? = null
  private var lastMotionAt: Double? = null
  private var pendingReason: FrameReason? = null
  private var pendingAt = 0.0
  private var retries = 0
  private var bank = budgetPerSecond
  private var bankUpdatedAt: Double? = null

  /** Start or resume: the first pass from [at] on captures, in every mode. */
  fun requestFrame(reason: FrameReason, at: Double) {
    pendingReason = reason
    pendingAt = at
    retries = 0
  }

  /** A new screen: in `navigation` mode the frame is taken once the screen settled. */
  fun screenDidChange(now: Double) {
    if (mode == ReplayMode.NAVIGATION) requestFrame(FrameReason.NAVIGATION, now + settleDelay)
  }

  /** Something on screen moved under a mask: wait [settleTime] before the next frame. */
  fun motion(now: Double) {
    lastMotionAt = now
  }

  /** A captured frame was not kept. Interval frames wait for the next interval; a requested one is asked for again. */
  fun dropped(reason: FrameReason, now: Double) {
    if (reason == FrameReason.TIMER || retries >= maxRetries) return
    retries++
    pendingReason = reason
    pendingAt = now + retryDelay
  }

  /**
   * The earliest time a frame can be due, null when none is wanted. [dirty]: the window drew since
   * the last frame; a `session` mode interval frame needs it, a requested one does not.
   */
  fun wakeAt(now: Double, dirty: Boolean): Double? {
    var at: Double = when {
      pendingReason != null -> pendingAt
      mode == ReplayMode.SESSION && dirty -> lastCaptureAt?.let { it + interval } ?: now
      else -> return null
    }
    lastMotionAt?.let { at = maxOf(at, it + settleTime) }
    val updated = bankUpdatedAt
    if (bank < 0 && updated != null) at = maxOf(at, updated - bank / budgetPerSecond)
    return at
  }

  fun decide(now: Double, dirty: Boolean): Decision {
    refill(now)
    val at = wakeAt(now, dirty) ?: return Decision.Wait
    if (now < at) return Decision.Wait
    val reason = pendingReason ?: FrameReason.TIMER
    pendingReason = null
    lastCaptureAt = now
    return Decision.Capture(reason)
  }

  /** The main-thread seconds a capture spent (walks and the copy request). */
  fun spent(seconds: Double, now: Double) {
    refill(now)
    bank -= maxOf(0.0, seconds)
  }

  val balance: Double get() = bank

  private fun refill(now: Double) {
    val at = bankUpdatedAt
    if (at != null && now > at) bank = minOf(budgetPerSecond, bank + (now - at) * budgetPerSecond)
    bankUpdatedAt = now
  }
}
