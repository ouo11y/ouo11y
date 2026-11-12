package dev.ouo.replay

import android.app.Activity
import android.app.Application
import android.content.Context
import android.os.Handler
import android.os.Looper
import dev.ouo.replay.core.ChunkUploader
import dev.ouo.replay.core.MaskRegistry
import dev.ouo.replay.core.OtlpReplayOutbox
import dev.ouo.replay.core.ReplayCounters
import dev.ouo.replay.core.basicAuthorization
import dev.ouo.replay.core.ReplayMode
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Public entry point of Android session replay (docs/specs/mobile-replay.md, "Host API"), the twin of
 * the Swift `OuoReplay`. Every call is safe from any thread; the recorder runs on the main thread.
 * No call throws into the host (client SDK spec ERR-1): what fails inside is counted ([status]).
 */
object OuoReplay {
  private val main = Handler(Looper.getMainLooper())
  private var sharedUploader: ChunkUploader? = null
  private var sharedOutbox: OtlpReplayOutbox? = null
  @Volatile private var recorder: ReplayRecorder? = null

  /** Errors caught at this facade, outside any recorder. */
  private val facadeCounters = ReplayCounters()

  /** View-level masks by view id, kept across recorders (set before or after [start]). */
  internal val masks = MaskRegistry()

  /**
   * The process's one OTLP replay outbox (two on one folder would send the same files). Its target
   * (URL, credential, resource) follows the latest start; what is already queued keeps the resource
   * it was encoded with.
   */
  @Synchronized
  internal fun outbox(context: Context, config: OuoReplayConfig, otlp: OuoReplayOtlp, counters: ReplayCounters): OtlpReplayOutbox {
    val authorization = if (config.projectId.isNotEmpty() && config.projectToken.isNotEmpty()) basicAuthorization(config.projectId, config.projectToken) else null
    val target = OtlpReplayOutbox.Target(otlp.logsUrl, authorization, otlp.resource, otlp.scopeVersion, otlp.schemaUrl)
    return sharedOutbox?.also { it.target = target }
      ?: OtlpReplayOutbox(
        File(OuoReplayConfig.directory(context.applicationContext), "otlp-outbox"),
        target,
        logger = ReplayRecorder.logger(config.debug),
        counters = counters,
      ).also { sharedOutbox = it }
  }

  /**
   * The process's one chunk uploader, made from the first config that asks (two uploaders on one
   * folder would send the same files). Its endpoint, credential and `holdUploads` stay for the process.
   */
  @Synchronized
  internal fun uploader(context: Context, config: OuoReplayConfig): ChunkUploader =
    sharedUploader ?: ChunkUploader(
      config.endpoint,
      config.projectId,
      config.projectToken,
      File(OuoReplayConfig.directory(context.applicationContext), "outbox"),
      ChunkUploader.Config(hold = config.holdUploads),
      logger = ReplayRecorder.logger(config.debug),
    ).also { sharedUploader = it }

  /** Starts capturing; [activity] is the one on screen now, if the host knows it. Replaces a previous start. */
  @JvmStatic
  @JvmOverloads
  fun start(context: Context, config: OuoReplayConfig, activity: Activity? = null) {
    val app = context.applicationContext as? Application ?: return
    onMain {
      recorder?.stop()
      recorder = null
      recorder = ReplayRecorder(app, config, activity).also { it.start() }
    }
  }

  /**
   * Buffer mode (`delivery = BUFFER`): sends the ring and records on as a session. [trigger] is
   * `error`, `crash`, `anr`, `hang` or `manual` (anything else counts as `manual`). No effect in
   * session mode, on the legacy path or once triggered.
   */
  @JvmStatic fun capture(trigger: String) = onMain { recorder?.capture(trigger) }

  /** The screen or page the next chunks belong to (`ouo.view.id`); null or empty clears it. */
  @JvmStatic fun setViewId(id: String?) = onMain { recorder?.setViewId(id?.takeIf { it.isNotEmpty() }?.take(256)) }

  /** Masks the view with this id (a React tag) whatever the rules say. Mask wins over [unmask]. */
  @JvmStatic fun mask(viewId: Int) {
    if (viewId > 0 && !masks.mask(viewId)) facadeCounters.count("replay.mask.ignored")
  }

  /** Shows the subtree of the view with this id. A masked view inside it, and every secure input, stays masked. */
  @JvmStatic fun unmask(viewId: Int) {
    if (viewId > 0 && !masks.unmask(viewId)) facadeCounters.count("replay.mask.ignored")
  }

  /** Options the host passed that could not be used (wrong type, out of range): counted, shown by [status]. */
  @JvmStatic fun reportInvalidOptions(keys: List<String>) {
    if (keys.isNotEmpty()) facadeCounters.count("replay.options.invalid", keys.size.toLong())
  }

  /** Forgets [mask] and [unmask] for this id. */
  @JvmStatic fun clearMask(viewId: Int) = masks.clear(viewId)

  /** Ends the recording because the session ended: `ouo.replay.ended` with `session_end` over OTLP. */
  @JvmStatic fun endSession() = end("session_end")

  /** Stops everything; over OTLP the stream ends with [reason] (`stop`, `session_end`, `consent`, `error`...). */
  @JvmStatic
  fun end(reason: String) = onMain {
    recorder?.stop(reason)
    recorder = null
  }

  /** What replay is doing and what it dropped, for diagnostics: plain values only. */
  @JvmStatic
  fun status(): Map<String, Any> {
    val out = HashMap<String, Any>()
    try {
      val r = recorder
      val p = r?.pipeline
      out["recording"] = r?.isRecording ?: false
      out["otlp"] = p != null
      if (p != null) {
        out["format"] = p.format
        p.replayId?.let { out["replayId"] = it }
        p.streamId?.let { out["streamId"] = it }
        out["lastSequence"] = p.lastSequence
        out["partial"] = p.partial
        out["triggered"] = p.triggered
        out["stopped"] = p.dead
      }
      val counts = HashMap<String, Any>()
      for ((k, v) in facadeCounters.snapshot()) counts[k] = v.toDouble()
      r?.counters?.snapshot()?.forEach { (k, v) -> counts[k] = v.toDouble() }
      out["counts"] = counts
      out["errors"] = ((r?.counters?.errorCount ?: 0) + facadeCounters.errorCount).toDouble()
    } catch (e: Throwable) {
      facadeCounters.error("status", e)
    }
    return out
  }

  /** Stops capturing and flushes; frames are not captured until [resume]. */
  @JvmStatic fun pause() = onMain { recorder?.pause() }

  /** Resumes with an immediate frame. */
  @JvmStatic fun resume() = onMain { recorder?.resume() }

  @JvmStatic val isRecording: Boolean get() = recorder?.isRecording ?: false

  /** The mode the recorder runs in (`auto` resolved for this device), null when not started. */
  @JvmStatic val mode: ReplayMode? get() = recorder?.mode

  /** Cuts the open chunk and drains the upload queue; [completion] runs on the main thread when done. */
  @JvmStatic
  @JvmOverloads
  fun flush(completion: (() -> Unit)? = null) {
    val posted = tryMain {
      val r = recorder
      if (r == null) completion?.invoke() else r.flush(completion)
    }
    // The main thread took nothing: the caller still gets its answer.
    if (!posted) facadeCounters.guard("flush.completion") { completion?.invoke() }
  }

  /** The session rotated: flushes the old session's chunk and restarts seq at 0 for [newId]. */
  @JvmStatic fun sessionDidRotate(newId: String) = onMain { recorder?.sessionDidRotate(newId) }

  /** A new screen is showing: its frame in `navigation` mode. */
  @JvmStatic fun screenDidChange() = onMain { recorder?.screenDidChange() }

  /** Stops everything and releases the window observers. Over OTLP the stream ends with `ouo.replay.ended`, reason `stop`. */
  @JvmStatic
  fun stop() {
    end("stop")
  }

  /**
   * Sends the replay chunk a crash, ANR kill or force stop left open in the previous run, whether or
   * not this run records. [start] does it too; only the first call in a process recovers.
   */
  @JvmStatic
  @JvmOverloads
  fun recoverPendingChunk(context: Context, config: OuoReplayConfig, crashSessionId: String? = null, crashAt: Long? = null) {
    // Over OTLP there is no open-chunk spool: the stream the previous run left open is ended (`partial`).
    val otlp = config.otlp
    if (otlp != null) OtlpPipeline.recover(context, config, otlp, crashSessionId) else ReplayRecorder.recoverSpool(context, config, crashSessionId, crashAt)
  }

  /** Finished sessions whose chunks wait on the device (`holdUploads`), after the previous run's open chunk was recovered. */
  @JvmStatic
  fun heldSessions(context: Context, config: OuoReplayConfig, completion: (List<ChunkUploader.HeldSession>) -> Unit) =
    ReplayRecorder.afterRecovery(context, config) { completion(uploader(context, config).heldSessions()) }

  /** Sends ([keep]) or deletes a held session's chunks. */
  @JvmStatic
  fun releaseHeld(context: Context, config: OuoReplayConfig, sessionId: String, keep: Boolean) = uploader(context, config).release(sessionId, keep)

  private fun onMain(block: () -> Unit) {
    tryMain(block)
  }

  /** Runs [block] on the main thread, now when already there. Nothing it throws leaves it. False when it could not be posted. */
  private fun tryMain(block: () -> Unit): Boolean =
    try {
      if (Looper.myLooper() == Looper.getMainLooper()) {
        facadeCounters.guard("facade") { block() }
        true
      } else {
        main.post { facadeCounters.guard("facade") { block() } }
      }
    } catch (e: Throwable) {
      facadeCounters.error("facade", e)
      false
    }

  /** Test hook: blocks until the main thread ran everything posted before it. */
  internal fun syncMain(timeoutMs: Long = 2000) {
    if (Looper.myLooper() == Looper.getMainLooper()) return
    val done = CountDownLatch(1)
    main.post { done.countDown() }
    done.await(timeoutMs, TimeUnit.MILLISECONDS)
  }
}
