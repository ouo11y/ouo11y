package dev.ouo.replay

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import dev.ouo.replay.core.Logger
import dev.ouo.replay.core.ReplayOTLPOptions
import dev.ouo.replay.core.ReplayRecorderMode
import dev.ouo.replay.core.ReplayScope
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Both pixel recorders build and start their pipeline. Regression: the video adapter's fields were
 * declared after the stream whose initializer reads them, so `pixel/video` never started on a device
 * while every JVM test passed.
 */
@RunWith(AndroidJUnit4::class)
class VideoPipelineTest {
  @Test
  fun bothPixelModesStart() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    for (mode in listOf(ReplayRecorderMode.PIXEL_FRAMES, ReplayRecorderMode.PIXEL_VIDEO)) {
      val options = ReplayOTLPOptions("http://127.0.0.1:9/v1/logs", ReplayScope(listOf("service.name" to "test"), "1.0.0", ""), recorder = mode)
      val config = OuoReplayConfig("http://127.0.0.1:9", "p", "t", { "0123456789abcdef0123456789abcdef" }, otlp = options)
      val pipeline = OtlpPipeline(context, config, options, ScreenCapturer(1000, 50), Logger.NONE)
      assertTrue("$mode starts", pipeline.start())
      assertTrue(pipeline.isActive)
      assertEquals(0, pipeline.diagnostics(0, 0)["replay.errors"])
      pipeline.discard(null)
    }
  }
}
