package dev.ouo.replay.core

import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Decides whether a frame is unchanged, a full image or a list of patches (ADR-0014), by hashing
 * every 64 px tile of the redacted frame and comparing with the last frame *sent*. Changed tiles
 * are merged into rectangles that do not overlap: runs of changed tiles per tile row, and runs
 * with the same columns in consecutive rows become one rectangle. More than [maxPatches]
 * rectangles become their bounding box. When the rectangles cover more than [maxChangedFraction]
 * of the frame, a full image is cheaper and goes instead. The same rules as the Swift
 * `TileDiffer` of `sdk/ios`. Not thread-safe: the compose thread owns it.
 */
class TileDiffer(val maxPatches: Int = 8, val maxChangedFraction: Double = 0.5) {
  sealed class Decision {
    /** No tile changed: send nothing. */
    object Unchanged : Decision()

    object Full : Decision()

    data class Patches(val rects: List<PixelRect>) : Decision()
  }

  private class Hashes(val width: Int, val height: Int, val tiles: LongArray)

  private var sent: Hashes? = null
  private var pending: Hashes? = null

  /**
   * [pixels] holds [height] rows of [rowBytes] bytes, [bytesPerPixel] bytes per pixel (2 for the
   * RGB_565 frames of the Android capture). [forceFull] asks for a full image whenever the frame
   * changed (the first frame of a chunk, a screen change). After [reset] or a size change the
   * frame is a full image even when unchanged.
   */
  fun diff(pixels: ByteArray, width: Int, height: Int, rowBytes: Int, bytesPerPixel: Int, forceFull: Boolean): Decision {
    val hashes = hash(pixels, width, height, rowBytes, bytesPerPixel)
    pending = hashes
    val last = sent
    if (last == null || last.width != width || last.height != height) return Decision.Full
    val ts = TILE
    val cols = (width + ts - 1) / ts
    val rows = (height + ts - 1) / ts
    val changed = BooleanArray(hashes.tiles.size)
    var any = false
    for (i in changed.indices) {
      if (hashes.tiles[i] != last.tiles[i]) {
        changed[i] = true
        any = true
      }
    }
    if (!any) return Decision.Unchanged
    if (forceFull) return Decision.Full
    var rects = merge(changed, cols, rows)
    if (rects.size > maxPatches) rects = listOf(boundingBox(rects))
    val clamped = rects.map { r ->
      val x = r.x * ts
      val y = r.y * ts
      PixelRect(x, y, minOf((r.x + r.w) * ts, width) - x, minOf((r.y + r.h) * ts, height) - y)
    }
    val area = clamped.sumOf { it.area.toLong() }
    if (area > maxChangedFraction * width.toLong() * height) return Decision.Full
    return Decision.Patches(clamped)
  }

  /** The frame [diff] looked at last was sent: later frames are compared with it. */
  fun commit() {
    pending?.let { sent = it }
    pending = null
  }

  /** Forgets the last frame sent, so the next frame is a full image (resume, screen change). */
  fun reset() {
    sent = null
    pending = null
  }

  companion object {
    const val TILE = 64
    private const val OFFSET = -0x340d631b7bdddcdbL // 0xcbf29ce484222325, FNV-1a 64 offset basis
    private const val PRIME = 0x100000001b3L

    /** 64-bit FNV-1a over 8-byte words of each tile's rows (shorter words for the row's tail). */
    private fun hash(pixels: ByteArray, width: Int, height: Int, rowBytes: Int, bpp: Int): Hashes {
      val ts = TILE
      val cols = (width + ts - 1) / ts
      val rows = (height + ts - 1) / ts
      val tiles = LongArray(cols * rows) { OFFSET }
      val buf = ByteBuffer.wrap(pixels).order(ByteOrder.LITTLE_ENDIAN)
      for (y in 0 until height) {
        val row = y * rowBytes
        val base = (y / ts) * cols
        for (c in 0 until cols) {
          var h = tiles[base + c]
          var at = row + c * ts * bpp
          val end = row + minOf((c + 1) * ts, width) * bpp
          while (at + 8 <= end) {
            h = (h xor buf.getLong(at)) * PRIME
            at += 8
          }
          while (at < end) {
            h = (h xor (pixels[at].toLong() and 0xff)) * PRIME
            at += 1
          }
          tiles[base + c] = h
        }
      }
      return Hashes(width, height, tiles)
    }

    /** Changed tiles as non-overlapping rectangles, in tile units, sorted by row then column. */
    fun merge(changed: BooleanArray, cols: Int, rows: Int): List<PixelRect> {
      val done = mutableListOf<PixelRect>()
      var open = mutableListOf<PixelRect>()
      for (r in 0 until rows) {
        val next = mutableListOf<PixelRect>()
        var c = 0
        while (c < cols) {
          if (!changed[r * cols + c]) {
            c++
            continue
          }
          val start = c
          while (c < cols && changed[r * cols + c]) c++
          val w = c - start
          val i = open.indexOfFirst { it.x == start && it.w == w }
          if (i >= 0) {
            val rect = open.removeAt(i)
            next.add(rect.copy(h = rect.h + 1))
          } else {
            next.add(PixelRect(start, r, w, 1))
          }
        }
        done += open
        open = next
      }
      return (done + open).sortedWith(compareBy({ it.y }, { it.x }))
    }

    fun boundingBox(rects: List<PixelRect>): PixelRect {
      val x0 = rects.minOf { it.x }
      val y0 = rects.minOf { it.y }
      val x1 = rects.maxOf { it.x + it.w }
      val y1 = rects.maxOf { it.y + it.h }
      return PixelRect(x0, y0, x1 - x0, y1 - y0)
    }
  }
}
