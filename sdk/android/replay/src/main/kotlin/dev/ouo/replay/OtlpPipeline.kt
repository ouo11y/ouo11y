package dev.ouo.replay

import android.content.Context
import dev.ouo.replay.core.FileReplayStateStore
import dev.ouo.replay.core.Logger
import dev.ouo.replay.core.ReplayEndReason
import dev.ouo.replay.core.ReplayFormatAdapter
import dev.ouo.replay.core.ReplayRecorderMode
import dev.ouo.replay.core.ReplayOTLPOptions
import dev.ouo.replay.core.ReplayStream
import dev.ouo.replay.core.ReplayTrigger
import dev.ouo.replay.core.Touch
import dev.ouo.sentrycore.Mp4SegmentWriter
import java.io.File
import java.util.concurrent.atomic.AtomicInteger

/**
 * The OTLP half of the pixel recorders (`mode: "pixel/frames"` or `"pixel/video"`, ADR-0021 decision 5, client SDK
 * spec 11), what the Swift `OTLPReplayRecorder` adds to the capture loop. "When to look" stays
 * [ReplayRecorder]'s (the draw listener and the `CapturePacer`). What a look becomes is the format
 * adapter's (`ouo-frames/3`, [PixelFormatAdapter]); numbering, chunking, the buffer ring and the
 * end record are [ReplayStream]'s; the disk queue is `ReplayDelivery`'s.
 *
 * Everything that touches the stream, the disk or the queue runs on the recorder's compose thread
 * (never the main thread: ERR-4). Nothing here throws (ERR-1): every block that runs on the compose
 * thread catches `Throwable` and counts it.
 */
internal class OtlpPipeline(context: Context, private val config: OuoReplayConfig, private val options: ReplayOTLPOptions, private val capturer: ScreenCapturer, private val logger: Logger) {
  private val delivery = OuoReplay.delivery(context, config, options)
  private val store = FileReplayStateStore(File(OuoReplayConfig.directory(context), FileReplayStateStore.FILE_NAME))
  private val compose = ReplayRecorder.compose
  private val faults = AtomicInteger()

  /** The stream itself is thread-safe; the reference changes on a session rotation. */
  @Volatile private var stream: ReplayStream = makeStream(sessionId(), options.replayId)

  private fun sessionId(): String = try {
    config.sessionId()
  } catch (e: Throwable) {
    ""
  }

  /** The adapter of the stream in use: the video adapter holds an open segment to drop on discard. */
  @Volatile private var adapter: ReplayFormatAdapter? = null
  private val videoDirectory = File(OuoReplayConfig.directory(context), "video")

  private fun makeStream(sessionId: String, replayId: String?): ReplayStream {
    // Secure fields are masked whatever the options say, so masking always ran on a frame.
    val a: ReplayFormatAdapter = when (options.recorder) {
      ReplayRecorderMode.PIXEL_VIDEO -> VideoFormatAdapter(capturer, videoDirectory, config.debug, logger, masked = true)
      else -> PixelFormatAdapter(capturer, masked = true)
    }
    adapter = a
    return ReplayStream(sessionId, replayId, options.scope, options.streamConfig, a, delivery, store, logger)
  }

  /** False once the stream ended on its own (the store refused a chunk, or too many errors): the recorder stops capturing. */
  val isActive: Boolean get() = stream.isActive && faults.get() < FAULT_LIMIT

  val replayId: String get() = stream.replayId
  val streamId: String get() = stream.streamId

  /**
   * The stream a kill left open ends first (RPL-20), then what earlier runs queued is sent: on the
   * compose thread, so before any chunk of this process. False when there is no session id:
   * `session.id` is required on every chunk (RPL-13), so nothing is recorded.
   */
  fun start(): Boolean {
    val previousExit = options.previousExit
    onCompose {
      // Segment files a killed process left half written: never sent, never kept.
      videoDirectory.listFiles()?.forEach { it.delete() }
      ReplayStream.endOpenStream(store, delivery, previousExit)
      delivery.drain {}
    }
    delivery.onLoss = { streamId -> stream.chunkLost(streamId) }
    if (options.recorder == ReplayRecorderMode.PIXEL_VIDEO && !Mp4SegmentWriter.isSupported) {
      // The encoder needs Android 8: nothing is recorded rather than another format unasked.
      logger.warn("pixel/video needs Android 8 (API 26): replay not started")
      OuoReplay.count("replay.mode_unsupported")
      return false
    }
    if (stream.sessionId.isEmpty()) {
      logger.warn("no session id: replay not started")
      OuoReplay.count("replay.no_session")
      return false
    }
    logger.log("started otlp logs=${options.logsUrl} mode=${options.recorder.wire} buffer=${options.bufferSeconds?.let { "${it}s" } ?: "off"} replay=${stream.replayId} stream=${stream.streamId}")
    return true
  }

  /** Compose thread. True when the look was taken, false when the adapter refused it (the frame is dropped). */
  fun look(look: PixelLook, t: Long): Boolean {
    val s = stream
    val before = s.stats.framesDropped
    s.look(look, t)
    return s.stats.framesDropped == before
  }

  fun touch(touch: Touch) = onCompose { stream.touch(touch) }

  fun tick() = onCompose { stream.tick() }

  /** Closes the chunk; what is captured next starts a new segment (RPL-8, RPL-9, RPL-10). */
  fun closeForGap() = onCompose {
    stream.background()
    delivery.drain {}
  }

  /** Closes the open chunk and tries to send what is queued; [completion] runs on another thread when done. */
  fun flush(completion: (() -> Unit)?) {
    val posted = onCompose {
      stream.flush()
      delivery.drain { completion?.invoke() }
    }
    if (!posted) completion?.invoke()
  }

  /**
   * A new session is a new replay (spec 11.1): the stream ends with `session_end` and a new replay
   * and stream start for [newId]. A buffer starts over untriggered.
   */
  fun rotate(newId: String) {
    val old = stream
    if (newId.isEmpty() || newId == old.sessionId) return
    stream = makeStream(newId, null)
    onCompose {
      old.end(ReplayEndReason.SESSION_END)
      delivery.drain {}
    }
    logger.log("session rotated -> $newId: replay=${stream.replayId} stream=${stream.streamId}")
  }

  fun capture(trigger: ReplayTrigger) = onCompose {
    stream.capture(trigger)
    delivery.drain {}
  }

  fun setViewId(id: String) = onCompose { stream.setViewId(id) }

  /** Ends the stream with `ouo.replay.ended`. */
  fun end(reason: ReplayEndReason) = onCompose {
    stream.end(reason)
    delivery.drain {}
  }

  /** Consent withdrawn (PRV-4): nothing further is sent (no end record either) and what is queued is deleted. */
  fun discard(completion: (() -> Unit)?) {
    val posted = onCompose {
      try {
        stream.abandon()
        (adapter as? VideoFormatAdapter)?.reset()
        delivery.discardPending()
      } finally {
        completion?.invoke()
      }
    }
    if (!posted) completion?.invoke()
  }

  /** The counters of `replayDiagnostics()`, under the names the iOS recorder uses. */
  fun diagnostics(maskDrops: Int, mainFaults: Int): Map<String, Int> {
    val s = stream.stats
    val d = delivery.stats
    return mapOf(
      "replay.frames_dropped" to s.framesDropped + maskDrops,
      "replay.events_dropped" to s.eventsDropped,
      "replay.errors" to s.errors + mainFaults + faults.get(),
      "replay.chunks" to s.chunks,
      "replay.chunk_splits" to s.splits,
      "replay.ring_evicted_segments" to s.ringEvictedSegments,
      "replay.store_refused" to s.refused,
      "replay.chunks_lost" to s.lost,
      "replay.state_failures" to s.stateFailures,
      "replay.accepted" to d.accepted,
      "replay.partial_rejected" to d.partialRejected,
      "replay.rejected_status" to d.rejectedStatus,
      "replay.evicted" to d.evicted,
    ) + ((adapter as? VideoFormatAdapter)?.let { mapOf("replay.video_segments" to it.segments) } ?: emptyMap())
  }

  /** Runs [body] on the compose thread; what it throws is counted, never rethrown. False when it could not be posted. */
  private fun onCompose(body: () -> Unit): Boolean =
    try {
      compose.execute {
        try {
          body()
        } catch (e: Throwable) {
          faults.incrementAndGet()
          logger.warn("replay pipeline error: ${e.javaClass.simpleName}")
        }
      }
      true
    } catch (e: Throwable) {
      faults.incrementAndGet()
      false
    }

  companion object {
    /** Errors caught here after which capture stops (ERR-6), like the stream's own limit. */
    const val FAULT_LIMIT = 20
  }
}
