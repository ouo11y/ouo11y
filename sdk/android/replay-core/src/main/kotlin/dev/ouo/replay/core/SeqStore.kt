package dev.ouo.replay.core

import java.io.File
import org.json.JSONObject

/**
 * Hands out monotonic chunk sequence numbers per session. `seq` starts at 0 for a new session id
 * and persists across app restarts within the same session (docs/specs/mobile-replay.md).
 */
interface SeqStore {
  /** Reserves and returns the next seq for [sessionId]; a different id than the last one restarts at 0. */
  fun next(sessionId: String): Int

  /** Forces the next seq for [sessionId] to be 0. */
  fun reset(sessionId: String)
}

class InMemorySeqStore : SeqStore {
  private var sessionId: String? = null
  private var seq = 0

  @Synchronized
  override fun next(sessionId: String): Int {
    if (this.sessionId != sessionId) {
      this.sessionId = sessionId
      seq = 0
    }
    return seq++
  }

  @Synchronized
  override fun reset(sessionId: String) {
    this.sessionId = sessionId
    seq = 0
  }
}

/** `{"session_id": ..., "seq": n}` in one small file, written atomically (temp file and rename). */
class FileSeqStore(private val file: File) : SeqStore {
  @Synchronized
  override fun next(sessionId: String): Int {
    val stored = runCatching { JSONObject(file.readText()) }.getOrNull()
    val seq = if (stored?.optString("session_id") == sessionId) stored.optInt("seq", 0) else 0
    write(sessionId, seq + 1)
    return seq
  }

  @Synchronized
  override fun reset(sessionId: String) = write(sessionId, 0)

  private fun write(sessionId: String, seq: Int) {
    runCatching {
      file.parentFile?.mkdirs()
      val tmp = File(file.path + ".tmp")
      tmp.writeText(JSONObject().put("session_id", sessionId).put("seq", seq).toString())
      if (!tmp.renameTo(file)) tmp.delete()
    }
  }
}
