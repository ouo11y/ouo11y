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
import dev.ouo.replay.core.ReplayCounters
import dev.ouo.replay.core.TileDiffer
import dev.ouo.replay.core.Touch
import dev.ouo.replay.core.TreeSnapshot
import dev.ouo.replay.core.Viewport
import java.io.File
import java.lang.ref.WeakReference
import java.util.concurrent.Executors
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
 * With [OuoReplayConfig.otlp] the frames go to the [OtlpPipeline] (format adapter, segments and
 * chunks of the client SDK spec, OTLP outbox) instead of the legacy `ChunkBuilder` and
 * `ChunkUploader`; the structure format walks the tree at the same moments and copies no pixel.
 *
 * Failure isolation (client SDK spec ERR-1): every callback the platform or an executor runs here
 * (draw listener, handler runnables, lifecycle callbacks, the copy's completion, compose-thread
 * blocks) catches `Throwable`, counts it and drops the frame; after
 * [ReplayCounters.selfDisableThreshold] of them capture stops for the process.
 */
internal class ReplayRecorder(private val app: Application, private val config: OuoReplayConfig, activity: Activity?) {
  private val logger = logger(config.debug)
  private val main = Handler(Looper.getMainLooper())
  private val rules = config.redactionRules
  val counters = ReplayCounters(logger = logger)
  private val planner = RedactionPlanner(rules)
  private val walker = ViewWalker(masks = OuoReplay.masks)
  private val capturer = ScreenCapturer(config.maxLongestSide, config.jpegQuality)
  private val differ = TileDiffer()

  /** The spec wire; null on the legacy path. */
  val pipeline: OtlpPipeline? = config.otlp?.let { o -> counters.guard("pipeline.create") { OtlpPipeline(app, config, o, logger, counters) } }
  private val structure = pipeline?.isStructure == true
  private val wireWalker = if (structure) ViewWalker(masks = OuoReplay.masks, wireRules = rules) else null

  // The legacy path: made on first use, never touched when the pipeline is there.
  private val uploader by lazy { OuoReplay.uploader(app, config) }
  private val spool by lazy { ChunkSpool(File(OuoReplayConfig.directory(app), SPOOL)) }
  val mode = config.mode.resolved(totalMemory(app))
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
  private val touches = TouchRecorder({ app.resources.displayMetrics.density }) { t, x, y -> handle(t, x, y) }

  /** `otlp` was asked for but the pipeline could not be made: nothing is recorded (never the legacy wire unasked). */
  private val broken = config.otlp != null && pipeline == null

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
          if (p.dead) {
            logger.warn("replay stopped: the stream ended or too many errors")
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
   * half-way is abandoned (the frame is dropped), and past the error threshold capture stops.
   */
  private inline fun safely(seam: String, block: () -> Unit) {
    try {
      block()
    } catch (e: Throwable) {
      counters.error(seam, e)
      try {
        pendingCapture = null
        inFlight = false
        dirty = true
        if (counters.disabled) stopCapture() else schedule()
      } catch (ignored: Throwable) {
      }
    }
  }

  /** Runs [block] on the compose thread; whatever it throws is counted there. */
  private fun onCompose(seam: String, block: () -> Unit) {
    try {
      compose.execute { counters.guard(seam, block) }
    } catch (e: Throwable) {
      counters.error(seam, e)
    }
  }

  private val lifecycle = object : Application.ActivityLifecycleCallbacks {
    override fun onActivityStarted(a: Activity) = safely("lifecycle.started") {
      started++
      if (started == 1 && !pausedByHost) {
        logger.log("foreground: resume with an immediate frame")
        // A new segment and keyframe on return to the foreground (RPL-9).
        pipeline?.foreground()
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
        val p = pipeline
        if (p != null) p.background() else flush(null)
      }
    }

    override fun onActivityCreated(a: Activity, b: Bundle?) {}

    override fun onActivityPaused(a: Activity) {}

    override fun onActivitySaveInstanceState(a: Activity, b: Bundle) {}

    override fun onActivityDestroyed(a: Activity) {}
  }

  fun start() {
    if (broken) {
      logger.warn("replay not started: the OTLP pipeline could not be created")
      return
    }
    val p = pipeline
    if (p != null) p.open() else recoverSpool(app, config)
    app.registerActivityLifecycleCallbacks(lifecycle)
    pausedByHost = false
    if (started > 0) resumeCapture()
    logger.log("started endpoint=${config.endpoint} project=${config.projectId} mode=${mode.wire} interval=${config.frameInterval}s")
  }

  fun pause() {
    pausedByHost = true
    stopCapture()
    flush(null)
    logger.log("paused")
  }

  fun resume() {
    pausedByHost = false
    if (started > 0) resumeCapture()
    logger.log("resumed")
  }

  /** Stops for good. Over OTLP the stream ends with `ouo.replay.ended` and [reason] (`stop`, `session_end`, `consent`...). */
  fun stop(reason: String = "stop") {
    stopCapture()
    val p = pipeline
    if (p != null) p.end(reason) else if (!broken) flush(null)
    app.unregisterActivityLifecycleCallbacks(lifecycle)
  }

  fun flush(completion: (() -> Unit)?) {
    val done: (() -> Unit)? = completion?.let { c -> { main.post { counters.guard("flush.completion") { c() } } } }
    val p = pipeline
    if (p != null) return p.flush(done)
    if (broken) {
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
      onCompose("differ.reset") { differ.reset() }
      p.rotate()
      return
    }
    if (broken) return
    onCompose("legacy.rotate") {
      builder.sessionDidRotate(newId)
      differ.reset()
    }
  }

  /** Buffer mode: sends the ring and records on as a session (`error`, `crash`, `anr`, `hang`, `manual`). */
  fun capture(trigger: String) {
    pipeline?.trigger(trigger)
  }

  fun setViewId(id: String?) {
    pipeline?.setViewId(id)
  }

  /**
   * A new screen (or a feedback asking for the screen): its frame in `navigation` mode; in
   * `session` mode the next interval frame, even when nothing drew since the last one (as on iOS,
   * whose interval frames do not wait for a draw). Either way that frame is a full image.
   */
  fun screenDidChange() {
    onCompose("differ.reset") { differ.reset() }
    pacer.screenDidChange(now())
    dirty = true
    schedule()
  }

  private fun resumeCapture() {
    if (isRecording || broken || pipeline?.dead == true || counters.disabled) return
    isRecording = true
    onCompose("differ.reset") { differ.reset() }
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

  private fun handle(t: Touch, xPx: Float, yPx: Float) {
    if (!isRecording) return
    val p = pipeline
    if (p != null) p.touch(t.ts, xPx.toDouble(), yPx.toDouble(), t.phase) else onCompose("legacy.touch") { builder.add(t) }
  }

  private fun onDraw() {
    // A capture waiting for this draw walks the tree now: dispatchOnDraw runs after layout and
    // before the frame is recorded, so the walk sees what this frame shows. The copy is requested
    // first thing after the draw, so the RenderThread copies this frame.
    pendingCapture?.let { p ->
      pendingCapture = null
      if (structure) {
        snapshotAndCompose(p.target, p.reason, p.spent)
        return
      }
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
    if (structure) snapshotAndCompose(target, reason, now() - start) else copyAndCompose(target, reason, plan(target.root), now() - start)
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

  /**
   * Structure format, main thread, `inFlight` set: walks the settled tree and hands the snapshot to
   * the compose thread. No pixel is copied. A walk that fails drops the frame (PRV-8).
   */
  private fun snapshotAndCompose(target: WindowSpy.Target, reason: FrameReason, spentBefore: Double) {
    main.removeCallbacks(drawTimeout)
    val root = target.root
    val t0 = now()
    val w = wireWalker
    val p = pipeline
    val snapshot =
      if (w == null || p == null || !isRecording || !root.isAttachedToWindow || root.width <= 0 || root.height <= 0) null
      else counters.guard("walk") {
        val at = IntArray(2)
        root.getLocationOnScreen(at)
        TreeSnapshot(System.currentTimeMillis(), w.walk(root), root.width, root.height, app.resources.displayMetrics.density.toDouble(), at[0].toFloat(), at[1].toFloat())
      }
    val t1 = now()
    pacer.spent(spentBefore + (t1 - t0), t1)
    if (snapshot == null || p == null) {
      pacer.dropped(reason, t1)
      inFlight = false
      return schedule()
    }
    onCompose("compose.tree") {
      try {
        p.tree(snapshot)
      } finally {
        main.post {
          safely("composed") {
            inFlight = false
            schedule()
          }
        }
      }
    }
  }

  private class PendingCapture(val target: WindowSpy.Target, val reason: FrameReason, val spent: Double)

  private var pendingCapture: PendingCapture? = null

  /** Masks of the tree as it is, in window pixels; null when the walk failed (the frame is dropped). */
  private fun plan(root: View): List<Box>? =
    runCatching { planner.rects(walker.walk(root), Box(0f, 0f, root.width.toFloat(), root.height.toFloat())) }.getOrNull()

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
    capturer.copy(target, bitmap, main) { ok -> safely("copied") {
      val t1 = now()
      val after = if (ok && root.isAttachedToWindow && root.width == w && root.height == h) plan(root) else null
      pacer.spent(spentBefore + (now() - t1), t1)
      if (after == null || !same(before, after)) {
        logger.log("frame ${reason.wire} dropped: ${if (after == null) "copy failed" else "a masked view moved"}")
        inFlight = false
        pacer.motion(t1)
        pacer.dropped(reason, t1)
        dirty = true
        return@safely schedule()
      }
      val density = app.resources.displayMetrics.density
      val viewport = Viewport(w / density.toDouble(), h / density.toDouble(), bitmap.width / (w / density.toDouble()))
      val p = pipeline
      onCompose("compose.frame") {
        // Anything that throws here (the encoder, the disk, the adapter) drops this frame only.
        var failed = true
        try {
          if (p == null) builder.updateViewport(viewport)
          when (val r = capturer.compose(bitmap, before, scale, differ, p?.needsKeyframe ?: builder.needsFullFrame, ts, reason)) {
            is ScreenCapturer.Result.Made -> {
              if (p != null) p.pixel(r.frame, w, h, bitmap.width, bitmap.height, density.toDouble()) else builder.add(r.frame)
              logger.log("frame ${reason.wire} ${if (r.frame.isFull) "full" else "${r.frame.patches?.size} patches"} ${r.frame.imageBytes} bytes, ${before.size} masks")
              failed = false
            }
            ScreenCapturer.Result.Failed -> {}
            ScreenCapturer.Result.Unchanged -> failed = false
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
    } }
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
