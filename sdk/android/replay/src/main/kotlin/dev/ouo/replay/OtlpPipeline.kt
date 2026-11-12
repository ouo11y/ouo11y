package dev.ouo.replay

import android.content.Context
import dev.ouo.replay.core.Frame
import dev.ouo.replay.core.Logger
import dev.ouo.replay.core.PixelCapture
import dev.ouo.replay.core.PixelFormatAdapter
import dev.ouo.replay.core.ReplayCounters
import dev.ouo.replay.core.ReplayDelivery
import dev.ouo.replay.core.ReplayFormatAdapter
import dev.ouo.replay.core.ReplayStream
import dev.ouo.replay.core.StreamStateStore
import dev.ouo.replay.core.StructureFormatAdapter
import dev.ouo.replay.core.TouchPhase
import dev.ouo.replay.core.TreeSnapshot
import java.io.File

/**
 * The spec wire of replay (ADR-0019 decision 5): a format adapter, the [ReplayStream] that cuts its
 * events into segments and chunks, and the OTLP outbox. Used by [ReplayRecorder] instead of the
 * legacy `ChunkBuilder` and `ChunkUploader` when [OuoReplayConfig.otlp] is set.
 *
 * Everything that touches the stream, the disk or the outbox runs on the recorder's compose thread;
 * the methods without "compose thread" in their comment may be called from any thread and hop
 * there. Nothing here throws: every body runs inside [ReplayCounters.guard].
 */
internal class OtlpPipeline(context: Context, private val config: OuoReplayConfig, otlp: OuoReplayOtlp, private val logger: Logger, val counters: ReplayCounters) {
  val isStructure = config.format == OuoReplayFormat.STRUCTURE
  private val pixel = if (isStructure) null else PixelFormatAdapter(config.redactionRules.masksAnything)
  private val structure = if (isStructure) StructureFormatAdapter(config.redactionRules) else null
  private val adapter: ReplayFormatAdapter<*> = structure ?: pixel!!
  private val outbox = OuoReplay.outbox(context, config, otlp, counters)
  private val state = StreamStateStore(File(OuoReplayConfig.directory(context), OPEN_STREAM))
  private val compose = ReplayRecorder.compose

  @Volatile private var stream: ReplayStream? = null
  @Volatile private var viewId: String? = null

  /** The stream ended on its own (the store takes nothing more) or too many errors were caught: the recorder stops capturing. */
  @Volatile var dead = false
    private set

  /** Compose thread: whether the next pixel frame must be a full image. */
  val needsKeyframe: Boolean get() = adapter.needsKeyframe

  val format: String get() = adapter.formatId
  val replayId: String? get() = stream?.replayId
  val streamId: String? get() = stream?.streamId
  val lastSequence: Int get() = stream?.lastSequence ?: -1
  val partial: Boolean get() = stream?.partial ?: false
  val triggered: Boolean get() = stream?.triggered ?: false
  val queued: Int get() = outbox.queuedCount

  /** Ends the stream a kill left open in the previous run, then opens this run's stream. */
  fun open() = onCompose("pipeline.open") {
    endLeftOpen(state, outbox, logger, null)
    openStream(config.replayId)
    logger.log("replay over OTLP: format=${adapter.formatId} mode=${config.delivery.wire} replay=${stream?.replayId} stream=${stream?.streamId}")
  }

  private fun openStream(replayId: String?) {
    val s = ReplayStream(
      ReplayStream.Config(
        replayId = replayId,
        delivery = config.delivery,
        bufferSeconds = config.bufferSeconds,
        keyframeIntervalMs = config.keyframeIntervalMs,
        chunkMaxBytes = config.chunkMaxBytes,
        chunkMaxMs = config.flushIntervalMs,
      ),
      adapter,
      config.sessionId,
      outbox,
      state,
      counters,
    )
    s.viewId = viewId
    stream = s
    dead = false
    outbox.onLoss = { id -> stream?.takeIf { it.streamId == id }?.reportLoss() }
  }

  /** Compose thread: a masked frame of the pixel format. */
  fun pixel(frame: Frame, width: Int, height: Int, imageWidth: Int, imageHeight: Int, scale: Double) {
    val a = pixel ?: return
    val s = stream ?: return
    val events = counters.guard("adapter.capture") { a.capture(PixelCapture(frame, width, height, imageWidth, imageHeight, scale)) }
    if (events == null) {
      // The adapter failed: this frame is dropped and what follows starts at a keyframe.
      counters.count("replay.dropped.adapter")
      s.markGap()
    } else {
      s.append(events)
    }
    check(s)
  }

  /** Compose thread: a walked tree of the structure format. */
  fun tree(snapshot: TreeSnapshot) {
    val a = structure ?: return
    val s = stream ?: return
    val events = counters.guard("adapter.capture") { a.capture(snapshot) }
    if (events == null) {
      counters.count("replay.dropped.adapter")
      s.markGap()
    } else {
      s.append(events)
    }
    check(s)
  }

  /** A touch in pixels of the captured window. */
  fun touch(t: Long, x: Double, y: Double, phase: TouchPhase) = onCompose("pipeline.touch") {
    stream?.let { s ->
      s.append(listOf(adapter.touch(t, x, y, phase)))
      check(s)
    }
  }

  fun tick() = onCompose("pipeline.tick") { stream?.let { it.tick(); check(it) } }

  fun background() = onCompose("pipeline.background") {
    stream?.background()
    outbox.drain {}
  }

  fun foreground() = onCompose("pipeline.foreground") { stream?.foreground() }

  /** Closes the open chunk and tries to send what is queued; [completion] runs on the compose or the queue thread. */
  fun flush(completion: (() -> Unit)?) {
    val done = { counters.guard("pipeline.flush.completion") { completion?.invoke() } }
    val posted = onCompose("pipeline.flush") {
      stream?.flush()
      outbox.drain { done() }
    }
    if (!posted) done()
  }

  /** The session rotated: the old session's replay ends (`session_end`) and a new replay starts. */
  fun rotate() = onCompose("pipeline.rotate") {
    stream?.end("session_end")
    openStream(null)
    outbox.drain {}
  }

  /** Buffer mode: sends the ring and goes on as a session recording. */
  fun trigger(reason: String) = onCompose("pipeline.trigger") {
    if (stream?.trigger(reason) == true) logger.log("buffer triggered ($reason)")
    outbox.drain {}
  }

  fun setViewId(id: String?) {
    viewId = id
    stream?.viewId = id
  }

  /** Ends the stream with `ouo.replay.ended` and sends what is queued. */
  fun end(reason: String, completion: (() -> Unit)? = null) {
    val done = { counters.guard("pipeline.end.completion") { completion?.invoke() } }
    val posted = onCompose("pipeline.end") {
      stream?.end(reason)
      stream = null
      outbox.drain { done() }
    }
    if (!posted) done()
  }

  private fun check(s: ReplayStream) {
    if (s.ended || counters.disabled) dead = true
  }

  private fun onCompose(seam: String, body: () -> Unit): Boolean =
    counters.guard(seam) {
      compose.execute { counters.guard(seam, body) }
      true
    } ?: false

  companion object {
    const val OPEN_STREAM = "open-stream.json"

    /** Compose thread only: the previous run's open stream is ended once per process. */
    private var leftOpenEnded = false

    /**
     * Compose thread: sends `ouo.replay.ended` (`partial`) for the stream a kill left open in the
     * previous run (RPL-20), with reason `crash` when the host knows that run crashed in the stream's
     * session, `background_kill` otherwise, and sends what that run left queued.
     */
    private fun endLeftOpen(state: StreamStateStore, outbox: dev.ouo.replay.core.OtlpReplayOutbox, logger: Logger, crashSessionId: String?) {
      if (leftOpenEnded) return
      leftOpenEnded = true
      val crashed = crashSessionId != null && state.read()?.sessionId == crashSessionId
      if (ReplayStream.endOpenStream(state, outbox, if (crashed) "crash" else "background_kill")) logger.log("ended the stream the previous run left open (partial)")
      outbox.drain {}
    }

    /** Any thread: [endLeftOpen] for a launch that may not start replay. */
    fun recover(context: Context, config: OuoReplayConfig, otlp: OuoReplayOtlp, crashSessionId: String?) {
      val counters = ReplayCounters()
      counters.guard("pipeline.recover") {
        ReplayRecorder.compose.execute {
          counters.guard("pipeline.recover") {
            val app = context.applicationContext
            endLeftOpen(StreamStateStore(File(OuoReplayConfig.directory(app), OPEN_STREAM)), OuoReplay.outbox(app, config, otlp, counters), ReplayRecorder.logger(config.debug), crashSessionId)
          }
        }
      }
    }
  }
}
