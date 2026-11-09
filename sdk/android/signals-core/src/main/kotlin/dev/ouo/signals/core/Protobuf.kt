package dev.ouo.signals.core

/**
 * The few protobuf wire-format reads the tombstone needs (no protobuf runtime in an app's SDK):
 * varints, length-delimited fields as nested readers, and skipping everything else. Every read is
 * bounds-checked and throws [IllegalArgumentException] on a malformed input, which the caller treats
 * as "no tombstone".
 */
internal class ProtoReader(private val buf: ByteArray, private var pos: Int = 0, private val end: Int = buf.size) {
  init {
    require(pos in 0..end && end <= buf.size) { "bad bounds" }
  }

  val done: Boolean get() = pos >= end

  /** The next field's tag: `number shl 3 or wireType`. */
  fun tag(): Int {
    val t = varint()
    require(t in 1..Int.MAX_VALUE.toLong()) { "bad tag" }
    return t.toInt()
  }

  fun varint(): Long {
    var result = 0L
    var shift = 0
    while (shift < 64) {
      require(pos < end) { "truncated varint" }
      val b = buf[pos++].toInt()
      result = result or ((b and 0x7f).toLong() shl shift)
      if (b and 0x80 == 0) return result
      shift += 7
    }
    throw IllegalArgumentException("varint too long")
  }

  /** A length-delimited field's bytes, as a reader over them. */
  fun message(): ProtoReader {
    val len = varint()
    require(len >= 0 && len <= end - pos) { "truncated field" }
    val r = ProtoReader(buf, pos, pos + len.toInt())
    pos += len.toInt()
    return r
  }

  fun string(): String {
    val len = varint()
    require(len >= 0 && len <= end - pos) { "truncated string" }
    val s = String(buf, pos, len.toInt(), Charsets.UTF_8)
    pos += len.toInt()
    return s
  }

  fun skip(wireType: Int) {
    when (wireType) {
      WIRE_VARINT -> varint()
      WIRE_FIXED64 -> advance(8)
      WIRE_LEN -> message()
      WIRE_FIXED32 -> advance(4)
      else -> throw IllegalArgumentException("unsupported wire type $wireType")
    }
  }

  private fun advance(n: Int) {
    require(n <= end - pos) { "truncated fixed field" }
    pos += n
  }

  /**
   * Reads every field: [onField] gets the field number and wire type and either consumes the
   * field and returns true, or returns false and the field is skipped.
   */
  inline fun fields(onField: (number: Int, wireType: Int) -> Boolean) {
    while (!done) {
      val t = tag()
      val wire = t and 7
      if (!onField(t ushr 3, wire)) skip(wire)
    }
  }

  companion object {
    const val WIRE_VARINT = 0
    const val WIRE_FIXED64 = 1
    const val WIRE_LEN = 2
    const val WIRE_FIXED32 = 5
  }
}
