import Foundation
import OuoCrashCore
import OuoVitals

/// Native crash capture (checklist G1). `install()` sets the signal handlers (OuoCrashCore, C) and
/// the uncaught NSException handler; a crash writes one JSON report to disk at crash time, and
/// `takePendingReport()` hands it over on the next launch so the host sends it (the React Native
/// SDK as an OTel `exception` with the crashed session's id). Report format:
/// project/kb/ios-native-crashes.md.
///
/// Next to another crash reporter (Sentry): ouo keeps the previously installed signal and
/// exception handlers and calls them after writing its report, whichever SDK installs first.
///
/// The two failures no handler can see come in the same report format (mobile SDK spec C3):
/// `install()` also keeps `run.json` current, and the next launch's `takePendingReport()` returns a
/// `termination` report when the previous run died in the foreground without a crash report
/// (`RunState`, `Termination`); `startHangTracking` reports main-thread hangs as `hang` reports.
public enum OuoCrash {
    /// Default directory: `Library/Application Support/ouo/crash`.
    public static var defaultDirectory: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSTemporaryDirectory())
        return base.appendingPathComponent("ouo/crash", isDirectory: true)
    }

    private static let lock = NSLock()
    private static var directory = defaultDirectory
    /// The handler that was installed before ours (Sentry's, the host's), called after ours.
    private static var previousExceptionHandler: (@convention(c) (NSException) -> Void)?
    private static var exceptionHandlerInstalled = false

    private static var tracker: RunTracker?
    /// Directories whose previous run was read (once per process, before this run writes its own).
    private static var previousRuns: [URL: RunState?] = [:]
    /// Directories whose pending report was taken (a crash or a termination, at most once).
    private static var taken: Set<URL> = []
    /// Pairs each hang's start (and its stack) with its end.
    private static var hangs = HangPairing()
    /// Where hang reports go: the last `startHangTracking` caller (a reloaded host replaces it).
    private static var hangHandler: ((String) -> Void)?

    static var reportURL: URL { directory.appendingPathComponent("report.json") }

    /// Installs the handlers. Safe to call more than once (later calls only change the session or
    /// directory). Returns false when the directory cannot be created or a handler failed.
    @discardableResult
    public static func install(directory dir: URL? = nil) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if let dir { directory = dir }
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        } catch {
            return false
        }
        let ok = reportURL.path.withCString { ouo_crash_install($0) }
        installExceptionHandler()
        if tracker == nil {
            _ = previousRun(in: directory)
            let t = RunTracker(url: directory.appendingPathComponent("run.json"))
            tracker = t
            t.start()
        }
        // Stack overflows on the main thread need an alternate signal stack there.
        if Thread.isMainThread {
            ouo_crash_install_alt_stack()
        } else {
            DispatchQueue.main.async { ouo_crash_install_alt_stack() }
        }
        return ok
    }

    /// Restores the previous signal handlers (tests, hosts that turn crash capture off).
    public static func uninstall() {
        ouo_crash_uninstall()
        lock.withLock {
            tracker?.stop()
            tracker = nil
        }
    }

    public static var isInstalled: Bool { ouo_crash_is_installed() }

    /// The session a crash from now on belongs to, and its start (epoch ms, 0 when unknown).
    public static func setSession(_ id: String, startedAtMs: Int64) {
        id.withCString { ouo_crash_set_session($0, startedAtMs) }
        lock.withLock { tracker }?.update {
            $0.sessionId = id
            $0.sessionStartedMs = startedAtMs
        }
    }

    /// What the app showed and its last steps (the host's screen context as JSON), kept in memory
    /// for the crash handler to write into the report: a crash right after a tap still carries the
    /// tap, which a file written after it could miss. At most 24 KiB of JSON (32 KiB in base64);
    /// longer is not kept. Cheap (a copy); from any thread.
    public static func setContext(_ json: Data) {
        let b64 = json.count <= 24 * 1024 ? json.base64EncodedString() : ""
        lock.withLock {
            b64.withCString { ouo_crash_set_context($0, b64.utf8.count) }
        }
    }

    /// The report left by the previous run, if any, removed from disk (at most once: a crash loop
    /// must not resend it). The JSON is what OuoCrashCore wrote, or, when the previous run died in
    /// the foreground without one, a `termination` report built from its `run.json` (once per process).
    public static func takePendingReport(directory dir: URL? = nil) -> String? {
        let d = dir ?? lock.withLock { directory }
        let url = d.appendingPathComponent("report.json")
        let first = lock.withLock { taken.insert(d).inserted }
        if let data = try? Data(contentsOf: url) {
            try? FileManager.default.removeItem(at: url)
            return String(data: data, encoding: .utf8)
        }
        guard first else { return nil }
        let previous = lock.withLock { previousRun(in: d) }
        return Termination.decide(previous: previous, now: .current())?.report
    }

    /// The previous run's state in `dir`, read before this run's tracker writes its own, and
    /// removed: if this run dies before it writes, the next launch must not judge that run again.
    /// Under `lock`.
    private static func previousRun(in dir: URL) -> RunState? {
        if let known = previousRuns[dir] { return known }
        let url = dir.appendingPathComponent("run.json")
        let state = RunState.load(url)
        try? FileManager.default.removeItem(at: url)
        previousRuns[dir] = .some(state)
        return state
    }

    /// Starts the app hang watchdog (`OuoVitals.startHangTracking`, spec C3.1). `onHang` gets one
    /// `hang` report per hang, once it is over, on the watchdog or the main thread: the duration,
    /// whether it was fully blocking, and the main thread's stack read when it was detected (frames
    /// and images as in a crash report, so dSYM symbolication reads it). While a hang is in
    /// progress `run.json` says so: a kill then is a `watchdog` termination. One watchdog per
    /// process; a later call only replaces `onHang` (a React Native reload creates a new module).
    public static func startHangTracking(onHang: @escaping (String) -> Void) {
        lock.withLock { hangHandler = onHang }
        OuoVitals.startHangTracking(
            onStart: { start in
                var buf = [UInt](repeating: 0, count: 128)
                let n = Int(ouo_crash_main_thread_backtrace(&buf, Int32(buf.count)))
                let frames = Array(buf.prefix(max(0, n)))
                let stack = json(stackFields(frames).merging(["arch": arch]) { a, _ in a })
                // Under the lock, so the run state sees the start before its end.
                lock.withLock {
                    guard hangs.started(start, frames: frames) else { return }
                    tracker?.update {
                        $0.hangStartedMs = nowMs()
                        $0.hangStack = stack
                    }
                }
            },
            onEnd: { hang, startMs in
                let (frames, handler) = lock.withLock { () -> ([UInt], ((String) -> Void)?) in
                    let frames = hangs.ended(hang.start)
                    tracker?.update {
                        $0.hangStartedMs = nil
                        $0.hangStack = nil
                    }
                    return (frames, hangHandler)
                }
                handler?(hangReport(hang, startMs: startMs, frames: frames))
            }
        )
    }

    static func hangReport(_ hang: Hang, startMs: Double, frames: [UInt]) -> String {
        json([
            "version": 1,
            "mechanism": "hang",
            "timestamp_ms": startMs.rounded(),
            "arch": arch,
            "thread": ["main": true],
            "hang": ["duration_ms": (hang.duration * 1_000_000).rounded() / 1000, "fully_blocking": hang.fullyBlocking],
        ].merging(stackFields(frames)) { a, _ in a })
    }

    /// `frames` and the `images` they point into, in the crash report's fields (also what a host
    /// puts on a captured error's stack, so dSYM symbolication reads it).
    public static func stackFields(_ frames: [UInt]) -> [String: Any] {
        var images: [UInt: [String: Any]] = [:]
        let fs: [[String: Any]] = frames.map { addr in
            var f: [String: Any] = ["instruction_addr": hex(addr)]
            var info = ouo_crash_image_info()
            if ouo_crash_image_for(addr, &info) {
                f["image_addr"] = hex(info.image_addr)
                if images[info.image_addr] == nil {
                    var image: [String: Any] = [
                        "code_file": info.code_file.map { String(cString: $0) } ?? "",
                        "image_addr": hex(info.image_addr),
                        "image_size": info.image_size,
                        "image_vmaddr": hex(UInt(info.image_vmaddr)),
                    ]
                    if info.has_uuid {
                        image["debug_id"] = withUnsafeBytes(of: info.uuid) { UUID(uuid: $0.load(as: uuid_t.self)).uuidString }
                    }
                    images[info.image_addr] = image
                }
            }
            return f
        }
        return ["frames": fs, "images": images.keys.sorted().compactMap { images[$0] }]
    }

    private static func hex(_ v: UInt) -> String { "0x" + String(v, radix: 16) }

    private static var arch: String {
        #if arch(arm64)
        return "arm64"
        #elseif arch(x86_64)
        return "x86_64"
        #else
        return "unknown"
        #endif
    }

    private static func installExceptionHandler() {
        let current = NSGetUncaughtExceptionHandler()
        if exceptionHandlerInstalled, let current, unsafeBitCast(current, to: UnsafeRawPointer.self) == unsafeBitCast(ouoExceptionHandler, to: UnsafeRawPointer.self) {
            return
        }
        // Someone replaced ours since (or first install): chain to whatever is there now.
        previousExceptionHandler = current
        NSSetUncaughtExceptionHandler(ouoExceptionHandler)
        exceptionHandlerInstalled = true
    }

    fileprivate static func handle(_ exception: NSException) {
        let addresses = exception.callStackReturnAddresses.map { UInt($0.uintValue) }
        let name = exception.name.rawValue
        let reason = exception.reason ?? ""
        name.withCString { n in
            reason.withCString { r in
                addresses.withUnsafeBufferPointer { a in
                    ouo_crash_record_exception(n, r, a.baseAddress, a.count, Thread.isMainThread)
                }
            }
        }
        previousExceptionHandler?(exception)
    }
}

private let ouoExceptionHandler: @convention(c) (NSException) -> Void = { exception in
    OuoCrash.handle(exception)
}

/// Pairs a hang's start with its end. The watchdog reports the start on its thread after the
/// detector's lock is released, so the end (from the main thread when the app resigns active) can
/// come first: then the start is ignored, and the report has no stack.
struct HangPairing {
    private var open: (start: Double, frames: [UInt])?
    private var endedBeforeStart: Double?

    /// False when this hang already ended: nothing to record.
    mutating func started(_ start: Double, frames: [UInt]) -> Bool {
        if endedBeforeStart == start {
            endedBeforeStart = nil
            return false
        }
        open = (start, frames)
        return true
    }

    /// The stack read at the start, or none when the start has not been seen.
    mutating func ended(_ start: Double) -> [UInt] {
        if let o = open, o.start == start {
            open = nil
            return o.frames
        }
        endedBeforeStart = start
        return []
    }
}
