package dev.ouo.replay

import android.util.Log
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Android stub: same function names as the iOS module so the JS side is platform-agnostic.
 * Every call is a no-op; the first one logs a warning. ADR-0006 schedules Android capture
 * after iOS works.
 */
class OuoReplayModule : Module() {
  companion object {
    private const val TAG = "ouo"
    @Volatile private var warned = false

    private fun warnOnce() {
      if (!warned) {
        warned = true
        Log.w(TAG, "ouo replay: Android not implemented yet (ADR-0006)")
      }
    }
  }

  override fun definition() = ModuleDefinition {
    Name("OuoReplay")

    Function("start") { _: String, _: Map<String, Any?> -> warnOnce() }
    Function("pause") { warnOnce() }
    Function("resume") { warnOnce() }
    Function("isRecording") { false }
    AsyncFunction("flush") { warnOnce() }
    Function("sessionDidRotate") { _: String -> warnOnce() }
    Function("setSessionId") { _: String -> }
    Function("stop") { }
  }
}
