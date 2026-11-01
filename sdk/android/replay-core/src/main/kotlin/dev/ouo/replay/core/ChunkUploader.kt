package dev.ouo.replay.core

import java.io.File

/**
 * Serialises chunks to gzip JSON and POSTs them to `${endpoint}/v1/replay/chunks` (the collector's
 * `ouoreplay` receiver) in order, with the headers the browser and iOS uploaders send plus the
 * project credential as HTTP Basic (ADR-0007).
 *
 * The queue is a [DiskQueue] folder (docs/specs/mobile-replay.md, "Chunking"): each chunk is written
 * there as the gzip body it is sent with before anything is sent. With [Config.hold], chunks go to
 * `held/` instead and wait for [release]: the host decides at the next launch whether a finished
 * session's replay is sent. One uploader per folder per process.
 */
class ChunkUploader(
  endpoint: String,
  projectId: String,
  projectToken: String,
  val directory: File,
  val config: Config = Config(),
  transport: Transport = UrlConnectionTransport,
  private val logger: Logger = Logger.NONE,
  now: () -> EpochMillis = System::currentTimeMillis,
) {
  data class Config(
    val maxQueueBytes: Long = 10L * 1024 * 1024,
    val retryDelayMs: (Int) -> Long = DiskQueue.Config.doubling(60_000),
    val hold: Boolean = false,
  )

  /** A finished session's held chunks, for the keep/drop decision. */
  data class HeldSession(val sessionId: String, val chunks: Int, val bytes: Long, val firstAt: EpochMillis, val lastAt: EpochMillis)

  /** `<session id>.<seq>.json.gz`: the tag of a queue file carries the request headers. */
  private class Tag(val sessionId: String, val seq: Int) {
    companion object {
      fun of(tag: String): Tag? {
        val parts = tag.split('.')
        if (parts.size < 4 || parts[parts.size - 2] != "json" || parts.last() != "gz") return null
        val seq = parts[parts.size - 3].toIntOrNull() ?: return null
        return Tag(parts.subList(0, parts.size - 3).joinToString("."), seq)
      }
    }
  }

  val url: String = endpoint.trimEnd('/') + CHUNKS_PATH
  val authorization: String = basicAuthorization(projectId, projectToken)
  private val queued: DiskQueue
  private val held: DiskQueue

  init {
    val bounds = DiskQueue.Config(config.maxQueueBytes, config.retryDelayMs)
    queued = DiskQueue(directory, bounds, transport, logger, now) { e, body ->
      Tag.of(e.tag)?.let { makeRequest(url, authorization, it.sessionId, it.seq, body) }
    }
    held = DiskQueue(File(directory, "held"), bounds, null, logger, now) { _, _ -> null }
  }

  val uploaded: Int get() = queued.sent
  val failed: Int get() = queued.rejected
  val queuedCount: Int get() = queued.count

  /** Encodes, compresses and writes the chunk to the queue folder before returning, then starts sending. */
  fun enqueue(chunk: FrameChunk) {
    val body = try {
      Gzip.compress(chunk.encodedJson())
    } catch (e: Exception) {
      logger.warn("could not encode chunk seq=${chunk.seq}: $e")
      return
    }
    val tag = "${chunk.sessionId}.${chunk.seq}.json.gz"
    val ok = if (config.hold) held.put(body, tag, sendIfRefused = false) else queued.put(body, tag)
    if (ok) logger.log("${if (config.hold) "held" else "queued"} session=${chunk.sessionId} seq=${chunk.seq} ${chunk.frames.size} frames ${chunk.touches.size} touches ${body.size} bytes gzip")
  }

  /** Tries to send what is queued; [completion] runs once the folder is empty or its oldest chunk failed again. */
  fun drain(completion: () -> Unit) = queued.drain(completion)

  /** Sessions with held chunks, oldest first. */
  fun heldSessions(): List<HeldSession> {
    val groups = LinkedHashMap<String, MutableList<DiskQueue.Entry>>()
    for (e in held.entries()) {
      val t = Tag.of(e.tag) ?: continue
      groups.getOrPut(t.sessionId) { mutableListOf() }.add(e)
    }
    return groups.map { (id, es) -> HeldSession(id, es.size, es.sumOf { it.bytes }, es.first().queuedAt, es.last().queuedAt) }
  }

  /** Sends ([keep]) or deletes a held session's chunks. */
  fun release(sessionId: String, keep: Boolean) {
    val es = held.entries().filter { Tag.of(it.tag)?.sessionId == sessionId }
    for (e in es) if (keep) held.move(e, queued) else held.remove(e)
    logger.log("${if (keep) "kept" else "dropped"} ${es.size} held chunks of session=$sessionId")
  }

  fun close() {
    queued.close()
    held.close()
  }

  companion object {
    const val CHUNKS_PATH = "/v1/replay/chunks"

    fun makeRequest(url: String, authorization: String, sessionId: String, seq: Int, gzipBody: ByteArray) =
      HttpRequest(
        url,
        mapOf(
          "Authorization" to authorization,
          "content-type" to "application/json",
          "content-encoding" to "gzip",
          "x-ouo-session-id" to sessionId,
          "x-ouo-seq" to seq.toString(),
        ),
        gzipBody,
      )
  }
}
