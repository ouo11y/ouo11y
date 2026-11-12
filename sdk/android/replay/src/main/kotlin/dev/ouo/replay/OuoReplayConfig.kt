package dev.ouo.replay

import android.content.Context
import dev.ouo.replay.core.RedactionRules
import dev.ouo.replay.core.ReplayDelivery
import dev.ouo.replay.core.ReplayMode
import java.io.File

/** What is recorded (ADR-0019 decision 5): masked screenshots (`ouo-frames/3`) or the view tree as rectangles (`ouo-wireframe/1`). */
enum class OuoReplayFormat { PIXEL, STRUCTURE }

/**
 * Replay over OTLP (client SDK spec 11): each chunk is one protobuf request to [logsUrl] (the
 * Collector's `/v1/logs`) under scope `ouo.replay`. [resource] values are strings, booleans, longs
 * or doubles.
 */
data class OuoReplayOtlp(
  val logsUrl: String,
  val resource: List<Pair<String, Any>> = emptyList(),
  val schemaUrl: String = "",
  val scopeVersion: String = "",
)

/** Host configuration (docs/specs/mobile-replay.md, "Host API"); the Android twin of the Swift `OuoReplayConfig`. */
data class OuoReplayConfig(
  /** Replay receiver base URL (the collector's `ouoreplay` port, 4319 by default); chunks go to `${endpoint}/v1/replay/chunks`. */
  val endpoint: String,
  /** Project id and token: the HTTP Basic credential of every upload (ADR-0007). */
  val projectId: String,
  val projectToken: String,
  /** Called when a chunk is opened; returns the active `session.id`. */
  val sessionId: () -> String,
  val mode: ReplayMode = ReplayMode.AUTO,
  /** Shortest time between two frames in `session` mode, seconds. */
  val frameInterval: Double = 1.0,
  val maskText: Boolean = true,
  /** Text inputs stay masked when labels are shown. */
  val maskInputs: Boolean = true,
  val maskImages: Boolean = true,
  val maskWebViews: Boolean = true,
  /** Extra view class names to mask (fully qualified, superclasses match too). */
  val maskClasses: Set<String> = emptySet(),
  val debug: Boolean = false,
  val flushIntervalMs: Long = 5_000,
  /** JPEG quality, 0..100. */
  val jpegQuality: Int = 50,
  /** Longest frame side in pixels. */
  val maxLongestSide: Int = 1000,
  /** Keep chunks on the device until the host releases their session ([OuoReplay.releaseHeld]). */
  val holdUploads: Boolean = false,
  /** Set: replay goes over OTLP with the options below. Null: the legacy upload, unchanged. */
  val otlp: OuoReplayOtlp? = null,
  val format: OuoReplayFormat = OuoReplayFormat.PIXEL,
  /** `session` records and sends everything; `buffer` keeps the last [bufferSeconds] in memory until [OuoReplay.capture]. */
  val delivery: ReplayDelivery = ReplayDelivery.SESSION,
  val bufferSeconds: Int = 60,
  /** 32 lowercase hex characters, or null for a random id. */
  val replayId: String? = null,
  val keyframeIntervalMs: Long = 300_000,
  /** Compressed bytes after which a chunk is closed (the hard limit is 1 MiB). */
  val chunkMaxBytes: Int = 256 * 1024,
) {
  val redactionRules: RedactionRules get() = RedactionRules(maskText, maskInputs, maskImages, maskWebViews, maskClasses)

  companion object {
    /** `noBackupFilesDir/ouo/replay`: the spool, the outbox and the seq store, excluded from device backups. */
    fun directory(context: Context): File = File(context.noBackupFilesDir, "ouo/replay")
  }
}
