package dev.ouo.replay.core

import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ReplayEnvelopeTest {
  private val scope = ReplayScope(listOf("service.name" to "golden"), "1.0.0", "https://opentelemetry.io/schemas/client-side-dev/0.1.0-dev")
  private val meta = ReplayChunkMeta(
    sessionId = "000102030405060708090a0b0c0d0e0f",
    replayId = "101112131415161718191a1b1c1d1e1f",
    streamId = "202122232425262728292a2b2c2d2e2f",
    segmentIndex = 0, sequence = 0, keyframe = true,
    startTime = 1_700_000_000_000, endTime = 1_700_000_005_000,
    format = "ouo-frames/3", encoding = "gzip", masked = true, mode = "session",
  )

  /** The request iOS produces for the same values (721 bytes): the two platforms are one wire. */
  private val golden =
    "0ace050a1a0a180a0c736572766963652e6e616d6512080a06676f6c64656e12af050a130a0a6f756f2e7265706c61791205312e302e3012db040900002a36fe9c971710092a083a06676f6c64656e32300a0a73657373696f6e2e696412220a20303030313032303330343035303630373038303930613062306330643065306632330a0d6f756f2e7265706c61792e696412220a203130313131323133313431353136313731383139316131623163316431653166323a0a146f756f2e7265706c61792e73747265616d2e696412220a203230323132323233323432353236323732383239326132623263326432653266321e0a186f756f2e7265706c61792e7365676d656e742e696e6465781202180032190a136f756f2e7265706c61792e73657175656e63651202180032190a136f756f2e7265706c61792e6b65796672616d651202100132200a156f756f2e7265706c61792e73746172745f74696d6512071880d095ffbc31321e0a136f756f2e7265706c61792e656e645f74696d6512071888f795ffbc3132230a116f756f2e7265706c61792e666f726d6174120e0a0c6f756f2d6672616d65732f33321d0a136f756f2e7265706c61792e656e636f64696e6712060a04677a697032570a116f756f2e7265706c61792e73686132353612420a4064643536646534313337393531643963393236383162303334313665633135663838366234343832613237653361353137643332663038353234346362653564321a0a146f756f2e7265706c61792e627974655f73697a651202180632170a116f756f2e7265706c61792e6d61736b656412021001321c0a0f6f756f2e7265706c61792e6d6f646512090a0773657373696f6e5900002a36fe9c971762106f756f2e7265706c61792e6368756e6b1a3a68747470733a2f2f6f70656e74656c656d657472792e696f2f736368656d61732f636c69656e742d736964652d6465762f302e312e302d646576"

  @Test
  fun goldenChunkRequestEqualsTheIosBytes() {
    val request = ReplayEnvelope.chunkRequest(scope, meta, "golden".toByteArray(Charsets.US_ASCII))
    val hex = ReplayEnvelope.hex(request)
    println("golden ouo.replay.chunk request (${request.size} bytes): $hex")
    assertEquals(721, request.size)
    assertEquals(golden, hex)
  }

  @Test
  fun goldenRequestDecodesWithAnIndependentReader() {
    val r = DecodedRecord(ReplayEnvelope.chunkRequest(scope, meta, "golden".toByteArray(Charsets.US_ASCII)))
    assertEquals(mapOf<String, Any>("service.name" to "golden"), r.resource)
    assertEquals("ouo.replay", r.scopeName)
    assertEquals("1.0.0", r.scopeVersion)
    assertEquals("https://opentelemetry.io/schemas/client-side-dev/0.1.0-dev", r.schemaUrl)
    assertEquals(1_700_000_000_000L * 1_000_000, r.timeNanos)
    assertEquals(r.timeNanos, r.observedNanos)
    assertEquals(9L, r.severity)
    assertFalse(r.hasSeverityText)
    assertEquals("ouo.replay.chunk", r.eventName)
    assertArrayEquals("golden".toByteArray(), r.body)
    // Fields in ascending number: time, severity, body, attributes, observed time, event name.
    assertEquals(listOf(1, 2, 5) + List(14) { 6 } + listOf(11, 12), r.fieldOrder)
    assertEquals(
      listOf(
        "session.id", "ouo.replay.id", "ouo.replay.stream.id", "ouo.replay.segment.index", "ouo.replay.sequence", "ouo.replay.keyframe",
        "ouo.replay.start_time", "ouo.replay.end_time", "ouo.replay.format", "ouo.replay.encoding", "ouo.replay.sha256", "ouo.replay.byte_size",
        "ouo.replay.masked", "ouo.replay.mode",
      ),
      r.attributeOrder,
    )
    assertEquals("000102030405060708090a0b0c0d0e0f", r.string("session.id"))
    assertEquals("101112131415161718191a1b1c1d1e1f", r.string("ouo.replay.id"))
    assertEquals("202122232425262728292a2b2c2d2e2f", r.string("ouo.replay.stream.id"))
    // Zero-valued ints are written, not left out.
    assertEquals(0L, r.long("ouo.replay.segment.index"))
    assertEquals(0L, r.long("ouo.replay.sequence"))
    assertTrue(r.bool("ouo.replay.keyframe"))
    assertEquals(1_700_000_000_000L, r.long("ouo.replay.start_time"))
    assertEquals(1_700_000_005_000L, r.long("ouo.replay.end_time"))
    assertEquals("ouo-frames/3", r.string("ouo.replay.format"))
    assertEquals("gzip", r.string("ouo.replay.encoding"))
    // SHA-256 of the 6 body bytes, lowercase hex (RPL-12), computed here with the JDK.
    assertEquals("dd56de4137951d9c92681b03416ec15f886b4482a27e3a517d32f085244cbe5d", r.string("ouo.replay.sha256"))
    assertEquals(6L, r.long("ouo.replay.byte_size"))
    assertTrue(r.bool("ouo.replay.masked"))
    assertEquals("session", r.string("ouo.replay.mode"))
    assertFalse("the SDK never sets ouo.replay.ref (RPL-14)", r.attributes.containsKey("ouo.replay.ref"))
  }

  @Test
  fun bufferChunkCarriesTriggerAndViewAndFalseValues() {
    val m = meta.copy(segmentIndex = 3, sequence = 41, keyframe = false, masked = false, mode = "buffer", trigger = "error", viewId = "v-1")
    val r = DecodedRecord(ReplayEnvelope.chunkRequest(scope, m, byteArrayOf(1, 2, 3), observedTime = 1_700_000_009_000))
    assertEquals(3, r.segment)
    assertEquals(41, r.sequence)
    assertFalse(r.keyframe)
    assertFalse(r.bool("ouo.replay.masked"))
    assertEquals("buffer", r.string("ouo.replay.mode"))
    assertEquals("error", r.string("ouo.replay.trigger"))
    assertEquals("v-1", r.string("ouo.view.id"))
    assertEquals(listOf("ouo.replay.trigger", "ouo.view.id"), r.attributeOrder.takeLast(2))
    assertEquals(1_700_000_009_000L * 1_000_000, r.observedNanos)
  }

  @Test
  fun endedRecordHasNoBodyAndItsAttributes() {
    val e = ReplayEnded(meta.sessionId, meta.replayId, meta.streamId, "partial", 7, "background_kill")
    val r = DecodedRecord(ReplayEnvelope.endedRequest(scope, e, 1_700_000_010_000))
    assertEquals("ouo.replay.ended", r.eventName)
    assertEquals("ouo.replay", r.scopeName)
    assertNull(r.body)
    assertEquals(listOf("session.id", "ouo.replay.id", "ouo.replay.stream.id", "ouo.replay.end_state", "ouo.replay.last_sequence", "ouo.replay.end_reason"), r.attributeOrder)
    assertEquals("partial", r.string("ouo.replay.end_state"))
    assertEquals(7L, r.long("ouo.replay.last_sequence"))
    assertEquals("background_kill", r.string("ouo.replay.end_reason"))
    // No chunk was produced: no last_sequence.
    val none = DecodedRecord(ReplayEnvelope.endedRequest(scope, e.copy(lastSequence = null, endState = "complete"), 1))
    assertFalse(none.attributes.containsKey("ouo.replay.last_sequence"))
  }

  @Test
  fun resourceValuesKeepTheirTypesAndEmptyScopeFieldsAreLeftOut() {
    val s = ReplayScope(listOf("a" to "x", "b" to true, "c" to 7L, "d" to 1.5))
    val r = DecodedRecord(ReplayEnvelope.chunkRequest(s, meta, byteArrayOf(0)))
    assertEquals(mapOf<String, Any>("a" to "x", "b" to true, "c" to 7L, "d" to 1.5), r.resource)
    assertNull(r.scopeVersion)
    assertNull(r.schemaUrl)
    assertEquals(s, ReplayScope.fromJson(JSONObject(s.toJson().toString())))
  }

  @Test
  fun readsPartialSuccessFromTheAnswer() {
    assertEquals(0L, ReplayEnvelope.rejectedLogRecords(null))
    assertEquals(0L, ReplayEnvelope.rejectedLogRecords(ByteArray(0)))
    val partial = ProtoWriter().varint(1, 1).string(2, "quota")
    assertEquals(1L, ReplayEnvelope.rejectedLogRecords(ProtoWriter().message(1, partial).toByteArray()))
    assertEquals(0L, ReplayEnvelope.rejectedLogRecords(ProtoWriter().message(1, ProtoWriter().string(2, "warning only")).toByteArray()))
    // Garbage is not a rejection: the status decided.
    assertEquals(0L, ReplayEnvelope.rejectedLogRecords(byteArrayOf(-1, -1, -1, -1)))
    assertEquals(0L, ReplayEnvelope.rejectedLogRecords("<html>ok</html>".toByteArray()))
  }

  @Test
  fun pixelFramesEventsAreOneJsonObjectPerLine() {
    val full = PixelFrames.event(Frame.full(1000, byteArrayOf(-1, -40, -1), FrameReason.RESUME), 540, 1200, 1.5)
    assertTrue(full.keyframe)
    val f = JSONObject(String(full.json))
    assertEquals(listOf(1000L, "frame", 540, 1200, 1.5, "resume", "/9j/"), listOf(f.getLong("t"), f.getString("type"), f.getInt("w"), f.getInt("h"), f.getDouble("scale"), f.getString("reason"), f.getString("jpeg")))
    assertEquals("{\"t\":1000,\"type\":\"frame\",\"w\":540,\"h\":1200,\"scale\":1.50,\"reason\":\"resume\",\"jpeg\":\"/9j/\"}", String(full.json))
    val patch = PixelFrames.event(Frame.patches(2000, listOf(Patch(PixelRect(64, 128, 64, 64), byteArrayOf(1))), FrameReason.TIMER), 540, 1200, 1.5)
    assertFalse(patch.keyframe)
    assertEquals("{\"t\":2000,\"type\":\"patch\",\"reason\":\"timer\",\"patches\":[{\"x\":64,\"y\":128,\"w\":64,\"h\":64,\"jpeg\":\"AQ==\"}]}", String(patch.json))
    // Touches are points of the viewport, like the frame's pixels divided by its scale.
    val touch = StubAdapter().touchEvent(Touch(3000, 10.0, 20.456, TouchPhase.BEGAN))!!
    assertEquals("{\"t\":3000,\"type\":\"touch\",\"x\":10,\"y\":20.46,\"phase\":\"began\"}", String(touch.json))
    assertEquals("0", ReplayJSON.number(Double.NaN))
    assertEquals("\"a\\nb\\u2028\\\"\"", ReplayJSON.string("a\nb \""))
    // A quality the encoder would throw on is brought into range.
    assertEquals(listOf(100, 1, 50), listOf(1000, -5, 50).map { PixelFrames.jpegQuality(it) })
  }
}
