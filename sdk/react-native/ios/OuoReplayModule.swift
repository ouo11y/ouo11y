import ExpoModulesCore
import Foundation
import OuoCrash
import OuoReplay
import OuoVitals

/// Options passed by `initRUM({ replay })` through `start(endpoint, options)`.
struct StartOptions: Record {
  @Field var sessionId: String = ""
  /// Project credential (ADR-0007): the uploader sends `Authorization: Basic base64(projectId:projectToken)`
  /// on every chunk request. JS validates both first.
  @Field var projectId: String = ""
  @Field var projectToken: String = ""
  /// "auto", "session" or "navigation" (OuoReplay `ReplayMode`); anything else is `auto`.
  @Field var mode: String = "auto"
  @Field var frameInterval: Double = 1.0
  @Field var maskText: Bool = true
  @Field var maskInputs: Bool = true
  @Field var maskImages: Bool = true
  @Field var maskWebViews: Bool = true
  @Field var debug: Bool = false
  /// Keep chunks on the device until JS releases their session (`replay.keepAtNextLaunch`).
  @Field var holdUploads: Bool = false
}

/// Thread-safe holder for the session id the JS session manager pushes down.
final class SessionIdBox {
  private let lock = NSLock()
  private var value = ""
  func get() -> String { lock.lock(); defer { lock.unlock() }; return value }
  func set(_ id: String) { lock.lock(); value = id; lock.unlock() }
}

/// Expo bridge for the OuoReplay, OuoCrash and OuoVitals Swift packages. One JS instance per app; the native
/// recorder is a process singleton, so every function forwards to `OuoReplay` (the enum in the
/// OuoReplay module; the fully qualified name avoids the module/type name clash) or `OuoCrash`.
public class OuoReplayModule: Module {
  private let sessionId = SessionIdBox()
  /// When this JS runtime's module instance was created (epoch ms): the start of a warm launch.
  private let createdAtMs = Date().timeIntervalSince1970 * 1000
  private var appStart: AppStartInfo?
  private var appStartResolved = false
  private let appStartLock = NSLock()
  private let otlpSession = URLSessionTransport.makeSession()

  private func config(_ endpoint: String, _ options: StartOptions) throws -> OuoReplayConfig {
    guard let url = URL(string: endpoint) else {
      throw Exception(name: "ERR_OUO_REPLAY_ENDPOINT", description: "invalid replay endpoint: \(endpoint)")
    }
    let projectId = options.projectId.trimmingCharacters(in: .whitespacesAndNewlines)
    let token = options.projectToken.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !projectId.isEmpty, !token.isEmpty else {
      throw Exception(name: "ERR_OUO_REPLAY_CREDENTIAL", description: "projectId and projectToken are required (ADR-0007); the collector rejects uploads without Authorization: Basic base64(projectId:projectToken)")
    }
    let box = self.sessionId
    return OuoReplayConfig(
      endpoint: url,
      projectId: projectId,
      projectToken: token,
      sessionId: { box.get() },
      mode: ReplayMode(rawValue: options.mode) ?? .auto,
      frameInterval: options.frameInterval,
      maskText: options.maskText,
      maskInputs: options.maskInputs,
      maskImages: options.maskImages,
      maskWebViews: options.maskWebViews,
      debug: options.debug,
      holdUploads: options.holdUploads
    )
  }

  public func definition() -> ModuleDefinition {
    Name("OuoReplay")

    // Frame counters run from the module's creation (the JS runtime's start), not only while
    // replay records, so the app start window has frames too.
    OnCreate {
      OuoVitals.startFrameTracking()
    }

    Function("start") { (endpoint: String, options: StartOptions) in
      let config = try self.config(endpoint, options)
      if !options.sessionId.isEmpty {
        self.sessionId.set(options.sessionId)
      }
      OuoReplay.start(config)
    }

    /// Sends the chunk a crash left open in the previous run; JS calls it before its sampling
    /// decision, so it does not depend on this session being recorded.
    Function("recoverPendingChunk") { (endpoint: String, options: StartOptions) in
      OuoReplay.recoverPendingChunk(try self.config(endpoint, options))
    }

    /// Finished sessions whose chunks wait on the device, after the previous run's open chunk
    /// was recovered: `[{ sessionId, chunks, bytes, firstAt, lastAt }]`.
    AsyncFunction("heldReplaySessions") { (endpoint: String, options: StartOptions, promise: Promise) in
      OuoReplay.heldSessions(try self.config(endpoint, options)) { held in
        promise.resolve(held.map { h -> [String: Any] in
          ["sessionId": h.sessionId, "chunks": h.chunks, "bytes": h.bytes, "firstAt": Double(h.firstAt), "lastAt": Double(h.lastAt)]
        })
      }
    }

    /// Sends (`keep`) or deletes a held session's chunks.
    Function("releaseHeldReplay") { (endpoint: String, options: StartOptions, sessionId: String, keep: Bool) in
      OuoReplay.releaseHeld(try self.config(endpoint, options), sessionId: sessionId, keep: keep)
    }

    // ---- OTLP delivery (checklist N48): gzip and POST off the JS thread ----

    /// gzips `body` and POSTs it with `headers` plus `content-encoding: gzip`. Resolves
    /// `{ status, retryAfter? }` (the raw header; JS parses seconds and HTTP dates), status 0 when
    /// the request did not reach the server.
    AsyncFunction("postOtlp") { (url: String, headers: [String: String], body: String, promise: Promise) in
      guard let target = URL(string: url) else {
        promise.resolve(["status": 400])
        return
      }
      var request = URLRequest(url: target)
      request.httpMethod = "POST"
      for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
      let raw = Data(body.utf8)
      if let gz = try? Gzip.compress(raw), gz.count < raw.count {
        request.httpBody = gz
        request.setValue("gzip", forHTTPHeaderField: "content-encoding")
      } else {
        request.httpBody = raw
      }
      self.otlpSession.dataTask(with: request) { _, response, error in
        guard error == nil, let http = response as? HTTPURLResponse else {
          promise.resolve(["status": 0])
          return
        }
        var result: [String: Any] = ["status": http.statusCode]
        if let ra = http.value(forHTTPHeaderField: "Retry-After") { result["retryAfter"] = ra }
        promise.resolve(result)
      }.resume()
    }

    Function("pause") {
      OuoReplay.pause()
    }

    Function("resume") {
      OuoReplay.resume()
    }

    Function("isRecording") { () -> Bool in
      OuoReplay.isRecording
    }

    AsyncFunction("flush") { (promise: Promise) in
      OuoReplay.flush {
        promise.resolve(nil)
      }
    }

    Function("sessionDidRotate") { (id: String) in
      self.sessionId.set(id)
      OuoReplay.sessionDidRotate(newId: id)
    }

    Function("setSessionId") { (id: String) in
      self.sessionId.set(id)
    }

    /// A route change: the frame for the new screen in navigation mode.
    Function("screenDidChange") {
      OuoReplay.screenDidChange()
    }

    Function("stop") {
      OuoReplay.stop()
    }

    // ---- native crashes (checklist G1), independent of replay ----

    /// Installs the signal and NSException handlers (chained to any installed before, such as
    /// Sentry's) and sets the session a crash belongs to, with its start (epoch ms) for the report.
    Function("installCrashReporter") { (sessionId: String, startedAtMs: Double) -> Bool in
      let ok = OuoCrash.install()
      if !sessionId.isEmpty { OuoCrash.setSession(sessionId, startedAtMs: Int64(startedAtMs)) }
      return ok
    }

    Function("setCrashSessionId") { (id: String, startedAtMs: Double) in
      OuoCrash.setSession(id, startedAtMs: Int64(startedAtMs))
    }

    /// The previous run's crash report (JSON), removed from disk; nil when the last run did not crash.
    Function("takePendingCrash") { () -> String? in
      OuoCrash.takePendingReport()
    }

    // ---- mobile vitals (checklist G2, docs/specs/mobile-vitals.md) ----

    /// Start of this launch for `ouo.app.start`: `processStartMs` is the process start for a cold
    /// launch (the image load when iOS prewarmed the process) and this runtime's start for a warm
    /// one (a JS reload in a live process). Resolved once per runtime; nil when unknown.
    Function("getAppStartInfo") { () -> [String: Any]? in
      self.appStartLock.lock()
      defer { self.appStartLock.unlock() }
      if !self.appStartResolved {
        self.appStartResolved = true
        self.appStart = OuoVitals.beginRuntime(at: self.createdAtMs)
      }
      guard let info = self.appStart else { return nil }
      return ["processStartMs": info.startMs, "type": info.type.rawValue, "prewarmed": info.prewarmed]
    }

    /// Cumulative CADisplayLink frame counters since the module started; JS diffs two snapshots.
    Function("getFrameStats") { () -> [String: Any]? in
      guard let s = OuoVitals.frameStats() else { return nil }
      return [
        "total": s.total,
        "slow": s.slow,
        "frozen": s.frozen,
        "delayMs": s.delayMs,
        "expectedFrameMs": s.expectedFrameMs,
      ]
    }
  }
}
