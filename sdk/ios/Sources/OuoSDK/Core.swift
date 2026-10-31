import Foundation
import OuoReplayCore
import OuoVitals

/// The SDK for one process: the session, the records and where they go. Every entry point is safe
/// from any thread: state lives under one lock, which is never held while app code or a platform
/// callback runs. The only file write under it is the small `session.json` (at most once a second,
/// and on session changes); the screen context is written on its own queue after the lock is
/// released, and session changes are reported in order after it.
///
/// The platform (UIKit lifecycle, OuoCrash, OuoVitals, OuoReplay, the URLSession hook) is wired by
/// `Ouo.start` through `Hooks`, so this class runs in tests on macOS.
final class Core {
    struct Hooks {
        var now: () -> Double = SteadyClock.nowMs
        /// Created at the first send, on the outbox's queue: the first `URLSession` of a process
        /// costs about 8 ms, which `start` on the main thread does not pay.
        var transport: ChunkTransport = LazyTransport()
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
        /// A new session is current (OuoCrash's session, replay). Called without the lock, in order:
        /// a change older than one already reported is skipped.
        var sessionChanged: (SessionRecord) -> Void = { _ in }
        /// Writes the screen context (`context.json`); injectable so tests can hold the write.
        var saveContext: ((ScreenContext, URL) -> Void)? = nil
        /// The same context, encoded, for the crash handler (`OuoCrash.setContext`). Called on the
        /// thread that changed it, before that call returns: a crash right after keeps it.
        var crashContext: (Data) -> Void = { _ in }
    }

    static let platform = "mobile"
    /// Longest `message` attribute of a log line (the Sentry bridge's cut).
    static let maxLogMessage = 1024

    let settings: Settings
    let log: Log
    let exporter: Exporter
    /// The resource without `device.id`, which the session store holds (`publishDevice`).
    let baseResource: Attributes
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
    /// Effects of a locked section that run after the lock is released (`locked`).
    private var generation = 0
    private var pendingRotation: (Int, SessionRecord)?
    private var contextSeq = 0
    private var pendingContext: (Int, ScreenContext)?
    private var publishedDevice = ""
    /// Writes `context.json` in order, off the caller's thread and out of the lock.
    let io = DispatchQueue(label: "dev.ouo.context", qos: .utility)
    private var writtenSeq = 0 // `io` only
    private let delivery = InOrder<SessionRecord>()
    private let crashOrder = InOrder<Data>()

    init(settings: Settings, directory: URL, hooks: Hooks = Hooks()) {
        self.settings = settings
        self.hooks = hooks
        self.directory = directory
        self.contextURL = directory.appendingPathComponent("context.json")
        self.log = Log(enabled: settings.debug)
        self.locale = Core.deviceLocale()
        let resource = Core.resource(settings)
        self.baseResource = resource
        self.exporter = Exporter(
            endpoint: settings.endpoint,
            authorization: ChunkUploader.basicAuthorization(projectId: settings.projectId, projectToken: settings.projectToken),
            directory: directory.appendingPathComponent("otlp", isDirectory: true),
            resource: resource,
            transport: hooks.transport,
            log: log
        )
        self.ingestPrefixes = [exporter.logsURL.absoluteString, exporter.tracesURL.absoluteString, Exporter.trim(settings.replayEndpoint) + ChunkUploader.chunksPath]
    }

    // MARK: - start

    /// The cold start: the previous run's session ends (with its crash or termination report when
    /// there is one), the new one starts, then the report itself is sent as a fatal `exception` of
    /// the crashed session, stamped at the crash, with the screen and last events that run persisted.
    func start(previousReport: NativeReport?, background: Bool, appStart: AppStartInfo?) {
        locked {
            inBackground = background
            // The launch's own state is no change: the first `app.lifecycle` is the first change.
            lifecycle = background ? "background" : "foreground"
            session = SessionManager(
                store: FileSessionStore(url: directory.appendingPathComponent("session.json")),
                now: hooks.now,
                timeouts: settings.timeouts,
                serviceVersion: settings.serviceVersion,
                emit: { [unowned self] name, attrs, at in self.emitLocked(name, attrs, at: at) },
                onRotate: { [unowned self] rec in
                    self.generation += 1
                    self.pendingRotation = (self.generation, rec)
                }
            )
            if settings.vitals {
                vitals = Vitals(deps: vitalsDeps(), appStart: appStart, launchedInForeground: !background)
            }
            session.start(crash: previousReport?.crashMarker, background: background)
            vitals?.sessionReady()
        }
        // The crashed run's screen and last events: read on the context queue before this run
        // writes its own there, off the caller's thread.
        if let r = previousReport {
            io.async { [self] in
                // The context the crash handler wrote wins; a termination (no handler ran) has the file.
                let ctx = r.screenContext ?? ScreenContext.load(contextURL)
                locked { emitPreviousReportLocked(r, ctx) }
            }
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
    func event(_ name: String, _ attrs: Attributes, severity: OuoLogLevel = .info, at: Double? = nil, body: String? = nil, trace: (String, String)? = nil) {
        locked { emitLocked(name, attrs, severity: severity, at: at ?? hooks.now(), body: body, trace: trace) }
    }

    /// `log` (C9): the message as body and `message`, the active span's trace.
    func logLine(_ severity: OuoLogLevel, _ message: String, _ attrs: Attributes, span: OuoSpan?) {
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

    /// A screen is showing (C7): one `navigation` per change, with `ouo.navigation.from`. `startedAt`:
    /// when it started to appear (UIKit's `viewWillAppear`), the start of its TTID; default now.
    func trackScreen(_ name: String, startedAt: Double? = nil) {
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
            vitals?.navigated(name, at: startedAt)
        }
    }

    /// The current screen's name ("" before the first): a tap records the screen it started on.
    var screenName: String { locked { screen } }

    /// `ui.tap` (C6), stamped at the touch start, on the screen it started on. A tap is activity.
    func tap(target: String, path: String?, viewType: String?, gesture: String, at: Double, screen: String) {
        guard settings.taps, !target.isEmpty else { return }
        var a: Attributes = ["ouo.ui.target": .string(target), "ouo.ui.gesture": .string(gesture)]
        if let path, path != target { a["ouo.ui.path"] = .string(path) }
        if let viewType { a["ouo.ui.view_type"] = .string(viewType) }
        if !screen.isEmpty { a["app.screen.name"] = .string(screen) }
        let body = TapRules.step(gesture: gesture, target: target, viewType: viewType, screen: screen)
        locked {
            session.touch()
            emitLocked("ui.tap", a, at: at, body: body)
        }
    }

    /// `feedback` (C10): returns its id, nil for an empty message. The record carries the session's
    /// last events; `screenshot` says the replay was asked for a frame of the screen.
    func feedback(message: String, contact: String?, screenshot: Bool) -> String? {
        let id = UUID().uuidString.lowercased()
        guard var a = Feedback.attributes(message: message, contact: contact, id: id) else {
            log.warn("feedback: empty message, nothing sent")
            return nil
        }
        if screenshot { a["ouo.feedback.screenshot"] = true }
        locked {
            // First: after an idle timeout this rotates, so the record lands on the session it is about.
            session.touch()
            let sid = session.ensure().id
            a["ouo.last_events"] = RecentEvents.attribute(recent.read(sid))
            emitLocked("feedback", a, at: hooks.now(), body: a["ouo.feedback.message"]?.text)
        }
        return id
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

    /// The event first, then one flush that writes everything to disk and tries to send it;
    /// `completion` once the outbox is empty or the collector could not be reached (the host ends its
    /// background task there).
    func didEnterBackground(completion: @escaping () -> Void = {}) {
        locked {
            lifecycleLocked("background")
            inBackground = true
            vitals?.background()
            session.background()
        }
        flush(completion: completion)
    }

    /// The device's protected data became available (the first unlock): a session file that could
    /// not be read at start is adopted now.
    func protectedDataAvailable() {
        locked { session.retryStore() }
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
        guard settings.lifecycleEvents else { return }
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
            var a: Attributes = ["service.version": .string(settings.serviceVersion)]
            stampLocked(&a)
            return a
        }
    }

    // MARK: - spans

    func export(_ span: SpanRecord) {
        guard case .string(let id)? = span.attributes["session.id"], sampled(id) else { return }
        exporter.add(span)
    }

    /// Writes the session (now), the context and every pending record to disk (on the context
    /// queue), then tries to send them; `completion` once the outbox is empty or its oldest request
    /// failed again.
    func flush(completion: @escaping () -> Void) {
        locked {
            session.persistNow()
            persistContextLocked()
        }
        // On the context queue: after the context write queued above, and after the previous run's
        // report that `start` emits there.
        io.async {
            self.exporter.flush()
            self.exporter.drain(completion: completion)
        }
    }

    // MARK: - internals (under `lock`)

    private func emitLocked(_ name: String, _ attrs: Attributes, severity: OuoLogLevel = .info, at: Double, body: String? = nil, trace: (String, String)? = nil) {
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
        set("service.version", .string(settings.serviceVersion))
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

    /// Snapshots the context; `locked` writes it after the lock is released.
    private func persistContextLocked() {
        guard let id = session.current?.id else { return }
        let c = ScreenContext(sessionId: id, screen: screen, events: recent.read(id))
        guard c != savedContext else { return }
        savedContext = c
        contextSeq += 1
        pendingContext = (contextSeq, c)
    }

    private func sampled(_ sessionId: String) -> Bool {
        Sampling.sampled(sessionId, rate: settings.sessionSampleRate, salt: Sampling.session)
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

    /// Runs `body` under the lock, then, released: the context write it asked for (queued, so in
    /// order and off this thread; a crash within a millisecond of it can lose it, as the React
    /// Native SDK's asynchronous storage can), the resource's `device.id` when it changed, and the
    /// session change it caused, in order across threads.
    @discardableResult
    func locked<T>(_ body: () -> T) -> T {
        lock.lock()
        let result = body()
        let rotation = pendingRotation
        let context = pendingContext
        pendingRotation = nil
        pendingContext = nil
        let device = session?.deviceId ?? ""
        let deviceChanged = device != publishedDevice
        publishedDevice = device
        lock.unlock()
        if let (seq, c) = context {
            // In order across threads, like the file below: an older context never lands last.
            if let data = try? JSONEncoder().encode(c) { crashOrder.deliver(seq, data, hooks.crashContext) }
            let url = contextURL
            let save = hooks.saveContext ?? { c, url in c.save(url) }
            io.async { [self] in
                guard seq > writtenSeq else { return }
                writtenSeq = seq
                save(c, url)
            }
        }
        if deviceChanged && !device.isEmpty {
            var r = baseResource
            r["device.id"] = .string(device)
            exporter.setResource(r)
        }
        if let (gen, rec) = rotation { delivery.deliver(gen, rec, hooks.sessionChanged) }
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

    /// Resource attributes, set once (mobile SDK spec rule 3) but for `device.id`, which comes from
    /// the session store; the app's extra ones lose on a clash.
    static func resource(_ c: Settings) -> Attributes {
        var a = c.resourceAttributes
        let v = ProcessInfo.processInfo.operatingSystemVersion
        let env = ProcessInfo.processInfo.environment
        let simulatorModel = env["SIMULATOR_MODEL_IDENTIFIER"]
        let model = simulatorModel ?? machine()
        a.merge([
            "service.name": .string(c.serviceName),
            "service.version": .string(c.serviceVersion),
            "deployment.environment.name": .string(c.environment),
            "ouo.platform": .string(platform),
            "ouo.sdk.name": .string(Ouo.sdkName),
            "ouo.sdk.version": .string(Ouo.sdkVersion),
            "os.name": .string(osName(model: model)),
            "os.version": .string("\(v.majorVersion).\(v.minorVersion).\(v.patchVersion)"),
            "device.manufacturer": "Apple",
            "device.model.identifier": .string(model),
        ]) { _, sdk in sdk }
        if simulatorModel != nil { a["ouo.device.simulator"] = true }
        return a
    }

    private static func osName(model: String) -> String {
        #if os(iOS)
        return ProcessInfo.processInfo.isiOSAppOnMac ? "macOS" : (model.hasPrefix("iPad") ? "iPadOS" : "iOS")
        #elseif os(macOS)
        return "macOS"
        #else
        return "unknown"
        #endif
    }

    /// `hw.machine`: `iPhone17,1`.
    private static func machine() -> String {
        var info = utsname()
        uname(&info)
        return withUnsafeBytes(of: &info.machine) { raw in
            String(decoding: raw.prefix { $0 != 0 }, as: UTF8.self)
        }
    }
}

/// Delivers values in the order they were made, across threads: one older than one already delivered
/// is skipped (a session change reported after a newer one would leave OuoCrash and replay on an
/// ended session).
final class InOrder<T> {
    private let lock = NSLock()
    private var delivered = 0

    func deliver(_ generation: Int, _ value: T, _ call: (T) -> Void) {
        lock.lock()
        defer { lock.unlock() }
        guard generation > delivered else { return }
        delivered = generation
        call(value)
    }
}

/// A `URLSessionTransport` made when the first request is sent.
final class LazyTransport: ChunkTransport {
    private let lock = NSLock()
    private var inner: URLSessionTransport?

    func send(_ request: URLRequest, completion: @escaping (Result<ChunkResponse, Swift.Error>) -> Void) {
        let t: URLSessionTransport = lock.withLock {
            if let inner { return inner }
            let made = URLSessionTransport()
            inner = made
            return made
        }
        t.send(request, completion: completion)
    }
}
