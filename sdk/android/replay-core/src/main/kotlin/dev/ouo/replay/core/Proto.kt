package dev.ouo.replay.core

import java.security.MessageDigest
import org.json.JSONObject

/**
 * The few protobuf wire types an OTLP logs request needs (ADR-0019, decision 5): varint,
 * length-delimited and fixed64. Hand-written so the replay envelope costs no dependency. Fields are
 * written in the order of the calls; callers write them in ascending field number.
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
 * The OTLP/HTTP logs request of one replay record (client SDK spec 11.3 and 11.5): one
 * `ResourceLogs`, one `ScopeLogs` (scope [SCOPE]), one `LogRecord`. Field numbers are those of
 * opentelemetry-proto v1.x (`logs.proto`, `common.proto`, `resource.proto`).
 */
object OtlpLogs {
  const val SCOPE = "ouo.replay"
  const val CHUNK_EVENT = "ouo.replay.chunk"
  const val ENDED_EVENT = "ouo.replay.ended"
  const val SEVERITY_INFO = 9L

  /** `AnyValue`: string 1, bool 2, int 3, double 4, bytes 7. A zero int and a false bool are written (a oneof has presence). */
  private fun anyValue(value: Any): ProtoWriter {
    val w = ProtoWriter(32)
    when (value) {
      is String -> w.string(1, value)
      is Boolean -> w.bool(2, value)
      is Int -> w.varint(3, value.toLong())
      is Long -> w.varint(3, value)
      is Double -> if (value.isFinite() && value == Math.rint(value) && Math.abs(value) < 9.007199254740992E15) w.varint(3, value.toLong()) else w.fixed64(4, java.lang.Double.doubleToRawLongBits(value))
      is Float -> w.fixed64(4, java.lang.Double.doubleToRawLongBits(value.toDouble()))
      is ByteArray -> w.bytes(7, value)
      else -> w.string(1, value.toString())
    }
    return w
  }

  private fun keyValue(key: String, value: Any): ProtoWriter = ProtoWriter(48).string(1, key).message(2, anyValue(value))

  /**
   * [body] null writes no body (the end record). Times are epoch milliseconds, sent as nanoseconds.
   * [resource] and [attributes] keep their order. An empty [scopeVersion] or [schemaUrl] is omitted
   * (proto3 default).
   */
  fun request(
    resource: List<Pair<String, Any>>,
    scopeVersion: String,
    schemaUrl: String,
    timeMs: Long,
    observedTimeMs: Long,
    eventName: String,
    body: ByteArray?,
    attributes: List<Pair<String, Any>>,
  ): ByteArray {
    val record = ProtoWriter(512 + (body?.size ?: 0))
    record.fixed64(1, timeMs * 1_000_000L)
    record.varint(2, SEVERITY_INFO)
    if (body != null) record.message(5, anyValue(body))
    for ((k, v) in attributes) record.message(6, keyValue(k, v))
    record.fixed64(11, observedTimeMs * 1_000_000L)
    record.string(12, eventName)

    val scope = ProtoWriter(32).string(1, SCOPE)
    if (scopeVersion.isNotEmpty()) scope.string(2, scopeVersion)
    val scopeLogs = ProtoWriter(record.size + 128).message(1, scope).message(2, record)
    if (schemaUrl.isNotEmpty()) scopeLogs.string(3, schemaUrl)

    val res = ProtoWriter(128)
    for ((k, v) in resource) res.message(1, keyValue(k, v))
    val resourceLogs = ProtoWriter(scopeLogs.size + res.size + 32).message(1, res).message(2, scopeLogs)
    return ProtoWriter(resourceLogs.size + 16).message(1, resourceLogs).toByteArray()
  }

  /**
   * `partial_success.rejected_log_records` of an `ExportLogsServiceResponse` (protobuf, or JSON when
   * the receiver answered so). 0 for an empty, absent or unreadable body: a 204 with no body is accepted.
   */
  fun rejectedLogRecords(body: ByteArray?): Long {
    if (body == null || body.isEmpty()) return 0
    return try {
      if (body[0] == '{'.code.toByte()) {
        val ps = JSONObject(String(body, Charsets.UTF_8)).optJSONObject("partialSuccess") ?: return 0
        ps.optString("rejectedLogRecords", "0").toLongOrNull() ?: 0
      } else {
        val partial = field(body, 1, 2) as? ByteArray ?: return 0
        (field(partial, 1, 0) as? Long) ?: 0
      }
    } catch (e: Exception) {
      0
    }
  }

  /** The last occurrence of [number] with [wire] type in [message]: a Long (varint) or a ByteArray. Throws on a malformed message. */
  private fun field(message: ByteArray, number: Int, wire: Int): Any? {
    var i = 0
    var found: Any? = null
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
        0 -> varint().let { if (n == number && wire == 0) found = it }
        1 -> i += 8
        2 -> {
          val len = varint().toInt()
          if (len < 0 || i + len > message.size) throw IllegalArgumentException("bad length")
          if (n == number && wire == 2) found = message.copyOfRange(i, i + len)
          i += len
        }
        5 -> i += 4
        else -> throw IllegalArgumentException("unsupported wire type")
      }
    }
    return found
  }
}

object Hex {
  private val DIGITS = "0123456789abcdef".toCharArray()

  fun of(bytes: ByteArray): String {
    val out = CharArray(bytes.size * 2)
    for (i in bytes.indices) {
      val b = bytes[i].toInt() and 0xff
      out[2 * i] = DIGITS[b ushr 4]
      out[2 * i + 1] = DIGITS[b and 15]
    }
    return String(out)
  }

  /** Lowercase hex SHA-256 (RPL-12). */
  fun sha256(bytes: ByteArray): String = of(MessageDigest.getInstance("SHA-256").digest(bytes))

  /** 128 random bits as 32 lowercase hex characters (replay and stream ids). */
  fun randomId(): String {
    val b = ByteArray(16)
    java.security.SecureRandom().nextBytes(b)
    return of(b)
  }

  fun isId(s: String?): Boolean = s != null && s.length == 32 && s.all { it in '0'..'9' || it in 'a'..'f' }
}
