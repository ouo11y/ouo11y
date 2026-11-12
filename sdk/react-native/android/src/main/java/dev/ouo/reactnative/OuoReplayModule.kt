package dev.ouo.reactnative

import android.content.Context
import dev.ouo.replay.OuoReplay
import dev.ouo.replay.OuoReplayConfig
import dev.ouo.replay.OuoReplayFormat
import dev.ouo.replay.OuoReplayOtlp
import dev.ouo.replay.core.Gzip
import dev.ouo.replay.core.HttpRequest
import dev.ouo.replay.core.ReplayMode
import dev.ouo.replay.core.ReplayOptions
import dev.ouo.replay.core.UrlConnectionTransport
import dev.ouo.signals.Signals
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.Executors

/**
 * Options passed by `initRUM({ replay })` through `start(endpoint, options)`: the iOS module's
 * `StartOptions`, read as a plain map by [ReplayOptions.parse] so that a wrong type or an absurd
 * number from JavaScript becomes a default, never an exception (client SDK spec ERR-1).
 *
 * Legacy keys (all optional): `sessionId`, `projectId`, `projectToken` (ADR-0007), `mode` ("auto",
 * "session" or "navigation"), `frameInterval`, `maskText`, `maskInputs`, `maskImages`,
 * `maskWebViews`, `debug`, `holdUploads`, and `jpegQuality` (1..100), `maxLongestSide`.
 *
 * Replay over OTLP (ADR-0019 decision 5), used only when `otlp` is present:
 * `otlp: { logsUrl, resource: { [key]: string | number | boolean }, schemaUrl, scopeVersion }`,
 * `format` ("pixel" | "structure"), `replayMode` ("session" | "buffer"), `bufferSeconds`,
 * `replayId` (32 hex), `keyframeIntervalMs`, `chunkMaxBytes`.
 */
typealias StartOptions = Map<String, Any?>

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

  /** The legacy path: throws to JS, as it always did, on an endpoint or a credential it cannot use. */
  private fun config(endpoint: String, raw: StartOptions): OuoReplayConfig {
    val options = ReplayOptions.parse(raw)
    OuoReplay.reportInvalidOptions(options.problems)
    val url = endpoint.trim()
    if (!(url.startsWith("http://") || url.startsWith("https://"))) throw InvalidEndpointException(endpoint)
    if (options.projectId.isEmpty() || options.projectToken.isEmpty()) throw MissingCredentialException()
    return config(url, options)
  }

  private fun config(url: String, options: ReplayOptions): OuoReplayConfig {
    val projectId = options.projectId
    val token = options.projectToken
    return OuoReplayConfig(
      endpoint = url,
      projectId = projectId,
      projectToken = token,
      sessionId = { sessionId },
      mode = ReplayMode.of(options.mode),
      frameInterval = options.frameInterval,
      maskText = options.maskText,
      maskInputs = options.maskInputs,
      maskImages = options.maskImages,
      maskWebViews = options.maskWebViews,
      debug = options.debug,
      jpegQuality = options.jpegQuality,
      maxLongestSide = options.maxLongestSide,
      holdUploads = options.holdUploads,
      otlp = options.otlp?.let { OuoReplayOtlp(it.logsUrl, it.resource, it.schemaUrl, it.scopeVersion) },
      format = if (options.format == ReplayOptions.FORMAT_STRUCTURE) OuoReplayFormat.STRUCTURE else OuoReplayFormat.PIXEL,
      delivery = options.delivery,
      bufferSeconds = options.bufferSeconds,
      replayId = options.replayId,
      keyframeIntervalMs = options.keyframeIntervalMs,
      chunkMaxBytes = options.chunkMaxBytes,
    )
  }

  /** Runs a native entry point so that nothing it throws reaches JavaScript or the app (client SDK spec ERR-1). */
  private inline fun <T> guarded(fallback: T, block: () -> T): T =
    try {
      block()
    } catch (e: Throwable) {
      OuoReplay.reportInvalidOptions(listOf("native"))
      fallback
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
    }

    // The activity's onResume can run before Signals registered its lifecycle callbacks, with no
    // current activity known yet at OnCreate (about 1 cold launch in 4 on an emulator): then no
    // window would ever be measured. So every later entry point attaches again once the activity is
    // known (idempotent per window).
    OnActivityEntersForeground { attachFrames() }

    /**
     * `start(endpoint: string, options: object): void`. Without `options.otlp` this is the legacy
     * recorder, exactly as before (it throws on a bad endpoint or a missing credential). With
     * `options.otlp` replay goes over OTLP and this never throws: options that cannot be used are
     * replaced by defaults and counted, and an unusable `otlp` starts nothing (see `replayStatus`).
     */
    Function("start") { endpoint: String, options: StartOptions ->
      val parsed = ReplayOptions.parse(options)
      if (parsed.otlp == null && !parsed.otlpInvalid) {
        val config = config(endpoint, options)
        if (parsed.sessionId.isNotEmpty()) sessionId = parsed.sessionId
        OuoReplay.start(context, config, appContext.currentActivity)
      } else {
        guarded(Unit) {
          OuoReplay.reportInvalidOptions(parsed.problems)
          if (!parsed.otlpInvalid) {
            if (parsed.sessionId.isNotEmpty()) sessionId = parsed.sessionId
            OuoReplay.start(context, config(endpoint.trim(), parsed), appContext.currentActivity)
          }
        }
      }
    }

    // ---- replay over OTLP (ADR-0019 decision 5); no effect on the legacy path unless noted ----

    /** `capture(trigger: "error" | "crash" | "anr" | "hang" | "manual"): void`. Buffer mode: sends the ring, then records as a session. */
    Function("capture") { trigger: String -> guarded(Unit) { OuoReplay.capture(trigger) } }

    /** `setViewId(id: string): void`. The `ouo.view.id` of the chunks opened from now on; "" clears it. */
    Function("setViewId") { id: String -> guarded(Unit) { OuoReplay.setViewId(id) } }

    /** `mask(reactTag: number): void`. Masks that view in both formats and on the legacy path. Mask wins over unmask. */
    Function("mask") { reactTag: Int -> guarded(Unit) { OuoReplay.mask(reactTag) } }

    /** `unmask(reactTag: number): void`. Shows that view's subtree; secure inputs and masked views inside stay masked. */
    Function("unmask") { reactTag: Int -> guarded(Unit) { OuoReplay.unmask(reactTag) } }

    /** `clearMask(reactTag: number): void`. Forgets mask and unmask for that view (call when it unmounts). */
    Function("clearMask") { reactTag: Int -> guarded(Unit) { OuoReplay.clearMask(reactTag) } }

    /** `endSession(): void`. Stops replay; over OTLP the stream ends with `ouo.replay.ended`, reason `session_end`. */
    Function("endSession") { guarded(Unit) { OuoReplay.endSession() } }

    /**
     * `replayStatus(): { recording, otlp, format?, replayId?, streamId?, lastSequence?, partial?, triggered?, stopped?, counts: { [reason]: number }, errors }`.
     */
    Function("replayStatus") { guarded(emptyMap<String, Any>()) { OuoReplay.status() } }

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

    /** `stop(): void`. Over OTLP the stream ends with `ouo.replay.ended`, reason `stop`. */
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
