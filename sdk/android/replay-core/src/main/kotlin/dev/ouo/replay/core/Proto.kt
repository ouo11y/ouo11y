package dev.ouo.replay.core

import java.security.MessageDigest
import org.json.JSONArray
import org.json.JSONObject

/**
 * The few protobuf wire types an OTLP logs request needs (ADR-0021 decision 5): varint,
 * length-delimited and fixed64. Hand-written so the replay envelope costs no dependency. Fields are
 * written in the order of the calls; callers write them in ascending field number. The Swift
 * `ProtoWriter` of `sdk/ios`, ported: both produce the same bytes (the golden vector).
 */
class ProtoWriter(initial: Int = 256) {
  private var buf = ByteArray(maxOf(16, initial))
  var size = 0
    private set

  private fun ensure(n: Int) {
    if (size + n <= buf.size) return
    buf = buf.copyOf(maxOf(buf.size * 2, size + n))
  }

  private fun rawVarint(value: Long) {
    ensure(10)
    var v = value
    while (v and 0x7fL.inv() != 0L) {
      buf[size++] = ((v and 0x7f) or 0x80).toByte()
      v = v ushr 7
    }
    buf[size++] = v.toByte()
  }

  private fun tag(field: Int, wire: Int) = rawVarint(((field shl 3) or wire).toLong())

  /** Wire type 0. Written even when zero: the caller decides what is omitted. */
  fun varint(field: Int, value: Long): ProtoWriter {
    tag(field, 0)
    rawVarint(value)
    return this
  }

  fun bool(field: Int, value: Boolean): ProtoWriter = varint(field, if (value) 1 else 0)

  /** Wire type 1, little endian. */
  fun fixed64(field: Int, value: Long): ProtoWriter {
    tag(field, 1)
    ensure(8)
    for (i in 0 until 8) buf[size++] = (value ushr (8 * i)).toByte()
    return this
  }

  fun double(field: Int, value: Double): ProtoWriter = fixed64(field, java.lang.Double.doubleToRawLongBits(value))

  /** Wire type 2. */
  fun bytes(field: Int, value: ByteArray): ProtoWriter {
    tag(field, 2)
    rawVarint(value.size.toLong())
    ensure(value.size)
    System.arraycopy(value, 0, buf, size, value.size)
    size += value.size
    return this
  }

  fun string(field: Int, value: String): ProtoWriter = bytes(field, value.toByteArray(Charsets.UTF_8))

  fun message(field: Int, value: ProtoWriter): ProtoWriter = bytes(field, value.toByteArray())

  fun toByteArray(): ByteArray = buf.copyOf(size)
}

/**
 * The resource and scope every record of a stream is sent under. [resource] values are a String,
 * a Boolean, a Long or a Double, written in list order.
 */
data class ReplayScope(val resource: List<Pair<String, Any>> = emptyList(), val scopeVersion: String = "", val schemaUrl: String = "") {
  fun toJson(): JSONObject {
    val attrs = JSONArray()
    for ((k, v) in resource) {
      val o = JSONObject().put("key", k)
      when (v) {
        is String -> o.put("s", v)
        is Boolean -> o.put("b", v)
        is Long -> o.put("i", v)
        is Int -> o.put("i", v.toLong())
        is Double -> o.put("d", v)
        else -> o.put("s", v.toString())
      }
      attrs.put(o)
    }
    return JSONObject().put("resource", attrs).put("scopeVersion", scopeVersion).put("schemaUrl", schemaUrl)
  }

  companion object {
    fun fromJson(o: JSONObject): ReplayScope {
      val out = ArrayList<Pair<String, Any>>()
      val attrs = o.optJSONArray("resource")
      if (attrs != null) {
        for (i in 0 until attrs.length()) {
          val a = attrs.optJSONObject(i) ?: continue
          val key = a.optString("key")
          if (key.isEmpty()) continue
          when {
            a.has("s") -> out.add(key to a.getString("s"))
            a.has("b") -> out.add(key to a.getBoolean("b"))
            a.has("i") -> out.add(key to a.getLong("i"))
            a.has("d") -> out.add(key to a.getDouble("d"))
          }
        }
      }
      return ReplayScope(out, o.optString("scopeVersion"), o.optString("schemaUrl"))
    }
  }
}

/** The attributes of one chunk record (client SDK spec 11.3). */
data class ReplayChunkMeta(
  val sessionId: String,
  val replayId: String,
  val streamId: String,
  val segmentIndex: Int,
  val sequence: Int,
  val keyframe: Boolean,
  val startTime: EpochMillis,
  val endTime: EpochMillis,
  val format: String,
  val encoding: String,
  val masked: Boolean,
  val mode: String,
  val trigger: String? = null,
  val viewId: String? = null,
)

/** The end record of a stream (client SDK spec 11.5). [lastSequence] null when the stream produced no chunk. */
data class ReplayEnded(
  val sessionId: String,
  val replayId: String,
  val streamId: String,
  /** `complete` or `partial`. */
  val endState: String,
  val lastSequence: Int?,
  val endReason: String,
)

/**
 * The OTLP/HTTP logs request of one replay record: one `ResourceLogs`, one `ScopeLogs` (scope
 * [SCOPE_NAME]), one `LogRecord`. Field numbers are those of opentelemetry-proto (`logs.proto`,
 * `common.proto`, `resource.proto`), written in ascending order; a zero int and a false bool are
 * written (a oneof has presence); severity is INFO with no text. The Swift `ReplayEnvelope`, ported.
 */
object ReplayEnvelope {
  const val SCOPE_NAME = "ouo.replay"
  const val CHUNK_EVENT = "ouo.replay.chunk"
  const val ENDED_EVENT = "ouo.replay.ended"
  const val SEVERITY_INFO = 9L

  private val DIGITS = "0123456789abcdef".toCharArray()

  fun hex(bytes: ByteArray): String {
    val out = CharArray(bytes.size * 2)
    for (i in bytes.indices) {
      val b = bytes[i].toInt() and 0xff
      out[2 * i] = DIGITS[b ushr 4]
      out[2 * i + 1] = DIGITS[b and 15]
    }
    return String(out)
  }

  /** Lowercase hex SHA-256 of the exact body bytes (RPL-12). */
  fun sha256Hex(bytes: ByteArray): String = hex(MessageDigest.getInstance("SHA-256").digest(bytes))

  /**
   * `ouo.replay.chunk`: the time is the chunk's start, the body the compressed bytes, the
   * attributes those of spec 11.3 in its order. `ouo.replay.ref` is the Collector's and is never
   * set (RPL-14). [observedTime] null: the chunk's start.
   */
  fun chunkRequest(scope: ReplayScope, meta: ReplayChunkMeta, body: ByteArray, observedTime: EpochMillis? = null): ByteArray {
    val a = ArrayList<Pair<String, Any>>(16)
    a.add("session.id" to meta.sessionId)
    a.add("ouo.replay.id" to meta.replayId)
    a.add("ouo.replay.stream.id" to meta.streamId)
    a.add("ouo.replay.segment.index" to meta.segmentIndex.toLong())
    a.add("ouo.replay.sequence" to meta.sequence.toLong())
    a.add("ouo.replay.keyframe" to meta.keyframe)
    a.add("ouo.replay.start_time" to meta.startTime)
    a.add("ouo.replay.end_time" to meta.endTime)
    a.add("ouo.replay.format" to meta.format)
    a.add("ouo.replay.encoding" to meta.encoding)
    a.add("ouo.replay.sha256" to sha256Hex(body))
    a.add("ouo.replay.byte_size" to body.size.toLong())
    a.add("ouo.replay.masked" to meta.masked)
    a.add("ouo.replay.mode" to meta.mode)
    meta.trigger?.let { a.add("ouo.replay.trigger" to it) }
    meta.viewId?.takeIf { it.isNotEmpty() }?.let { a.add("ouo.view.id" to it) }
    return request(scope, CHUNK_EVENT, meta.startTime, observedTime ?: meta.startTime, body, a)
  }

  /** `ouo.replay.ended`: the same envelope with no body. */
  fun endedRequest(scope: ReplayScope, ended: ReplayEnded, time: EpochMillis): ByteArray {
    val a = ArrayList<Pair<String, Any>>(6)
    a.add("session.id" to ended.sessionId)
    a.add("ouo.replay.id" to ended.replayId)
    a.add("ouo.replay.stream.id" to ended.streamId)
    a.add("ouo.replay.end_state" to ended.endState)
    ended.lastSequence?.let { a.add("ouo.replay.last_sequence" to it.toLong()) }
    a.add("ouo.replay.end_reason" to ended.endReason)
    return request(scope, ENDED_EVENT, time, time, null, a)
  }

  private fun nanos(ms: EpochMillis): Long = maxOf(0L, ms) * 1_000_000L

  private fun keyValue(key: String, value: Any): ProtoWriter {
    val v = ProtoWriter(32)
    when (value) {
      is String -> v.string(1, value)
      is Boolean -> v.bool(2, value)
      is Int -> v.varint(3, value.toLong())
      is Long -> v.varint(3, value)
      is Double -> v.double(4, value)
      is Float -> v.double(4, value.toDouble())
      else -> v.string(1, value.toString())
    }
    return ProtoWriter(48).string(1, key).message(2, v)
  }

  fun request(scope: ReplayScope, event: String, time: EpochMillis, observedTime: EpochMillis, body: ByteArray?, attributes: List<Pair<String, Any>>): ByteArray {
    val record = ProtoWriter(512 + (body?.size ?: 0))
    record.fixed64(1, nanos(time))
    record.varint(2, SEVERITY_INFO)
    if (body != null) record.message(5, ProtoWriter(body.size + 8).bytes(7, body))
    for ((k, v) in attributes) record.message(6, keyValue(k, v))
    record.fixed64(11, nanos(observedTime))
    record.string(12, event)

    val s = ProtoWriter(32).string(1, SCOPE_NAME)
    if (scope.scopeVersion.isNotEmpty()) s.string(2, scope.scopeVersion)
    val scopeLogs = ProtoWriter(record.size + 128).message(1, s).message(2, record)
    if (scope.schemaUrl.isNotEmpty()) scopeLogs.string(3, scope.schemaUrl)

    val resource = ProtoWriter(128)
    for ((k, v) in scope.resource) resource.message(1, keyValue(k, v))
    val resourceLogs = ProtoWriter(scopeLogs.size + resource.size + 32).message(1, resource).message(2, scopeLogs)
    return ProtoWriter(resourceLogs.size + 16).message(1, resourceLogs).toByteArray()
  }

  /**
   * `partial_success.rejected_log_records` of an `ExportLogsServiceResponse`. 0 for an empty,
   * absent or unreadable body: a 204 with no body is accepted.
   */
  fun rejectedLogRecords(response: ByteArray?): Long {
    if (response == null || response.isEmpty()) return 0
    return try {
      val partial = field(response, 1, 2) as? ByteArray ?: return 0
      maxOf(0L, (field(partial, 1, 0) as? Long) ?: 0L)
    } catch (e: Exception) {
      0
    }
  }

  /** The first occurrence of [number] with [wire] type in [message]: a Long (varint) or a ByteArray. Throws on a malformed message. */
  private fun field(message: ByteArray, number: Int, wire: Int): Any? {
    var i = 0
    fun varint(): Long {
      var shift = 0
      var out = 0L
      while (true) {
        val b = message[i++].toInt()
        out = out or ((b and 0x7f).toLong() shl shift)
        if (b and 0x80 == 0) return out
        shift += 7
        if (shift > 63) throw IllegalArgumentException("varint too long")
      }
    }
    while (i < message.size) {
      val tag = varint()
      val n = (tag ushr 3).toInt()
      when ((tag and 7).toInt()) {
        0 -> varint().let { if (n == number && wire == 0) return it }
        1 -> i += 8
        2 -> {
          val len = varint().toInt()
          if (len < 0 || i + len > message.size) throw IllegalArgumentException("bad length")
          if (n == number && wire == 2) return message.copyOfRange(i, i + len)
          i += len
        }
        5 -> i += 4
        else -> throw IllegalArgumentException("unsupported wire type")
      }
    }
    return null
  }
}
