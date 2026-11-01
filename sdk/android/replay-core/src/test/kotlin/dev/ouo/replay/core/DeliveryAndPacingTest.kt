package dev.ouo.replay.core

import java.io.File
import java.nio.file.Files
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.zip.GZIPInputStream
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class DeliveryAndPacingTest {
  private class Recording(var answers: MutableList<HttpAnswer>) : Transport {
    val requests = mutableListOf<HttpRequest>()

    @Synchronized
    override fun send(request: HttpRequest): HttpAnswer {
      requests.add(request)
      return if (answers.size > 1) answers.removeAt(0) else answers[0]
    }
  }

  private fun chunk(sid: String, seq: Int) =
    FrameChunk(sid, seq, 1000, 2000, Viewport(400.0, 800.0, 1.0), frames = listOf(Frame.full(1000, byteArrayOf(-1, -40), FrameReason.TIMER)), touches = emptyList(), masked = true)

  private fun drain(u: ChunkUploader) {
    val done = CountDownLatch(1)
    u.drain { done.countDown() }
    assertTrue(done.await(5, TimeUnit.SECONDS))
  }

  private fun dir(): File = Files.createTempDirectory("ouo-outbox").toFile()

  @Test
  fun uploadsGzipWithTheHeadersInOrder() {
    val t = Recording(mutableListOf(HttpAnswer(200)))
    val u = ChunkUploader("http://10.0.2.2:4319/", "demo", "pt_dev", dir(), transport = t)
    u.enqueue(chunk("s1", 0))
    u.enqueue(chunk("s1", 1))
    drain(u)
    assertEquals(2, t.requests.size)
    val r = t.requests[0]
    assertEquals("http://10.0.2.2:4319/v1/replay/chunks", r.url)
    assertEquals("Basic ZGVtbzpwdF9kZXY=", r.headers["Authorization"])
    assertEquals("gzip", r.headers["content-encoding"])
    assertEquals("s1", r.headers["x-ouo-session-id"])
    assertEquals(listOf("0", "1"), t.requests.map { it.headers["x-ouo-seq"] })
    assertEquals(chunk("s1", 0), FrameChunk.decode(GZIPInputStream(r.body.inputStream()).readBytes()))
    assertEquals(0, u.queuedCount)
    u.close()
  }

  @Test
  fun retriesOutagesAndDropsRejections() {
    val d = dir()
    val t = Recording(mutableListOf(HttpAnswer(503, "0"), HttpAnswer(0)))
    val u = ChunkUploader("http://x", "p", "t", d, ChunkUploader.Config(retryDelayMs = { 3_600_000 }), transport = t)
    u.enqueue(chunk("s1", 0))
    drain(u)
    assertEquals("an outage keeps the chunk on disk", 1, u.queuedCount)
    u.close()
    // The next process sends it; a 400 removes it without a retry.
    val t2 = Recording(mutableListOf(HttpAnswer(400)))
    val u2 = ChunkUploader("http://x", "p", "t", d, transport = t2)
    drain(u2)
    assertEquals(1, t2.requests.size)
    assertEquals(0, u2.queuedCount)
    assertEquals(1, u2.failed)
    u2.close()
  }

  @Test
  fun heldChunksWaitForTheDecision() {
    val d = dir()
    val t = Recording(mutableListOf(HttpAnswer(200)))
    val u = ChunkUploader("http://x", "p", "t", d, ChunkUploader.Config(hold = true), transport = t)
    u.enqueue(chunk("old", 0))
    u.enqueue(chunk("old", 1))
    u.enqueue(chunk("other", 0))
    drain(u)
    assertEquals(0, t.requests.size)
    assertEquals(listOf("old" to 2, "other" to 1), u.heldSessions().map { it.sessionId to it.chunks })
    u.release("old", keep = true)
    u.release("other", keep = false)
    drain(u)
    assertEquals(listOf("0", "1"), t.requests.map { it.headers["x-ouo-seq"] })
    assertEquals(emptyList<ChunkUploader.HeldSession>(), u.heldSessions())
    u.close()
  }

  @Test
  fun queueBoundDropsTheOldest() {
    val d = dir()
    var clock = 5_000L
    val q = DiskQueue(d, DiskQueue.Config(maxBytes = 25), transport = null, now = { clock }) { _, _ -> null }
    q.put(ByteArray(10), "a")
    q.put(ByteArray(10), "b")
    // The clock moved back a day: the name still sorts after the newest, and nothing expires.
    clock -= 24 * 3600 * 1000L
    q.put(ByteArray(10), "c")
    assertEquals(listOf("b", "c"), q.entries().map { it.tag })
    clock += 10 * 24 * 3600 * 1000L
    assertEquals(listOf("b", "c"), q.entries().map { it.tag })
    q.close()
  }

  @Test
  fun pacerNeedsADrawAndKeepsTheInterval() {
    val p = CapturePacer(ReplayMode.SESSION, 1.0)
    p.requestFrame(FrameReason.RESUME, 0.0)
    assertEquals(CapturePacer.Decision.Capture(FrameReason.RESUME), p.decide(0.0, dirty = false))
    assertEquals("nothing drew: no frame", CapturePacer.Decision.Wait, p.decide(5.0, dirty = false))
    assertEquals(CapturePacer.Decision.Capture(FrameReason.TIMER), p.decide(5.0, dirty = true))
    assertEquals("within the interval", CapturePacer.Decision.Wait, p.decide(5.5, dirty = true))
    assertEquals(6.0, p.wakeAt(5.5, dirty = true)!!, 1e-9)
    // A 300 ms capture overdraws the 100 ms bank: the next frame waits until it is refilled.
    p.spent(0.3, 6.0)
    assertEquals(CapturePacer.Decision.Wait, p.decide(7.0, dirty = true))
    assertEquals(CapturePacer.Decision.Capture(FrameReason.TIMER), p.decide(8.01, dirty = true))
  }

  @Test
  fun navigationModeCapturesScreensAndRetriesDrops() {
    val p = CapturePacer(ReplayMode.NAVIGATION, 1.0)
    assertEquals(null, p.wakeAt(0.0, dirty = true))
    p.screenDidChange(10.0)
    assertEquals(CapturePacer.Decision.Wait, p.decide(10.2, dirty = true))
    assertEquals(CapturePacer.Decision.Capture(FrameReason.NAVIGATION), p.decide(10.4, dirty = false))
    p.dropped(FrameReason.NAVIGATION, 10.5)
    p.motion(10.5)
    // The retry (0.5 s) is later than the settle time (0.25 s) after the motion.
    assertEquals(11.0, p.wakeAt(10.5, dirty = false)!!, 1e-9)
    assertEquals(CapturePacer.Decision.Capture(FrameReason.NAVIGATION), p.decide(11.0, dirty = false))
    assertEquals(ReplayMode.NAVIGATION, ReplayMode.AUTO.resolved(3L shl 30))
    assertEquals(ReplayMode.SESSION, ReplayMode.AUTO.resolved(8L shl 30))
  }
}
