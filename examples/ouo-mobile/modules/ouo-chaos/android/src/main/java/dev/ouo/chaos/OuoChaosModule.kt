package dev.ouo.chaos

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.Handler
import android.os.Looper
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Demo-only (Android): the journey's command channel and what the OS does to an app. Not part of the SDK.
 *
 * `scripts/journey-android.sh` and the Android conformance suite send commands as broadcasts
 * (`adb shell am broadcast -a dev.ouo.mobilestore.JOURNEY -p dev.ouo.mobilestore --es cmd 'screen/Cart'`),
 * which reach JS as `onJourneyCommand` events (src/journey.ts). The receiver is registered only
 * while JS listens, which src/journey.ts does in the conformance and debug builds: it is exported
 * (adb's shell user sends it), so a demo build does not take commands from other apps. A broadcast does not pause the
 * activity: an `am start` deep link would, and React Native reports every pause as a background.
 */
class OuoChaosModule : Module() {
  private var receiver: BroadcastReceiver? = null
  private val main = Handler(Looper.getMainLooper())

  override fun definition() = ModuleDefinition {
    Name("OuoChaos")

    Events("onJourneyCommand")

    OnStartObserving {
      val context = appContext.reactContext?.applicationContext ?: return@OnStartObserving
      if (receiver != null) return@OnStartObserving
      val r = object : BroadcastReceiver() {
        override fun onReceive(c: Context, intent: Intent) {
          val cmd = intent.getStringExtra("cmd") ?: return
          sendEvent("onJourneyCommand", mapOf("cmd" to cmd))
        }
      }
      val filter = IntentFilter(ACTION)
      if (Build.VERSION.SDK_INT >= 33) context.registerReceiver(r, filter, Context.RECEIVER_EXPORTED) else context.registerReceiver(r, filter)
      receiver = r
    }

    OnStopObserving {
      receiver?.let { r -> runCatching { appContext.reactContext?.applicationContext?.unregisterReceiver(r) } }
      receiver = null
    }

    /** Blocks the main thread for `ms` (no frame is drawn): a fully blocking hang. */
    AsyncFunction("blockMainThread") { ms: Double ->
      main.post { Thread.sleep(ms.toLong()) }
    }

    /** Blocks the main thread `times` times for `ms`, with a frame between the blocks. */
    Function("stutterMainThread") { ms: Double, times: Int ->
      for (i in 0 until times) main.postDelayed({ Thread.sleep(ms.toLong()) }, i * (ms.toLong() + 50))
    }

    /** A native crash: an uncaught exception on the main thread kills the process. */
    Function("crashNatively") {
      main.post { throw IllegalStateException("ouo-mobile: native crash from the Chaos module") }
    }

    /**
     * An NDK crash in C code (`libouochaos.so`) on the JS thread, where a crash in Hermes or a
     * third-party library's JSI code happens: `abort` true is `abort()` with an abort message, else
     * a SIGSEGV at address 0. No handler runs; Android 12+ keeps the tombstone for the next launch.
     */
    Function("crashInNativeCode") { abort: Boolean ->
      NativeCrash.crash(if (abort) NativeCrash.ABORT else NativeCrash.SEGV)
    }

    /**
     * What the low-memory killer does to a foreground app: a memory warning (`onTrimMemory`
     * RUNNING_CRITICAL, delivered to the app's registered callbacks), then a SIGKILL without a
     * crash report a second later.
     */
    Function("simulateOutOfMemory") {
      val app = appContext.reactContext?.applicationContext as? android.app.Application
      main.post { app?.onTrimMemory(android.content.ComponentCallbacks2.TRIM_MEMORY_RUNNING_CRITICAL) }
      main.postDelayed({ android.os.Process.killProcess(android.os.Process.myPid()) }, 1000)
    }

    /** The `ouo_action` extra of the intent that started the activity (`am start -e ouo_action <name>`), or "". */
    Function("launchAction") { appContext.currentActivity?.intent?.getStringExtra("ouo_action") ?: "" }
  }

  companion object {
    const val ACTION = "dev.ouo.mobilestore.JOURNEY"
  }
}
