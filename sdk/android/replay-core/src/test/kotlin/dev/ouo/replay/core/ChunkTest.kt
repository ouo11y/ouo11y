package dev.ouo.replay.core

import java.io.File
import java.nio.file.Files
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ChunkTest {
  private val vp = Viewport(411.0, 914.0, 1.0)
  private val jpeg = byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 1, 2, 3)

  private fun full(ts: Long) = Frame.full(ts, jpeg, FrameReason.TIMER)

  private fun patch(ts: Long) = Frame.patches(ts, listOf(Patch(PixelRect(0, 64, 64, 64), jpeg)), FrameReason.TIMER)

  private fun tmp(): File = Files.createTempDirectory("ouo-chunk").toFile()

  @Test
  fun base64MatchesTheJdk() {
    for (n in 0..40) {
      val bytes = ByteArray(n) { (it * 37 + 11).toByte() }
      assertEquals(java.util.Base64.getEncoder().encodeToString(bytes), base64(bytes))
    }
    assertEquals("Basic ZGVtbzpwdF9kZXY=", basicAuthorization("demo", "pt_dev"))
  }

  @Test
  fun chunkJsonHasTheSpecKeys() {
    val chunk = FrameChunk("s1", 3, 1000, 2000, vp, frames = listOf(full(1000), patch(1500)), touches = listOf(Touch(1200, 1.5, 2.0, TouchPhase.BEGAN)), masked = true)
    val o = JSONObject(String(chunk.encodedJson()))
    assertEquals(
      setOf("kind", "schema_version", "session_id", "seq", "started_at", "ended_at", "viewport", "platform", "mode", "frames", "touches", "masked"),
      o.keySet(),
    )
    assertEquals("frames", o.getString("kind"))
    assertEquals(2, o.getInt("schema_version"))
    assertEquals("android", o.getString("platform"))
    val f0 = o.getJSONArray("frames").getJSONObject(0)
    val f1 = o.getJSONArray("frames").getJSONObject(1)
    assertTrue(f0.has("jpeg") && !f0.has("patches"))
    assertTrue(f1.has("patches") && !f1.has("jpeg"))
    assertEquals(setOf("x", "y", "w", "h", "jpeg"), f1.getJSONArray("patches").getJSONObject(0).keySet())
    assertEquals("began", o.getJSONArray("touches").getJSONObject(0).getString("phase"))
    assertEquals(chunk, FrameChunk.decode(chunk.encodedJson()))
  }

  @Test
  fun firstFrameOfAChunkIsFullAndChunksCutOnTime() {
    var now = 1000L
    val out = mutableListOf<FrameChunk>()
    val b = ChunkBuilder(ChunkBuilder.Config(), vp, { "s1" }, InMemorySeqStore(), { now }) { out.add(it) }
    assertTrue(b.needsFullFrame)
    b.add(patch(1000))
    assertTrue("a patch frame cannot open a chunk", b.isEmpty)
    b.add(full(1000))
    b.add(patch(2000))
    assertFalse(b.needsFullFrame)
    now = 6000
    b.add(Touch(6000, 1.0, 1.0, TouchPhase.BEGAN))
    assertEquals(1, out.size)
    assertEquals(0, out[0].seq)
    assertEquals(2, out[0].frames.size)
    assertEquals(6000, out[0].endedAt)
    b.add(Touch(6100, 1.0, 1.0, TouchPhase.ENDED))
    b.flush()
    assertEquals("a chunk with touches only is sent", 2, out.size)
    assertEquals(1, out[1].seq)
    assertEquals(0, out[1].frames.size)
  }

  @Test
  fun bigImagesViewportChangesAndRotationCutTheChunk() {
    val out = mutableListOf<FrameChunk>()
    val seq = InMemorySeqStore()
    var sid = "s1"
    val b = ChunkBuilder(ChunkBuilder.Config(maxImageBytes = 20), vp, { sid }, seq, { 0L }) { out.add(it) }
    b.add(Frame(0, "x".repeat(30), null, FrameReason.TIMER))
    assertEquals(1, out.size)
    b.add(full(1))
    b.updateViewport(vp.copy(width = 914.0, height = 411.0))
    assertEquals(2, out.size)
    assertEquals(vp, out[1].viewport)
    b.add(full(2))
    sid = "s2"
    b.sessionDidRotate("s2")
    assertEquals("s1", out[2].sessionId)
    b.add(full(3))
    b.flush()
    assertEquals("s2", out[3].sessionId)
    assertEquals(0, out[3].seq)
  }

  @Test
  fun spoolRecoversTheOpenChunkAfterAKill() {
    val dir = tmp()
    val spool = ChunkSpool(File(dir, "open-chunk.jsonl"))
    val b = ChunkBuilder(ChunkBuilder.Config(), vp, { "s1" }, InMemorySeqStore(), { 1000L }, spool) { }
    b.add(Touch(1001, 1.0, 1.0, TouchPhase.BEGAN))
    b.add(full(1002))
    b.add(patch(1500))
    // The process dies here: the builder never flushes. A torn last line is skipped.
    spool.file.appendText("{\"frame\":{\"ts\":17")
    val chunk = ChunkSpool(spool.file).recover(now = 2000)
    assertNotNull(chunk)
    chunk!!
    assertEquals(2, chunk.frames.size)
    assertEquals(1, chunk.touches.size)
    assertEquals(1500, chunk.endedAt)
    assertEquals(0, chunk.seq)
    // A crash later than the last frame ends the chunk at the crash.
    assertEquals(1900, ChunkSpool(spool.file).recover(now = 2000, crashSessionId = "s1", crashAt = 1900)!!.endedAt)
    // However old (the clock may have moved): sent. An empty spool is removed.
    assertNotNull(ChunkSpool(spool.file).recover(now = 1001 + 7 * 24 * 3600 * 1000L))
    spool.file.writeText("{\"header\":{\"sessionId\":\"s1\",\"seq\":0,\"startedAt\":1,\"viewport\":{\"width\":1,\"height\":1,\"scale\":1},\"platform\":\"android\",\"masked\":true,\"mode\":\"session\"}}\n")
    assertNull(ChunkSpool(spool.file).recover(now = 2000))
    assertFalse(spool.file.exists())
  }

  @Test
  fun fileSeqStorePersistsPerSession() {
    val f = File(tmp(), "seq.json")
    assertEquals(0, FileSeqStore(f).next("a"))
    assertEquals(1, FileSeqStore(f).next("a"))
    assertEquals(0, FileSeqStore(f).next("b"))
    FileSeqStore(f).reset("b")
    assertEquals(0, FileSeqStore(f).next("b"))
  }
}
