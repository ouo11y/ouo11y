package dev.ouo.replay.core

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Fault injection (client SDK spec ERR-1): whatever the adapter, the disk, the collector or
 * JavaScript does wrong, no call throws; capture degrades or stops, and it is counted.
 */
class ReplayFaultTest {
  private val scope = ReplayScope(listOf("service.name" to "test"))

  private fun stream(sink: ReplaySink, adapter: ReplayFormatAdapter = StubAdapter(), config: ReplayStreamConfig = ReplayStreamConfig(), store: ReplayStateStore? = null) =
    ReplayStream("sess-1", null, scope, config, adapter, sink, store)

  @Test
  fun anAdapterThatThrowsDropsTheFrameAndThenDisablesTheStream() {
    val sink = MemorySink()
    val s = stream(sink, config = ReplayStreamConfig(selfDisableThreshold = 5))
    s.look(StubLook(), 1000)
    for (i in 0 until 3) s.look(StubLook(fail = IllegalStateException("boom")), 1100L + i)
    s.look(StubLook(fail = OutOfMemoryError("bitmap")), 1200)
    // A look of another format, and masking that could not be established: dropped (PRV-8).
    s.look(object : ReplayLook {}, 1300)
    assertEquals(5, s.stats.framesDropped)
    assertFalse("five errors: capture stopped", s.isActive)
    val ended = sink.ended.single()
    assertEquals("error", ended.string("ouo.replay.end_reason"))
    assertEquals("what was captured before still went out", 1, sink.chunks.size)
    s.look(StubLook(), 2000) // no-op from here on
    assertEquals(2, sink.requests.size)

    // A masking failure is the format doing its job: dropped and counted, not an SDK error.
    val s2 = stream(MemorySink(), config = ReplayStreamConfig(selfDisableThreshold = 2))
    for (i in 0 until 10) s2.look(StubLook(fail = ReplayFormatError(ReplayFormatError.Kind.MASKING_FAILED)), 1000L + i)
    assertEquals(listOf(10, 0), listOf(s2.stats.framesDropped, s2.stats.errors))
    assertTrue(s2.isActive)
  }

  @Test
  fun garbageFromAnAdapterNeverReachesTheWire() {
    val sink = MemorySink()
    val adapter = StubAdapter()
    val s = stream(sink, adapter, ReplayStreamConfig(maxEventBytes = 2048))
    s.look(StubLook(), 1000)
    val garbage = listOf(
      ReplayEvent(1100, false, "not json"),
      ReplayEvent(1101, false, "{\"a\":1}\n{\"b\":2}"),
      ReplayEvent(1102, false, ""),
      ReplayEvent(1103, true, "[1,2,3]"),
      ReplayEvent(1104, false, "{\"p\":\"" + "x".repeat(5000) + "\"}"),
      ReplayEvent(1105, false, ByteArray(0)),
    )
    val before = adapter.keyframeRequests
    s.look(StubLook(raw = garbage), 1100)
    s.look(StubLook(raw = emptyList()), 1150)
    assertEquals(6, s.stats.eventsDropped)
    assertEquals(6, s.stats.errors)
    assertTrue("a new keyframe is asked for: later events may build on what was dropped", adapter.keyframeRequests > before)
    s.look(StubLook(), 1200)
    s.end(ReplayEndReason.STOP)
    // Only whole JSON objects, one per line, in what was sent.
    for (c in sink.chunks) for (line in c.lines) org.json.JSONObject(line)
    assertEquals(listOf(0, 1), sink.chunks.map { it.segment })
    assertEquals(listOf(true, true), sink.chunks.map { it.keyframe })
  }

  @Test
  fun aCompressorThatFailsLosesTheChunkNotTheApp() {
    val sink = MemorySink()
    val adapter = StubAdapter()
    val s = stream(sink, adapter)
    s.look(StubLook(), 1000)
    adapter.failCompress = true
    s.flush()
    assertEquals(0, sink.requests.size)
    assertEquals(1, s.stats.errors)
    adapter.failCompress = false
    s.look(StubLook(), 2000)
    s.flush()
    // Nothing was numbered for the lost chunk: no hole.
    assertEquals(listOf(0), sink.chunks.map { it.sequence })
    assertTrue(sink.chunks[0].keyframe)
  }

  @Test
  fun aStoreThatRefusesStopsCaptureAndMarksTheStreamPartial() {
    for (sink in listOf(MemorySink(accept = false), MemorySink(explode = true))) {
      val state = FileReplayStateStore(File(TestFiles.dir(), "open-stream.json"))
      val s = stream(sink, store = state)
      s.look(StubLook(), 1000)
      s.tick(7000)
      assertFalse("RPL-18: capture stops", s.isActive)
      assertTrue(s.isPartial)
      // The chunk, then the end record it could not store either.
      assertEquals(2, s.stats.refused)
      assertEquals(1, s.producedChunks)
      // The state stays, so the next launch says what this one could not.
      val next = MemorySink()
      assertTrue(ReplayStream.endOpenStream(state, next))
      val ended = next.ended.single()
      assertEquals(listOf("partial", 0L), listOf(ended.string("ouo.replay.end_state"), ended.long("ouo.replay.last_sequence")))
    }
  }

  @Test
  fun aDiskThatFailsIsCountedAndNothingThrows() {
    // The queue folder cannot exist: its parent is a regular file.
    val blocker = File(TestFiles.dir(), "blocker").apply { writeText("x") }
    val d = ReplayDelivery("http://collector.test/v1/logs", "", File(blocker, "outbox-otlp"), transport = { HttpAnswer(200) })
    val state = FileReplayStateStore(File(blocker, "open-stream.json"))
    val s = stream(d, store = state)
    s.look(StubLook(), 1000)
    s.tick(7000)
    assertEquals(2, d.stats.refused)
    assertFalse(s.isActive)
    assertTrue(s.isPartial)
    assertTrue("the state could not be written either", s.stats.stateFailures > 0)
    assertNull(state.load())
    assertEquals(0, d.queuedCount)
    assertEquals(0, d.discardPending())
    assertFalse(ReplayStream.endOpenStream(state, d))
    d.close()
    // After close: still no throw.
    assertFalse(d.put(byteArrayOf(1), "s", 0))
    d.drain {}
  }

  @Test
  fun aTransportThatThrowsKeepsTheRecordForARetry() {
    val dir = TestFiles.dir()
    var calls = 0
    val t = Transport {
      calls++
      if (calls == 1) throw IllegalStateException("socket factory exploded")
      if (calls == 2) throw StackOverflowError()
      HttpAnswer(200)
    }
    val d = ReplayDelivery("http://collector.test/v1/logs", "", dir, ReplayDelivery.Config(retryDelayMs = { 0 }), t)
    assertTrue(d.put(byteArrayOf(1, 2), "s1", 0))
    TestFiles.eventually { d.stats.accepted == 1 }
    assertEquals(3, calls)
    assertEquals(0, d.queuedCount)
    d.close()
  }

  @Test
  fun aLossHandlerThatThrowsOrCallsBackDoesNotStallTheQueue() {
    val dir = TestFiles.dir()
    val d = ReplayDelivery("http://collector.test/v1/logs", "", dir, ReplayDelivery.Config(retryDelayMs = { 0 }), { HttpAnswer(400) })
    val told = java.util.concurrent.atomic.AtomicInteger()
    d.onLoss = {
      told.incrementAndGet()
      d.queuedCount // back into the queue from the handler
      throw IllegalStateException("handler exploded")
    }
    d.put(byteArrayOf(1), "s1", 0)
    d.put(byteArrayOf(2), "s1", 1)
    TestFiles.drain(d)
    TestFiles.eventually { told.get() == 2 }
    assertEquals(2, d.stats.rejectedStatus)
    d.close()
  }

  @Test
  fun malformedOptionsNeverThrow() {
    // No `otlp`: the legacy path, whatever else is there.
    assertTrue(ReplayOTLPOptions.parse(null) is ReplayOTLPOptions.Parsed.Legacy)
    assertTrue(ReplayOTLPOptions.parse(mapOf("mode" to "session", "jpegQuality" to 1000)) is ReplayOTLPOptions.Parsed.Legacy)
    assertTrue(ReplayOTLPOptions.parse(mapOf("otlp" to null)) is ReplayOTLPOptions.Parsed.Legacy)

    // OTLP asked for but unusable: off, never the legacy wire by accident.
    val off = listOf<Map<String, Any?>>(
      mapOf("otlp" to "http://x/v1/logs"),
      mapOf("otlp" to 42),
      mapOf("otlp" to emptyMap<String, Any?>()),
      mapOf("otlp" to mapOf("logsUrl" to 7)),
      mapOf("otlp" to mapOf("logsUrl" to "ftp://x/v1/logs")),
      mapOf("otlp" to mapOf("logsUrl" to "not a url")),
      mapOf("otlp" to mapOf("logsUrl" to "http://")),
      mapOf("otlp" to mapOf("logsUrl" to "http://x/v1/logs"), "mode" to "pixel/video"),
      mapOf("otlp" to mapOf("logsUrl" to "http://x/v1/logs"), "mode" to "structure/wireframe"),
      mapOf("otlp" to mapOf("logsUrl" to "http://x/v1/logs"), "mode" to "pixel"),
      mapOf("otlp" to mapOf("logsUrl" to "http://x/v1/logs"), "mode" to "session"),
      mapOf("otlp" to mapOf("logsUrl" to "http://x/v1/logs"), "mode" to 3),
    )
    for (o in off) {
      val p = ReplayOTLPOptions.parse(o)
      assertTrue("$o", p is ReplayOTLPOptions.Parsed.Off && p.problems.isNotEmpty())
    }

    // Usable, with everything else wrong: defaults, clamps and a list of problems.
    val p = ReplayOTLPOptions.parse(
      mapOf(
        "otlp" to mapOf(
          "logsUrl" to " https://collector.test:4318/v1/logs ",
          "resource" to mapOf("service.name" to "app", "b" to true, "n" to 3.0, "f" to 1.5, "bad" to listOf(1), "nan" to Double.NaN, 7 to "x"),
          "schemaUrl" to 12, "scopeVersion" to listOf("1"), "previousExit" to "meteor",
        ),
        "cadence" to "sometimes", "buffer" to "yes", "replayId" to "XYZ",
        "keyframeIntervalMs" to -1, "chunkMaxBytes" to 1e12, "frameInterval" to "fast",
      )
    ) as ReplayOTLPOptions.Parsed.Otlp
    val o = p.options
    assertEquals("https://collector.test:4318/v1/logs", o.logsUrl)
    // In key order, typed: a whole number is an int, the rest a double.
    assertEquals(listOf<Pair<String, Any>>("b" to true, "f" to 1.5, "n" to 3L, "service.name" to "app"), o.scope.resource)
    assertEquals(listOf("", ""), listOf(o.scope.schemaUrl, o.scope.scopeVersion))
    assertEquals(ReplayRecorderMode.PIXEL_FRAMES, o.recorder)
    assertEquals(ReplayMode.AUTO, o.cadence)
    assertEquals(60.0, o.bufferSeconds!!, 0.0)
    assertNull(o.replayId)
    assertEquals(ReplayEndReason.BACKGROUND_KILL, o.previousExit)
    assertEquals(listOf(1000L, 1L shl 20), listOf(o.keyframeIntervalMs, o.chunkMaxBytes.toLong()))
    assertEquals(p.problems.toString(), 10, p.problems.size)
    assertEquals(ReplayCaptureMode.BUFFER, o.streamConfig.mode)

    // The valid form.
    val ok = ReplayOTLPOptions.parse(
      mapOf(
        "otlp" to mapOf("logsUrl" to "http://10.0.2.2:4318/v1/logs", "schemaUrl" to "https://s", "scopeVersion" to "1.2.3", "previousExit" to "crash"),
        "mode" to "pixel/frames", "cadence" to "navigation", "buffer" to mapOf("seconds" to 2), "replayId" to "abcdef0123456789abcdef0123456789",
        "keyframeIntervalMs" to 60_000, "chunkMaxBytes" to 100_000.0,
      )
    ) as ReplayOTLPOptions.Parsed.Otlp
    assertEquals(listOf("buffer.seconds is out of range, clamped"), ok.problems)
    assertEquals(5.0, ok.options.bufferSeconds!!, 0.0)
    assertEquals(ReplayMode.NAVIGATION, ok.options.cadence)
    assertEquals(ReplayEndReason.CRASH, ok.options.previousExit)
    assertEquals("abcdef0123456789abcdef0123456789", ok.options.replayId)
    assertEquals(listOf(60_000L, 100_000L), listOf(ok.options.keyframeIntervalMs, ok.options.chunkMaxBytes.toLong()))
    assertEquals(ReplayScope(emptyList(), "1.2.3", "https://s"), ok.options.scope)
    // `buffer` absent or false: the whole session.
    val whole = ReplayOTLPOptions.parse(mapOf("otlp" to mapOf("logsUrl" to "http://x/v1/logs"), "buffer" to false)) as ReplayOTLPOptions.Parsed.Otlp
    assertNull(whole.options.bufferSeconds)
    assertEquals(ReplayCaptureMode.SESSION, whole.options.streamConfig.mode)

    val (common, problems) = ReplayOTLPOptions.Common.parse(
      mapOf("sessionId" to 5, "projectId" to " demo ", "projectToken" to null, "frameInterval" to 1e9, "maskText" to "no", "maskInputs" to 0, "maskImages" to false, "debug" to "true")
    )
    assertEquals(ReplayOTLPOptions.Common(projectId = "demo", frameInterval = 60.0, maskImages = false), common)
    // A mask option that is not a boolean masks.
    assertTrue(common.maskText && common.maskInputs)
    assertEquals(5, problems.size)
    assertEquals(ReplayOTLPOptions.Common(), ReplayOTLPOptions.Common.parse(null).first)
  }

  @Test
  fun maskRegistryAndStrictPlanning() {
    val r = ReplayMaskRegistry()
    r.mask(7)
    r.unmask(8)
    assertEquals(ReplayMaskRegistry.Snapshot(setOf(7), setOf(8)), r.snapshot())
    // For a tag the last call decides; for a view, mask wins.
    r.unmask(7)
    r.mask(8)
    val snap = r.snapshot()
    assertEquals(ReplayMaskRegistry.Snapshot(setOf(8), setOf(7)), snap)
    assertEquals(true, snap.override(8, null))
    assertEquals(false, snap.override(7, null))
    assertEquals(true, snap.override(7, "ouo-mask"))
    assertEquals(true, snap.override(8, "ouo-unmask"))
    assertEquals(false, snap.override(null, "ouo-unmask"))
    assertNull(snap.override(99, "title"))
    assertNull(snap.override(null, null))
    r.reset()
    assertEquals(ReplayMaskRegistry.Snapshot(), r.snapshot())
    // Bounded: a refused unmask leaves the view masked by its class.
    for (i in 1..ReplayMaskRegistry.LIMIT + 5) r.unmask(i)
    assertEquals(ReplayMaskRegistry.LIMIT, r.snapshot().unmasked.size)
    assertEquals(5, r.refused)

    val window = Box(0f, 0f, 1080f, 2400f)
    val password = ViewNode("android.widget.EditText", listOf("android.widget.TextView"), Box(0f, 100f, 500f, 200f), secure = true)
    val label = ViewNode("android.widget.TextView", emptyList(), Box(0f, 300f, 500f, 400f), textLines = listOf(Box(0f, 300f, 200f, 400f)))
    val maskedInside = ViewNode("android.view.ViewGroup", emptyList(), Box(0f, 500f, 500f, 600f), maskOverride = true)
    val tagged = ViewNode("android.view.ViewGroup", emptyList(), Box(0f, 700f, 500f, 800f), tag = "ouo-mask")
    val unmasked = ViewNode("android.view.ViewGroup", emptyList(), window, maskOverride = false, children = listOf(password, label, maskedInside, tagged))
    val root = ViewNode("android.widget.FrameLayout", emptyList(), window, children = listOf(unmasked))
    // Strict (the OTLP path): the label shows; the secure input and the masks inside stay masked,
    // with every mask option off too (PRV-7).
    val expected = listOf(Box(0f, 100f, 500f, 200f), Box(0f, 500f, 500f, 600f), Box(0f, 700f, 500f, 800f))
    assertEquals(expected, RedactionPlanner(RedactionRules(strict = true)).rects(root, window))
    assertEquals(expected, RedactionPlanner(RedactionRules(false, false, false, false, strict = true)).rects(root, window))
    assertEquals(listOf(Box(0f, 100f, 500f, 200f)), RedactionPlanner(RedactionRules(false, false, false, false, strict = true)).rects(password.copy(tag = "ouo-unmask"), window))
    // Not strict: the behaviour the native SDK shipped with (unmask opts its whole subtree out).
    assertEquals(emptyList<Box>(), RedactionPlanner().rects(root, window))
    // A view-level mask applies on both paths; a view-level unmask shows a label.
    assertEquals(listOf(Box(0f, 300f, 500f, 400f)), RedactionPlanner().rects(label.copy(maskOverride = true), window))
    assertEquals(emptyList<Box>(), RedactionPlanner(RedactionRules(strict = true)).rects(label.copy(maskOverride = false), window))
  }
}
