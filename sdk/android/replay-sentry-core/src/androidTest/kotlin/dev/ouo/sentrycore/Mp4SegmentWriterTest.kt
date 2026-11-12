package dev.ouo.sentrycore

import android.graphics.Bitmap
import android.graphics.Color
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMetadataRetriever
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/** sentry-java's encoder through the ouo driver on a device: a segment is a playable mp4 that starts with a keyframe. */
@RunWith(AndroidJUnit4::class)
class Mp4SegmentWriterTest {
  private val dir = File(InstrumentationRegistry.getInstrumentation().targetContext.cacheDir, "mp4-test")

  private fun solid(w: Int, h: Int, color: Int) = Bitmap.createBitmap(w, h, Bitmap.Config.RGB_565).apply { eraseColor(color) }

  @Test
  fun fiveFramesMakeAPlayableSelfContainedSegment() {
    val (w, h) = Mp4SegmentWriter.recordingSize(1080, 2400, 2.625f)
    assertEquals(416 to 912, w to h) // 411x914 dp in 16 px blocks
    val file = File(dir, "a.mp4")
    val writer = Mp4SegmentWriter(file, w, h)
    writer.start()
    val colors = listOf(Color.RED, Color.RED, Color.GREEN, Color.BLUE, Color.BLUE)
    for (c in colors) writer.encode(solid(w, h, c))
    val bytes = writer.finish()
    assertNotNull(bytes)
    assertTrue("the file is deleted", !file.exists())
    // An ISO BMFF file: `ftyp` at offset 4.
    assertEquals("ftyp", String(bytes!!, 4, 4, Charsets.US_ASCII))

    val copy = File(dir, "copy.mp4").apply { parentFile?.mkdirs(); writeBytes(bytes) }
    val ex = MediaExtractor()
    ex.setDataSource(copy.path)
    assertEquals(1, ex.trackCount)
    val format = ex.getTrackFormat(0)
    assertEquals(MediaFormat.MIMETYPE_VIDEO_AVC, format.getString(MediaFormat.KEY_MIME))
    ex.selectTrack(0)
    var samples = 0
    var firstSync = false
    do {
      if (samples == 0) firstSync = ex.sampleFlags and MediaExtractor.SAMPLE_FLAG_SYNC != 0
      samples++
    } while (ex.advance())
    ex.release()
    assertEquals(5, samples)
    assertTrue("a segment starts with a keyframe", firstSync)

    val r = MediaMetadataRetriever()
    r.setDataSource(copy.path)
    assertEquals("5000", r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION))
    val frame = r.getFrameAtIndex(2)!!
    val px = frame.getPixel(frame.width / 2, frame.height / 2)
    assertTrue("frame 2 is green: ${Integer.toHexString(px)}", Color.green(px) > 200 && Color.red(px) < 60 && Color.blue(px) < 60)
    r.release()
    copy.delete()
  }

  @Test
  fun aSegmentWithoutFramesIsNothingAndAbortLeavesNoFile() {
    val file = File(dir, "b.mp4")
    val w = Mp4SegmentWriter(file, 64, 64)
    w.start()
    assertNull(w.finish())
    assertTrue(!file.exists())
    val w2 = Mp4SegmentWriter(file, 64, 64)
    w2.start()
    w2.encode(solid(64, 64, Color.WHITE))
    w2.abort()
    w2.abort()
    assertTrue(!file.exists())
  }
}
