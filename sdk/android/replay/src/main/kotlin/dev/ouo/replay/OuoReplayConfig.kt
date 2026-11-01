package dev.ouo.replay

import android.content.Context
import dev.ouo.replay.core.RedactionRules
import dev.ouo.replay.core.ReplayMode
import java.io.File

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
) {
  val redactionRules: RedactionRules get() = RedactionRules(maskText, maskInputs, maskImages, maskWebViews, maskClasses)

  companion object {
    /** `noBackupFilesDir/ouo/replay`: the spool, the outbox and the seq store, excluded from device backups. */
    fun directory(context: Context): File = File(context.noBackupFilesDir, "ouo/replay")
  }
}
