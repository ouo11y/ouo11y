package dev.ouo.replay

import android.app.Activity
import android.app.Application
import android.content.Context
import android.os.Handler
import android.os.Looper
import dev.ouo.replay.core.ChunkUploader
import dev.ouo.replay.core.ReplayMode
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Public entry point of Android session replay (docs/specs/mobile-replay.md, "Host API"), the twin of
 * the Swift `OuoReplay`. Every call is safe from any thread; the recorder runs on the main thread.
 */
object OuoReplay {
  private val main = Handler(Looper.getMainLooper())
  private var sharedUploader: ChunkUploader? = null
  private var recorder: ReplayRecorder? = null

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
    val app = context.applicationContext as Application
    onMain {
      recorder?.stop()
      recorder = ReplayRecorder(app, config, activity).also { it.start() }
    }
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
  fun flush(completion: (() -> Unit)? = null) = onMain {
    val r = recorder
    if (r == null) completion?.invoke() else r.flush(completion)
  }

  /** The session rotated: flushes the old session's chunk and restarts seq at 0 for [newId]. */
  @JvmStatic fun sessionDidRotate(newId: String) = onMain { recorder?.sessionDidRotate(newId) }

  /** A new screen is showing: its frame in `navigation` mode. */
  @JvmStatic fun screenDidChange() = onMain { recorder?.screenDidChange() }

  /** Stops everything and releases the window observers. */
  @JvmStatic
  fun stop() = onMain {
    recorder?.stop()
    recorder = null
  }

  /**
   * Sends the replay chunk a crash, ANR kill or force stop left open in the previous run, whether or
   * not this run records. [start] does it too; only the first call in a process recovers.
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
    if (Looper.myLooper() == Looper.getMainLooper()) block() else main.post(block)
  }

  /** Test hook: blocks until the main thread ran everything posted before it. */
  internal fun syncMain(timeoutMs: Long = 2000) {
    if (Looper.myLooper() == Looper.getMainLooper()) return
    val done = CountDownLatch(1)
    main.post { done.countDown() }
    done.await(timeoutMs, TimeUnit.MILLISECONDS)
  }
}
