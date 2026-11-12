package dev.ouo.replay.core

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** A fake encoder: a "file" is `mp4:` and the frames of its slots, so the tests read what each slot showed. */
class FakeMp4 : VideoSegmenter.Encoder<String> {
  var slots: MutableList<String>? = null
  val released = ArrayList<String>()
  var aborted = 0
  var failOn: String? = null

  override fun begin(first: String) {
    slots = ArrayList()
  }

  override fun encode(frame: String) {
    if (frame == failOn) throw IllegalStateException("codec")
    (slots ?: error("not begun")).add(frame)
  }

  override fun finish(): ByteArray? {
    val s = slots ?: return null
    slots = null
    return ("mp4:" + s.joinToString(",")).toByteArray()
  }

  override fun abort() {
    slots = null
    aborted++
  }

  override fun release(frame: String) {
    released.add(frame)
  }
}

private fun ReplayEvent.text() = String(json, Charsets.UTF_8)

class VideoSegmenterTest {
  @Test
  fun slotsShowTheNewestFrameAndSegmentsCarryTheFrameOnScreen() {
    val enc = FakeMp4()
    val v = VideoSegmenter(enc)
    assertTrue(v.add("a", 10_000).isEmpty())
    assertTrue(v.add("b", 10_400).isEmpty()) // same slot: b replaces a
    assertTrue(v.add("c", 12_500).isEmpty()) // slots [10.0,11.0) and [11.0,12.0) show b
    // A tick past the segment's end: slots 2..4 show c, the segment goes out.
    val out = v.pending(15_000, closing = false)
    val seg = out.single()
    assertEquals("mp4:b,b,c,c,c", seg.text())
    assertEquals(listOf(10_000L, 15_000L), listOf(seg.t, seg.end))
    assertTrue(seg.segment && seg.keyframe)
    assertEquals(listOf("a", "b"), enc.released)
    // The next segment starts with the frame on screen (self-contained), then gets d.
    v.add("d", 16_200)
    val next = v.pending(20_000, closing = false).single()
    assertEquals("mp4:c,d,d,d,d", next.text())
    assertEquals(15_000L, next.t)
  }

  @Test
  fun aStaticScreenSendsNothingAfterItsLastSegment() {
    val enc = FakeMp4()
    val v = VideoSegmenter(enc)
    v.add("a", 0)
    assertEquals("mp4:a,a,a,a,a", v.pending(5_000, false).single().text())
    // Nothing new for a whole segment: the carried segment is dropped, not sent.
    assertTrue(v.pending(10_000, false).isEmpty())
    assertTrue(v.pending(60_000, false).isEmpty())
    assertEquals(1, enc.aborted)
    // The next change starts a segment at its own time.
    v.add("b", 61_300)
    val s = v.pending(66_300, false).single()
    assertEquals(listOf(61_300L, 66_300L), listOf(s.t, s.end))
    assertEquals("mp4:b,b,b,b,b", s.text())
  }

  @Test
  fun closingFinishesWhatIsOpenWithTheFrameOnScreen() {
    val v = VideoSegmenter(FakeMp4())
    v.add("a", 1_000)
    v.add("b", 2_300)
    val s = v.pending(2_600, closing = true).single()
    // Slot [1,2) showed a, the slot in progress shows b.
    assertEquals("mp4:a,b", s.text())
    assertEquals(listOf(1_000L, 3_000L), listOf(s.t, s.end))
    // Closed: nothing is carried, the next frame starts afresh.
    assertTrue(v.pending(9_000, true).isEmpty())
    v.add("c", 9_500)
    assertEquals("mp4:c", v.pending(9_500, true).single().text())
  }

  @Test
  fun anEncoderFailureLosesTheSegmentNeverHalfOfIt() {
    val enc = FakeMp4()
    enc.failOn = "bad"
    val v = VideoSegmenter(enc)
    v.add("bad", 0)
    try {
      v.pending(3_000, false)
      error("expected the codec failure")
    } catch (e: IllegalStateException) {
    }
    v.reset()
    assertTrue(enc.aborted >= 1)
    assertTrue("bad" in enc.released)
    v.add("ok", 4_000)
    assertEquals("mp4:ok", v.pending(4_000, true).single().text())
  }
}

/** `ouo-video/1` through the stream with the fake encoder: what the Android adapter does without the bitmaps. */
class VideoStreamTest {
  private val scope = ReplayScope(listOf("service.name" to "test"), "1.0.0", "https://example.test/schema")
  private var clock = 0L

  private class Frame(val name: String) : ReplayLook

  private class FakeVideoAdapter(val enc: FakeMp4 = FakeMp4()) : ReplayFormatAdapter {
    val segmenter = VideoSegmenter(enc)
    override val formatId = VideoFrames.FORMAT
    override val encoding = VideoFrames.ENCODING
    override val masked = true
    override fun requestKeyframe() {}
    override fun touchEvent(touch: Touch): ReplayEvent? = null
    override fun compress(payload: ByteArray): ByteArray = payload
    override fun events(look: ReplayLook, t: EpochMillis): List<ReplayEvent> = segmenter.add((look as Frame).name, t)
    override fun pending(t: EpochMillis, closing: Boolean): List<ReplayEvent> = segmenter.pending(t, closing)
  }

  private fun stream(sink: ReplaySink, config: ReplayStreamConfig = ReplayStreamConfig(), adapter: ReplayFormatAdapter = FakeVideoAdapter()) =
    ReplayStream("sess-1", null, scope, config, adapter, sink, null, now = { clock })

  @Test
  fun oneChunkPerSegmentEachAKeyframeWithItsOwnIndexAndTheMp4AsBody() {
    val sink = MemorySink()
    val s = stream(sink)
    s.look(Frame("a"), 1_000)
    s.touch(Touch(1_500, 1.0, 2.0, TouchPhase.BEGAN)) // not recorded by this format
    s.look(Frame("b"), 4_000)
    s.tick(6_000)
    s.look(Frame("c"), 8_000)
    s.tick(11_000)
    clock = 12_000
    s.end(ReplayEndReason.STOP)
    val cs = sink.chunks
    assertEquals(listOf(0, 1), cs.map { it.sequence })
    assertEquals(listOf(0, 1), cs.map { it.segment })
    assertEquals(listOf(true, true), cs.map { it.keyframe })
    assertArrayEquals("mp4:a,a,a,b,b".toByteArray(), cs[0].body)
    assertArrayEquals("mp4:b,b,c,c,c".toByteArray(), cs[1].body)
    for (c in cs) {
      assertEquals("ouo-video/1", c.string("ouo.replay.format"))
      assertEquals("identity", c.string("ouo.replay.encoding"))
      assertEquals(true, c.bool("ouo.replay.masked"))
    }
    assertEquals(listOf(1_000L, 6_000L), listOf(cs[0].long("ouo.replay.start_time"), cs[0].long("ouo.replay.end_time")))
    assertEquals(listOf(6_000L, 11_000L), listOf(cs[1].long("ouo.replay.start_time"), cs[1].long("ouo.replay.end_time")))
    val ended = sink.ended.single()
    assertEquals("complete", ended.string("ouo.replay.end_state"))
    assertEquals(1L, ended.long("ouo.replay.last_sequence"))
  }

  @Test
  fun flushBackgroundAndEndSendWhatTheEncoderHolds() {
    val sink = MemorySink()
    val s = stream(sink)
    s.look(Frame("a"), 1_000)
    clock = 2_500
    s.flush()
    assertArrayEquals("mp4:a,a".toByteArray(), sink.chunks.single().body)
    s.look(Frame("b"), 3_000)
    clock = 3_200
    s.background()
    s.look(Frame("c"), 9_000)
    clock = 9_100
    s.end(ReplayEndReason.SESSION_END)
    assertEquals(listOf("mp4:a,a", "mp4:b", "mp4:c"), sink.chunks.map { String(it.body!!) })
    assertEquals(listOf(0, 1, 2), sink.chunks.map { it.segment })
    assertEquals("session_end", sink.ended.single().string("ouo.replay.end_reason"))
  }

  @Test
  fun bufferKeepsWholeSegmentsUntilCaptureThenGoesOnAsSession() {
    val sink = MemorySink()
    val s = stream(sink, ReplayStreamConfig(mode = ReplayCaptureMode.BUFFER, bufferSeconds = 10.0))
    var t = 0L
    for (i in 0 until 30) {
      s.look(Frame("f$i"), t)
      t += 1_000
      clock = t
      s.tick(t)
    }
    assertEquals("nothing leaves before the trigger", 0, sink.requests.size)
    assertTrue("the ring holds at least the window", s.bufferedChunks >= 2)
    clock = t
    val flushed = s.capture(ReplayTrigger.ERROR)!!
    val cs = sink.chunks
    assertEquals(flushed, cs.size)
    assertEquals((0 until flushed).toList(), cs.map { it.sequence })
    assertEquals((0 until flushed).toList(), cs.map { it.segment })
    assertTrue(cs.all { it.keyframe && it.string("ouo.replay.trigger") == "error" && it.string("ouo.replay.mode") == "buffer" })
    // Covers the last 10 s at least, and every body is one whole file.
    assertTrue(t - cs.first().long("ouo.replay.start_time") >= 10_000)
    assertTrue(cs.all { String(it.body!!).startsWith("mp4:") })
    s.look(Frame("after"), t + 500)
    clock = t + 600
    s.end(ReplayEndReason.STOP)
    assertEquals(flushed + 1, sink.chunks.size)
    assertEquals(flushed, sink.chunks.last().segment)
  }

  @Test
  fun abandonSendsNothingAndASegmentOverTheHardLimitIsDroppedNotCut() {
    val sink = MemorySink()
    val s = stream(sink)
    s.look(Frame("a"), 0)
    s.abandon()
    s.tick(10_000)
    assertEquals(0, sink.requests.size)

    val big = MemorySink()
    val s2 = stream(big, ReplayStreamConfig(hardLimitBytes = 64))
    s2.look(Frame("x".repeat(100)), 0)
    clock = 1_000
    s2.flush()
    assertEquals(0, big.chunks.size)
    assertEquals(1, s2.stats.eventsDropped)
    s2.look(Frame("y"), 6_000)
    clock = 6_100
    s2.flush()
    assertEquals(listOf(0), big.chunks.map { it.sequence })
    assertEquals("mp4:y", String(big.chunks.single().body!!))
  }

  @Test
  fun anEncoderFailureDropsTheFrameAndIsCounted() {
    val sink = MemorySink()
    val enc = FakeMp4().apply { failOn = "bad" }
    val adapter = FakeVideoAdapter(enc)
    val s = stream(sink, adapter = adapter)
    s.look(Frame("bad"), 0)
    s.tick(2_000)
    assertEquals(1, s.stats.framesDropped)
    adapter.segmenter.reset()
    s.look(Frame("ok"), 3_000)
    clock = 3_100
    s.flush()
    assertEquals("mp4:ok", String(sink.chunks.single().body!!))
  }
}
