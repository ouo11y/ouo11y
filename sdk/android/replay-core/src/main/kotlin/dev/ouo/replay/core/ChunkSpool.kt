package dev.ouo.replay.core

import java.io.File
import java.io.FileOutputStream
import org.json.JSONArray
import org.json.JSONObject

/**
 * The open chunk on disk, so a crash, an ANR kill or a force stop mid-chunk loses nothing: the next
 * launch sends what was captured ([recover]), ending at its last frame or touch.
 *
 * One append-only JSON Lines file: the chunk header first, then one line per frame and one per
 * batch of touches. A line cut short by the crash fails to parse and is skipped. Written on the
 * compose thread; removed once the chunk was handed to the uploader. No age limit, like the queue it
 * goes to ([DiskQueue]): the wall clock may have moved since the chunk started. Same format as the
 * Swift `ChunkSpool` of `sdk/ios`.
 */
class ChunkSpool(val file: File) {
  data class Header(
    val sessionId: String,
    val seq: Int,
    val startedAt: EpochMillis,
    val viewport: Viewport,
    val platform: String,
    val masked: Boolean,
    val mode: String,
  )

  private var out: FileOutputStream? = null

  fun begin(header: Header) {
    close()
    runCatching {
      file.parentFile?.mkdirs()
      out = FileOutputStream(file, false)
      write(
        JSONObject().put(
          "header",
          JSONObject()
            .put("sessionId", header.sessionId)
            .put("seq", header.seq)
            .put("startedAt", header.startedAt)
            .put("viewport", header.viewport.toJson())
            .put("platform", header.platform)
            .put("masked", header.masked)
            .put("mode", header.mode),
        )
      )
    }
  }

  fun append(frame: Frame, viewport: Viewport) = write(JSONObject().put("frame", frame.toJson()).put("viewport", viewport.toJson()))

  fun append(touches: List<Touch>) {
    if (touches.isNotEmpty()) write(JSONObject().put("touches", JSONArray(touches.map { it.toJson() })))
  }

  /** The chunk was handed over (the uploader stored it): the file is no longer needed. */
  fun clear() {
    close()
    file.delete()
  }

  /**
   * The chunk the previous process left open, if it holds anything. Call before the first frame of this process. The file stays until [clear], which
   * the caller runs once the uploader stored the chunk. [crashSessionId] and [crashAt]: the
   * previous run's crash, so a chunk of that session ends there.
   */
  fun recover(now: EpochMillis = System.currentTimeMillis(), crashSessionId: String? = null, crashAt: EpochMillis? = null): FrameChunk? {
    close()
    val text = runCatching { file.readText() }.getOrNull() ?: return null
    var header: JSONObject? = null
    var viewport: Viewport? = null
    var frames = mutableListOf<Frame>()
    val touches = mutableListOf<Touch>()
    for (raw in text.split('\n')) {
      if (raw.isBlank()) continue
      val line = runCatching { JSONObject(raw) }.getOrNull() ?: continue
      line.optJSONObject("header")?.let { header = it }
      runCatching { line.optJSONObject("frame")?.let { frames.add(Frame.fromJson(it)) } }
      runCatching { line.optJSONObject("viewport")?.let { viewport = Viewport.fromJson(it) } }
      line.optJSONArray("touches")?.let { a -> for (i in 0 until a.length()) runCatching { touches.add(Touch.fromJson(a.getJSONObject(i))) } }
    }
    // Only the last line can be cut short, but never let a chunk start with a patch frame.
    frames = frames.dropWhile { !it.isFull }.toMutableList()
    val h = header
    val startedAt = h?.optLong("startedAt") ?: 0L
    if (h == null || (frames.isEmpty() && touches.isEmpty())) {
      clear()
      return null
    }
    val sessionId = h.getString("sessionId")
    var last = maxOf(frames.maxOfOrNull { it.ts } ?: 0L, touches.maxOfOrNull { it.ts } ?: 0L)
    if (crashAt != null && crashSessionId == sessionId && crashAt <= now) last = maxOf(last, crashAt)
    return FrameChunk(
      sessionId = sessionId,
      seq = h.getInt("seq"),
      startedAt = startedAt,
      endedAt = maxOf(last, startedAt),
      viewport = viewport ?: Viewport.fromJson(h.getJSONObject("viewport")),
      platform = h.optString("platform", "android"),
      mode = h.optString("mode", "session"),
      frames = frames,
      touches = touches,
      masked = h.optBoolean("masked", true),
    )
  }

  private fun write(line: JSONObject) {
    val o = out ?: return
    try {
      o.write((line.toString() + "\n").toByteArray(Charsets.UTF_8))
      o.flush()
    } catch (e: Exception) {
      // Disk full or file gone: stop spooling this chunk, the in-memory one still goes out.
      close()
    }
  }

  private fun close() {
    runCatching { out?.close() }
    out = null
  }
}
