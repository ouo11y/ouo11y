package dev.ouo.signals

import android.app.Activity
import android.app.ActivityManager
import android.app.Application
import android.app.ApplicationStartInfo
import android.content.ComponentCallbacks2
import android.content.Context
import android.content.res.Configuration
import android.os.Build
import android.os.Bundle
import android.os.Debug
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.os.Process
import android.os.SystemClock
import android.util.Log
import android.view.FrameMetrics
import android.view.Window
import dev.ouo.signals.core.AppStart
import dev.ouo.signals.core.Exit
import dev.ouo.signals.core.FrameCounter
import dev.ouo.signals.core.HangDetector
import dev.ouo.signals.core.JvmFrame
import dev.ouo.signals.core.Report
import dev.ouo.signals.core.RunState
import dev.ouo.signals.core.Termination
import java.io.File
import java.util.Collections
import java.util.IdentityHashMap
import java.util.concurrent.Executors

/**
 * The native signals of the mobile SDK spec on Android, the twin of the Swift `OuoCrash` and
 * `OuoVitals` (docs/specs/mobile-sdk.md C2, C3, C4): uncaught Java and Kotlin exceptions written as
 * a report at crash time (C2), main-thread hangs reported when they end (C3.1), foreground
 * terminations judged at the next launch from `ApplicationExitInfo` (C3.2), slow and frozen frames
 * from `FrameMetrics` per window, and the app start (C4). Reports use the format the React Native
 * SDK reads (`sdk/react-native/src/crash.ts`); the native Android package will register the same
 * classes with opentelemetry-android (ADR-0017).
 *
 * Files live in `noBackupFilesDir/ouo/signals`: `crash.json` (written at crash time, taken by the
 * next launch) and `run.json` (this run's process, session, last memory warning, hang in progress).
 */
object Signals {
  private const val TAG = "ouo"
  private val main = Handler(Looper.getMainLooper())
  private val io = Executors.newSingleThreadExecutor { r -> Thread(r, "ouo-signals").apply { isDaemon = true } }

  private lateinit var app: Application
  private lateinit var dir: File
  private var initialized = false

  /** The previous run's report (a crash, else a termination), read once at [init]; [takePendingReport] hands it out. */
  private var pending: String? = null

  @Volatile private var run: RunState = RunState(Process.myPid())
  @Volatile private var installed = false
  private var onHang: ((String) -> Unit)? = null

  private val frames = FrameCounter()
  /** Started activities whose `onStart` was seen (main thread only). */
  private val started = Collections.newSetFromMap(IdentityHashMap<Activity, Boolean>())
  /**
   * Seeded at [init] from the process importance, since an activity may have started before the
   * lifecycle callbacks were registered; from then on each `onStart` / `onStop` sets it from
   * [started] (an `onStop` of an activity started before [init] makes it false unless another one
   * started since). Written on the main thread, which then wakes the watchdog ([wake]).
   */
  @Volatile private var foreground = false
  /** The watchdog parks on it while the app is in the background. */
  private val wake = Object()
  /** When the main thread last saw the app leave the foreground (uptime ms). */
  @Volatile private var leftForegroundAt = 0L
  private var runtimes = 0
  @Volatile private var hangFrames = emptyList<JvmFrame>()

  /**
   * Reads what the previous run left (before this run writes anything) and starts the frame
   * counters and the foreground tracking. Idempotent; call it as early as the host can (the
   * React Native module calls it when the JS runtime creates the module).
   */
  @Synchronized
  fun init(context: Context) {
    if (initialized) return
    initialized = true
    app = context.applicationContext as Application
    dir = File(app.noBackupFilesDir, "ouo/signals").apply { mkdirs() }
    mappingId = Report.mappingId(runCatching { app.assets.open(Report.DEBUG_META_ASSET).use { it.reader().readText() } }.getOrNull())
    val crashFile = File(dir, CRASH)
    val crash = runCatching { crashFile.takeIf { it.exists() }?.readText() }.getOrNull()
    crashFile.delete()
    val previous = RunState.parse(runCatching { File(dir, RUN).readText() }.getOrNull())
    // A termination is never judged across an update (C3), so this build's mapping id is the dead run's.
    pending = crash ?: Termination.decide(previous, lastExit(previous?.pid), crashReported = false)?.copy(mappingId = mappingId)?.toJson()
    updateRun { RunState(Process.myPid()) }
    foreground = isVisible(app)
    app.registerActivityLifecycleCallbacks(lifecycle)
    app.registerComponentCallbacks(memory)
  }

  /** This build's R8 mapping id (ADR-0027), set by [init]; null when the APK has no `ouo-debug-meta.properties`. */
  @Volatile private var mappingId: String? = null

  /** This build's R8 mapping id, null before [init] or when the app is not minified with `gradle/ouo-mapping.gradle`. */
  fun mappingId(): String? = mappingId

  /** The previous run's crash or termination report (JSON), once; null when it ended normally. */
  @Synchronized
  fun takePendingReport(): String? = pending.also { pending = null }

  /**
   * Installs the uncaught exception handler (chained to the one before it: React Native's, the
   * system's, another SDK's) and the hang watchdog, whose reports arrive on [onHang] when a hang is
   * over. Returns false when [init] did not run.
   */
  @Synchronized
  fun install(sessionId: String, sessionStartedMs: Long, onHang: (String) -> Unit): Boolean {
    if (!initialized) return false
    setSession(sessionId, sessionStartedMs)
    this.onHang = onHang
    if (installed) return true
    installed = true
    val previous = Thread.getDefaultUncaughtExceptionHandler()
    Thread.setDefaultUncaughtExceptionHandler { thread, error ->
      runCatching { writeCrash(thread, error) }
      if (previous != null) previous.uncaughtException(thread, error) else {
        Process.killProcess(Process.myPid())
        System.exit(10)
      }
    }
    watchdog.start()
    return true
  }

  /** The session a crash, hang or termination belongs to, and its start (epoch ms). */
  fun setSession(sessionId: String, sessionStartedMs: Long) {
    if (!initialized || sessionId.isEmpty()) return
    updateRun { it.copy(sessionId = sessionId, sessionStartedMs = sessionStartedMs) }
  }

  /** Cumulative frame counters since [init], null before the first rendered frame. */
  fun frameStats(): Map<String, Double>? = frames.snapshot()

  /**
   * Start of this JS runtime's launch for `ouo.app.start`: `{ processStartMs, type, prewarmed }`.
   * Cold from the process start for the first runtime of a process started to show the app; warm
   * from [runtimeCreatedMs] for a reload, or for a process the system started earlier for a
   * receiver, a service or a provider.
   */
  @Synchronized
  fun appStart(runtimeCreatedMs: Long): Map<String, Any> {
    runtimes++
    val processStart = System.currentTimeMillis() - (SystemClock.uptimeMillis() - Process.getStartUptimeMillis())
    val (type, at) = AppStart.of(processStart, runtimeCreatedMs, runtimes == 1, startedForActivity())
    return mapOf("processStartMs" to at.toDouble(), "type" to type, "prewarmed" to false)
  }

  // ---- crash ----

  private fun writeCrash(thread: Thread, error: Throwable) {
    val (name, reason) = Report.describe(error)
    val r = run
    val report = Report(
      mechanism = "jvm",
      timestampMs = System.currentTimeMillis(),
      sessionId = r.sessionId,
      sessionStartedMs = r.sessionStartedMs.takeIf { it > 0 },
      exceptionName = name,
      exceptionReason = reason,
      mainThread = thread === Looper.getMainLooper().thread,
      frames = Report.frames(error.stackTrace),
      mappingId = mappingId,
    )
    // Synchronous and atomic: the process dies when the handlers return.
    val tmp = File(dir, "$CRASH.tmp")
    tmp.writeText(report.toJson())
    tmp.renameTo(File(dir, CRASH))
  }

  // ---- run state and terminations ----

  private val runLock = Any()

  /**
   * Changes the run state and queues its write. The JS thread (session), the watchdog (hang) and the
   * main thread (memory warning) all change it: under one lock, so no change is lost and the single
   * io thread writes the states in the order they were made.
   */
  private fun updateRun(change: (RunState) -> RunState): RunState =
    synchronized(runLock) {
      val state = change(run)
      run = state
      val text = state.toJson()
      io.execute {
        runCatching {
          val tmp = File(dir, "$RUN.tmp")
          tmp.writeText(text)
          tmp.renameTo(File(dir, RUN))
        }
      }
      state
    }

  private fun lastExit(pid: Int?): Exit? {
    if (pid == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return null
    return runCatching {
      val am = app.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
      am.getHistoricalProcessExitReasons(app.packageName, pid, 1).firstOrNull()?.let {
        Exit(it.pid, it.reason, it.importance, it.status, it.timestamp)
      }
    }.getOrNull()
  }

  private val memory = object : ComponentCallbacks2 {
    override fun onTrimMemory(level: Int) {
      // The running levels are the memory warnings of a foreground app; the others are about a
      // process in the background, which a termination never is.
      @Suppress("DEPRECATION")
      if (level == ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW || level == ComponentCallbacks2.TRIM_MEMORY_RUNNING_CRITICAL) memoryWarning()
    }

    override fun onLowMemory() = memoryWarning()

    override fun onConfigurationChanged(newConfig: Configuration) {}
  }

  private fun memoryWarning() {
    if (initialized) updateRun { it.copy(memoryWarningMs = System.currentTimeMillis()) }
  }

  // ---- hangs ----

  @Volatile private var lastAnswer = SystemClock.uptimeMillis()
  @Volatile private var pinged = false
  private val pong = Runnable {
    lastAnswer = SystemClock.uptimeMillis()
    pinged = false
  }

  private val watchdog = object : Thread("ouo-hang-watchdog") {
    init {
      isDaemon = true
    }

    private val detector = HangDetector()
    private var startedAtEpoch = 0L
    private var framesAtStart = 0.0

    override fun run() {
      // Measuring starts now: the main thread has not been asked anything before (a baseline from
      // init, seconds earlier on a slow cold start, would read as a hang until its first answer).
      lastAnswer = SystemClock.uptimeMillis()
      while (true) {
        try {
          // Not measured in the background: parked until an activity starts (no wake-ups there).
          if (!foreground) {
            stop(leftForegroundAt, report = true)
            synchronized(wake) { while (!foreground) wake.wait() }
            lastAnswer = SystemClock.uptimeMillis()
          }
          sleep(TICK_MS)
        } catch (e: InterruptedException) {
          return
        }
        // Nor while a debugger can stop the main thread: a hang in progress is dropped.
        if (Debug.isDebuggerConnected()) {
          stop(SystemClock.uptimeMillis(), report = false)
          lastAnswer = SystemClock.uptimeMillis()
          continue
        }
        if (!pinged) {
          pinged = true
          main.post(pong)
        }
        val now = SystemClock.uptimeMillis()
        when (val e = detector.tick(now, lastAnswer)) {
          is HangDetector.Event.Started -> {
            startedAtEpoch = System.currentTimeMillis() - (now - e.startedAt)
            framesAtStart = frames.snapshot()?.get("total") ?: 0.0
            // The stack while the main thread is still blocked; a termination during the hang carries it.
            val stack = Report.frames(Looper.getMainLooper().thread.stackTrace)
            hangFrames = stack
            updateRun { it.copy(hangStartedMs = startedAtEpoch, hangFrames = stack) }
          }
          is HangDetector.Event.Ended -> ended(e)
          null -> {}
        }
      }
    }

    /** Measuring stops at [now] (uptime): a hang in progress ends there, reported when [report]. */
    private fun stop(now: Long, report: Boolean) {
      val e = detector.interrupt(now, lastAnswer) ?: return
      if (report) ended(e) else updateRun { it.copy(hangStartedMs = null, hangFrames = emptyList()) }
    }

    private fun ended(e: HangDetector.Event.Ended) {
      val drew = (frames.snapshot()?.get("total") ?: 0.0) > framesAtStart
      val r = updateRun { it.copy(hangStartedMs = null, hangFrames = emptyList()) }
      val report = Report(
        mechanism = "hang",
        timestampMs = startedAtEpoch,
        sessionId = r.sessionId,
        sessionStartedMs = r.sessionStartedMs.takeIf { it > 0 },
        mainThread = true,
        frames = hangFrames,
        hangDurationMs = e.durationMs,
        hangFullyBlocking = !drew,
        mappingId = mappingId,
      )
      val cb = onHang
      if (cb != null) main.post { cb(report.toJson()) }
    }
  }

  // ---- foreground and frames ----

  private val frameThread by lazy { HandlerThread("ouo-frames").apply { start() } }
  private val frameHandler by lazy { Handler(frameThread.looper) }
  private val frameListeners = HashMap<Window, Window.OnFrameMetricsAvailableListener>()

  private val lifecycle = object : Application.ActivityLifecycleCallbacks {
    override fun onActivityStarted(a: Activity) {
      started.add(a)
      setForeground(true)
    }

    override fun onActivityStopped(a: Activity) {
      started.remove(a)
      setForeground(started.isNotEmpty())
    }

    override fun onActivityResumed(a: Activity) = attachFrames(a)

    override fun onActivityPaused(a: Activity) = detachFrames(a)

    override fun onActivityCreated(a: Activity, b: Bundle?) {}

    override fun onActivitySaveInstanceState(a: Activity, b: Bundle) {}

    override fun onActivityDestroyed(a: Activity) {}
  }

  private fun setForeground(value: Boolean) {
    if (value == foreground) return
    if (!value) leftForegroundAt = SystemClock.uptimeMillis()
    synchronized(wake) {
      foreground = value
      wake.notifyAll()
    }
  }

  /** The host's current activity, for a module created after the first `onResume`. */
  fun attachCurrent(activity: Activity?) {
    if (activity == null) return
    main.post { attachFrames(activity) }
  }

  private fun attachFrames(a: Activity) {
    val w = a.window ?: return
    if (frameListeners.containsKey(w)) return
    val l = Window.OnFrameMetricsAvailableListener { window, metrics, _ ->
      val total = metrics.getMetric(FrameMetrics.TOTAL_DURATION) / 1e6
      val deadline =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) metrics.getMetric(FrameMetrics.DEADLINE) / 1e6
        else 1000.0 / (window.windowManager.defaultDisplay.refreshRate.takeIf { it > 1f } ?: 60f)
      // The first frame of a window includes its inflation and layout: it is the TTID's, not jank.
      if (metrics.getMetric(FrameMetrics.FIRST_DRAW_FRAME) == 1L) return@OnFrameMetricsAvailableListener
      frames.frame(total, deadline)
    }
    runCatching {
      w.addOnFrameMetricsAvailableListener(l, frameHandler)
      frameListeners[w] = l
    }.onFailure { Log.w(TAG, "[signals] FrameMetrics unavailable: $it") }
  }

  private fun detachFrames(a: Activity) {
    val w = a.window ?: return
    frameListeners.remove(w)?.let { l -> runCatching { w.removeOnFrameMetricsAvailableListener(l) } }
  }

  // ---- helpers ----

  private fun isVisible(context: Context): Boolean =
    runCatching {
      val info = ActivityManager.RunningAppProcessInfo()
      ActivityManager.getMyMemoryState(info)
      info.importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND ||
        info.importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_VISIBLE
    }.getOrDefault(true)

  /** Android 15: whether this process was started to show an activity (null before 15 or when unknown). */
  private fun startedForActivity(): Boolean? {
    if (Build.VERSION.SDK_INT < 35) return null
    return runCatching {
      val am = app.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
      val info = am.getHistoricalProcessStartReasons(1).firstOrNull()?.takeIf { it.pid == Process.myPid() } ?: return null
      info.reason == ApplicationStartInfo.START_REASON_LAUNCHER ||
        info.reason == ApplicationStartInfo.START_REASON_LAUNCHER_RECENTS ||
        info.reason == ApplicationStartInfo.START_REASON_START_ACTIVITY
    }.getOrNull()
  }

  private const val CRASH = "crash.json"
  private const val RUN = "run.json"
  private const val TICK_MS = 200L
}
