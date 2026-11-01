package dev.ouo.reactnative

import android.content.Context
import dev.ouo.replay.OuoReplay
import dev.ouo.replay.OuoReplayConfig
import dev.ouo.replay.core.Gzip
import dev.ouo.replay.core.HttpRequest
import dev.ouo.replay.core.ReplayMode
import dev.ouo.replay.core.UrlConnectionTransport
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import java.util.concurrent.Executors

/** Options passed by `initRUM({ replay })` through `start(endpoint, options)`: the iOS module's `StartOptions`. */
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
 * on both platforms, plus the OTLP delivery and the vitals measurements ([Vitals]). The recorder is
 * a process singleton. Crash and hang functions are not here yet (roadmap W9 part 2, on
 * opentelemetry-android): the JavaScript checks each one before it calls it.
 */
class OuoReplayModule : Module() {
  @Volatile private var sessionId = ""

  /** When this JS runtime's module instance was created (epoch ms): the start of a warm launch. */
  private val createdAtMs = System.currentTimeMillis().toDouble()
  private val appStart: Map<String, Any> by lazy { Vitals.beginRuntime(createdAtMs) }
  private val http = Executors.newSingleThreadExecutor { r -> Thread(r, "ouo-otlp").apply { isDaemon = true } }

  private val context: Context
    get() = appContext.reactContext?.applicationContext ?: throw Exceptions.ReactContextLost()

  private fun config(endpoint: String, options: StartOptions): OuoReplayConfig {
    val url = endpoint.trim()
    if (!(url.startsWith("http://") || url.startsWith("https://"))) throw InvalidEndpointException(endpoint)
    val projectId = options.projectId.trim()
    val token = options.projectToken.trim()
    if (projectId.isEmpty() || token.isEmpty()) throw MissingCredentialException()
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
      holdUploads = options.holdUploads,
    )
  }

  override fun definition() = ModuleDefinition {
    Name("OuoReplay")

    // Frame counters run from the module's creation (the JS runtime's start), not only while replay
    // records, so the app start window has frames too.
    OnCreate { appContext.reactContext?.let { Vitals.startFrameTracking(it) } }

    OnActivityEntersForeground { Vitals.resume() }

    OnActivityEntersBackground { Vitals.pause() }

    Function("start") { endpoint: String, options: StartOptions ->
      val config = config(endpoint, options)
      if (options.sessionId.isNotEmpty()) sessionId = options.sessionId
      OuoReplay.start(context, config, appContext.currentActivity)
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

    // ---- mobile vitals (docs/specs/mobile-vitals.md) ----

    /** Start of this launch for `ouo.app.start`: `{ processStartMs, type, prewarmed }`, resolved once per runtime. */
    Function("getAppStartInfo") { appStart }

    /** Cumulative frame counters since the module started; JS diffs two snapshots. */
    Function("getFrameStats") { Vitals.frameStats() }
  }
}
