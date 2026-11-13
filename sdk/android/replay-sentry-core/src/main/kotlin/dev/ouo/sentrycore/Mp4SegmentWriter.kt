package dev.ouo.sentrycore

import android.graphics.Bitmap
import android.os.Build
import dev.ouo.sentrycore.android.replay.video.MuxerConfig
import dev.ouo.sentrycore.android.replay.video.SimpleVideoEncoder
import java.io.File
import kotlin.math.roundToInt

/**
 * The ouo driver of sentry-java's video encoder (`SimpleVideoEncoder` and `SimpleMp4FrameMuxer`,
 * copied unmodified): one mp4 segment at a time, frames drawn as they come, the file read back
 * and deleted when finished. The only public surface of this module; the copy stays `internal`.
 *
 * H.264 through `MediaCodec` with a surface input, one keyframe every 6 frames (upstream's
 * setting), so a segment starts with a keyframe and plays alone. Android 8 (API 26) or later,
 * like upstream; [isSupported] says whether this device can.
 *
 * Not thread-safe: one thread (the replay compose thread) drives it. Every method but [abort]
 * may throw; the caller drops the segment.
 */
class Mp4SegmentWriter(
  private val file: File,
  val width: Int,
  val height: Int,
  private val frameRate: Int = 1,
  private val bitRate: Int = DEFAULT_BIT_RATE,
  debug: Boolean = false,
  log: ((String) -> Unit)? = null,
) {
  private val options = SentryOptions.of(debug, log)
  private var encoder: SimpleVideoEncoder? = null
  private var frames = 0

  /** Frames encoded into the open file. */
  val frameCount: Int get() = frames

  fun start() {
    check(encoder == null) { "already started" }
    file.parentFile?.mkdirs()
    if (file.exists()) file.delete()
    val e = SimpleVideoEncoder(options, MuxerConfig(file, width, height, frameRate, bitRate))
    try {
      e.start()
    } catch (t: Throwable) {
      e.release()
      throw t
    }
    encoder = e
    frames = 0
  }

  /** Draws [frame] (exactly [width] x [height]) as the next frame. */
  fun encode(frame: Bitmap) {
    val e = encoder ?: error("not started")
    require(frame.width == width && frame.height == height) { "frame size" }
    e.encode(frame)
    frames++
  }

  /** Finishes the file and returns its bytes (null when no frame was muxed). The file is deleted. */
  fun finish(): ByteArray? {
    val e = encoder ?: return null
    encoder = null
    try {
      e.release()
      if (frames == 0 || e.duration <= 0L || !file.isFile || file.length() == 0L) return null
      return file.readBytes()
    } finally {
      file.delete()
    }
  }

  /** Drops the open file. Never throws. */
  fun abort() {
    val e = encoder
    encoder = null
    try {
      e?.release()
    } catch (ignored: Throwable) {
    }
    try {
      file.delete()
    } catch (ignored: Throwable) {
    }
  }

  companion object {
    /** Sentry's default quality (`SentryReplayQuality.MEDIUM`): 75 kbit/s at one pixel per dp. */
    const val DEFAULT_BIT_RATE = 75_000
    const val DEFAULT_SIZE_SCALE = 1.0f

    val isSupported: Boolean get() = Build.VERSION.SDK_INT >= 26

    /**
     * The video size for a window of [windowWidth] x [windowHeight] pixels at [density]: one pixel
     * per dp times [sizeScale], each side brought to a multiple of 16 (codecs work in 16 px blocks
     * and some fail to configure otherwise). Ported from upstream's `ScreenshotRecorderConfig.fromSize`.
     */
    fun recordingSize(windowWidth: Int, windowHeight: Int, density: Float, sizeScale: Float = DEFAULT_SIZE_SCALE): Pair<Int, Int> {
      val d = if (density.isFinite() && density > 0f) density else 1f
      return blocks(((windowWidth / d) * sizeScale).roundToInt()) to blocks(((windowHeight / d) * sizeScale).roundToInt())
    }

    private fun blocks(v: Int): Int {
      val r = v % 16
      return if (r <= 8) maxOf(16, v - r) else v + (16 - r)
    }
  }
}
