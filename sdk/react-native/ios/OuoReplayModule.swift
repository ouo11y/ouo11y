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

  /// A React tag from JavaScript: a positive whole number, anything else is ignored.
  private static func tag(_ value: Double?) -> Int? {
    guard let value, value.isFinite, value >= 1, value <= 2_147_483_647, value == value.rounded() else { return nil }
    return Int(value)
  }

  public func definition() -> ModuleDefinition {
    Name("OuoReplay")

    /// A main-thread hang is over: `{ report }`, a `hang` report (mobile SDK spec C3.1).
    Events("onHang")

    // Frame counters run from the module's creation (the JS runtime's start), not only while
    // replay records, so the app start window has frames too.
    OnCreate {
      OuoVitals.startFrameTracking()
      ErrorContext.start()
      // A new JavaScript runtime hands out React tags again: masks set by the last one are void.
      ReplayMaskRegistry.shared.reset()
    }

    /// `start(endpoint: string, options: object)`.
    ///
    /// Without `options.otlp` this is the upload path that existed before, with the options read
    /// as before (`StartOptions`; `mode` is `auto | session | navigation`).
    ///
    /// With `options.otlp` replay goes out as OTLP log records (ADR-0021 decision 5) and nothing
    /// here throws: a value that cannot be used falls back to its default and is counted
    /// (`replayDiagnostics()`), and options replay cannot run with leave it off. Keys:
    /// - `otlp: { logsUrl: string, resource?: { [key]: string | number | boolean }, schemaUrl?: string,
    ///   scopeVersion?: string, previousExit?: "crash" | "background_kill" }`
    /// - `mode?: "pixel/frames" | "pixel/video"` (default `pixel/frames`, `ouo-frames/3`;
    ///   `pixel/video` records H.264 segments, `ouo-video/1`, with the same masking;
    ///   `structure/wireframe` is not in this build and leaves replay off)
    /// - `cadence?: "auto" | "session" | "navigation"` (what `mode` means on the legacy path)
    /// - `buffer?: { seconds?: number }` (present: keep a ring of that many seconds, default 60,
    ///   and send on `capture(trigger)`; absent: record the whole session)
    /// - `replayId?: string` (32 lowercase hex), `keyframeIntervalMs?: number`, `chunkMaxBytes?: number`
    /// - `sessionId`, `projectId`, `projectToken`, `frameInterval`, `maskText`, `maskInputs`,
    ///   `maskImages`, `maskWebViews`, `debug` as before
    Function("start") { (endpoint: String, options: [String: Any]) in
      switch ReplayOTLPOptions.parse(options) {
      case .legacy:
        guard let appContext = self.appContext else { throw Exceptions.AppContextLost() }
        let legacy = try StartOptions(from: options, appContext: appContext)
        let config = try self.config(endpoint, legacy)
        if !legacy.sessionId.isEmpty {
          self.sessionId.set(legacy.sessionId)
        }
        OuoReplay.start(config)
      case .off(let problems):
        OuoReplay.noteOptionProblems(problems, debug: ReplayOTLPOptions.bool(options["debug"]) ?? false)
      case .otlp(let otlp, var problems):
        let (common, more) = ReplayOTLPOptions.Common.parse(options)
        problems += more
        guard !common.projectId.isEmpty, !common.projectToken.isEmpty else {
          // The collector answers 401 without the credential: nothing would arrive.
          OuoReplay.noteOptionProblems(problems + ["projectId and projectToken are required"], debug: common.debug)
          return
        }
        if !common.sessionId.isEmpty {
          self.sessionId.set(common.sessionId)
        }
        let box = self.sessionId
        var config = OuoReplayConfig(
          endpoint: URL(string: endpoint) ?? otlp.logsUrl,
          projectId: common.projectId,
          projectToken: common.projectToken,
          sessionId: { box.get() },
          frameInterval: common.frameInterval,
          maskText: common.maskText,
          maskInputs: common.maskInputs,
          maskImages: common.maskImages,
          maskWebViews: common.maskWebViews,
          debug: common.debug
        )
        config.otlp = otlp
        OuoReplay.noteOptionProblems(problems, debug: common.debug)
        OuoReplay.start(config)
      }
    }

    // ---- OTLP replay (ADR-0021 decision 5) ----

    /// `capture(trigger: string)`: buffer mode only. Sends the ring and records on as a session.
    /// `trigger` is `error`, `crash`, `anr`, `hang` or `manual`; anything else counts as `manual`.
    Function("capture") { (trigger: String?) in
      OuoReplay.capture(trigger: trigger ?? "manual")
    }

    /// `setViewId(id: string)`: the screen the next chunks belong to (`ouo.view.id`).
    Function("setViewId") { (id: String?) in
      OuoReplay.setViewId(id ?? "")
    }

    /// `mask(reactTag: number)`: masks that view in every recorder. Mask wins over unmask.
    Function("mask") { (reactTag: Double?) in
      if let tag = Self.tag(reactTag) { OuoReplay.mask(reactTag: tag) }
    }

    /// `unmask(reactTag: number)`: shows that view and what is inside it. A mask inside it still
    /// masks, and a secure field is always masked.
    Function("unmask") { (reactTag: Double?) in
      if let tag = Self.tag(reactTag) { OuoReplay.unmask(reactTag: tag) }
    }

    /// `endSession()`: stops and ends the stream with `ouo.replay.ended`, reason `session_end`
    /// (`stop()` ends it with reason `stop`).
    Function("endSession") {
      OuoReplay.stop(reason: .sessionEnd)
    }

    /// `discardPending(): Promise<void>`: stops the recorder without an end record and deletes
    /// every replay record not yet accepted (consent withdrawn).
    AsyncFunction("discardPending") { (promise: Promise) in
      OuoReplay.discardPending {
        promise.resolve(nil)
      }
    }

    /// `replayDiagnostics(): { [counter: string]: number }`: what replay dropped or could not do
    /// in this process, by reason (frames, events, chunks lost or rejected, option problems).
    Function("replayDiagnostics") { () -> [String: Int] in
      OuoReplay.diagnostics()
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
    /// Also tracks the run for the next launch's termination check and starts the app hang
    /// watchdog, whose reports arrive as `onHang` events (JS listens before calling this).
    Function("installCrashReporter") { (sessionId: String, startedAtMs: Double) -> Bool in
      let ok = OuoCrash.install()
      if !sessionId.isEmpty { OuoCrash.setSession(sessionId, startedAtMs: Int64(startedAtMs)) }
      OuoCrash.startHangTracking { [weak self] report in
        self?.sendEvent("onHang", ["report": report])
      }
      return ok
    }

    Function("setCrashSessionId") { (id: String, startedAtMs: Double) in
      OuoCrash.setSession(id, startedAtMs: Int64(startedAtMs))
    }

    /// The previous run's crash report (JSON), removed from disk, or a `termination` report when it
    /// died in the foreground without one; nil when the last run ended normally.
    Function("takePendingCrash") { () -> String? in
      OuoCrash.takePendingReport()
    }

    /// The device side of an error's context (mobile SDK spec C2): memory and network type now.
    Function("getErrorContext") { () -> [String: Any] in
      var c: [String: Any] = ["networkType": ErrorContext.networkType]
      if let f = ErrorContext.memoryFootprintBytes { c["memoryFootprintBytes"] = Double(f) }
      if let a = ErrorContext.memoryAvailableBytes { c["memoryAvailableBytes"] = Double(a) }
      return c
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
