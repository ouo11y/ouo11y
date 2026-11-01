package dev.ouo.replay.core

import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit

/**
 * A folder of requests waiting for the collector (mobile SDK spec C11): each body is a file written
 * before anything is sent and removed when the collector answers. Network errors and OTLP/HTTP's
 * retryable answers (429, 502, 503, 504: [retryable]) leave it in place and retry after a backoff
 * (at least `Retry-After`), on [drain] and in the next process, so an outage, a crash or a kill
 * mid-request loses nothing. Any other answer is final: 2xx is sent, the rest is rejected (removed
 * and counted), so a request answered 500 every time does not block the queue (checklist N55). Sent oldest first, one request at a time. Bounded by bytes, the
 * oldest dropped first, never the one in flight nor the newest. The Swift `DiskQueue` of `sdk/ios`,
 * ported.
 *
 * No age bound: the wall clock is the user's to move and a monotonic clock restarts at boot, so an
 * age would drop what is queued when the clock moves forward (checklist N77, as on iOS).
 *
 * Files are `<stamp, 13 digits>-<counter, 6 digits>.<tag>`, so names sort in queue order and the tag
 * carries what the request needs. The stamp is the wall clock when queued, raised above the newest
 * name in the folder when the clock moved back, so the order is the order of [put] whatever the clock
 * does. A queue without a transport only holds. One queue per folder per process: two would send the
 * same files.
 */
class DiskQueue(
  val directory: File,
  val config: Config,
  private val transport: Transport?,
  private val logger: Logger = Logger.NONE,
  private val now: () -> EpochMillis = System::currentTimeMillis,
  private val request: (Entry, ByteArray) -> HttpRequest?,
) {
  data class Config(
    val maxBytes: Long,
    /** Wait before retrying after the nth failure in a row, in ms. Injected so tests do not wait. */
    val retryDelayMs: (Int) -> Long = doubling(60_000),
  ) {
    companion object {
      /** 1 s doubling up to [capMs]. */
      fun doubling(capMs: Long): (Int) -> Long = { n -> minOf(1000L shl (maxOf(1, n) - 1).coerceAtMost(20), capMs) }
    }
  }

  class Entry(val file: File, val tag: String, val queuedAt: EpochMillis) {
    val bytes: Long get() = file.length()

    companion object {
      fun of(file: File): Entry? {
        val name = file.name
        val dot = name.indexOf('.')
        if (dot <= 0) return null
        val head = name.substring(0, dot).split('-')
        if (head.size != 2) return null
        val at = head[0].toLongOrNull() ?: return null
        head[1].toIntOrNull() ?: return null
        val tag = name.substring(dot + 1)
        if (tag.isEmpty() || tag.endsWith(".tmp")) return null
        return Entry(file, tag, at)
      }
    }
  }

  private val executor: ScheduledExecutorService = Executors.newSingleThreadScheduledExecutor { r ->
    Thread(r, "ouo-queue-${directory.name}").apply { isDaemon = true }
  }
  /** Sends happen here, so `put` never waits behind a request in flight (up to its 15 s timeout). */
  private val io = Executors.newSingleThreadExecutor { r -> Thread(r, "ouo-send-${directory.name}").apply { isDaemon = true } }
  private var counter = 0
  private var inFlight: File? = null
  private var failures = 0
  private var retryScheduled = false
  private val waiters = mutableListOf<() -> Unit>()

  @Volatile var sent = 0
    private set

  @Volatile var dropped = 0
    private set

  @Volatile var rejected = 0
    private set

  /**
   * Writes [body] as the newest entry before returning, applies the bounds, then starts sending.
   * When the disk refuses it, it is sent once from memory unless [sendIfRefused] is false, and
   * false is returned.
   */
  fun put(body: ByteArray, tag: String, sendIfRefused: Boolean = true): Boolean {
    val ok = onQueue {
      counter = (counter + 1) % 1_000_000
      val stamp = maxOf(now(), (list(directory).lastOrNull()?.queuedAt ?: 0L) + 1)
      val name = "${pad(stamp, 13)}-${pad(counter.toLong(), 6)}.$tag"
      val file = File(directory, name)
      try {
        directory.mkdirs()
        val tmp = File(directory, "$name.tmp")
        tmp.writeBytes(body)
        if (!tmp.renameTo(file)) throw java.io.IOException("rename failed")
        enforceBound()
        true
      } catch (e: Exception) {
        logger.warn("could not queue $tag on disk ($e)${if (sendIfRefused) ", sending it once from memory" else ""}")
        if (sendIfRefused && transport != null) {
          Entry.of(file)?.let { entry -> request(entry, body)?.let { req -> io.execute { transport.send(req) } } }
        }
        false
      }
    }
    // During a backoff the new entry waits for the retry: an outage is not hammered once per put.
    if (ok) executor.execute { if (!retryScheduled) pump() }
    return ok
  }

  /** Tries to send what is queued and calls [completion] once the folder is empty or its oldest entry failed again. */
  fun drain(completion: () -> Unit) {
    executor.execute {
      waiters.add(completion)
      pump()
    }
  }

  /** Entries on disk, oldest first. */
  fun entries(): List<Entry> = onQueue { list(directory) }

  val count: Int get() = onQueue { list(directory).size }

  /** Deletes an entry unsent (a held replay the host decided to drop). */
  fun remove(e: Entry) = onQueue {
    e.file.delete()
    dropped++
  }

  /** Moves an entry into [other] under the same name, then lets [other] apply its bounds and send. */
  fun move(e: Entry, other: DiskQueue) {
    onQueue {
      other.directory.mkdirs()
      if (!e.file.renameTo(File(other.directory, e.file.name))) logger.warn("could not move ${e.tag}")
    }
    other.executor.execute {
      other.enforceBound()
      other.pump()
    }
  }

  /** Stops the thread (tests). Pending work is dropped; files stay on disk. */
  fun close() {
    executor.shutdownNow()
    io.shutdownNow()
  }

  private fun <T> onQueue(body: () -> T): T = executor.submit<T> { body() }.get()

  private fun enforceBound() {
    val es = list(directory)
    var total = es.sumOf { it.bytes }
    // Oldest first; never the newest, nor the one in flight (its answer removes it).
    for (victim in es.dropLast(1)) {
      if (total <= config.maxBytes) break
      if (victim.file == inFlight) continue
      total -= victim.bytes
      drop(victim, "queue bound")
    }
  }

  private fun drop(e: Entry, why: String) {
    e.file.delete()
    dropped++
    logger.warn("dropped ${e.tag} ($why)")
  }

  private fun pump() {
    val t = transport
    if (t == null) {
      finishWaiters()
      return
    }
    if (inFlight != null) return
    val head = list(directory).firstOrNull()
    if (head == null) {
      failures = 0
      finishWaiters()
      return
    }
    val body = runCatching { head.file.readBytes() }.getOrNull()
    val req = body?.let { request(head, it) }
    if (req == null) {
      drop(head, "unreadable")
      pump()
      return
    }
    inFlight = head.file
    io.execute {
      val answer = t.send(req)
      executor.execute { finish(head, answer) }
    }
  }

  private fun finish(head: Entry, answer: HttpAnswer) {
    inFlight = null
    val status = answer.status
    when {
      status in 200..299 -> {
        head.file.delete()
        sent++
        failures = 0
        logger.log("sent ${head.tag}")
        pump()
      }
      status == 0 || retryable(status) ->
        retryLater(head, if (status == 0) "network error" else "HTTP $status", answer.retryAfterSeconds)
      else -> {
        head.file.delete()
        rejected++
        logger.warn("${head.tag} rejected: HTTP $status, dropped (not retryable)")
        pump()
      }
    }
  }

  private fun retryLater(head: Entry, why: String, retryAfterSeconds: Double?) {
    failures++
    val delay = maxOf(config.retryDelayMs(failures), ((retryAfterSeconds ?: 0.0) * 1000).toLong())
    logger.warn("sending ${head.tag} failed ($why), kept on disk, retry in $delay ms")
    finishWaiters()
    if (retryScheduled) return
    retryScheduled = true
    executor.schedule({
      retryScheduled = false
      pump()
    }, delay, TimeUnit.MILLISECONDS)
  }

  private fun finishWaiters() {
    val ws = waiters.toList()
    waiters.clear()
    ws.forEach { runCatching { it() } }
  }

  companion object {
    /** OTLP/HTTP's retryable answers: 429, 502, 503 and 504. Any other status is final. */
    fun retryable(status: Int): Boolean = status == 429 || status == 502 || status == 503 || status == 504

    fun pad(n: Long, width: Int): String = n.toString().padStart(width, '0')

    fun list(folder: File): List<Entry> =
      (folder.listFiles() ?: emptyArray()).mapNotNull { if (it.isFile) Entry.of(it) else null }.sortedBy { it.file.name }
  }
}
