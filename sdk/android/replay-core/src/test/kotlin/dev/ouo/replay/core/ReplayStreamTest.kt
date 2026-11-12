package dev.ouo.replay.core

import java.io.File
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ReplayStreamTest {
  private val scope = ReplayScope(listOf("service.name" to "test"), "1.0.0", "https://example.test/schema")
  private var clock = 1_000_000L

  private fun stream(
    sink: ReplaySink,
    config: ReplayStreamConfig = ReplayStreamConfig(),
    adapter: ReplayFormatAdapter = StubAdapter(),
    store: ReplayStateStore? = null,
    replayId: String? = null,
  ) = ReplayStream("sess-1", replayId, scope, config, adapter, sink, store, now = { clock })

  @Test
  fun idsAndFirstChunk() {
    val sink = MemorySink()
    val given = "abcdef0123456789abcdef0123456789"
    val s = stream(sink, replayId = given)
    assertEquals(given, s.replayId)
    assertTrue(ReplayStream.isValidId(s.streamId))
    assertNotEquals(s.streamId, stream(sink).streamId)
    // Not 32 lowercase hex, or all zero: a fresh id.
    for (bad in listOf("ABCDEF0123456789ABCDEF0123456789", "short", "0".repeat(32))) assertNotEquals(bad, stream(sink, replayId = bad).replayId)

    s.look(StubLook("a"), 1000)
    s.look(StubLook("b"), 2000)
    assertEquals("nothing is sent before the chunk closes", 0, sink.requests.size)
    s.tick(6000)
    val c = sink.chunks.single()
    assertEquals(listOf(0, 0, true), listOf(c.segment, c.sequence, c.keyframe))
    assertEquals(listOf(1000L, 2000L), listOf(c.long("ouo.replay.start_time"), c.long("ouo.replay.end_time")))
    assertEquals(1000L * 1_000_000, c.timeNanos)
    assertEquals("sess-1", c.string("session.id"))
    assertEquals(given, c.string("ouo.replay.id"))
    assertEquals(s.streamId, c.string("ouo.replay.stream.id"))
    assertEquals("stub/1", c.string("ouo.replay.format"))
    assertEquals("session", c.string("ouo.replay.mode"))
    assertFalse(c.attributes.containsKey("ouo.replay.trigger"))
    assertEquals(mapOf<String, Any>("service.name" to "test"), c.resource)
    assertEquals(2, c.lines.size)
    assertTrue(c.lines[0].contains("\"type\":\"key\""))
  }

  @Test
  fun sequenceNeverResetsAndSegmentsStartWithKeyframes() {
    val sink = MemorySink()
    val adapter = StubAdapter()
    val s = stream(sink, ReplayStreamConfig(keyframeIntervalMs = 60_000), adapter)
    s.look(StubLook(), 1000)
    s.touch(Touch(1500, 1.0, 2.0, TouchPhase.BEGAN))
    s.tick(6500) // older than chunkMaxMs: chunk 0 closes
    s.look(StubLook(), 7000) // opens chunk 1 of the same segment
    s.markGap() // a capture gap: the next look starts a segment (RPL-8)
    s.look(StubLook(), 8000)
    s.background() // RPL-10: the chunk closes; RPL-9: the return starts a segment
    s.look(StubLook(), 9000)
    s.look(StubLook(), 70_000) // keyframeIntervalMs passed since the segment started
    s.flush()
    val cs = sink.chunks
    assertEquals(listOf(0, 1, 2, 3, 4), cs.map { it.sequence })
    assertEquals(listOf(0, 0, 1, 2, 3), cs.map { it.segment })
    assertEquals(listOf(true, false, true, true, true), cs.map { it.keyframe })
    // Every segment decodes alone: its first line is a keyframe.
    for (c in cs.filter { it.keyframe }) assertTrue(c.lines.first().contains("\"type\":\"key\""))
    assertEquals(listOf("{\"t\":1500,\"type\":\"touch\",\"x\":1,\"y\":2,\"phase\":\"began\"}"), cs[0].lines.drop(1))
    assertEquals(5, s.producedChunks)
    assertEquals(5, s.stats.chunks)
  }

  @Test
  fun eventsBeforeTheKeyframeAreDropped() {
    val sink = MemorySink()
    val s = stream(sink)
    s.touch(Touch(900, 1.0, 1.0, TouchPhase.BEGAN)) // nothing to draw it over yet
    s.look(StubLook(), 1000)
    s.flush()
    assertEquals(1, s.stats.eventsDropped)
    assertEquals(1, sink.chunks.single().lines.size)
  }

  @Test
  fun closesAtChunkMaxBytesAndCompressesOnce() {
    val sink = MemorySink()
    val s = stream(sink, ReplayStreamConfig(chunkMaxBytes = 4096))
    for (i in 0 until 6) s.look(StubLook(TestFiles.noise(3000, i.toLong())), 1000L + i)
    assertTrue("closed by size, without a tick", sink.chunks.isNotEmpty())
    s.flush()
    val cs = sink.chunks
    assertTrue(cs.size >= 2)
    for (c in cs) {
      val body = c.body!!
      assertTrue("hard limit", body.size <= ReplayStreamConfig.HARD_LIMIT_BYTES)
      assertEquals(ReplayEnvelope.sha256Hex(body), c.string("ouo.replay.sha256"))
      assertEquals(body.size.toLong(), c.long("ouo.replay.byte_size"))
      assertEquals("gzip", c.string("ouo.replay.encoding"))
      val plain = Gzip.decompress(body)
      // One gzip: what is inside is the NDJSON itself, not another gzip stream.
      assertEquals('{'.code.toByte(), plain[0])
      assertEquals('\n'.code.toByte(), plain[plain.size - 1])
    }
    // All six looks arrive, in order, across the chunks.
    assertEquals((0 until 6).map { 1000L + it }, cs.flatMap { it.lines }.map { org.json.JSONObject(it).getLong("t") })
  }

  @Test
  fun aBodyOverTheHardLimitIsSplitNeverTruncated() {
    val sink = MemorySink()
    val s = stream(sink, ReplayStreamConfig(chunkMaxBytes = 2048, hardLimitBytes = 2048))
    val big = TestFiles.noise(20_000, 7)
    s.look(StubLook(big), 1000)
    s.look(StubLook("small"), 1100)
    s.flush()
    val cs = sink.chunks
    assertTrue("split in several chunks: ${cs.size}", cs.size > 4)
    assertTrue(s.stats.splits > 0)
    assertEquals(cs.indices.toList(), cs.map { it.sequence })
    assertEquals("one segment", setOf(0), cs.map { it.segment }.toSet())
    assertEquals("only the first chunk is the keyframe chunk", listOf(true) + List(cs.size - 1) { false }, cs.map { it.keyframe })
    for (c in cs) assertTrue(c.body!!.size <= 2048)
    // Each body decompresses on its own, and together they are the payload, byte for byte (RPL-7).
    val joined = cs.map { Gzip.decompress(it.body!!) }.reduce { a, b -> a + b }
    val expected = "{\"t\":1000,\"type\":\"key\",\"p\":\"$big\"}\n{\"t\":1100,\"type\":\"delta\",\"p\":\"small\"}\n"
    assertArrayEquals(expected.toByteArray(), joined)
  }

  @Test
  fun bufferRingKeepsWholeSegmentsAndItsKeyframe() {
    val sink = MemorySink()
    val s = stream(sink, ReplayStreamConfig(mode = ReplayCaptureMode.BUFFER, bufferSeconds = 20.0))
    for (i in 0..100) {
      val t = 1_000_000L + i * 1000
      clock = t
      s.look(StubLook("f$i"), t)
      s.tick(t)
    }
    assertEquals("nothing leaves the device before a trigger", 0, sink.requests.size)
    assertTrue(s.bufferedChunks > 0)
    assertTrue(s.stats.ringEvictedSegments > 0)
    assertEquals(0, s.producedChunks)

    val last = 1_000_000L + 100 * 1000
    val flushed = s.capture(ReplayTrigger.ERROR)!!
    val cs = sink.chunks
    assertEquals(flushed, cs.size)
    // Numbered from 0 at the trigger; the first chunk starts a segment with its keyframe.
    assertEquals(cs.indices.toList(), cs.map { it.sequence })
    assertEquals(listOf(0, true), listOf(cs[0].segment, cs[0].keyframe))
    assertTrue(cs[0].lines.first().contains("\"type\":\"key\""))
    // At least the last 20 s are there, and not much more than five quarters of it.
    val first = cs[0].long("ouo.replay.start_time")
    assertTrue("covers the window: ${last - first} ms", last - first >= 20_000)
    assertTrue("bounded: ${last - first} ms", last - first <= 31_000)
    // Whole segments: the index rises exactly at keyframe chunks.
    var index = -1
    for (c in cs) {
      if (c.keyframe) index++
      assertEquals(index, c.segment)
    }
    for (c in cs) assertEquals(listOf("buffer", "error"), listOf(c.string("ouo.replay.mode"), c.string("ouo.replay.trigger")))
    assertNull("a second trigger has nothing to do", s.capture(ReplayTrigger.MANUAL))

    // Recording goes on as a session: sent as chunks close, still marked buffer and with the trigger.
    clock = last + 1000
    s.look(StubLook("after"), last + 1000)
    s.tick(last + 7000)
    val after = sink.chunks.last()
    assertEquals(cs.size, after.sequence)
    assertEquals(listOf("buffer", "error"), listOf(after.string("ouo.replay.mode"), after.string("ouo.replay.trigger")))
    s.end(ReplayEndReason.SESSION_END)
    val ended = sink.ended.single()
    assertEquals(listOf("complete", "session_end"), listOf(ended.string("ouo.replay.end_state"), ended.string("ouo.replay.end_reason")))
    assertEquals(sink.chunks.size - 1L, ended.long("ouo.replay.last_sequence"))
  }

  @Test
  fun anUntriggeredBufferEndsSilentlyAndItsRingIsBounded() {
    val sink = MemorySink()
    val store = FileReplayStateStore(File(TestFiles.dir(), "open-stream.json"))
    val s = stream(sink, ReplayStreamConfig(mode = ReplayCaptureMode.BUFFER, bufferSeconds = 3600.0, ringMaxBytes = 1 shl 16), store = store)
    for (i in 0..400) {
      val t = 1_000_000L + i * 1000
      s.look(StubLook(TestFiles.noise(2000, i.toLong())), t)
      s.tick(t)
    }
    assertTrue("memory bound holds whatever the window says", s.stats.ringEvictedSegments > 0)
    assertFalse("an untriggered ring never reaches the disk", store.file.exists())
    s.end(ReplayEndReason.STOP)
    assertEquals(0, sink.requests.size)
    assertFalse(s.isActive)
  }

  @Test
  fun endedIsCompleteOnlyWhenNothingWasLost() {
    val dir = TestFiles.dir()
    val store = FileReplayStateStore(File(dir, "open-stream.json"))
    val sink = MemorySink()
    val s = stream(sink, store = store)
    s.setViewId("checkout")
    s.look(StubLook(), 1000)
    s.tick(7000)
    s.look(StubLook(), 8000)
    assertEquals(0, store.load()!!.lastSequence)
    s.end(ReplayEndReason.STOP)
    val ended = sink.ended.single()
    assertEquals(listOf("complete", "stop", 1L), listOf(ended.string("ouo.replay.end_state"), ended.string("ouo.replay.end_reason"), ended.long("ouo.replay.last_sequence")))
    assertEquals("sess-1", ended.string("session.id"))
    assertEquals(s.replayId, ended.string("ouo.replay.id"))
    assertEquals(s.streamId, ended.string("ouo.replay.stream.id"))
    assertNull(ended.body)
    assertEquals("checkout", sink.chunks[0].string("ouo.view.id"))
    assertNull("an ended stream leaves no open state", store.load())
    // Later calls do nothing.
    s.end(ReplayEndReason.ERROR)
    s.look(StubLook(), 9000)
    s.flush()
    assertEquals(3, sink.requests.size)

    // A chunk the queue lost after taking it: partial, and a new segment before more is sent.
    val sink2 = MemorySink()
    val s2 = stream(sink2)
    s2.look(StubLook(), 1000)
    s2.tick(7000)
    s2.chunkLost("another-stream")
    assertFalse(s2.isPartial)
    s2.chunkLost(s2.streamId)
    assertTrue(s2.isPartial)
    s2.look(StubLook(), 8000)
    s2.end(ReplayEndReason.SESSION_END)
    assertEquals(listOf(0, 1), sink2.chunks.map { it.segment })
    assertEquals(listOf(0, 1), sink2.chunks.map { it.sequence })
    assertEquals("partial", sink2.ended.single().string("ouo.replay.end_state"))
    assertEquals(1, s2.stats.lost)

    // No chunk at all: an end record without last_sequence.
    val sink3 = MemorySink()
    stream(sink3).end(ReplayEndReason.CONSENT)
    assertFalse(sink3.ended.single().attributes.containsKey("ouo.replay.last_sequence"))
    assertEquals("consent", sink3.ended.single().string("ouo.replay.end_reason"))
  }

  @Test
  fun aKilledStreamIsEndedPartialByTheNextLaunch() {
    val store = FileReplayStateStore(File(TestFiles.dir(), "open-stream.json"))
    val sink = MemorySink()
    val s = stream(sink, store = store)
    s.look(StubLook(), 1000)
    s.tick(7000)
    s.look(StubLook(), 8000)
    s.tick(14_000)
    // The process dies here: no end record.
    assertEquals(0, sink.ended.size)

    val next = MemorySink()
    assertTrue(ReplayStream.endOpenStream(FileReplayStateStore(store.file), next, ReplayEndReason.CRASH, now = 99_000))
    val ended = next.ended.single()
    assertEquals(listOf("partial", "crash", 1L), listOf(ended.string("ouo.replay.end_state"), ended.string("ouo.replay.end_reason"), ended.long("ouo.replay.last_sequence")))
    assertEquals(listOf("sess-1", s.replayId, s.streamId), listOf(ended.string("session.id"), ended.string("ouo.replay.id"), ended.string("ouo.replay.stream.id")))
    // Under the resource and scope the stream was recorded with.
    assertEquals(mapOf<String, Any>("service.name" to "test"), ended.resource)
    assertEquals("1.0.0", ended.scopeVersion)
    assertEquals(99_000L * 1_000_000, ended.timeNanos)
    assertEquals(next.tags.single(), s.streamId to null)
    // Once.
    assertFalse(ReplayStream.endOpenStream(FileReplayStateStore(store.file), next))
    // A store that refuses keeps the state for the launch after.
    val s2 = stream(MemorySink(), store = store)
    s2.look(StubLook(), 1000)
    s2.tick(7000)
    assertFalse(ReplayStream.endOpenStream(store, MemorySink(accept = false)))
    assertEquals(s2.streamId, store.load()!!.streamId)
    // Unreadable state is dropped, not tripped over.
    store.file.writeText("{not json")
    assertFalse(ReplayStream.endOpenStream(store, next))
    assertFalse(store.file.exists())
  }

  @Test
  fun abandonSendsNothingAndForgets() {
    val store = FileReplayStateStore(File(TestFiles.dir(), "open-stream.json"))
    val sink = MemorySink()
    val s = stream(sink, store = store)
    s.look(StubLook(), 1000)
    s.tick(7000)
    s.look(StubLook(), 8000)
    s.abandon()
    assertEquals("the chunk already handed over stays; nothing more, no end record", 1, sink.requests.size)
    assertFalse(s.isActive)
    assertNull(store.load())
  }

  @Test
  fun configBringsAbsurdValuesIntoRange() {
    val c = ReplayStreamConfig(bufferSeconds = Double.NaN, keyframeIntervalMs = -5, chunkMaxBytes = Int.MAX_VALUE, chunkMaxMs = 0, ringMaxBytes = -1, maxEventBytes = 0, selfDisableThreshold = -3)
    assertEquals(60.0, c.bufferSeconds, 0.0)
    assertEquals(1000L, c.keyframeIntervalMs)
    assertEquals(ReplayStreamConfig.HARD_LIMIT_BYTES, c.chunkMaxBytes)
    assertEquals(100L, c.chunkMaxMs)
    assertEquals(1 shl 16, c.ringMaxBytes)
    assertEquals(1024, c.maxEventBytes)
    assertEquals(1, c.selfDisableThreshold)
    assertEquals(15_000L, ReplayStreamConfig(bufferSeconds = 60.0).ringSegmentMs)
  }
}
