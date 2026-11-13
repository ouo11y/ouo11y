package dev.ouo.replay.core

import java.io.File
import java.nio.file.Files
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertTrue

/**
 * A minimal protobuf reader, independent of [ProtoWriter], for the tests: it knows nothing of OTLP
 * beyond the field numbers the tests name.
 */
class Proto(private val bytes: ByteArray) {
  class Field(val number: Int, val wire: Int, val varint: Long, val data: ByteArray)

  val fields: List<Field> = run {
    val out = ArrayList<Field>()
    var i = 0
    fun varint(): Long {
      var shift = 0
      var v = 0L
      while (true) {
        val b = bytes[i++].toInt()
        v = v or ((b and 0x7f).toLong() shl shift)
        if (b and 0x80 == 0) return v
        shift += 7
      }
    }
    while (i < bytes.size) {
      val tag = varint()
      val number = (tag ushr 3).toInt()
      when (val wire = (tag and 7).toInt()) {
        0 -> out.add(Field(number, wire, varint(), ByteArray(0)))
        1 -> {
          var v = 0L
          for (k in 0 until 8) v = v or ((bytes[i + k].toLong() and 0xff) shl (8 * k))
          i += 8
          out.add(Field(number, wire, v, ByteArray(0)))
        }
        2 -> {
          val len = varint().toInt()
          out.add(Field(number, wire, 0, bytes.copyOfRange(i, i + len)))
          i += len
        }
        else -> error("wire type $wire")
      }
    }
    out
  }

  fun all(number: Int): List<Field> = fields.filter { it.number == number }

  fun one(number: Int): Field = all(number).single()

  fun message(number: Int): Proto = Proto(one(number).data)

  fun string(number: Int): String = String(one(number).data, Charsets.UTF_8)

  fun has(number: Int): Boolean = fields.any { it.number == number }
}

/** One decoded replay request: the single log record of the single scope of the single resource. */
class DecodedRecord(request: ByteArray) {
  private val resourceLogs = Proto(request).message(1)
  private val scopeLogs = resourceLogs.message(2)
  private val record = scopeLogs.message(2)

  val resource: Map<String, Any> = attributes(resourceLogs.message(1), 1)
  val scopeName: String = scopeLogs.message(1).string(1)
  val scopeVersion: String? = scopeLogs.message(1).let { if (it.has(2)) it.string(2) else null }
  val schemaUrl: String? = if (scopeLogs.has(3)) scopeLogs.string(3) else null
  val timeNanos: Long = record.one(1).varint
  val observedNanos: Long = record.one(11).varint
  val severity: Long = record.one(2).varint
  val hasSeverityText: Boolean = record.has(3)
  val eventName: String = record.string(12)
  val body: ByteArray? = if (record.has(5)) record.message(5).one(7).data else null
  val attributes: Map<String, Any> = attributes(record, 6)
  val attributeOrder: List<String> = record.all(6).map { Proto(it.data).string(1) }
  val fieldOrder: List<Int> = record.fields.map { it.number }

  fun string(key: String): String = attributes[key] as String

  fun long(key: String): Long = attributes[key] as Long

  fun bool(key: String): Boolean = attributes[key] as Boolean

  val sequence: Int get() = long("ouo.replay.sequence").toInt()
  val segment: Int get() = long("ouo.replay.segment.index").toInt()
  val keyframe: Boolean get() = bool("ouo.replay.keyframe")

  /** The decompressed body as its lines. */
  val lines: List<String> get() = String(Gzip.decompress(body!!), Charsets.UTF_8).split('\n').filter { it.isNotEmpty() }

  private fun attributes(message: Proto, field: Int): Map<String, Any> {
    val out = LinkedHashMap<String, Any>()
    for (kv in message.all(field)) {
      val p = Proto(kv.data)
      val v = p.message(2).fields.single()
      out[p.string(1)] = when (v.number) {
        1 -> String(v.data, Charsets.UTF_8)
        2 -> v.varint != 0L
        3 -> v.varint
        4 -> java.lang.Double.longBitsToDouble(v.varint)
        7 -> v.data
        else -> error("AnyValue field ${v.number}")
      }
    }
    return out
  }
}

/** Keeps what a stream hands over; can refuse or throw. */
class MemorySink(var accept: Boolean = true, var explode: Boolean = false) : ReplaySink {
  val requests = ArrayList<ByteArray>()
  val tags = ArrayList<Pair<String, Int?>>()

  @Synchronized
  override fun put(request: ByteArray, streamId: String, sequence: Int?): Boolean {
    if (explode) throw IllegalStateException("sink exploded")
    if (!accept) return false
    requests.add(request)
    tags.add(streamId to sequence)
    return true
  }

  val records: List<DecodedRecord> get() = synchronized(this) { requests.map { DecodedRecord(it) } }
  val chunks: List<DecodedRecord> get() = records.filter { it.eventName == ReplayEnvelope.CHUNK_EVENT }
  val ended: List<DecodedRecord> get() = records.filter { it.eventName == ReplayEnvelope.ENDED_EVENT }
}

/** The look of the stub format: its payload, or what the adapter should do wrong with it. */
class StubLook(val payload: String = "x", val fail: Throwable? = null, val raw: List<ReplayEvent>? = null) : ReplayLook

/** A format of the tests: one event per look, a keyframe when one was asked for. Proves the stream needs nothing of a real format (RPL-23). */
class StubAdapter(override val masked: Boolean = true) : ReplayFormatAdapter {
  override val formatId = "stub/1"
  var keyframeRequests = 0
  private var wantKeyframe = false
  var failCompress = false

  override fun requestKeyframe() {
    keyframeRequests++
    wantKeyframe = true
  }

  override fun events(look: ReplayLook, t: EpochMillis): List<ReplayEvent> {
    val l = look as? StubLook ?: throw ReplayFormatError(ReplayFormatError.Kind.WRONG_LOOK)
    l.fail?.let { throw it }
    l.raw?.let { return it }
    val key = wantKeyframe
    wantKeyframe = false
    return listOf(ReplayEvent(t, key, "{\"t\":$t,\"type\":\"${if (key) "key" else "delta"}\",\"p\":${ReplayJSON.string(l.payload)}}"))
  }

  override fun compress(payload: ByteArray): ByteArray {
    if (failCompress) throw IllegalStateException("compress failed")
    return super.compress(payload)
  }
}

object TestFiles {
  fun dir(name: String = "ouo-replay"): File = Files.createTempDirectory(name).toFile()

  /** Text gzip cannot shrink much: [n] random hex characters, the same for the same [seed]. */
  fun noise(n: Int, seed: Long): String {
    val r = java.util.Random(seed)
    val sb = StringBuilder(n)
    repeat(n) { sb.append("0123456789abcdef"[r.nextInt(16)]) }
    return sb.toString()
  }

  fun drain(d: ReplayDelivery) {
    val done = CountDownLatch(1)
    d.drain { done.countDown() }
    assertTrue(done.await(5, TimeUnit.SECONDS))
  }

  /** Waits for [condition] (the queue's threads finish their work asynchronously). */
  fun eventually(condition: () -> Boolean) {
    val until = System.currentTimeMillis() + 5000
    while (!condition()) {
      assertTrue("condition not met in 5 s", System.currentTimeMillis() < until)
      Thread.sleep(5)
    }
  }
}
