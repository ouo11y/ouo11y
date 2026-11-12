package dev.ouo.reactnative

import android.content.Context
import dev.ouo.replay.OuoReplay
import dev.ouo.replay.OuoReplayConfig
import dev.ouo.replay.core.Gzip
import dev.ouo.replay.core.HttpRequest
import dev.ouo.replay.core.ReplayEndReason
import dev.ouo.replay.core.ReplayMaskRegistry
import dev.ouo.replay.core.ReplayMode
import dev.ouo.replay.core.ReplayOTLPOptions
import dev.ouo.replay.core.UrlConnectionTransport
import dev.ouo.signals.Signals
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import java.util.concurrent.Executors

/**
 * Options of the legacy upload path, passed by `initRUM({ replay })`: the iOS module's
 * `StartOptions`. `recoverPendingChunk`, `heldReplaySessions` and `releaseHeldReplay` take it as
 * before; `start` reads the same keys from a plain object ([legacyOptions]) because it must first
 * see whether `otlp` is there.
 */
class StartOptions : Record {
  @Field val sessionId: String = ""

  /** Project credential (ADR-0007), validated by JS first. */
  @Field val projectId: String = ""

  @Field val projectToken: String = ""

  /** "auto", "session" or "navigation"; anything else is auto. */
  @Field val mode: String = "auto"

  @Field val frameInterval: Double = 1.0

  @Field val maskText: Boolean = true

  @Field val maskInputs: Boolean = true

  @Field val maskImages: Boolean = true

  @Field val maskWebViews: Boolean = true

  @Field val debug: Boolean = false

  /** Keep chunks on the device until JS releases their session (`replay.keepAtNextLaunch`). */
  @Field val holdUploads: Boolean = false
}

/** The legacy options of `start`, read from the object JavaScript passed: the fields and defaults of [StartOptions]. */
private class LegacyStart(raw: Map<String, Any?>) {
  val sessionId = raw["sessionId"] as? String ?: ""
  val projectId = raw["projectId"] as? String ?: ""
  val projectToken = raw["projectToken"] as? String ?: ""
  val mode = raw["mode"] as? String ?: "auto"
  val frameInterval = ReplayOTLPOptions.number(raw["frameInterval"]) ?: 1.0
  val maskText = raw["maskText"] as? Boolean ?: true
  val maskInputs = raw["maskInputs"] as? Boolean ?: true
  val maskImages = raw["maskImages"] as? Boolean ?: true
  val maskWebViews = raw["maskWebViews"] as? Boolean ?: true
  val debug = raw["debug"] as? Boolean ?: false
  val holdUploads = raw["holdUploads"] as? Boolean ?: false
}

private class InvalidEndpointException(endpoint: String) : CodedException("ERR_OUO_REPLAY_ENDPOINT", "invalid replay endpoint: $endpoint", null)

private class MissingCredentialException :
  CodedException(
    "ERR_OUO_REPLAY_CREDENTIAL",
    "projectId and projectToken are required (ADR-0007); the collector rejects uploads without Authorization: Basic base64(projectId:projectToken)",
    null,
  )

/**
 * Expo bridge for the Android replay of sdk/android (`dev.ouo.replay.OuoReplay`), with the function
 * names of the iOS module (`sdk/react-native/ios/OuoReplayModule.swift`) so the JavaScript is the same
 * on both platforms, plus the OTLP delivery and the native signals of sdk/android ([Signals]:
 * crashes, hangs, foreground terminations, frames and app start). Recorder and signals are process
 * singletons.
 */
class OuoReplayModule : Module() {
  @Volatile private var sessionId = ""

  /** When this JS runtime's module instance was created (epoch ms): the start of a warm launch. */
  private val createdAtMs = System.currentTimeMillis().toDouble()
  private val appStart: Map<String, Any> by lazy { Signals.appStart(createdAtMs.toLong()) }
  private val http = Executors.newSingleThreadExecutor { r -> Thread(r, "ouo-otlp").apply { isDaemon = true } }

  private val context: Context
    get() = appContext.reactContext?.applicationContext ?: throw Exceptions.ReactContextLost()

  private fun config(endpoint: String, options: StartOptions): OuoReplayConfig =
    config(endpoint, options.projectId, options.projectToken, options.mode, options.frameInterval, options.maskText, options.maskInputs, options.maskImages, options.maskWebViews, options.debug, options.holdUploads)

  /** The legacy path: throws to JS, as it always did, on an endpoint or a credential it cannot use. */
  private fun config(
    endpoint: String, rawProjectId: String, rawToken: String, mode: String, frameInterval: Double,
    maskText: Boolean, maskInputs: Boolean, maskImages: Boolean, maskWebViews: Boolean, debug: Boolean, holdUploads: Boolean,
  ): OuoReplayConfig {
    val url = endpoint.trim()
    if (!(url.startsWith("http://") || url.startsWith("https://"))) throw InvalidEndpointException(endpoint)
    val projectId = rawProjectId.trim()
    val token = rawToken.trim()
    if (projectId.isEmpty() || token.isEmpty()) throw MissingCredentialException()
    return OuoReplayConfig(
      endpoint = url,
      projectId = projectId,
      projectToken = token,
      sessionId = { sessionId },
      mode = ReplayMode.of(mode),
      frameInterval = frameInterval,
      maskText = maskText,
      maskInputs = maskInputs,
      maskImages = maskImages,
      maskWebViews = maskWebViews,
      debug = debug,
      holdUploads = holdUploads,
    )
  }

  /** `start` with `options.otlp`: nothing here throws; what cannot be used is counted (`replayDiagnostics`). */
  private fun startOtlp(endpoint: String, options: Map<String, Any?>, otlp: ReplayOTLPOptions, found: List<String>) {
    val (common, more) = ReplayOTLPOptions.Common.parse(options)
    val problems = found + more
    if (common.projectId.isEmpty() || common.projectToken.isEmpty()) {
      // The collector answers 401 without the credential: nothing would arrive.
      OuoReplay.noteOptionProblems(problems + "projectId and projectToken are required", common.debug)
      return
    }
    if (common.sessionId.isNotEmpty()) sessionId = common.sessionId
    val config = OuoReplayConfig(
      endpoint = endpoint.trim().ifEmpty { otlp.logsUrl },
      projectId = common.projectId,
      projectToken = common.projectToken,
      sessionId = { sessionId },
      frameInterval = common.frameInterval,
      maskText = common.maskText,
      maskInputs = common.maskInputs,
      maskImages = common.maskImages,
      maskWebViews = common.maskWebViews,
      debug = common.debug,
      otlp = otlp,
    )
    OuoReplay.noteOptionProblems(problems, common.debug)
    OuoReplay.start(context, config, appContext.currentActivity)
  }

  /** Runs a native entry point of the OTLP path so that nothing it throws reaches JavaScript or the app (client SDK spec ERR-1). */
  private inline fun guarded(block: () -> Unit) {
    try {
      block()
    } catch (e: Throwable) {
      runCatching { OuoReplay.noteOptionProblems(listOf("native call failed: ${e.javaClass.simpleName}")) }
    }
  }

  /** A React tag from JavaScript: a positive whole number, anything else is ignored. */
  private fun tag(value: Double?): Int? {
    if (value == null || !value.isFinite() || value < 1 || value > 2_147_483_647 || value != Math.rint(value)) return null
    return value.toInt()
  }

  /** FrameMetrics listens per window: the current activity's, once there is one (see OnActivityEntersForeground). */
  private fun attachFrames() = Signals.attachCurrent(appContext.currentActivity)

  override fun definition() = ModuleDefinition {
    Name("OuoReplay")

    /** A main-thread hang is over: `{ report }`, a `hang` report (mobile SDK spec C3.1). */
    Events("onHang")

    // Before JS asks for anything: the previous run's crash or termination is read before this run
    // writes its own state, and the frame counters run from the JS runtime's start.
    OnCreate {
      appContext.reactContext?.let { Signals.init(it) }
      attachFrames()
      // A new JavaScript runtime hands out React tags again: masks set by the last one are void.
      ReplayMaskRegistry.shared.reset()
    }

    // The activity's onResume can run before Signals registered its lifecycle callbacks, with no
    // current activity known yet at OnCreate (about 1 cold launch in 4 on an emulator): then no
    // window would ever be measured. So every later entry point attaches again once the activity is
    // known (idempotent per window).
    OnActivityEntersForeground { attachFrames() }

    /**
     * `start(endpoint: string, options: object)`.
     *
     * Without `options.otlp` this is the upload path that existed before, with the options read as
     * before ([StartOptions]; `mode` is `auto | session | navigation`).
     *
     * With `options.otlp` replay goes out as OTLP log records (ADR-0021 decision 5) and nothing
     * here throws: a value that cannot be used falls back to its default and is counted
     * (`replayDiagnostics()`), and options replay cannot run with leave it off. Keys:
     * - `otlp: { logsUrl: string, resource?: { [key]: string | number | boolean }, schemaUrl?: string,
     *   scopeVersion?: string, previousExit?: "crash" | "background_kill" }`
     * - `mode?: "pixel/frames" | "pixel/video"` (default `pixel/frames`, `ouo-frames/3`; `pixel/video`
     *   is `ouo-video/1`: the same capture and masks encoded as mp4 segments by sentry-java's encoder,
     *   Android 8 or later; `structure/wireframe` is not in this build and leaves replay off)
     * - `cadence?: "auto" | "session" | "navigation"` (what `mode` means on the legacy path)
     * - `buffer?: { seconds?: number }` (present: keep a ring of that many seconds, default 60,
     *   and send on `capture(trigger)`; absent: record the whole session)
     * - `replayId?: string` (32 lowercase hex), `keyframeIntervalMs?: number`, `chunkMaxBytes?: number`
     * - `sessionId`, `projectId`, `projectToken`, `frameInterval`, `maskText`, `maskInputs`,
     *   `maskImages`, `maskWebViews`, `debug` as before
     */
    Function("start") { endpoint: String, options: Map<String, Any?> ->
      when (val parsed = ReplayOTLPOptions.parse(options)) {
        is ReplayOTLPOptions.Parsed.Legacy -> {
          val o = LegacyStart(options)
          val config = config(endpoint, o.projectId, o.projectToken, o.mode, o.frameInterval, o.maskText, o.maskInputs, o.maskImages, o.maskWebViews, o.debug, o.holdUploads)
          if (o.sessionId.isNotEmpty()) sessionId = o.sessionId
          OuoReplay.start(context, config, appContext.currentActivity)
        }
        is ReplayOTLPOptions.Parsed.Off -> guarded { OuoReplay.noteOptionProblems(parsed.problems, options["debug"] as? Boolean ?: false) }
        is ReplayOTLPOptions.Parsed.Otlp -> guarded { startOtlp(endpoint, options, parsed.options, parsed.problems) }
      }
    }

    // ---- OTLP replay (ADR-0021 decision 5) ----

    /**
     * `capture(trigger: string)`: buffer mode only. Sends the ring and records on as a session.
     * `trigger` is `error`, `crash`, `anr`, `hang` or `manual`; anything else counts as `manual`.
     */
    Function("capture") { trigger: String? -> guarded { OuoReplay.capture(trigger ?: "manual") } }

    /** `setViewId(id: string)`: the screen the next chunks belong to (`ouo.view.id`). */
    Function("setViewId") { id: String? -> guarded { OuoReplay.setViewId(id ?: "") } }

    /** `mask(reactTag: number)`: masks that view in every recorder. Mask wins over unmask. */
    Function("mask") { reactTag: Double? -> guarded { tag(reactTag)?.let { OuoReplay.mask(it) } } }

    /**
     * `unmask(reactTag: number)`: shows that view and what is inside it. A mask inside it still
     * masks, and a secure field is always masked.
     */
    Function("unmask") { reactTag: Double? -> guarded { tag(reactTag)?.let { OuoReplay.unmask(it) } } }

    /**
     * `endSession()`: stops and ends the stream with `ouo.replay.ended`, reason `session_end`
     * (`stop()` ends it with reason `stop`).
     */
    Function("endSession") { guarded { OuoReplay.stop(ReplayEndReason.SESSION_END) } }

    /**
     * `discardPending(): Promise<void>`: stops the recorder without an end record and deletes
     * every replay record not yet accepted (consent withdrawn).
     */
    AsyncFunction("discardPending") { promise: Promise ->
      try {
        OuoReplay.discardPending(context) { promise.resolve(null) }
      } catch (e: Throwable) {
        promise.resolve(null)
      }
    }

    /**
     * `replayDiagnostics(): { [counter: string]: number }`: what replay dropped or could not do
     * in this process, by reason (frames, events, chunks lost or rejected, option problems).
     */
    Function("replayDiagnostics") {
      try {
        OuoReplay.diagnostics()
      } catch (e: Throwable) {
        emptyMap<String, Int>()
      }
    }

    /** Sends the chunk a crash left open in the previous run; JS calls it before its sampling decision. */
    Function("recoverPendingChunk") { endpoint: String, options: StartOptions ->
      OuoReplay.recoverPendingChunk(context, config(endpoint, options))
    }

    /** Finished sessions whose chunks wait on the device: `[{ sessionId, chunks, bytes, firstAt, lastAt }]`. */
    AsyncFunction("heldReplaySessions") { endpoint: String, options: StartOptions, promise: Promise ->
      OuoReplay.heldSessions(context, config(endpoint, options)) { held ->
        promise.resolve(
          held.map {
            mapOf("sessionId" to it.sessionId, "chunks" to it.chunks, "bytes" to it.bytes.toDouble(), "firstAt" to it.firstAt.toDouble(), "lastAt" to it.lastAt.toDouble())
          }
        )
      }
    }

    Function("releaseHeldReplay") { endpoint: String, options: StartOptions, id: String, keep: Boolean ->
      OuoReplay.releaseHeld(context, config(endpoint, options), id, keep)
    }

    // ---- OTLP delivery (checklist N48): gzip and POST off the JS thread ----

    /**
     * gzips `body` and POSTs it with `headers` plus `content-encoding: gzip`. Resolves
     * `{ status, retryAfter? }` (the raw header; JS parses seconds and HTTP dates), status 0 when the
     * request did not reach the server.
     */
    AsyncFunction("postOtlp") { url: String, headers: Map<String, String>, body: String, promise: Promise ->
      http.execute {
        val raw = body.toByteArray(Charsets.UTF_8)
        val gz = runCatching { Gzip.compress(raw) }.getOrNull()
        val all = headers.toMutableMap()
        val payload = if (gz != null && gz.size < raw.size) {
          all["content-encoding"] = "gzip"
          gz
        } else {
          raw
        }
        val answer = UrlConnectionTransport.send(HttpRequest(url, all, payload))
        val result = mutableMapOf<String, Any>("status" to answer.status)
        answer.retryAfter?.let { result["retryAfter"] = it }
        promise.resolve(result)
      }
    }

    Function("pause") { OuoReplay.pause() }

    Function("resume") { OuoReplay.resume() }

    Function("isRecording") { OuoReplay.isRecording }

    AsyncFunction("flush") { promise: Promise -> OuoReplay.flush { promise.resolve(null) } }

    Function("sessionDidRotate") { id: String ->
      sessionId = id
      OuoReplay.sessionDidRotate(id)
    }

    Function("setSessionId") { id: String -> sessionId = id }

    /** A route change: the frame for the new screen in navigation mode. */
    Function("screenDidChange") { OuoReplay.screenDidChange() }

    Function("stop") { OuoReplay.stop() }

    // ---- native crashes, hangs and terminations (docs/specs/mobile-sdk.md C2, C3) ----

    /**
     * Installs the uncaught exception handler (chained to React Native's) and the hang watchdog,
     * whose reports arrive as `onHang` events, and sets the session a crash belongs to.
     */
    Function("installCrashReporter") { sessionId: String, startedAtMs: Double ->
      attachFrames()
      Signals.install(sessionId, startedAtMs.toLong()) { report -> sendEvent("onHang", mapOf("report" to report)) }
    }

    Function("setCrashSessionId") { id: String, startedAtMs: Double -> Signals.setSession(id, startedAtMs.toLong()) }

    /** The previous run's crash report (JSON), or a `termination` report when it was killed in the foreground; null otherwise. */
    Function("takePendingCrash") { Signals.takePendingReport() }

    // ---- mobile vitals (docs/specs/mobile-vitals.md) ----

    /** Start of this launch for `ouo.app.start`: `{ processStartMs, type, prewarmed }`, resolved once per runtime. */
    Function("getAppStartInfo") {
      attachFrames()
      appStart
    }

    /** Cumulative frame counters since the module started; JS diffs two snapshots. */
    Function("getFrameStats") {
      attachFrames()
      Signals.frameStats()
    }
  }
}
