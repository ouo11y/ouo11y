import Foundation
import OuoCrashCore

/// What a run of the app last wrote about itself (`run.json` next to the crash report), so the next
/// launch can tell a foreground termination (OOM, watchdog) from a run that ended normally
/// (mobile SDK spec C3.2, project/kb-archive/ios-hangs-terminations.md).
public struct RunState: Codable, Equatable {
    /// `CFBundleShortVersionString (CFBundleVersion) <main executable's LC_UUID>`: an update is no
    /// termination, nor a development reinstall that kept the version string.
    public var release: String
    /// `major.minor.patch (kern.osversion build)`: an OS update restarts every app.
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
    /// The main thread's stack of that hang, read when it was detected: `{"frames":[...],"images":[...]}`
    /// as in a crash report, so a watchdog kill during it reports where the main thread was stuck.
    public var hangStack: String?
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
        let v = ProcessInfo.processInfo.operatingSystemVersion
        return RunState(
            release: "\(version) (\(build)) \(mainImageUUID())",
            os: "\(v.majorVersion).\(v.minorVersion).\(v.patchVersion) (\(sysctlString("kern.osversion")))",
            bootMs: bootTimeMs()
        )
    }

    static func load(_ url: URL) -> RunState? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(RunState.self, from: data)
    }

    /// Readable after the first unlock, also when the app's default is `NSFileProtectionComplete`
    /// (a background launch of a locked device must still read it).
    func write(_ url: URL) {
        guard let data = try? JSONEncoder().encode(self) else { return }
        #if os(iOS) || os(tvOS) || os(visionOS) || os(watchOS)
        try? data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        #else
        try? data.write(to: url, options: .atomic)
        #endif
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
    /// The main thread's stack when the run died during a hang (`RunState.hangStack`).
    public var stack: String?

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
        var t = Termination(cause: cause, atMs: p.aliveMs, sessionId: p.sessionId, sessionStartedMs: p.sessionStartedMs)
        if p.hangStartedMs != nil { t.stack = p.hangStack }
        return t
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
        // Died during a hang: where the main thread was stuck, as in a crash report.
        if let stack, let data = stack.data(using: .utf8),
           let s = try? JSONSerialization.jsonObject(with: data) as? [String: Any], s["frames"] is [Any] {
            r["frames"] = s["frames"]
            r["images"] = s["images"] ?? []
            r["thread"] = ["main": true]
            if let arch = s["arch"] { r["arch"] = arch }
        }
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

func sysctlString(_ name: String) -> String {
    var size = 0
    guard sysctlbyname(name, nil, &size, nil, 0) == 0, size > 0 else { return "" }
    var buf = [CChar](repeating: 0, count: size)
    guard sysctlbyname(name, &buf, &size, nil, 0) == 0 else { return "" }
    return String(cString: buf)
}

/// The main executable's LC_UUID (changes with every build), "" when unknown.
func mainImageUUID() -> String {
    var uuid = [UInt8](repeating: 0, count: 16)
    guard ouo_crash_main_image_uuid(&uuid) else { return "" }
    return UUID(uuid: (uuid[0], uuid[1], uuid[2], uuid[3], uuid[4], uuid[5], uuid[6], uuid[7], uuid[8], uuid[9], uuid[10], uuid[11], uuid[12], uuid[13], uuid[14], uuid[15])).uuidString
}
