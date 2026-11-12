package dev.ouo.replay.core

import java.io.File

/**
 * The replay queue of the OTLP path (client SDK spec 8, 11.4): one [DiskQueue] folder of its own,
 * so a replay backlog cannot delay telemetry (TRN-3). Each record is the final protobuf request
 * body, written to disk before its first send (RPL-15) and sent again byte for byte until the
 * collector answers (TRN-10), one record per request (TRN-5): `POST <logsUrl>` with
 * `Content-Type: application/x-protobuf` and no `Content-Encoding` (the body inside the record is
 * already compressed by the format, once). The Swift `ReplayDelivery` of `sdk/ios`, ported.
 *
 * | Answer (TRN-6) | Action |
 * |---|---|
 * | 2xx, no `partial_success.rejected_log_records` | deleted |
 * | 2xx, rejected > 0 | deleted, counted `partialRejected` |
 * | 429, 503 | kept; retried after `Retry-After` capped at 300 s (TRN-8), else after the backoff |
 * | 502, 504, no answer | kept; exponential backoff with full jitter, 1 s to 300 s (TRN-7) |
 * | anything else | deleted, counted `rejectedStatus` |
 *
 * Beyond `maxQueueBytes` the oldest records go first: the oldest chunks of the oldest segment,
 * whole (RPL-17). Every chunk lost after it was taken (evicted, rejected) is reported through
 * [onLoss] so its stream is marked partial. No foreground service (LIF-14): what is queued when
 * the process dies is sent by the next launch. One delivery per folder per process.
 */
class ReplayDelivery(
  logsUrl: String,
  /** The `Authorization` header value, what the chunk uploader sends ([basicAuthorization]); empty sends none. */
  authorization: String,
  val directory: File,
  val config: Config = Config(),
  transport: Transport = UrlConnectionTransport,
  logger: Logger = Logger.NONE,
  now: () -> EpochMillis = System::currentTimeMillis,
) : ReplaySink {
  data class Config(
    val maxQueueBytes: Long = 20L * 1024 * 1024,
    val maxEntries: Int = 2048,
    /** Wait in ms before the nth retry in a row. Injected so tests do not wait. */
    val retryDelayMs: (Int) -> Long = DiskQueue.Config.fullJitter(),
    val retryAfterCapMs: Long = 300_000,
  )

  data class Stats(
    /** Durably accepted (TRN-12). */
    val accepted: Int = 0,
    val partialRejected: Int = 0,
    val rejectedStatus: Int = 0,
    /** Dropped unsent by the queue's bounds (or unreadable). */
    val evicted: Int = 0,
    /** Not stored: the disk refused the write. */
    val refused: Int = 0,
  )

  /** Where and as whom the records go; the latest start of the process decides. */
  private class Target(val url: String, val authorization: String)

  @Volatile private var target = Target(logsUrl, authorization)
  private val lock = Any()
  private var counters = Stats()

  /** Called (on a thread of its own, never the caller's or the queue's) with the stream id of every chunk lost after [put] took it. */
  @Volatile var onLoss: ((String) -> Unit)? = null

  // The stream calls `put` under its lock and waits for the queue; a loss reported from the queue's
  // thread straight into the stream would wait for that lock for ever.
  private val notify = java.util.concurrent.Executors.newSingleThreadExecutor { r -> Thread(r, "ouo-replay-notify").apply { isDaemon = true } }

  private val queue = DiskQueue(
    directory,
    DiskQueue.Config(config.maxQueueBytes, config.retryDelayMs, config.retryAfterCapMs, config.maxEntries),
    transport,
    logger,
    now,
    rejectedRecords = { ReplayEnvelope.rejectedLogRecords(it.body) },
    onOutcome = { tag, outcome -> finished(tag, outcome) },
  ) { _, body ->
    val t = target
    makeRequest(t.url, t.authorization, body)
  }

  val url: String get() = target.url
  val stats: Stats get() = synchronized(lock) { counters }
  val queuedCount: Int get() = try {
    queue.count
  } catch (e: Throwable) {
    0
  }

  /** A later start of the same process sends to its own URL and credential. */
  fun retarget(logsUrl: String, authorization: String) {
    target = Target(logsUrl, authorization)
  }

  /**
   * Writes the record to the queue folder before returning, then starts sending. False when the
   * disk refused it: nothing is sent from memory, the caller stops capture (RPL-18).
   */
  override fun put(request: ByteArray, streamId: String, sequence: Int?): Boolean {
    val tag = if (sequence != null) "$streamId.$sequence.chunk.pb" else "$streamId.ended.pb"
    val ok = try {
      queue.put(request, tag, sendIfRefused = false)
    } catch (e: Throwable) {
      false
    }
    if (!ok) synchronized(lock) { counters = counters.copy(refused = counters.refused + 1) }
    return ok
  }

  /** Tries to send what is queued (this process's records and those an earlier one left); [completion] runs once the folder is empty or its oldest record failed again. */
  fun drain(completion: () -> Unit) {
    try {
      queue.drain(completion)
    } catch (e: Throwable) {
      try {
        completion()
      } catch (ignored: Throwable) {
      }
    }
  }

  /**
   * Deletes every record not yet accepted (consent withdrawn, an app-initiated clear: TRN-13, not
   * counted as a loss and not reported to the stream). Returns how many were deleted. A request
   * already on the wire may still arrive.
   */
  fun discardPending(): Int =
    try {
      val entries = queue.entries()
      entries.forEach { queue.remove(it) }
      entries.size
    } catch (e: Throwable) {
      0
    }

  fun close() {
    queue.close()
    notify.shutdown()
  }

  /** On the disk queue's thread: must not call back into it. */
  private fun finished(tag: String, outcome: DiskQueue.Outcome) {
    var lost = true
    synchronized(lock) {
      counters = when (outcome) {
        DiskQueue.Outcome.SENT -> {
          lost = false
          counters.copy(accepted = counters.accepted + 1)
        }
        DiskQueue.Outcome.PARTIAL_REJECTED -> counters.copy(partialRejected = counters.partialRejected + 1)
        DiskQueue.Outcome.REJECTED_STATUS -> counters.copy(rejectedStatus = counters.rejectedStatus + 1)
        DiskQueue.Outcome.EVICTED, DiskQueue.Outcome.UNREADABLE -> counters.copy(evicted = counters.evicted + 1)
      }
    }
    // `<stream id>.<sequence>.chunk.pb`: only a chunk leaves a hole in its stream.
    val parts = tag.split('.')
    val handler = onLoss
    if (lost && parts.size == 4 && parts[2] == "chunk" && handler != null) {
      try {
        notify.execute {
          try {
            handler(parts[0])
          } catch (ignored: Throwable) {
          }
        }
      } catch (ignored: Throwable) {
      }
    }
  }

  companion object {
    const val CONTENT_TYPE = "application/x-protobuf"
    const val DIRECTORY_NAME = "outbox-otlp"

    /** One OTLP/HTTP request: binary protobuf, no `Content-Encoding` (TRN-1, spec 8.1). */
    fun makeRequest(url: String, authorization: String, body: ByteArray): HttpRequest {
      val headers = LinkedHashMap<String, String>()
      if (authorization.isNotEmpty()) headers["Authorization"] = authorization
      headers["Content-Type"] = CONTENT_TYPE
      return HttpRequest(url, headers, body)
    }

    /** [discardPending] for a folder no delivery was made for in this process. */
    fun discardPending(directory: File): Int {
      var removed = 0
      for (e in DiskQueue.list(directory)) if (runCatching { e.file.delete() }.getOrDefault(false)) removed++
      return removed
    }
  }
}
