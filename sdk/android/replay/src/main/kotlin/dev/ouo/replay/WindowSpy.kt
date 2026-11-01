package dev.ouo.replay

import android.annotation.SuppressLint
import android.app.Activity
import android.view.View
import android.view.Window

/**
 * Finds what to capture, RootViewsSpy-style (Square's curtains, Sentry's `RootViewsSpy`): the root
 * views of every window of the process, read from `WindowManagerGlobal.mViews` (a non-SDK field on
 * the "unsupported" list apps may read), so a full-screen dialog (a React Native `Modal`) above the
 * activity is what gets recorded. Falls back to the resumed activity's window when the field is not
 * readable. Main thread only.
 */
internal object WindowSpy {
  /** The window to copy and the root view to walk; [window] is null when only a software draw works. */
  class Target(val root: View, val window: Window?)

  @SuppressLint("PrivateApi", "DiscouragedPrivateApi")
  private val globalViews: (() -> List<View>)? = runCatching {
    val cls = Class.forName("android.view.WindowManagerGlobal")
    val instance = cls.getMethod("getInstance").invoke(null)
    val field = cls.getDeclaredField("mViews").apply { isAccessible = true }
    val read: () -> List<View> = {
      @Suppress("UNCHECKED_CAST")
      (field.get(instance) as? List<View>)?.toList() ?: emptyList()
    }
    read()
    read
  }.getOrNull()

  @SuppressLint("PrivateApi", "DiscouragedPrivateApi")
  private val decorWindow = runCatching {
    Class.forName("com.android.internal.policy.DecorView").getDeclaredField("mWindow").apply { isAccessible = true }
  }.getOrNull()

  /** Root views in z-order (bottom first); just the activity's when the spy is not available. */
  fun rootViews(activity: Activity?): List<View> {
    val all = runCatching { globalViews?.invoke() }.getOrNull()
    if (!all.isNullOrEmpty()) return all
    return listOfNotNull(activity?.window?.peekDecorView())
  }

  /**
   * The topmost visible window that covers the activity's window (the activity itself, or a
   * full-screen dialog over it). Popups, toasts and partial dialogs are not recorded (part 1).
   */
  fun captureTarget(activity: Activity?): Target? {
    val activityWindow = activity?.window
    val activityRoot = activityWindow?.peekDecorView()
    val roots = rootViews(activity)
    val w = activityRoot?.width ?: 0
    val h = activityRoot?.height ?: 0
    for (root in roots.asReversed()) {
      if (!root.isAttachedToWindow || root.visibility != View.VISIBLE || root.width <= 0 || root.height <= 0) continue
      if (root === activityRoot) return Target(root, activityWindow)
      if (activityRoot != null && (root.width < w || root.height < h)) continue
      val window = windowOf(root) ?: continue
      return Target(root, window)
    }
    return activityRoot?.takeIf { it.width > 0 && it.height > 0 }?.let { Target(it, activityWindow) }
  }

  /** The `Window` of a `DecorView` (activity or dialog), null for other roots (popups, toasts). */
  fun windowOf(root: View): Window? = runCatching { decorWindow?.get(root) as? Window }.getOrNull()
}
