import Foundation
import OuoCrashCore

/// Native crash capture (checklist G1). `install()` sets the signal handlers (OuoCrashCore, C) and
/// the uncaught NSException handler; a crash writes one JSON report to disk at crash time, and
/// `takePendingReport()` hands it over on the next launch so the host sends it (the React Native
/// SDK as an OTel `exception` with the crashed session's id). Report format:
/// project/kb/ios-native-crashes.md.
///
/// Next to another crash reporter (Sentry): ouo keeps the previously installed signal and
/// exception handlers and calls them after writing its report, whichever SDK installs first.
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
    }

    public static var isInstalled: Bool { ouo_crash_is_installed() }

    /// The session a crash from now on belongs to, and its start (epoch ms, 0 when unknown).
    public static func setSession(_ id: String, startedAtMs: Int64) {
        id.withCString { ouo_crash_set_session($0, startedAtMs) }
    }

    /// The report left by the previous run, if any, removed from disk (at most once: a crash loop
    /// must not resend it). The JSON is what OuoCrashCore wrote.
    public static func takePendingReport(directory dir: URL? = nil) -> String? {
        let url = (dir ?? lock.withLock { directory }).appendingPathComponent("report.json")
        guard let data = try? Data(contentsOf: url) else { return nil }
        try? FileManager.default.removeItem(at: url)
        return String(data: data, encoding: .utf8)
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
