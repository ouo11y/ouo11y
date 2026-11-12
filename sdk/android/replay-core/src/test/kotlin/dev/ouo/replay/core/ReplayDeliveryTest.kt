package dev.ouo.replay.core

import java.io.File
import java.util.concurrent.CopyOnWriteArrayList
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ReplayDeliveryTest {
  /** Answers in order (the last one for ever); records every request and what was on disk when it was sent. */
  private class Scripted(private val dir: File, vararg answers: HttpAnswer) : Transport {
    private val script = answers.toMutableList()
    val requests = CopyOnWriteArrayList<HttpRequest>()
    val onDisk = CopyOnWriteArrayList<Int>()

    @Synchronized
    override fun send(request: HttpRequest): HttpAnswer {
      requests.add(request)
      onDisk.add(DiskQueue.list(dir).size)
      return if (script.size > 1) script.removeAt(0) else script[0]
    }
  }

  private val never: (Int) -> Long = { 3_600_000 }
  private val scope = ReplayScope(listOf("service.name" to "test"))

  private fun partialSuccess(rejected: Long): ByteArray = ProtoWriter().message(1, ProtoWriter().varint(1, rejected).string(2, "refused")).toByteArray()

  private fun delivery(dir: File, t: Transport, retry: (Int) -> Long = never, maxBytes: Long = 20L * 1024 * 1024) =
    ReplayDelivery("http://collector.test:4318/v1/logs", "Basic ZGVtbzpwdF9kZXY=", dir, ReplayDelivery.Config(maxQueueBytes = maxBytes, retryDelayMs = retry), t)

  @Test
  fun oneProtobufRequestPerRecordPersistedBeforeItIsSent() {
    val dir = TestFiles.dir()
    val t = Scripted(dir, HttpAnswer(200))
    val d = delivery(dir, t)
    val record = byteArrayOf(10, 0, 1, 2, 3)
    assertTrue(d.put(record, "s1", 0))
    assertTrue(d.put(byteArrayOf(9), "s1", null))
    TestFiles.drain(d)
    assertEquals(2, t.requests.size)
    val r = t.requests[0]
    assertEquals("http://collector.test:4318/v1/logs", r.url)
    assertEquals("application/x-protobuf", r.headers["Content-Type"])
    assertEquals("Basic ZGVtbzpwdF9kZXY=", r.headers["Authorization"])
    assertFalse("no second compression (TRN-1, spec 8.1)", r.headers.keys.any { it.equals("content-encoding", ignoreCase = true) })
    assertArrayEquals(record, r.body)
    assertTrue("on disk when first sent (RPL-15)", t.onDisk[0] >= 1)
    assertEquals(ReplayDelivery.Stats(accepted = 2), d.stats)
    assertEquals(0, d.queuedCount)
    d.close()
    // No credential: no header.
    assertNull(ReplayDelivery.makeRequest("http://x", "", record).headers["Authorization"])
  }

  @Test
  fun aRetrySendsTheSameBytes() {
    val dir = TestFiles.dir()
    val t = Scripted(dir, HttpAnswer(503, "0"), HttpAnswer(0), HttpAnswer(502), HttpAnswer(204))
    val d = delivery(dir, t, retry = { 0 })
    val record = TestFiles.noise(500, 1).toByteArray()
    d.put(record, "s1", 0)
    TestFiles.eventually { d.stats.accepted == 1 }
    assertEquals(4, t.requests.size)
    for (r in t.requests) assertArrayEquals(record, r.body)
    assertEquals(0, d.queuedCount)
    d.close()
  }

  @Test
  fun answersFollowTheTable() {
    // Kept and retried: nothing is deleted, nothing is counted as lost.
    for (answer in listOf(HttpAnswer(429, "1"), HttpAnswer(503), HttpAnswer(502), HttpAnswer(504), HttpAnswer(0))) {
      val dir = TestFiles.dir()
      val d = delivery(dir, Scripted(dir, answer))
      val lost = CopyOnWriteArrayList<String>()
      d.onLoss = { lost.add(it) }
      d.put(byteArrayOf(1), "s1", 0)
      TestFiles.drain(d)
      assertEquals("status ${answer.status} keeps the record", 1, d.queuedCount)
      assertEquals(ReplayDelivery.Stats(), d.stats)
      assertTrue(lost.isEmpty())
      d.close()
    }
    // Accepted: 2xx with no rejected records, a 204 with no body included.
    for (answer in listOf(HttpAnswer(200), HttpAnswer(204), HttpAnswer(200, body = partialSuccess(0)), HttpAnswer(202, body = ByteArray(0)))) {
      val dir = TestFiles.dir()
      val d = delivery(dir, Scripted(dir, answer))
      d.put(byteArrayOf(1), "s1", 0)
      TestFiles.drain(d)
      assertEquals(ReplayDelivery.Stats(accepted = 1), d.stats)
      assertEquals(0, d.queuedCount)
      d.close()
    }
    // 2xx with rejected > 0: deleted, counted, not retried, the stream is told.
    run {
      val dir = TestFiles.dir()
      val t = Scripted(dir, HttpAnswer(200, body = partialSuccess(1)))
      val d = delivery(dir, t, retry = { 0 })
      val lost = CopyOnWriteArrayList<String>()
      d.onLoss = { lost.add(it) }
      d.put(byteArrayOf(1), "s1", 4)
      TestFiles.drain(d)
      assertEquals(ReplayDelivery.Stats(partialRejected = 1), d.stats)
      assertEquals(listOf(1, 0), listOf(t.requests.size, d.queuedCount))
      assertEquals(listOf("s1"), lost.toList())
      d.close()
    }
    // Anything else: deleted and counted.
    for (status in listOf(400, 401, 404, 413, 500, 501, 301)) {
      val dir = TestFiles.dir()
      val t = Scripted(dir, HttpAnswer(status))
      val d = delivery(dir, t, retry = { 0 })
      val lost = CopyOnWriteArrayList<String>()
      d.onLoss = { lost.add(it) }
      d.put(byteArrayOf(1), "s1", 0)
      d.put(byteArrayOf(2), "s1", null) // the end record: rejected too, but it leaves no hole in the stream
      TestFiles.drain(d)
      assertEquals("status $status", ReplayDelivery.Stats(rejectedStatus = 2), d.stats)
      assertEquals(listOf(2, 0), listOf(t.requests.size, d.queuedCount))
      assertEquals(listOf("s1"), lost.toList())
      d.close()
    }
  }

  @Test
  fun backoffHasFullJitterAndRetryAfterIsCapped() {
    val top = DiskQueue.Config.fullJitter(1_000, 300_000) { 1.0 }
    assertEquals(listOf(1_000L, 2_000L, 4_000L, 8_000L), (1..4).map { top(it) })
    assertEquals("capped at 300 s", 300_000L, top(12))
    assertEquals(300_000L, top(1000))
    assertEquals(300_000L, top(-4).let { top(40) })
    val bottom = DiskQueue.Config.fullJitter(1_000, 300_000) { 0.0 }
    assertEquals("never under a tenth of the initial wait", listOf(100L, 100L), listOf(bottom(1), bottom(9)))
    val half = DiskQueue.Config.fullJitter(1_000, 300_000) { 0.5 }
    assertEquals(listOf(500L, 1_000L, 150_000L), listOf(half(1), half(2), half(20)))
    assertEquals(1_000L, DiskQueue.Config.fullJitter(1_000, 300_000) { Double.NaN }(1))
    // The default spreads: 200 draws of the 5th retry are not all the same and stay in range.
    val draws = (1..200).map { DiskQueue.Config.fullJitter()(5) }
    assertTrue(draws.all { it in 100..16_000 })
    assertTrue(draws.toSet().size > 20)

    // Retry-After is honoured, up to the cap; without one, the backoff.
    assertEquals(7_000L, DiskQueue.retryDelay(500, 7.0, 300_000))
    assertEquals(300_000L, DiskQueue.retryDelay(500, 86_400.0, 300_000))
    assertEquals(0L, DiskQueue.retryDelay(500, 0.0, 300_000))
    assertEquals(500L, DiskQueue.retryDelay(500, null, 300_000))
    assertEquals(500L, DiskQueue.retryDelay(500, -3.0, 300_000))
    assertEquals(500L, DiskQueue.retryDelay(500, Double.NaN, 300_000))
    assertEquals(86_400.0, HttpAnswer(429, " 86400 ").retryAfterSeconds!!, 0.0)
    assertNull(HttpAnswer(503, "Wed, 21 Oct 2026 07:28:00 GMT").retryAfterSeconds)
  }

  @Test
  fun aBacklogEvictsTheOldestChunksAndMarksTheStreamPartial() {
    val dir = TestFiles.dir()
    val d = delivery(dir, Scripted(dir, HttpAnswer(0)), maxBytes = 6_000)
    val s = ReplayStream("sess-1", null, scope, ReplayStreamConfig(), StubAdapter(), d)
    d.onLoss = { s.chunkLost(it) }
    for (i in 0 until 8) {
      val t = 1000L + i * 6000
      s.look(StubLook(TestFiles.noise(1500, i.toLong())), t)
      s.tick(t + 5500)
    }
    TestFiles.drain(d)
    TestFiles.eventually { d.stats.evicted > 0 && s.isPartial }
    assertEquals(8, s.producedChunks)
    // What is left are the newest, under the sequences they were given: nothing is renumbered.
    val left = DiskQueue.list(dir).map { it.tag }
    assertTrue(left.isNotEmpty() && left.size < 8)
    val sequences = left.map { it.split('.')[1].toInt() }
    assertEquals(sequences.sorted(), sequences)
    assertEquals(7, sequences.last())
    assertTrue("the oldest went first", 0 !in sequences || d.stats.evicted == 0)
    for (tag in left) assertEquals(listOf(s.streamId, "chunk", "pb"), tag.split('.').let { listOf(it[0], it[2], it[3]) })
    // After a loss the stream restarts at a keyframe and its end record says partial.
    s.end(ReplayEndReason.STOP)
    val ended = DiskQueue.list(dir).last()
    assertEquals("${s.streamId}.ended.pb", ended.tag)
    assertEquals("partial", DecodedRecord(ended.file.readBytes()).string("ouo.replay.end_state"))
    d.close()
  }

  @Test
  fun theNextProcessSendsWhatWasQueuedAndDiscardDeletesIt() {
    val dir = TestFiles.dir()
    val d1 = delivery(dir, Scripted(dir, HttpAnswer(0)))
    val record = byteArrayOf(4, 5, 6)
    d1.put(record, "s1", 0)
    d1.put(record, "s1", 1)
    TestFiles.drain(d1)
    d1.close()
    // The process is gone; a new one drains the folder with the same bytes.
    val t = Scripted(dir, HttpAnswer(200))
    val d2 = delivery(dir, t)
    TestFiles.drain(d2)
    assertEquals(2, t.requests.size)
    assertArrayEquals(record, t.requests[0].body)
    d2.close()

    val d3 = delivery(dir, Scripted(dir, HttpAnswer(0)))
    val lost = CopyOnWriteArrayList<String>()
    d3.onLoss = { lost.add(it) }
    d3.put(record, "s2", 0)
    d3.put(record, "s2", null)
    TestFiles.drain(d3)
    assertEquals(2, d3.discardPending())
    assertEquals(0, d3.queuedCount)
    assertTrue("a discard is not a loss", lost.isEmpty())
    d3.close()
    File(dir, "0000000000001-000001.s3.0.chunk.pb").writeBytes(record)
    assertEquals(1, ReplayDelivery.discardPending(dir))
    assertEquals(0, DiskQueue.list(dir).size)
  }
}
