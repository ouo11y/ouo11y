import Foundation
import OuoCrash
import OuoReplay
import OuoVitals
import QuartzCore
#if canImport(UIKit)
import UIKit
#endif

/// Severity of `Ouo.log` lines.
@objc(OuoLogLevel)
public enum OuoLogLevel: Int {
    case trace, debug, info, warn, error, fatal

    var severity: Severity {
        switch self {
        case .trace: return .trace
        case .debug: return .debug
        case .info: return .info
        case .warn: return .warn
        case .error: return .error
        case .fatal: return .fatal
        }
    }
}

/// The ouo SDK for native iOS apps (UIKit and SwiftUI, Swift and Objective-C): sessions, crashes,
/// hangs, terminations, vitals, network spans, replay and the span and log API, sent as OTLP to the
/// ouo collector (docs/specs/mobile-sdk.md, ADR-0016).
///
/// Call `Ouo.start` once, as early as possible, on the main thread (`application(_:didFinishLaunchingWithOptions:)`,
/// or `App.init`). Every other call is safe from any thread and does nothing before `start`.
@objc(Ouo)
@objcMembers
public final class Ouo: NSObject {
    /// `ouo.sdk.name` and `ouo.sdk.version`.
    public static let sdkName = "ouo11y-ios"
    public static let sdkVersion = "0.2.0" // x-release-please-version

    /// A namespace: the API is static.
    private override init() {}

    private static let lock = NSLock()
    private static var core: Core?
    private static var starting = false
    static var current: Core? { lock.withLock { core } }

    /// Starts the SDK. Returns false, and does nothing, when it already started in this process, the
    /// config is unusable (the reason is logged) or the process is an app extension.
    @discardableResult
    public static func start(_ config: OuoConfig) -> Bool {
        // Refusals first: a refused start leaves the next one free.
        if let problem = config.problem {
            NSLog("[ouo] Ouo.start: %@", problem)
            return false
        }
        // Extensions have no UIApplication (and their own short lifecycle): not supported.
        guard !isAppExtension(Bundle.main.bundleURL) else {
            NSLog("[ouo] Ouo.start: app extensions are not supported, nothing is recorded")
            return false
        }
        let first = lock.withLock { () -> Bool in
            defer { starting = true }
            return !starting
        }
        guard first else {
            NSLog("[ouo] Ouo.start called twice; the first configuration stays")
            return false
        }
        let replay = ReplayControl(config)
        var hooks = Core.Hooks()
        // Called without Core's lock: OuoCrash's session for the next crash report, replay for the new session.
        hooks.sessionChanged = { rec in
            if config.crashes { OuoCrash.setSession(rec.id, startedAtMs: Int64(rec.startedAt.rounded())) }
            replay?.sessionChanged(rec.id)
        }
        #if canImport(UIKit)
        hooks.frameStats = { OuoVitals.frameStats() }
        // The frame's time on the SDK's clock, so a TTID never mixes two clocks.
        hooks.nextFrame = { cb in OuoVitals.nextFrame { t in cb(SteadyClock.nowMs() + (t - CACurrentMediaTime()) * 1000) } }
        #endif
        hooks.deviceContext = {
            var a: Attributes = ["network.connection.type": .string(ErrorContext.networkType)]
            if let f = ErrorContext.memoryFootprintBytes { a["ouo.memory.app_bytes"] = .int(Int64(clamping: f)) }
            if let m = ErrorContext.memoryAvailableBytes { a["ouo.memory.available_bytes"] = .int(Int64(clamping: m)) }
            return a
        }
        let c = Core(config: config, directory: baseDirectory, hooks: hooks)

        // The previous run's crash or termination, read before this run's crash state is written.
        let report = config.crashes ? OuoCrash.takePendingReport().flatMap(NativeReport.parse) : nil
        if config.crashes { OuoCrash.install() }
        ErrorContext.start()
        let background = launchedInBackground
        let appStart = config.vitals ? OuoVitals.beginRuntime(at: c.now()) : nil
        replay?.recover()
        c.start(previousReport: report, background: background, appStart: appStart)
        lock.withLock { core = c }

        if config.crashes {
            OuoCrash.startHangTracking { report in Ouo.current?.hang(report) }
        }
        if config.vitals { OuoVitals.startFrameTracking() }
        URLSessionHook.install { task in Ouo.current?.taskWillResume(task) }
        #if canImport(UIKit)
        Lifecycle.install(measureFirstFrame: config.vitals && !background)
        #endif
        c.log.log("started: session \(c.sessionId), endpoint \(config.endpoint.absoluteString), project \(config.projectId)")
        return true
    }

    // MARK: - session (C1)

    /// The current `session.id`; nil before `start`.
    public static var sessionId: String? { current?.sessionId }
    /// `user.id`: the app's id once `setUser` was called, else an anonymous id kept on the device.
    public static var userId: String? { current?.userId }

    /// Identifies the user. Anonymous to identified keeps the session; another identified user ends it
    /// (`user_change`) and starts a new one.
    public static func setUser(_ userId: String) { current?.setUser(userId) }
    /// Logout: a fresh anonymous id, in a new session.
    public static func clearUser() { current?.clearUser() }
    /// Ends the session now (`manual`); the next record starts a new one.
    public static func endSession() { current?.endSession() }
    /// Counts as session activity (taps and requests already do).
    public static func recordActivity() { current?.activity() }

    // MARK: - records

    /// A custom event (an OTel log record with `event.name`), a funnel step.
    public static func addEvent(_ name: String, attributes: [String: Any]? = nil) {
        var a = Attributes(app: attributes)
        a["ouo.event.custom"] = true
        current?.event(name, a)
    }

    /// A handled, non-fatal error, with the stack of this call (C2).
    @objc(captureError:attributes:)
    public static func captureError(_ error: Error, attributes: [String: Any]? = nil) {
        guard let c = current else { return }
        let ns = error as NSError
        let (type, message) = Swift.type(of: error) is NSError.Type
            ? ("\(ns.domain) \(ns.code)", ns.localizedDescription)
            : (String(reflecting: Swift.type(of: error)), String(describing: error))
        c.captureError(type: type, message: message, attrs: Attributes(app: attributes), stack: Stack.current(skipping: 1))
    }

    /// A caught `NSException`, with the stack it was raised at (else this call's).
    @objc(captureException:attributes:)
    public static func captureException(_ exception: NSException, attributes: [String: Any]? = nil) {
        guard let c = current else { return }
        let raised = exception.callStackReturnAddresses.map { UInt($0.uintValue) }
        let stack = raised.isEmpty ? Stack.current(skipping: 1) : Stack.fields(OuoCrash.stackFields(raised))
        c.captureError(type: exception.name.rawValue, message: exception.reason ?? "", attrs: Attributes(app: attributes), stack: stack)
    }

    /// A log line (C9): a record named `log` with the severity, the message and the active span's trace.
    @objc(log:message:attributes:)
    public static func log(_ level: OuoLogLevel, _ message: String, attributes: [String: Any]? = nil) {
        current?.logLine(level.severity, message, Attributes(app: attributes), span: nil)
    }

    /// A screen is showing (C7, C4): one `navigation` per change (`url.path` = `/<name>`) and its
    /// `ouo.screen.display` (TTID). Screens of UIKit and SwiftUI are tracked by themselves in a later
    /// version; until then, and for screens the SDK cannot see, call this.
    public static func trackScreen(_ name: String) { current?.trackScreen(name) }

    /// The current screen's content is on screen: its `ouo.screen.display` gets TTFD (C4).
    public static func reportFullyDisplayed() { current?.reportFullyDisplayed() }

    // MARK: - spans (C9)

    /// Starts a span, a child of the active `withSpan` span on this thread. End it with `end()`.
    @objc(startSpan:attributes:)
    public static func startSpan(_ name: String, attributes: [String: Any]? = nil) -> OuoSpan {
        let c = current
        return OuoSpan(core: c, name: name, kind: .internal, attributes: Attributes(app: attributes), parent: OuoSpan.active, start: c?.now() ?? SteadyClock.nowMs())
    }

    /// Runs `body` inside a span: requests, logs and errors on this thread meanwhile join its trace.
    /// The span ends when `body` returns, failed when it throws.
    public static func withSpan<T>(_ name: String, attributes: [String: Any]? = nil, _ body: (OuoSpan) throws -> T) rethrows -> T {
        let span = startSpan(name, attributes: attributes)
        OuoSpan.push(span)
        defer {
            OuoSpan.pop(span)
            span.end()
        }
        do {
            return try body(span)
        } catch {
            span.setError(String(describing: error))
            throw error
        }
    }

    @objc(withSpan:attributes:block:)
    public static func withSpanObjC(_ name: String, attributes: [String: Any]?, block: (OuoSpan) -> Void) {
        withSpan(name, attributes: attributes, block)
    }

    // MARK: - delivery (C11)

    /// Writes everything pending to disk and tries to send it (OTLP and replay); `completion` runs
    /// on the main thread once the outbox is empty or the collector could not be reached.
    public static func flush(completion: (() -> Void)? = nil) {
        guard let c = current else {
            completion.map { DispatchQueue.main.async(execute: $0) }
            return
        }
        let group = DispatchGroup()
        group.enter()
        c.flush { group.leave() }
        if c.config.replaySampleRate > 0 {
            group.enter()
            OuoReplay.flush { group.leave() }
        }
        group.notify(queue: .main) { completion?() }
    }

    // MARK: - internals

    /// `Library/Application Support/ouo/sdk`, excluded from backups (a restored backup must not
    /// carry `device.id` or a session to another device).
    static var baseDirectory: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first ?? URL(fileURLWithPath: NSTemporaryDirectory())
        var dir = base.appendingPathComponent("ouo/sdk", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? dir.setResourceValues(values)
        return dir
    }

    static func isAppExtension(_ bundleURL: URL) -> Bool { bundleURL.pathExtension == "appex" }

    /// iOS launched the process in the background (a background fetch, a push, a location event):
    /// its session ends with `background` unless the app is opened in time, and it has no app start.
    private static var launchedInBackground: Bool {
        #if canImport(UIKit)
        guard Thread.isMainThread else { return false }
        return UIApplication.shared.applicationState == .background
        #else
        return false
        #endif
    }
}

/// Replay for the sessions in its sample: started for the first, rotated with the session, paused
/// for a session outside the sample.
final class ReplayControl {
    private let config: OuoReplayConfig
    private let rate: Double
    private let sessionRate: Double
    private let lock = NSLock()
    private var sessionId = ""
    private var started = false
    private var paused = false

    init?(_ c: OuoConfig) {
        guard c.replaySampleRate > 0 else { return nil }
        rate = c.replaySampleRate
        sessionRate = c.sessionSampleRate
        let box = SessionBox()
        config = OuoReplayConfig(
            endpoint: c.resolvedReplayEndpoint, projectId: c.projectId, projectToken: c.projectToken,
            sessionId: { box.value }, mode: c.replayMode,
            maskText: c.replayMaskText, maskInputs: c.replayMaskInputs, maskImages: c.replayMaskImages, maskWebViews: c.replayMaskWebViews,
            debug: c.debug
        )
        self.box = box
    }

    private let box: SessionBox

    /// Sends the chunk a crash left open, whether or not this session records.
    func recover() { OuoReplay.recoverPendingChunk(config) }

    func sessionChanged(_ id: String) {
        let record = Sampling.sampled(id, rate: sessionRate, salt: Sampling.session) && Sampling.sampled(id, rate: rate, salt: Sampling.replay)
        lock.withLock {
            box.value = id
            if record {
                if !started {
                    started = true
                    OuoReplay.start(config)
                } else {
                    OuoReplay.sessionDidRotate(newId: id)
                    if paused { OuoReplay.resume() }
                }
                paused = false
            } else if started && !paused {
                paused = true
                OuoReplay.pause()
            }
        }
    }
}

private final class SessionBox {
    private let lock = NSLock()
    private var id = ""
    var value: String {
        get { lock.withLock { id } }
        set { lock.withLock { id = newValue } }
    }
}

#if canImport(UIKit)
/// The app's lifecycle notifications (C1): `app.lifecycle`, the background rule of sessions, the
/// flush on background (inside a background task, so the requests get time to leave), the first
/// frame for the app start.
enum Lifecycle {
    static func install(measureFirstFrame: Bool) {
        let center = NotificationCenter.default
        center.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: nil) { _ in Ouo.current?.willResignActive() }
        center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: nil) { _ in Ouo.current?.didBecomeActive() }
        center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: nil) { _ in
            guard let c = Ouo.current else { return }
            c.didEnterBackground()
            let app = UIApplication.shared
            var task = UIBackgroundTaskIdentifier.invalid
            let end = {
                guard task != .invalid else { return }
                app.endBackgroundTask(task)
                task = .invalid
            }
            task = app.beginBackgroundTask(withName: "ouo.flush") { end() }
            c.flush { DispatchQueue.main.async(execute: end) }
        }
        if measureFirstFrame {
            OuoVitals.nextFrame { t in Ouo.current?.firstFrame(SteadyClock.nowMs() + (t - CACurrentMediaTime()) * 1000) }
        }
    }
}
#endif
