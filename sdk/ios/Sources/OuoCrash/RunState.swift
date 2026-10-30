import Foundation

/// What a run of the app last wrote about itself (`run.json` next to the crash report), so the next
/// launch can tell a foreground termination (OOM, watchdog) from a run that ended normally
/// (mobile SDK spec C3.2, project/kb/ios-terminations.md).
public struct RunState: Codable, Equatable {
    /// `CFBundleShortVersionString (CFBundleVersion)`: an update is no termination.
    public var release: String
    /// `operatingSystemVersionString`: an OS update restarts every app.
    public var os: String
    /// Device boot time, epoch ms (`kern.boottime`): a reboot or shutdown is no termination.
    public var bootMs: Double
    /// The app was active (foreground, not inactive) at the last write.
    public var active = false
    /// The app received `willTerminate` (the user or the system closed it in an orderly way).
    public var terminated = false
    /// A debugger was attached (Xcode's stop button kills the app).
    public var debugger = false
    public var sessionId = ""
    public var sessionStartedMs: Int64 = 0
    /// The last time the run was known alive, epoch ms (state changes and a heartbeat while active).
    public var aliveMs: Double = 0
    /// Set while an app hang is in progress (C3.1), cleared when it ends.
    public var hangStartedMs: Double?
    /// The last memory warning, epoch ms.
    public var memoryWarningMs: Double?

    public init(release: String, os: String, bootMs: Double) {
        self.release = release
        self.os = os
        self.bootMs = bootMs
    }

    /// The facts about this process the next run compares with.
    public static func current() -> RunState {
        let info = Bundle.main.infoDictionary ?? [:]
        let version = info["CFBundleShortVersionString"] as? String ?? ""
        let build = info["CFBundleVersion"] as? String ?? ""
        return RunState(release: "\(version) (\(build))", os: ProcessInfo.processInfo.operatingSystemVersionString, bootMs: bootTimeMs())
    }

    static func load(_ url: URL) -> RunState? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(RunState.self, from: data)
    }

    func write(_ url: URL) {
        guard let data = try? JSONEncoder().encode(self) else { return }
        try? data.write(to: url, options: .atomic)
    }
}

/// A previous run that ended in the foreground without a crash report.
public struct Termination: Equatable {
    public enum Cause: String {
        case memory, watchdog, unknown
    }

    public let cause: Cause
    /// When the run was last known alive, epoch ms.
    public let atMs: Double
    public let sessionId: String
    public let sessionStartedMs: Int64

    /// A memory warning this close to the end makes the cause `memory` (jetsam follows warnings).
    public static let memoryWarningWindowMs: Double = 60_000
    /// Boot times this close are the same boot (`kern.boottime` moves with clock corrections).
    static let bootToleranceMs: Double = 5_000

    /// Sentry's watchdog termination heuristic: the previous run was active, without a crash
    /// report (checked by the caller), a `willTerminate`, a debugger, an app or OS update or a
    /// reboot since. The cause: `memory` after a recent memory warning, `watchdog` when a hang was
    /// in progress (the main thread was blocked when it died), else `unknown`.
    public static func decide(previous p: RunState?, now c: RunState) -> Termination? {
        guard let p, p.active, !p.terminated, !p.debugger, p.aliveMs > 0 else { return nil }
        guard p.release == c.release, p.os == c.os, abs(p.bootMs - c.bootMs) < bootToleranceMs else { return nil }
        let cause: Cause
        if let w = p.memoryWarningMs, p.aliveMs - w <= memoryWarningWindowMs {
            cause = .memory
        } else if p.hangStartedMs != nil {
            cause = .watchdog
        } else {
            cause = .unknown
        }
        return Termination(cause: cause, atMs: p.aliveMs, sessionId: p.sessionId, sessionStartedMs: p.sessionStartedMs)
    }

    /// The report the host reads like a crash report (`mechanism: "termination"`).
    public var report: String {
        var r: [String: Any] = [
            "version": 1,
            "mechanism": "termination",
            "timestamp_ms": atMs.rounded(),
            "session_id": sessionId,
            "termination": ["cause": cause.rawValue],
        ]
        if sessionStartedMs > 0 { r["session_started_ms"] = sessionStartedMs }
        return json(r)
    }
}

func json(_ object: [String: Any]) -> String {
    guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else { return "{}" }
    return String(data: data, encoding: .utf8) ?? "{}"
}

func bootTimeMs() -> Double {
    var tv = timeval()
    var size = MemoryLayout<timeval>.stride
    var mib: [Int32] = [CTL_KERN, KERN_BOOTTIME]
    guard sysctl(&mib, 2, &tv, &size, nil, 0) == 0 else { return 0 }
    return Double(tv.tv_sec) * 1000 + Double(tv.tv_usec) / 1000
}
