package dev.ouo.reactnative

import android.content.Context
import android.hardware.display.DisplayManager
import android.os.Handler
import android.os.Looper
import android.os.Process
import android.os.SystemClock
import android.view.Choreographer
import android.view.Display

/**
 * The native measurements of docs/specs/mobile-vitals.md on Android, behind the same Expo functions
 * as the iOS `OuoVitals` (`getAppStartInfo`, `getFrameStats`), so the JavaScript computes app start,
 * the first screen's TTID and TTFD, and `app.jank` the same way on both platforms.
 *
 * - App start: the process start (`Process.getStartUptimeMillis()`) for the first JS runtime of the
 *   process (cold), the runtime's own start for a later one (warm: a reload, an activity re-created
 *   in a live process).
 * - Frames: a `Choreographer` callback per vsync while the app is in the foreground; a frame is slow
 *   when it took longer than the display's frame duration (with 4 ms of tolerance) and frozen from
 *   700 ms (Sentry's and Android vitals' definitions). The frame duration follows the display's
 *   refresh rate as it changes (a 120 Hz panel that drops to 60 Hz when idle), through a
 *   `DisplayListener`. Paused in the background, where a gap is not
 *   a frame. The callback only counts: a few nanoseconds per frame on the main thread.
 *
 * W9 part 2 moves both onto opentelemetry-android (ADR-0016) for the native package.
 */
internal object Vitals {
  private val main = Handler(Looper.getMainLooper())
  private var runtimes = 0

  @Volatile private var total = 0L
  @Volatile private var slow = 0L
  @Volatile private var frozen = 0L
  @Volatile private var delayMs = 0.0
  @Volatile private var expectedMs = 1000.0 / 60
  private var last = 0L
  private var running = false
  private var started = false

  private val callback = object : Choreographer.FrameCallback {
    override fun doFrame(frameTimeNanos: Long) {
      if (!running) return
      if (last != 0L) {
        val ms = (frameTimeNanos - last) / 1e6
        total++
        if (ms >= FROZEN_MS) frozen++ else if (ms > expectedMs + TOLERANCE_MS) slow++
        if (ms > expectedMs) delayMs += ms - expectedMs
      }
      last = frameTimeNanos
      Choreographer.getInstance().postFrameCallback(this)
    }
  }

  /** Once per JS runtime: cold for the first in the process, warm after. Main or any thread. */
  @Synchronized
  fun beginRuntime(createdAtMs: Double): Map<String, Any> {
    runtimes++
    if (runtimes > 1) return mapOf("processStartMs" to createdAtMs, "type" to "warm", "prewarmed" to false)
    val processStart = System.currentTimeMillis() - (SystemClock.uptimeMillis() - Process.getStartUptimeMillis())
    return mapOf("processStartMs" to processStart.toDouble(), "type" to "cold", "prewarmed" to false)
  }

  /** Starts counting frames (idempotent); the frame duration follows the default display. */
  fun startFrameTracking(context: Context) {
    main.post {
      if (!started) {
        started = true
        val dm = context.applicationContext.getSystemService(Context.DISPLAY_SERVICE) as? DisplayManager
        val read = { dm?.getDisplay(Display.DEFAULT_DISPLAY)?.refreshRate?.takeIf { it > 1f }?.let { expectedMs = 1000.0 / it } }
        read()
        dm?.registerDisplayListener(
          object : DisplayManager.DisplayListener {
            override fun onDisplayChanged(displayId: Int) {
              if (displayId == Display.DEFAULT_DISPLAY) read()
            }

            override fun onDisplayAdded(displayId: Int) {}

            override fun onDisplayRemoved(displayId: Int) {}
          },
          main,
        )
      }
      resume()
    }
  }

  fun resume() = main.post {
    if (running || !started) return@post
    running = true
    last = 0L
    Choreographer.getInstance().postFrameCallback(callback)
  }

  fun pause() = main.post {
    running = false
    Choreographer.getInstance().removeFrameCallback(callback)
  }

  /** Cumulative counters since tracking started; JS diffs two snapshots. Null before the first frame. */
  fun frameStats(): Map<String, Any>? {
    if (total == 0L) return null
    return mapOf("total" to total.toDouble(), "slow" to slow.toDouble(), "frozen" to frozen.toDouble(), "delayMs" to delayMs, "expectedFrameMs" to expectedMs)
  }

  private const val FROZEN_MS = 700.0
  private const val TOLERANCE_MS = 4.0
}
