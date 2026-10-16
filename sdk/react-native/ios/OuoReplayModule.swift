import ExpoModulesCore
import Foundation
import OuoReplay

/// Options passed by `initRUM({ replay })` through `start(endpoint, options)`.
struct StartOptions: Record {
  @Field var sessionId: String = ""
  /// Project credential (ADR-0007): the uploader sends `Authorization: Basic base64(projectId:projectToken)`
  /// on every chunk request. JS validates both first.
  @Field var projectId: String = ""
  @Field var projectToken: String = ""
  @Field var frameInterval: Double = 1.0
  @Field var maskText: Bool = true
  @Field var maskInputs: Bool = true
  @Field var maskImages: Bool = true
  @Field var maskWebViews: Bool = true
  @Field var debug: Bool = false
}

/// Thread-safe holder for the session id the JS session manager pushes down.
final class SessionIdBox {
  private let lock = NSLock()
  private var value = ""
  func get() -> String { lock.lock(); defer { lock.unlock() }; return value }
  func set(_ id: String) { lock.lock(); value = id; lock.unlock() }
}

/// Expo bridge for the OuoReplay Swift package. One JS instance per app; the native recorder is a
/// process singleton, so every function forwards to `OuoReplay` (the enum in the OuoReplay module;
/// the fully qualified name avoids the module/type name clash).
public class OuoReplayModule: Module {
  private let sessionId = SessionIdBox()

  public func definition() -> ModuleDefinition {
    Name("OuoReplay")

    Function("start") { (endpoint: String, options: StartOptions) in
      guard let url = URL(string: endpoint) else {
        throw Exception(name: "ERR_OUO_REPLAY_ENDPOINT", description: "invalid replay endpoint: \(endpoint)")
      }
      let projectId = options.projectId.trimmingCharacters(in: .whitespacesAndNewlines)
      let token = options.projectToken.trimmingCharacters(in: .whitespacesAndNewlines)
      guard !projectId.isEmpty, !token.isEmpty else {
        throw Exception(name: "ERR_OUO_REPLAY_CREDENTIAL", description: "projectId and projectToken are required (ADR-0007); the collector rejects uploads without Authorization: Basic base64(projectId:projectToken)")
      }
      if !options.sessionId.isEmpty {
        self.sessionId.set(options.sessionId)
      }
      let box = self.sessionId
      OuoReplay.start(OuoReplayConfig(
        endpoint: url,
        projectId: projectId,
        projectToken: token,
        sessionId: { box.get() },
        frameInterval: options.frameInterval,
        maskText: options.maskText,
        maskInputs: options.maskInputs,
        maskImages: options.maskImages,
        maskWebViews: options.maskWebViews,
        debug: options.debug
      ))
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

    Function("stop") {
      OuoReplay.stop()
    }
  }
}
