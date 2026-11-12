package dev.ouo.replay

import android.app.Activity
import android.app.Application
import android.content.Context
import android.os.Handler
import android.os.Looper
import dev.ouo.replay.core.ChunkUploader
import dev.ouo.replay.core.FileReplayStateStore
import dev.ouo.replay.core.ReplayDelivery
import dev.ouo.replay.core.ReplayEndReason
import dev.ouo.replay.core.ReplayMaskRegistry
import dev.ouo.replay.core.ReplayMode
import dev.ouo.replay.core.ReplayOTLPOptions
import dev.ouo.replay.core.ReplayTrigger
import dev.ouo.replay.core.basicAuthorization
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * Public entry point of Android session replay (docs/specs/mobile-replay.md, "Host API"), the twin of
 * the Swift `OuoReplay`. Every call is safe from any thread; the recorder runs on the main thread.
 * No call throws into the host (client SDK spec ERR-1): what fails inside is counted ([diagnostics]).
 */
object OuoReplay {
  private val main = Handler(Looper.getMainLooper())
  private var sharedUploader: ChunkUploader? = null
  private var sharedDelivery: ReplayDelivery? = null
  @Volatile private var recorder: ReplayRecorder? = null
  private val counters = ConcurrentHashMap<String, AtomicInteger>()

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

  /**
   * The process's one OTLP replay queue (two on one folder would send the same files), in
   * `outbox-otlp` beside the legacy outbox. It sends with the `Authorization` the chunk uploader
   * sends; a later start of the same process retargets it to its own URL and credential.
   */
  @Synchronized
  internal fun delivery(context: Context, config: OuoReplayConfig, options: ReplayOTLPOptions): ReplayDelivery {
    val authorization = if (config.projectId.isNotEmpty() && config.projectToken.isNotEmpty()) basicAuthorization(config.projectId, config.projectToken) else ""
    return sharedDelivery?.also { it.retarget(options.logsUrl, authorization) }
      ?: ReplayDelivery(
        options.logsUrl,
        authorization,
        File(OuoReplayConfig.directory(context.applicationContext), ReplayDelivery.DIRECTORY_NAME),
        logger = ReplayRecorder.logger(config.debug),
      ).also { sharedDelivery = it }
  }

  /** Counts something the SDK dropped or could not do (ERR-7), reported by [diagnostics]. */
  internal fun count(key: String, n: Int = 1) {
    counters.getOrPut(key) { AtomicInteger() }.addAndGet(n)
  }

  /**
   * Problems found in the start options (a wrong type, a value out of range, a mode this build
   * does not record): counted, and logged when [debug] is on. Never thrown.
   */
  @JvmStatic
  @JvmOverloads
  fun noteOptionProblems(problems: List<String>, debug: Boolean = false) {
    if (problems.isEmpty()) return
    count("replay.option_problems", problems.size)
    val logger = ReplayRecorder.logger(debug)
    problems.forEach { logger.warn("option: $it") }
  }

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
   * Buffer mode (`buffer: { seconds }`): sends the ring and records on as a session. [trigger] is
   * `error`, `crash`, `anr`, `hang` or `manual`; anything else counts as `manual`. Does nothing
   * when no buffer is waiting.
   */
  @JvmStatic
  fun capture(trigger: String) {
    val known = ReplayTrigger.of(trigger)
    if (known == null) count("replay.unknown_trigger")
    onMain { recorder?.capture(known ?: ReplayTrigger.MANUAL) }
  }

  /** The screen the next chunks belong to (`ouo.view.id`). */
  @JvmStatic fun setViewId(id: String) = onMain { recorder?.setViewId(id) }

  /**
   * Masks the React Native view with this tag (any view with this id) in every recorder
   * ([ReplayMaskRegistry]). The native equivalent is the view tag `ouo-mask`.
   */
  @JvmStatic fun mask(reactTag: Int) = ReplayMaskRegistry.shared.mask(reactTag)

  /**
   * Shows the React Native view with this tag (and what is inside it) although its class is
   * masked. A mask inside it still masks, and a secure field is always masked.
   */
  @JvmStatic fun unmask(reactTag: Int) = ReplayMaskRegistry.shared.unmask(reactTag)

  /** Stops and ends the stream with `ouo.replay.ended` and this reason (the OTLP recorder; the legacy recorder just stops). */
  @JvmStatic
  fun stop(reason: ReplayEndReason) = onMain {
    recorder?.stop(reason)
    recorder = null
  }

  /**
   * Deletes replay records not yet accepted by the collector and stops the OTLP recorder without
   * an end record (consent withdrawn, PRV-4). [completion] runs, on another thread, when the files
   * are gone.
   */
  @JvmStatic
  @JvmOverloads
  fun discardPending(context: Context, completion: (() -> Unit)? = null) {
    val app = context.applicationContext
    val finish = {
      try {
        val existing = synchronized(this) { sharedDelivery }
        val dir = OuoReplayConfig.directory(app)
        if (existing != null) existing.discardPending() else ReplayDelivery.discardPending(File(dir, ReplayDelivery.DIRECTORY_NAME))
        FileReplayStateStore(File(dir, FileReplayStateStore.FILE_NAME)).clear()
      } catch (e: Throwable) {
        count("replay.errors")
      }
      try {
        completion?.invoke()
      } catch (e: Throwable) {
        count("replay.errors")
      }
    }
    val posted = tryMain {
      val r = recorder
      recorder = null
      // Behind whatever the recorder still has on the compose thread, never on the main thread.
      if (r != null) r.discard { finish() } else ReplayRecorder.compose.execute { finish() }
    }
    if (!posted) finish()
  }

  /** Counters of what replay dropped or could not do in this process (ERR-7), by reason. */
  @JvmStatic
  fun diagnostics(): Map<String, Int> {
    val out = HashMap<String, Int>()
    try {
      for ((k, v) in counters) out[k] = v.get()
      out["replay.mask_registry_refused"] = ReplayMaskRegistry.shared.refused
      recorder?.diagnostics()?.forEach { (k, v) -> out[k] = (out[k] ?: 0) + v }
    } catch (e: Throwable) {
      count("replay.errors")
    }
    return out
  }

  /** Stops capturing and flushes; frames are not captured until [resume]. */
  @JvmStatic fun pause() = onMain { recorder?.pause() }

  /** Resumes with an immediate frame. */
  @JvmStatic fun resume() = onMain { recorder?.resume() }

  @JvmStatic val isRecording: Boolean get() = recorder?.isRecording ?: false

  /** The cadence the recorder runs at (`auto` resolved for this device), null when not started. */
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
    if (!posted) {
      try {
        completion?.invoke()
      } catch (e: Throwable) {
        count("replay.errors")
      }
    }
  }

  /**
   * The session rotated. Legacy: flushes the old session's chunk and restarts seq at 0 for [newId].
   * OTLP: the stream ends with `session_end` and a new replay starts for [newId].
   */
  @JvmStatic fun sessionDidRotate(newId: String) = onMain { recorder?.sessionDidRotate(newId) }

  /** A new screen is showing: its frame in `navigation` mode. */
  @JvmStatic fun screenDidChange() = onMain { recorder?.screenDidChange() }

  /** Stops everything and releases the window observers. Over OTLP the stream ends with `ouo.replay.ended`, reason `stop`. */
  @JvmStatic
  fun stop() {
    stop(ReplayEndReason.STOP)
  }

  /**
   * Sends the replay chunk a crash, ANR kill or force stop left open in the previous run, whether or
   * not this run records. [start] does it too; only the first call in a process recovers. (The
   * legacy path; over OTLP the stream the previous run left open is ended by the next [start].)
   */
  @JvmStatic
  @JvmOverloads
  fun recoverPendingChunk(context: Context, config: OuoReplayConfig, crashSessionId: String? = null, crashAt: Long? = null) =
    ReplayRecorder.recoverSpool(context, config, crashSessionId, crashAt)

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
  private fun tryMain(block: () -> Unit): Boolean {
    val guarded = Runnable {
      try {
        block()
      } catch (e: Throwable) {
        count("replay.errors")
      }
    }
    return try {
      if (Looper.myLooper() == Looper.getMainLooper()) {
        guarded.run()
        true
      } else {
        main.post(guarded)
      }
    } catch (e: Throwable) {
      count("replay.errors")
      false
    }
  }

  /** Test hook: blocks until the main thread ran everything posted before it. */
  internal fun syncMain(timeoutMs: Long = 2000) {
    if (Looper.myLooper() == Looper.getMainLooper()) return
    val done = CountDownLatch(1)
    main.post { done.countDown() }
    done.await(timeoutMs, TimeUnit.MILLISECONDS)
  }
}
