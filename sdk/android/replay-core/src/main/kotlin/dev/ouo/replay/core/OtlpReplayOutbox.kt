package dev.ouo.replay.core

import java.io.File

/**
 * Delivery of replay records over OTLP (client SDK spec 8 and 11.4, ADR-0019 decision 5): each
 * chunk, and each end record, is ONE `POST <logsUrl>` with `Content-Type: application/x-protobuf`
 * and no `Content-Encoding` (the body inside is already compressed by the format layer), carrying
 * an `ExportLogsServiceRequest` with one log record (TRN-5).
 *
 * The request bytes are built once, written to the [DiskQueue] folder before the first send
 * (RPL-15) and sent from there, so a retry and the next process send the same bytes (TRN-10) and a
 * replay backlog never waits behind, or delays, the telemetry queue (TRN-3). Answers (TRN-6):
 *
 * | Answer | Action |
 * |---|---|
 * | 2xx, no `partial_success.rejected_log_records` | removed |
 * | 2xx, rejected > 0 | removed, counted, the stream is partial |
 * | 429, 503 | retried, `Retry-After` honoured up to 300 s |
 * | 502, 504, no answer | retried, exponential backoff with full jitter from 1 s to 300 s |
 * | anything else | removed, counted, the stream is partial |
 *
 * Over [Config.maxQueueBytes] the oldest chunks go first (the oldest segment of the oldest stream)
 * and their stream is told ([onLoss]); nothing is renumbered (RPL-17). No foreground service: what
 * is queued when the process dies is sent by the next launch.
 */
class OtlpReplayOutbox(
  val directory: File,
  /** Where and as whom the records are sent; replaced by every start, read at every send. */
  @Volatile var target: Target,
  val config: Config = Config(),
  transport: Transport = UrlConnectionTransport,
  private val logger: Logger = Logger.NONE,
  private val counters: ReplayCounters = ReplayCounters(),
  now: () -> EpochMillis = System::currentTimeMillis,
) : ReplayStream.Sink {
  data class Config(
    val maxQueueBytes: Long = 32L * 1024 * 1024,
    val retryDelayMs: (Int) -> Long = DiskQueue.Config.fullJitter(1_000, 300_000),
    val retryAfterCapMs: Long = 300_000,
  )

  class Target(
    val logsUrl: String,
    /** The `Authorization` header the legacy uploader sends (HTTP Basic of the project credential), or null. */
    val authorization: String?,
    val resource: List<Pair<String, Any>>,
    val scopeVersion: String,
    val schemaUrl: String,
  )

  /** Called with the stream id whose chunk was evicted, rejected or refused. Queue thread: must not block. */
  @Volatile var onLoss: ((streamId: String) -> Unit)? = null

  private val queue = DiskQueue(
    directory,
    DiskQueue.Config(config.maxQueueBytes, config.retryDelayMs, config.retryAfterCapMs),
    transport,
    logger,
    now,
    rejectedRecords = { OtlpLogs.rejectedLogRecords(it.body) },
    onOutcome = { tag, outcome -> left(tag, outcome) },
  ) { _, body ->
    val t = target
    val headers = LinkedHashMap<String, String>()
    t.authorization?.let { headers["Authorization"] = it }
    headers["Content-Type"] = CONTENT_TYPE
    HttpRequest(t.logsUrl, headers, body)
  }

  val sent: Int get() = queue.sent
  val rejectedStatus: Int get() = queue.rejected
  val partialRejected: Int get() = queue.partialRejected
  val evicted: Int get() = queue.dropped
  val queuedCount: Int get() = try {
    queue.count
  } catch (e: Throwable) {
    0
  }

  override fun chunk(chunk: ReplayChunk): Boolean {
    val bytes = try {
      encode(target, chunk)
    } catch (e: Throwable) {
      counters.error("outbox.encode", e)
      return false
    }
    return put(bytes, "c.${chunk.streamId}.${chunk.sequence}.pb")
  }

  override fun ended(ended: ReplayEnded): Boolean {
    val bytes = try {
      encode(target, ended)
    } catch (e: Throwable) {
      counters.error("outbox.encode", e)
      return false
    }
    return put(bytes, "e.${ended.streamId}.end.pb")
  }

  /** Tries to send what is queued; [completion] runs once the folder is empty or its oldest record failed again. */
  fun drain(completion: () -> Unit) {
    try {
      queue.drain(completion)
    } catch (e: Throwable) {
      counters.error("outbox.drain", e)
      try {
        completion()
      } catch (ignored: Throwable) {
      }
    }
  }

  fun close() = queue.close()

  private fun put(bytes: ByteArray, tag: String): Boolean =
    try {
      val ok = queue.put(bytes, tag)
      // Refused by the disk: it was sent once from memory (TRN-15), and is counted.
      if (!ok) counters.count("replay.persist_failed")
      ok
    } catch (e: Throwable) {
      counters.error("outbox.put", e)
      false
    }

  private fun left(tag: String, outcome: DiskQueue.Outcome) {
    when (outcome) {
      DiskQueue.Outcome.SENT -> return
      DiskQueue.Outcome.PARTIAL_REJECTED -> counters.count("replay.partial_rejected")
      DiskQueue.Outcome.REJECTED_STATUS -> counters.count("replay.rejected_status")
      DiskQueue.Outcome.EVICTED -> counters.count("replay.evicted")
      DiskQueue.Outcome.UNREADABLE -> counters.count("replay.unreadable")
    }
    val parts = tag.split('.')
    if (parts.size == 4 && parts[0] == "c") onLoss?.invoke(parts[1])
  }

  companion object {
    const val CONTENT_TYPE = "application/x-protobuf"

    /** The attributes of spec 11.3, in its order. `ouo.replay.ref` is the Collector's and is never set (RPL-14). */
    fun attributes(c: ReplayChunk): List<Pair<String, Any>> {
      val a = ArrayList<Pair<String, Any>>(16)
      a.add("session.id" to c.sessionId)
      a.add("ouo.replay.id" to c.replayId)
      a.add("ouo.replay.stream.id" to c.streamId)
      a.add("ouo.replay.segment.index" to c.segmentIndex.toLong())
      a.add("ouo.replay.sequence" to c.sequence.toLong())
      a.add("ouo.replay.keyframe" to c.keyframe)
      a.add("ouo.replay.start_time" to c.startTime)
      a.add("ouo.replay.end_time" to c.endTime)
      a.add("ouo.replay.format" to c.format)
      a.add("ouo.replay.encoding" to c.encoding)
      a.add("ouo.replay.sha256" to c.sha256)
      a.add("ouo.replay.byte_size" to c.byteSize.toLong())
      a.add("ouo.replay.masked" to c.masked)
      a.add("ouo.replay.mode" to c.mode)
      c.trigger?.let { a.add("ouo.replay.trigger" to it) }
      c.viewId?.takeIf { it.isNotEmpty() }?.let { a.add("ouo.view.id" to it) }
      return a
    }

    /** `ouo.replay.chunk`: time and observed time are the chunk's start, the body is the compressed bytes. */
    fun encode(t: Target, c: ReplayChunk): ByteArray =
      OtlpLogs.request(t.resource, t.scopeVersion, t.schemaUrl, c.startTime, c.startTime, OtlpLogs.CHUNK_EVENT, c.body, attributes(c))

    /** `ouo.replay.ended` (spec 11.5): the same envelope with no body. */
    fun encode(t: Target, e: ReplayEnded): ByteArray {
      val a = ArrayList<Pair<String, Any>>(6)
      a.add("session.id" to e.sessionId)
      a.add("ouo.replay.id" to e.replayId)
      a.add("ouo.replay.stream.id" to e.streamId)
      a.add("ouo.replay.end_state" to if (e.complete) "complete" else "partial")
      e.lastSequence?.let { a.add("ouo.replay.last_sequence" to it.toLong()) }
      a.add("ouo.replay.end_reason" to e.reason)
      return OtlpLogs.request(t.resource, t.scopeVersion, t.schemaUrl, e.time, e.time, OtlpLogs.ENDED_EVENT, null, a)
    }
  }
}
