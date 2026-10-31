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

    /// OTLP `severityNumber` and `severityText`.
    var number: Int { [1, 5, 9, 13, 17, 21][rawValue] }
    var text: String { ["TRACE", "DEBUG", "INFO", "WARN", "ERROR", "FATAL"][rawValue] }
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
    private static var replay: ReplayControl?
    #if canImport(UIKit)
    private static var taps: TapTracking?
    #endif
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
        guard !isAppExtension(bundleURL()) else {
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
        // What the app set now; later changes to `config` are not seen.
        let settings = Settings(config)
        let replay = ReplayControl(settings)
        lock.withLock { Ouo.replay = replay }
        var hooks = Core.Hooks()
        // Called without Core's lock, in order: OuoCrash's session for the next crash report, replay.
        hooks.sessionChanged = { rec in
            if settings.crashes { OuoCrash.setSession(rec.id, startedAtMs: Int64(rec.startedAt.rounded())) }
            replay?.sessionChanged(rec.id)
        }
        if settings.crashes { hooks.crashContext = { OuoCrash.setContext($0) } }
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
        let c = Core(settings: settings, directory: baseDirectory, hooks: hooks)

        // The previous run's crash or termination, read before this run's crash state is written.
        let report = settings.crashes ? OuoCrash.takePendingReport().flatMap(NativeReport.parse) : nil
        if settings.crashes { OuoCrash.install() }
        ErrorContext.start()
        let background = LaunchRole.isBackground(LaunchRole.current())
        let appStart = settings.vitals ? OuoVitals.beginRuntime(at: c.now()) : nil
        replay?.recover(crash: report.flatMap { r in r.session_id.map { ($0, EpochMillis(r.timestamp_ms.rounded())) } })
        c.start(previousReport: report, background: background, appStart: appStart)
        lock.withLock { core = c }

        if settings.crashes {
            OuoCrash.startHangTracking { report in Ouo.current?.hang(report) }
        }
        if settings.vitals { OuoVitals.startFrameTracking() }
        URLSessionHook.install { task in Ouo.current?.taskWillResume(task) }
        #if canImport(UIKit)
        Lifecycle.install(measureFirstFrame: settings.vitals && !background)
        let uikit = {
            if settings.screens { ScreenTracking.install() }
            if settings.taps {
                let t = TapTracking(labels: settings.tapLabels)
                lock.withLock { taps = t }
                t.install()
            }
        }
        if Thread.isMainThread { uikit() } else { DispatchQueue.main.async(execute: uikit) }
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
        current?.logLine(level, message, Attributes(app: attributes), span: nil)
    }

    /// A screen is showing (C7, C4): one `navigation` per change (`url.path` = `/<name>`) and its
    /// `ouo.screen.display` (TTID). UIKit view controllers are tracked by themselves (`screens`) and
    /// SwiftUI views with `.ouoScreen("Name")`; call this for screens neither can see.
    public static func trackScreen(_ name: String) { current?.trackScreen(name) }

    /// A tap the SDK cannot see (a SwiftUI control, a custom gesture): `ui.tap` on the current
    /// screen with this target, kept as given also when `tapLabels` is off. Counts as activity.
    public static func trackTap(_ target: String) {
        guard let c = current else { return }
        c.tap(target: target, path: nil, viewType: nil, gesture: "tap", at: c.now(), screen: c.screenName)
    }

    /// User feedback (C10): the user's text and how to reach them, as the app passes them. Returns
    /// the feedback's id, nil for an empty message. With `screenshot` and replay recording this
    /// session, the recorder takes a masked frame of the current screen (the replay is the screenshot).
    @objc(feedback:contact:screenshot:)
    @discardableResult
    public static func feedback(_ message: String, contact: String? = nil, screenshot: Bool = false) -> String? {
        guard let c = current else { return nil }
        let recording = screenshot && (lock.withLock { replay }?.isRecording ?? false)
        if recording { OuoReplay.screenDidChange() }
        return c.feedback(message: message, contact: contact, screenshot: recording)
    }

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
        if c.settings.replaySampleRate > 0 {
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
    /// The main bundle's URL; replaced in tests.
    static var bundleURL: () -> URL = { Bundle.main.bundleURL }
}

/// Whether iOS launched the process for the user or in the background (a background fetch, a push,
/// a location event): a background launch's session ends with `background` unless the app is opened
/// in time, and it has no app start. Decided from the task's role, which the system sets when it
/// launches the process (what Datadog reads too). Not from `applicationState`: in an app with
/// scenes (every new Xcode project, every SwiftUI `App`) it is `.background` in
/// `didFinishLaunching` even when the user tapped the icon.
enum LaunchRole {
    /// `task_category_policy.role`, nil when the kernel does not answer.
    static func current() -> Int32? {
        var policy = task_category_policy_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_category_policy_data_t>.size / MemoryLayout<integer_t>.size)
        var getDefault: boolean_t = 0
        let kr = withUnsafeMutablePointer(to: &policy) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                task_policy_get(mach_task_self_, task_policy_flavor_t(TASK_CATEGORY_POLICY), $0, &count, &getDefault)
            }
        }
        return kr == KERN_SUCCESS ? policy.role.rawValue : nil
    }

    /// Background only for the roles the system gives background launches; a foreground launch, an
    /// unknown role or no answer count as a launch for the user (the common case, and what keeps
    /// app start and the first screen's TTID).
    static func isBackground(_ role: Int32?) -> Bool {
        guard let role else { return false }
        return [TASK_BACKGROUND_APPLICATION, TASK_DARWINBG_APPLICATION, TASK_NONUI_APPLICATION].map(\.rawValue).contains(role)
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

    init?(_ c: Settings) {
        guard c.replaySampleRate > 0 else { return nil }
        rate = c.replaySampleRate
        sessionRate = c.sessionSampleRate
        let box = SessionBox()
        config = OuoReplayConfig(
            endpoint: c.replayEndpoint, projectId: c.projectId, projectToken: c.projectToken,
            sessionId: { box.value }, mode: c.replayMode,
            maskText: c.replayMask.text, maskInputs: c.replayMask.inputs, maskImages: c.replayMask.images, maskWebViews: c.replayMask.webViews,
            debug: c.debug
        )
        self.box = box
    }

    private let box: SessionBox

    /// Sends the chunk a crash left open, whether or not this session records; it ends at the crash.
    func recover(crash: (sessionId: String, at: EpochMillis)?) { OuoReplay.recoverPendingChunk(config, crash: crash) }

    /// Replay records the current session.
    var isRecording: Bool { lock.withLock { started && !paused } }

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
            // The task first, so the one flush (disk, then the network) runs inside it.
            let app = UIApplication.shared
            var task = UIBackgroundTaskIdentifier.invalid
            let end = {
                guard task != .invalid else { return }
                app.endBackgroundTask(task)
                task = .invalid
            }
            task = app.beginBackgroundTask(withName: "ouo.flush") { end() }
            c.didEnterBackground { DispatchQueue.main.async(execute: end) }
        }
        // The first unlock after a reboot: a session file a background launch could not read.
        center.addObserver(forName: UIApplication.protectedDataDidBecomeAvailableNotification, object: nil, queue: nil) { _ in
            Ouo.current?.protectedDataAvailable()
        }
        if measureFirstFrame {
            OuoVitals.nextFrame { t in Ouo.current?.firstFrame(SteadyClock.nowMs() + (t - CACurrentMediaTime()) * 1000) }
        }
    }
}
#endif
