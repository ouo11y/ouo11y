package dev.ouo.replay

import android.app.Activity
import android.app.ActivityManager
import android.app.Application
import android.content.Context
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.view.View
import android.view.ViewTreeObserver
import dev.ouo.replay.core.Box
import dev.ouo.replay.core.CapturePacer
import dev.ouo.replay.core.ChunkBuilder
import dev.ouo.replay.core.ChunkSpool
import dev.ouo.replay.core.FileSeqStore
import dev.ouo.replay.core.FrameReason
import dev.ouo.replay.core.Logger
import dev.ouo.replay.core.RedactionPlanner
import dev.ouo.replay.core.ReplayEndReason
import dev.ouo.replay.core.ReplayTrigger
import dev.ouo.replay.core.TileDiffer
import dev.ouo.replay.core.Touch
import dev.ouo.replay.core.Viewport
import java.io.File
import java.lang.ref.WeakReference
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger
import kotlin.math.abs

/**
 * Owns the capture loop (docs/specs/mobile-replay.md, "Capture rules (Android)"):
 *
 * - The window's `OnDrawListener` sets a dirty flag: in `session` mode a frame is taken at most
 *   once per interval and only when the window drew since the last one, so a static screen costs
 *   neither a copy nor a hash. The [CapturePacer] adds the navigation mode, settle time, retries
 *   and the 100 ms per second time bank of the main-thread work.
 * - On the main thread: the view walk and its masks, the `PixelCopy` request, and when the copy
 *   is done a second walk. **Masking fails closed**: a frame whose masks differ between the two
 *   walks (a masked view moved or scrolled while the GPU copied) is dropped.
 * - On the compose thread: masks painted black, the tile diff, JPEG encoding, chunking, the spool
 *   and the hand-off to the uploader. One capture in flight.
 * - Background (no started activity): capture stops and the chunk is flushed; foreground resumes
 *   with an immediate full frame. Touches are recorded but never trigger a capture.
 *
 * With [OuoReplayConfig.otlp] (ADR-0021 decision 5) the same looks go to the [OtlpPipeline]: the
 * `ouo-frames/3` format adapter, the segments and chunks of the client SDK spec and the OTLP disk
 * queue, instead of the legacy `ChunkBuilder` and `ChunkUploader`, which are then never touched.
 * On that path masking is strict: a secure input is always masked and a mask inside an unmasked
 * subtree wins.
 *
 * Failure isolation (client SDK spec ERR-1): every callback the platform or an executor runs here
 * (draw listener, handler runnables, lifecycle callbacks, the copy's completion, compose-thread
 * blocks) catches `Throwable`, counts it and drops the frame; after [FAULT_LIMIT] of them capture
 * stops for this recorder (ERR-6).
 */
internal class ReplayRecorder(private val app: Application, private val config: OuoReplayConfig, activity: Activity?) {
  private val logger = logger(config.debug)
  private val main = Handler(Looper.getMainLooper())
  private val otlp = config.otlp
  private val rules = if (otlp != null) config.redactionRules.copy(strict = true) else config.redactionRules
  private val planner = RedactionPlanner(rules)
  private val walker = ViewWalker()
  private val capturer = ScreenCapturer(config.maxLongestSide, config.jpegQuality)
  private val faults = AtomicInteger()
  private val maskDrops = AtomicInteger()

  /** The spec wire; null on the legacy path. */
  private val pipeline: OtlpPipeline? = otlp?.let { o ->
    try {
      OtlpPipeline(app, config, o, capturer, logger)
    } catch (e: Throwable) {
      faults.incrementAndGet()
      null
    }
  }

  /** OTLP was asked for but cannot run (no pipeline, no session id): nothing is recorded, never the legacy wire unasked. */
  private var stopped = otlp != null && pipeline == null

  // The legacy path: made on first use, never touched when OTLP was asked for.
  private val differ = TileDiffer()
  private val uploader by lazy { OuoReplay.uploader(app, config) }
  private val spool by lazy { ChunkSpool(File(OuoReplayConfig.directory(app), SPOOL)) }
  val mode = (otlp?.cadence ?: config.mode).resolved(totalMemory(app))
  private val pacer = CapturePacer(mode, config.frameInterval.let { if (it.isFinite()) it else 1.0 })
  private val builder by lazy {
    ChunkBuilder(
      ChunkBuilder.Config(config.flushIntervalMs, platform = "android", masked = rules.masksAnything, mode = mode.wire),
      Viewport(0.0, 0.0, 1.0),
      config.sessionId,
      FileSeqStore(File(OuoReplayConfig.directory(app), SEQ)),
      spool = spool,
    ) { chunk -> uploader.enqueue(chunk) }
  }
  private val touches = TouchRecorder({ app.resources.displayMetrics.density }) { t -> handle(t) }

  // Main thread from here on.
  private var current = WeakReference(activity)
  // Whether the app is in the foreground now: the host may start replay from the background (a
  // headless task), when Expo still reports the last activity.
  private var started = if (activity != null && isVisible()) 1 else 0
  @Volatile var isRecording = false
    private set
  private var pausedByHost = false
  private var inFlight = false
  private var dirty = true
  private var observed: View? = null
  private val drawListener = ViewTreeObserver.OnDrawListener { safely("draw") { onDraw() } }
  private val pass = Runnable { safely("pass") { captureIfDue() } }
  private val keepAlive = object : Runnable {
    override fun run() {
      safely("tick") {
        if (!isRecording) return@safely
        val p = pipeline
        if (p != null) {
          if (!p.isActive) {
            // The store refused a chunk or the stream disabled itself: the end record is out.
            logger.warn("replay stopped: the stream ended")
            stopped = true
            stopCapture()
            return@safely
          }
          p.tick()
        } else {
          onCompose("legacy.flushIfDue") { builder.flushIfDue() }
        }
        main.postDelayed(this, 1000)
      }
    }
  }

  /**
   * Runs a main-thread callback so that nothing it throws reaches the app. A capture that failed
   * half-way is abandoned (the frame is dropped), and past [FAULT_LIMIT] capture stops.
   */
  private inline fun safely(seam: String, block: () -> Unit) {
    try {
      block()
    } catch (e: Throwable) {
      try {
        fault(seam, e)
        pendingCapture = null
        inFlight = false
        dirty = true
        if (faults.get() >= FAULT_LIMIT) disable() else schedule()
      } catch (ignored: Throwable) {
      }
    }
  }

  private fun fault(seam: String, e: Throwable) {
    faults.incrementAndGet()
    // The class only: a message could hold what was on screen (ERR-8).
    logger.warn("$seam failed: ${e.javaClass.simpleName}")
  }

  /** Too many errors: capture stops, and over OTLP the stream ends with reason `error`. */
  private fun disable() {
    if (stopped) return
    stopped = true
    logger.warn("replay disabled after ${faults.get()} errors")
    stopCapture()
    pipeline?.end(ReplayEndReason.ERROR)
  }

  /** Runs [block] on the compose thread; whatever it throws is counted there. */
  private fun onCompose(seam: String, block: () -> Unit) {
    try {
      compose.execute {
        try {
          block()
        } catch (e: Throwable) {
          fault(seam, e)
        }
      }
    } catch (e: Throwable) {
      fault(seam, e)
    }
  }

  private val lifecycle = object : Application.ActivityLifecycleCallbacks {
    override fun onActivityStarted(a: Activity) = safely("lifecycle.started") {
      started++
      if (started == 1 && !pausedByHost) {
        logger.log("foreground: resume with an immediate frame")
        resumeCapture()
      }
    }

    override fun onActivityResumed(a: Activity) = safely("lifecycle.resumed") {
      current = WeakReference(a)
      if (isRecording) {
        pacer.requestFrame(FrameReason.RESUME, now())
        schedule()
      }
    }

    override fun onActivityStopped(a: Activity) = safely("lifecycle.stopped") {
      started = maxOf(0, started - 1)
      if (started == 0) {
        logger.log("background: stop capturing, flush")
        stopCapture()
        closeForGap()
      }
    }

    override fun onActivityCreated(a: Activity, b: Bundle?) {}

    override fun onActivityPaused(a: Activity) {}

    override fun onActivitySaveInstanceState(a: Activity, b: Bundle) {}

    override fun onActivityDestroyed(a: Activity) {}
  }

  fun start() {
    val p = pipeline
    if (otlp != null) {
      if (p == null || !p.start()) {
        stopped = true
        logger.warn("replay not started")
        return
      }
    } else {
      recoverSpool(app, config)
    }
    app.registerActivityLifecycleCallbacks(lifecycle)
    pausedByHost = false
    if (started > 0) resumeCapture()
    logger.log("started endpoint=${config.endpoint} project=${config.projectId} cadence=${mode.wire} interval=${config.frameInterval}s")
  }

  fun pause() {
    pausedByHost = true
    stopCapture()
    closeForGap()
    logger.log("paused")
  }

  fun resume() {
    pausedByHost = false
    if (started > 0) resumeCapture()
    logger.log("resumed")
  }

  /** Stops for good. Over OTLP the stream ends with `ouo.replay.ended` and [reason]; the legacy recorder just stops. */
  fun stop(reason: ReplayEndReason = ReplayEndReason.STOP) {
    stopCapture()
    val p = pipeline
    if (p != null) {
      if (!stopped) p.end(reason)
    } else if (otlp == null) {
      flush(null)
    }
    stopped = true
    runCatching { app.unregisterActivityLifecycleCallbacks(lifecycle) }
  }

  /** Consent withdrawn (PRV-4): capture stops, no end record, and what is queued is deleted. [completion] runs on another thread. */
  fun discard(completion: (() -> Unit)?) {
    stopCapture()
    stopped = true
    runCatching { app.unregisterActivityLifecycleCallbacks(lifecycle) }
    val p = pipeline
    // Never on the main thread: the completion deletes files.
    if (p != null) p.discard(completion) else onCompose("discard") { completion?.invoke() }
  }

  /** The chunk closes; over OTLP what is captured next starts a new segment (RPL-8 to RPL-10). */
  private fun closeForGap() {
    val p = pipeline
    if (p != null) p.closeForGap() else flush(null)
  }

  fun flush(completion: (() -> Unit)?) {
    val done: (() -> Unit)? = completion?.let { c ->
      {
        main.post {
          try {
            c()
          } catch (e: Throwable) {
            fault("flush.completion", e)
          }
        }
      }
    }
    val p = pipeline
    if (p != null) return p.flush(done)
    if (otlp != null) {
      done?.invoke()
      return
    }
    // Behind every capture already handed to the compose thread, so their frames are in the chunk.
    onCompose("legacy.flush") {
      builder.flush()
      uploader.drain { done?.invoke() }
    }
  }

  fun sessionDidRotate(newId: String) {
    logger.log("session rotated -> $newId")
    val p = pipeline
    if (p != null) {
      if (!stopped) p.rotate(newId)
      return
    }
    if (otlp != null) return
    onCompose("legacy.rotate") {
      builder.sessionDidRotate(newId)
      differ.reset()
    }
  }

  /** Buffer mode: sends the ring and records on as a session. */
  fun capture(trigger: ReplayTrigger) {
    if (!stopped) pipeline?.capture(trigger)
  }

  fun setViewId(id: String) {
    pipeline?.setViewId(id)
  }

  /** Counters of the OTLP path under the names of the iOS recorder; empty on the legacy path. */
  fun diagnostics(): Map<String, Int> = pipeline?.diagnostics(maskDrops.get(), faults.get()) ?: emptyMap()

  /**
   * A new screen (or a feedback asking for the screen): its frame in `navigation` mode; in
   * `session` mode the next interval frame, even when nothing drew since the last one (as on iOS,
   * whose interval frames do not wait for a draw). On the legacy path that frame is a full image.
   */
  fun screenDidChange() {
    if (otlp == null) onCompose("differ.reset") { differ.reset() }
    pacer.screenDidChange(now())
    dirty = true
    schedule()
  }

  private fun resumeCapture() {
    if (isRecording || stopped) return
    isRecording = true
    if (otlp == null) onCompose("differ.reset") { differ.reset() }
    pacer.requestFrame(FrameReason.RESUME, now())
    main.removeCallbacks(keepAlive)
    main.postDelayed(keepAlive, 1000)
    schedule()
  }

  private fun stopCapture() {
    isRecording = false
    // A capture waiting for a draw is dropped; `inFlight` clears when it was not requested yet.
    if (pendingCapture != null) {
      pendingCapture = null
      inFlight = false
    }
    main.removeCallbacks(drawTimeout)
    main.removeCallbacks(pass)
    main.removeCallbacks(keepAlive)
    observe(null)
    touches.detach()
  }

  private fun handle(t: Touch) {
    if (!isRecording) return
    val p = pipeline
    if (p != null) p.touch(t) else onCompose("legacy.touch") { builder.add(t) }
  }

  private fun onDraw() {
    // A capture waiting for this draw walks the tree now: dispatchOnDraw runs after layout and
    // before the frame is recorded, so the walk sees what this frame shows. The copy is requested
    // first thing after the draw, so the RenderThread copies this frame.
    pendingCapture?.let { p ->
      pendingCapture = null
      val start = now()
      val before = plan(p.target.root)
      main.postAtFrontOfQueue { safely("copy") { copyAndCompose(p.target, p.reason, before, now() - start + p.spent) } }
      return
    }
    if (dirty) return
    dirty = true
    // Not from inside the draw: the pass walks the tree.
    main.post { safely("schedule") { schedule() } }
  }

  private fun observe(root: View?) {
    if (observed === root) return
    observed?.viewTreeObserver?.takeIf { it.isAlive }?.removeOnDrawListener(drawListener)
    observed = root
    root?.viewTreeObserver?.addOnDrawListener(drawListener)
    dirty = true
  }

  /** Runs a pass when the pacer's next frame can be due (none when nothing is wanted). */
  private fun schedule() {
    main.removeCallbacks(pass)
    if (!isRecording || inFlight) return
    val now = now()
    val at = pacer.wakeAt(now, dirty) ?: return
    main.postDelayed(pass, maxOf(0L, ((at - now) * 1000).toLong()))
  }

  private fun captureIfDue() {
    if (!isRecording || inFlight) return
    val target = WindowSpy.captureTarget(current.get())
    if (target == null) {
      main.postDelayed(pass, 500)
      return
    }
    observe(target.root)
    touches.attach(target.window)
    val start = now()
    val reason = when (val d = pacer.decide(start, dirty)) {
      is CapturePacer.Decision.Capture -> d.reason
      CapturePacer.Decision.Wait -> return schedule()
    }
    dirty = false
    inFlight = true
    // The copy shows the last frame drawn, the walk the views as they are now: they must be the
    // same. With a layout or an invalidation not drawn yet (a setText from a plain Handler message,
    // a spinner's next frame) the masks would be where the new content is and the old content
    // unmasked: the walk and the copy wait for the next draw instead.
    if (!isSettled(target.root)) {
      pendingCapture = PendingCapture(target, reason, now() - start)
      main.postDelayed(drawTimeout, DRAW_TIMEOUT_MS)
      return
    }
    copyAndCompose(target, reason, plan(target.root), now() - start)
  }

  /** The draw a pending capture waits for did not come (the window stopped drawing): drop it. */
  private val drawTimeout = Runnable {
    safely("drawTimeout") {
      val p = pendingCapture ?: return@safely
      pendingCapture = null
      inFlight = false
      pacer.dropped(p.reason, now())
      dirty = true
      schedule()
    }
  }

  private class PendingCapture(val target: WindowSpy.Target, val reason: FrameReason, val spent: Double)

  private var pendingCapture: PendingCapture? = null

  /** Masks of the tree as it is, in window pixels; null when the walk failed (the frame is dropped). */
  private fun plan(root: View): List<Box>? =
    try {
      planner.rects(walker.walk(root), Box(0f, 0f, root.width.toFloat(), root.height.toFloat()))
    } catch (e: Throwable) {
      // PRV-8: the masked state of this frame is not known.
      fault("walk", e)
      null
    }

  /** Main thread, `inFlight` set: copies the window, walks again, and hands the frame to the compose thread. */
  private fun copyAndCompose(target: WindowSpy.Target, reason: FrameReason, before: List<Box>?, spentBefore: Double) {
    main.removeCallbacks(drawTimeout)
    val root = target.root
    val t0 = now()
    if (before == null || !isRecording || !root.isAttachedToWindow || root.width <= 0 || root.height <= 0) {
      pacer.spent(spentBefore, t0)
      pacer.dropped(reason, t0)
      inFlight = false
      return schedule()
    }
    val w = root.width
    val h = root.height
    val bitmap = capturer.bitmapFor(w, h)
    val scale = bitmap.width.toFloat() / w
    val ts = System.currentTimeMillis()
    capturer.copy(target, bitmap, main) { ok ->
      safely("copied") {
        val t1 = now()
        val after = if (ok && root.isAttachedToWindow && root.width == w && root.height == h) plan(root) else null
        pacer.spent(spentBefore + (now() - t1), t1)
        if (after == null || !same(before, after)) {
          logger.log("frame ${reason.wire} dropped: ${if (after == null) "copy failed" else "a masked view moved"}")
          maskDrops.incrementAndGet()
          inFlight = false
          pacer.motion(t1)
          pacer.dropped(reason, t1)
          dirty = true
          return@safely schedule()
        }
        val density = app.resources.displayMetrics.density.let { if (it.isFinite() && it > 0f) it else 1f }
        val points = w / density.toDouble()
        val viewport = Viewport(points, h / density.toDouble(), bitmap.width / points)
        val p = pipeline
        onCompose("compose.frame") {
          // Anything that throws here (the encoder, the disk, the adapter) drops this frame only.
          var failed = true
          try {
            if (p != null) {
              failed = !p.look(PixelLook(bitmap, before, scale, bitmap.width / points, reason), ts)
            } else {
              builder.updateViewport(viewport)
              when (val r = capturer.compose(bitmap, before, scale, differ, builder.needsFullFrame, ts, reason)) {
                is ScreenCapturer.Result.Made -> {
                  builder.add(r.frame)
                  logger.log("frame ${reason.wire} ${if (r.frame.isFull) "full" else "${r.frame.patches?.size} patches"} ${r.frame.imageBytes} bytes, ${before.size} masks")
                  failed = false
                }
                ScreenCapturer.Result.Failed -> {}
                ScreenCapturer.Result.Unchanged -> failed = false
              }
            }
          } finally {
            val dropped = failed
            main.post {
              safely("composed") {
                inFlight = false
                if (dropped) pacer.dropped(reason, now())
                schedule()
              }
            }
          }
        }
      }
    }
  }

  private fun same(a: List<Box>, b: List<Box>): Boolean =
    a.size == b.size && a.indices.all { i ->
      abs(a[i].left - b[i].left) < 0.5f && abs(a[i].top - b[i].top) < 0.5f && abs(a[i].right - b[i].right) < 0.5f && abs(a[i].bottom - b[i].bottom) < 0.5f
    }

  companion object {
    const val SPOOL = "open-chunk.jsonl"
    const val SEQ = "seq.json"

    /** How long a capture waits for the draw of a changed tree before it is dropped. */
    const val DRAW_TIMEOUT_MS = 1000L

    /** Errors caught on the main and compose threads after which capture stops (ERR-6). */
    const val FAULT_LIMIT = 20

    /** Shared by every recorder, so a restarted recorder recovers the spool only after the previous one cut its chunk. */
    val compose = Executors.newSingleThreadExecutor { r -> Thread(r, "ouo-replay-compose").apply { isDaemon = true } }

    /** Compose thread only. */
    private var recovered = false

    fun now(): Double = SystemClock.uptimeMillis() / 1000.0

    /** The window shows its view tree as it is: no layout and no invalidation waits for a draw. */
    fun isSettled(root: View): Boolean = !root.isLayoutRequested && !root.isDirty

    private fun isVisible(): Boolean =
      runCatching {
        val info = ActivityManager.RunningAppProcessInfo()
        ActivityManager.getMyMemoryState(info)
        // Exactly these two: a foreground service (and the pre-26 / pre-28 states between them)
        // ranks above VISIBLE with no activity started.
        info.importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND ||
          info.importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_VISIBLE
      }.getOrDefault(true)

    fun totalMemory(context: Context): Long =
      runCatching {
        val info = ActivityManager.MemoryInfo()
        (context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager).getMemoryInfo(info)
        info.totalMem
      }.getOrDefault(0L)

    fun logger(enabled: Boolean): Logger =
      if (!enabled) Logger.NONE
      else object : Logger {
        override fun log(message: String) {
          Log.d("ouo", "[replay] $message")
        }

        override fun warn(message: String) {
          Log.w("ouo", "[replay] $message")
        }
      }

    /**
     * Sends the chunk the previous process left open (crash, ANR kill, force stop), whether or not
     * this launch records, then whatever earlier processes queued. Once per process, on the compose
     * thread, so before any frame of this process.
     */
    fun recoverSpool(context: Context, config: OuoReplayConfig, crashSessionId: String? = null, crashAt: Long? = null) {
      val app = context.applicationContext
      compose.execute {
        if (recovered) return@execute
        recovered = true
        val uploader = OuoReplay.uploader(app, config)
        val spool = ChunkSpool(File(OuoReplayConfig.directory(app), SPOOL))
        spool.recover(crashSessionId = crashSessionId, crashAt = crashAt)?.let {
          logger(config.debug).log("recovered open chunk ${it.sessionId}#${it.seq}: ${it.frames.size} frames")
          uploader.enqueue(it)
        }
        // After enqueue stored it in the outbox: a kill before this line sends it again.
        spool.clear()
        uploader.drain {}
      }
    }

    /** Runs [body] on the compose thread once the previous run's open chunk was recovered. */
    fun afterRecovery(context: Context, config: OuoReplayConfig, body: () -> Unit) {
      recoverSpool(context, config)
      compose.execute(body)
    }
  }
}
