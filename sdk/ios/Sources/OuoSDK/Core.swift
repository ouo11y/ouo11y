import Foundation
import OuoReplayCore
import OuoVitals

/// The SDK for one process: the session, the records and where they go. Every entry point is safe
/// from any thread: state lives under one lock, which is never held while app code or a platform
/// callback runs. File writes under the lock are the few small ones the spec needs on disk at once
/// (the session, and the screen context after a tap, navigation or exception).
///
/// The platform (UIKit lifecycle, OuoCrash, OuoVitals, OuoReplay, the URLSession hook) is wired by
/// `Ouo.start` through `Hooks`, so this class runs in tests on macOS.
final class Core {
    struct Hooks {
        var now: () -> Double = SteadyClock.nowMs
        var transport: ChunkTransport = URLSessionTransport()
        /// Display link counters, the next frame and timers for the vitals.
        var frameStats: () -> FrameStats? = { nil }
        var nextFrame: (@escaping (Double) -> Void) -> Void = { _ in }
        var after: (Double, @escaping () -> Void) -> () -> Void = { ms, block in
            let item = DispatchWorkItem(block: block)
            DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + ms / 1000, execute: item)
            return { item.cancel() }
        }
        /// Memory and network type now (`ErrorContext`), for an exception's context.
        var deviceContext: () -> Attributes = { [:] }
        /// A new session is current (OuoCrash's session, replay). Called without the lock.
        var sessionChanged: (SessionRecord) -> Void = { _ in }
    }

    static let platform = "mobile"
    /// Longest `message` attribute of a log line (the Sentry bridge's cut).
    static let maxLogMessage = 1024

    let config: OuoConfig
    let log: Log
    let exporter: Exporter
    let resource: Attributes
    /// The SDK's own requests, never traced.
    let ingestPrefixes: [String]
    private let hooks: Hooks
    private let directory: URL
    private let contextURL: URL
    private let locale: String?
    private let lock = NSLock()
    private var session: SessionManager!
    private var vitals: Vitals?
    private var recent = RecentEvents()
    private var screen = ""
    private var path: String?
    private var lifecycle: String?
    private var inBackground = false
    private var savedContext: ScreenContext?
    private var contextTimer = false
    /// Session changes seen under the lock, reported after it is released.
    private var rotations: [SessionRecord] = []

    init(config: OuoConfig, directory: URL, hooks: Hooks = Hooks()) {
        self.config = config
        self.hooks = hooks
        self.directory = directory
        self.contextURL = directory.appendingPathComponent("context.json")
        self.log = Log(enabled: config.debug)
        self.locale = Core.deviceLocale()
        let replay = config.resolvedReplayEndpoint
        let resource = Core.resource(config)
        self.resource = resource
        self.exporter = Exporter(
            endpoint: config.endpoint,
            authorization: ChunkUploader.basicAuthorization(projectId: config.projectId, projectToken: config.projectToken),
            directory: directory.appendingPathComponent("otlp", isDirectory: true),
            resource: resource,
            transport: hooks.transport,
            log: log
        )
        self.ingestPrefixes = [exporter.logsURL.absoluteString, exporter.tracesURL.absoluteString, Exporter.trim(replay) + ChunkUploader.chunksPath]
    }

    // MARK: - start

    /// The cold start: the previous run's session ends (with its crash or termination report when
    /// there is one), the new one starts, then the report itself is sent as a fatal `exception` of
    /// the crashed session, stamped at the crash, with the screen and last events that run persisted.
    func start(previousReport: NativeReport?, background: Bool, appStart: AppStartInfo?) {
        // Read before this run writes its own.
        let previousContext = ScreenContext.load(contextURL)
        locked {
            inBackground = background
            // The launch's own state is no change: the first `app.lifecycle` is the first change.
            lifecycle = background ? "background" : "foreground"
            session = SessionManager(
                store: FileSessionStore(url: directory.appendingPathComponent("session.json")),
                now: hooks.now,
                timeouts: SessionManager.Timeouts(inactivity: config.inactivityTimeout * 1000, maxDuration: config.maxSessionDuration * 1000, background: config.backgroundTimeout * 1000),
                serviceVersion: config.serviceVersion,
                emit: { [unowned self] name, attrs, at in self.emitLocked(name, attrs, at: at) },
                onRotate: { [unowned self] rec in self.rotations.append(rec) }
            )
            if config.vitals {
                vitals = Vitals(deps: vitalsDeps(), appStart: appStart, launchedInForeground: !background)
            }
            session.start(crash: previousReport?.crashMarker, background: background)
            if let r = previousReport { emitPreviousReportLocked(r, previousContext) }
            vitals?.sessionReady()
        }
        exporter.drain()
    }

    private func emitPreviousReportLocked(_ r: NativeReport, _ ctx: ScreenContext?) {
        var a = r.attributes
        let crashed = r.session_id ?? ""
        if let ctx, crashed.isEmpty || ctx.sessionId == crashed { a.merge(ctx.attributes) { own, _ in own } }
        if let locale { a["ouo.device.locale"] = .string(locale) }
        if let ended = session.lastEnded, ended.id == crashed, let v = ended.serviceVersion { a["service.version"] = .string(v) }
        emitLocked("exception", a, severity: .error, at: r.timestamp_ms)
        log.warn("native \(r.mechanism) of the previous run reported: \(a["exception.message"]?.text ?? "")")
    }

    // MARK: - records

    /// An event (`event.name`) on the current session, or on the session its attributes name.
    func event(_ name: String, _ attrs: Attributes, severity: Severity = .info, at: Double? = nil, body: String? = nil, trace: (String, String)? = nil) {
        locked { emitLocked(name, attrs, severity: severity, at: at ?? hooks.now(), body: body, trace: trace) }
    }

    /// `log` (C9): the message as body and `message`, the active span's trace.
    func logLine(_ severity: Severity, _ message: String, _ attrs: Attributes, span: OuoSpan?) {
        var a = attrs
        a["message"] = .string(String(message.prefix(Self.maxLogMessage)))
        let trace = (span ?? OuoSpan.active).map { ($0.traceId, $0.spanId) }
        locked { emitLocked("log", a, severity: severity, at: hooks.now(), body: message, trace: trace) }
    }

    /// An `exception` with its context (C2): the screen and last events before it, the locale, the
    /// memory and network now; `own` wins.
    func exception(_ own: Attributes, at: Double? = nil, trace: (String, String)? = nil) {
        let device = hooks.deviceContext()
        locked {
            let id = session.ensure().id
            var a = ScreenContext(sessionId: id, screen: screen, events: recent.read(id)).attributes
            if let locale { a["ouo.device.locale"] = .string(locale) }
            a.merge(device) { _, d in d }
            a.merge(own) { _, o in o }
            emitLocked("exception", a, severity: .error, at: at ?? hooks.now(), trace: trace)
        }
    }

    /// A handled error the app reports, with the stack of the call.
    func captureError(type: String, message: String, attrs: Attributes, stack: (frames: [NativeReport.Frame], images: [NativeReport.Image])) {
        var a: Attributes = [
            "exception.type": .string(type),
            "exception.message": .string(message),
            "exception.stacktrace": .string(Stack.format(type: type, message: message, frames: stack.frames, images: stack.images, arch: Core.arch, threadMain: Thread.isMainThread, verb: "captured")),
            "ouo.exception.fatal": false,
            "ouo.exception.handled": true,
            "ouo.exception.kind": "captured",
            "ouo.crash.arch": .string(Core.arch),
        ]
        a.merge(Stack.symbolication(frames: stack.frames, images: stack.images)) { _, b in b }
        a.merge(attrs) { _, app in app }
        exception(a, trace: OuoSpan.active.map { ($0.traceId, $0.spanId) })
    }

    /// A main-thread hang is over (C3.1): a non-fatal `hang` exception of the current session.
    func hang(_ report: String) {
        guard let r = NativeReport.parse(report), r.mechanism == "hang" else {
            log.warn("unreadable hang report dropped")
            return
        }
        exception(r.attributes, at: r.timestamp_ms)
    }

    /// A screen is showing (C7): one `navigation` per change, with `ouo.navigation.from`.
    func trackScreen(_ name: String) {
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return }
        locked {
            let p = "/" + name
            guard p != path else { return }
            var a: Attributes = ["url.path": .string(p), "ouo.navigation.kind": "screen"]
            if let from = path { a["ouo.navigation.from"] = .string(from) }
            path = p
            screen = name
            session.touch()
            emitLocked("navigation", a, at: hooks.now(), body: p)
            vitals?.navigated(name)
        }
    }

    func now() -> Double { hooks.now() }

    func reportFullyDisplayed() { locked { vitals?.fullyDisplayed() } }

    /// Activity (session-lifecycle.md): a touch, a request.
    func activity() { locked { session.touch() } }

    /// The first frame after launch (app start).
    func firstFrame(_ at: Double) { locked { vitals?.firstFrame(at) } }

    // MARK: - lifecycle (C1)

    func willResignActive() {
        locked { lifecycleLocked("inactive") }
    }

    /// The event first, so the flush that follows sends it.
    func didEnterBackground() {
        locked {
            lifecycleLocked("background")
            inBackground = true
            vitals?.background()
            session.background()
            persistContextLocked()
        }
        exporter.flush()
    }

    /// Back from the background the session may rotate first, so the event lands in the new one.
    func didBecomeActive() {
        let wasBackground: Bool = locked {
            let was = inBackground
            if was {
                inBackground = false
                session.foreground()
                vitals?.foreground()
            }
            lifecycleLocked("foreground")
            return was
        }
        // The network may be back too.
        if wasBackground { exporter.drain() }
    }

    private func lifecycleLocked(_ state: String) {
        guard state != lifecycle else { return }
        lifecycle = state
        guard config.lifecycleEvents else { return }
        emitLocked("app.lifecycle", ["ouo.app.state": .string(state)], at: hooks.now(), body: "app \(state)")
    }

    // MARK: - session

    var sessionId: String { locked { session.ensure().id } }
    var userId: String { locked { session.user.id } }
    func setUser(_ id: String) { locked { session.setUser(id) } }
    func clearUser() { locked { session.clearUser() } }
    func endSession() { locked { session.endSession() } }

    /// Session ids for a request's baggage and a span, without touching the session.
    func correlation() -> Attributes {
        locked {
            var a: Attributes = ["service.version": .string(config.serviceVersion)]
            stampLocked(&a)
            return a
        }
    }

    // MARK: - spans

    func export(_ span: SpanRecord) {
        guard case .string(let id)? = span.attributes["session.id"], sampled(id) else { return }
        exporter.add(span)
    }

    /// Writes the session, the context and every pending record to disk, then tries to send them;
    /// `completion` once the outbox is empty or its oldest request failed again.
    func flush(completion: @escaping () -> Void) {
        locked {
            session.persistNow()
            persistContextLocked()
        }
        exporter.flush()
        exporter.drain(completion: completion)
    }

    // MARK: - internals (under `lock`)

    private func emitLocked(_ name: String, _ attrs: Attributes, severity: Severity = .info, at: Double, body: String? = nil, trace: (String, String)? = nil) {
        var a = attrs
        a["event.name"] = .string(name)
        stampLocked(&a)
        let record = LogRecord(timeMs: at, severity: severity, body: body ?? name, attributes: a, traceId: trace?.0, spanId: trace?.1)
        recent.add(record)
        if case .string(let id)? = a["session.id"], sampled(id) { exporter.add(record) }
        if ScreenContext.persistAtOnce.contains(name) {
            persistContextLocked()
        } else if !contextTimer {
            contextTimer = true
            _ = hooks.after(ScreenContext.persistDelayMs) { [weak self] in
                self?.locked {
                    self?.contextTimer = false
                    self?.persistContextLocked()
                }
            }
        }
    }

    /// Session attributes on every record (mobile SDK spec rule 2). A record that names its session
    /// (`session.start`, `session.end`, a previous run's crash) keeps it and gets only the user.
    private func stampLocked(_ a: inout Attributes) {
        func set(_ k: String, _ v: AttributeValue) { if a[k] == nil { a[k] = v } }
        set("ouo.platform", .string(Self.platform))
        set("service.version", .string(config.serviceVersion))
        if case .string(let named)? = a["session.id"] {
            set("user.id", .string(session.user.id))
            set("ouo.user.anonymous", .bool(session.user.anonymous))
            if let c = session.current, c.id == named, let p = c.previousId { set("session.previous_id", .string(p)) }
            return
        }
        let s = session.ensure()
        a["session.id"] = .string(s.id)
        set("user.id", .string(s.userId))
        set("ouo.user.anonymous", .bool(session.user.anonymous))
        if let p = s.previousId { set("session.previous_id", .string(p)) }
    }

    private func persistContextLocked() {
        guard let id = session.current?.id else { return }
        let c = ScreenContext(sessionId: id, screen: screen, events: recent.read(id))
        guard c != savedContext else { return }
        savedContext = c
        c.save(contextURL)
    }

    private func sampled(_ sessionId: String) -> Bool {
        Sampling.sampled(sessionId, rate: config.sessionSampleRate, salt: Sampling.session)
    }

    private func vitalsDeps() -> Vitals.Deps {
        Vitals.Deps(
            now: hooks.now,
            frameStats: hooks.frameStats,
            // Frame and timer callbacks come back on other threads: under the lock again.
            nextFrame: { [unowned self] cb in self.hooks.nextFrame { at in self.locked { cb(at) } } },
            after: { [unowned self] ms, block in self.hooks.after(ms) { self.locked { block() } } },
            emit: { [unowned self] name, attrs, at in self.emitLocked(name, attrs, at: at, body: "") },
            log: { [log] in log.log($0) }
        )
    }

    /// Runs `body` under the lock, then reports the session changes it caused.
    @discardableResult
    func locked<T>(_ body: () -> T) -> T {
        lock.lock()
        let result = body()
        let changed = rotations
        rotations = []
        lock.unlock()
        changed.forEach(hooks.sessionChanged)
        return result
    }

    // MARK: - device

    static var arch: String {
        #if arch(arm64)
        return "arm64"
        #elseif arch(x86_64)
        return "x86_64"
        #else
        return "unknown"
        #endif
    }

    /// BCP 47 (`en-US`).
    static func deviceLocale() -> String? {
        let id: String
        if #available(iOS 16, macOS 13, *) {
            id = Locale.current.identifier(.bcp47)
        } else {
            id = Locale.current.identifier.replacingOccurrences(of: "_", with: "-")
        }
        return id.isEmpty ? nil : id
    }

    /// Resource attributes, set once (mobile SDK spec rule 3); the app's extra ones lose on a clash.
    static func resource(_ c: OuoConfig) -> Attributes {
        var a = Attributes(app: c.resourceAttributes)
        let v = ProcessInfo.processInfo.operatingSystemVersion
        let env = ProcessInfo.processInfo.environment
        let simulatorModel = env["SIMULATOR_MODEL_IDENTIFIER"]
        a.merge([
            "service.name": .string(c.serviceName),
            "service.version": .string(c.serviceVersion),
            "deployment.environment.name": .string(c.environment),
            "ouo.platform": .string(platform),
            "ouo.sdk.name": .string(Ouo.sdkName),
            "ouo.sdk.version": .string(Ouo.sdkVersion),
            "os.name": .string(osName),
            "os.version": .string("\(v.majorVersion).\(v.minorVersion).\(v.patchVersion)"),
            "device.manufacturer": "Apple",
            "device.model.identifier": .string(simulatorModel ?? machine()),
        ]) { _, sdk in sdk }
        if simulatorModel != nil { a["ouo.device.simulator"] = true }
        return a
    }

    private static var osName: String {
        #if os(iOS)
        return ProcessInfo.processInfo.isiOSAppOnMac ? "macOS" : (isPad ? "iPadOS" : "iOS")
        #elseif os(macOS)
        return "macOS"
        #else
        return "unknown"
        #endif
    }

    #if os(iOS)
    static var isPad = false
    #endif

    /// `hw.machine`: `iPhone17,1`.
    private static func machine() -> String {
        var info = utsname()
        uname(&info)
        return withUnsafeBytes(of: &info.machine) { raw in
            String(decoding: raw.prefix { $0 != 0 }, as: UTF8.self)
        }
    }
}
