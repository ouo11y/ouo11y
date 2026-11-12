package dev.ouo.replay

import android.view.KeyboardShortcutGroup
import android.view.Menu
import android.view.MotionEvent
import android.view.Window
import dev.ouo.replay.core.Touch
import dev.ouo.replay.core.TouchPhase

/**
 * Observes touches on a window without changing them: wraps its `Window.Callback` and records the
 * first pointer of every event it forwards (Sentry's and curtains' technique). Coordinates are in
 * dp of the window, the replay's points. Moves are sampled every [moveIntervalMs]. Main thread.
 */
internal class TouchRecorder(private val density: () -> Float, private val onTouch: (Touch) -> Unit) {
  private var window: Window? = null
  private var wrapper: Callback? = null
  private var lastMoveAt = 0L
  private val moveIntervalMs = 50L

  /** Starts observing [target], stops observing the previous window. */
  fun attach(target: Window?) {
    if (target === window) return
    detach()
    val delegate = target?.callback ?: return
    val cb = Callback(delegate)
    target.callback = cb
    window = target
    wrapper = cb
  }

  /** Restores the window's callback when ours is still on top; otherwise only stops recording through it. */
  fun detach() {
    val w = window
    val cb = wrapper
    if (w != null && cb != null) {
      if (w.callback === cb) w.callback = cb.delegate
      cb.active = false
    }
    window = null
    wrapper = null
  }

  private fun record(e: MotionEvent) {
    val phase = when (e.actionMasked) {
      MotionEvent.ACTION_DOWN -> TouchPhase.BEGAN
      MotionEvent.ACTION_MOVE -> TouchPhase.MOVED
      MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> TouchPhase.ENDED
      else -> return
    }
    val now = System.currentTimeMillis()
    if (phase == TouchPhase.MOVED) {
      if (now - lastMoveAt < moveIntervalMs) return
      lastMoveAt = now
    }
    val d = density().let { if (it.isFinite() && it > 0f) it else 1f }
    onTouch(Touch(now, (e.getX(0) / d).toDouble(), (e.getY(0) / d).toDouble(), phase))
  }

  private inner class Callback(val delegate: Window.Callback) : Window.Callback by delegate {
    var active = true

    override fun dispatchTouchEvent(event: MotionEvent?): Boolean {
      // Never let the recorder change what the app's own callback sees or throws.
      if (active && event != null) {
        try {
          record(event)
        } catch (ignored: Throwable) {
        }
      }
      return delegate.dispatchTouchEvent(event)
    }

    // Default methods of the interface: forwarded explicitly, delegation only covers abstract ones.
    override fun onProvideKeyboardShortcuts(data: MutableList<KeyboardShortcutGroup>?, menu: Menu?, deviceId: Int) =
      delegate.onProvideKeyboardShortcuts(data, menu, deviceId)

    override fun onPointerCaptureChanged(hasCapture: Boolean) = delegate.onPointerCaptureChanged(hasCapture)
  }
}
