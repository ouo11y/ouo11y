import Foundation
import OuoCrash
import OuoReplayCore

/// A report written by OuoCrash (project/kb/ios-native-crashes.md): a crash at crash time, a
/// `termination` built by the next launch, a `hang` when one is over. The same fields as
/// `NativeCrashReport` in `@ouo11y/react-native`'s `crash.ts`, which this file ports.
struct NativeReport: Codable, Equatable {
    struct Frame: Codable, Equatable {
        var instruction_addr: String
        var image_addr: String?
    }
    struct Image: Codable, Equatable {
        var code_file: String
        var debug_id: String?
        var image_addr: String
        var image_size: Int?
        var image_vmaddr: String?
    }
    struct ThreadInfo: Codable, Equatable { var main: Bool? }
    struct Signal: Codable, Equatable {
        var number: Int?
        var name: String?
        var mach_exception: String?
        var code: Int?
        var code_name: String?
        var address: String?
    }
    struct ExceptionInfo: Codable, Equatable {
        var name: String?
        var reason: String?
    }
    struct HangInfo: Codable, Equatable {
        var duration_ms: Double
        var fully_blocking: Bool?
    }
    struct TerminationInfo: Codable, Equatable { var cause: String? }

    var mechanism: String
    var timestamp_ms: Double
    var session_id: String?
    var session_started_ms: Double?
    var arch: String?
    var thread: ThreadInfo?
    var signal: Signal?
    var exception: ExceptionInfo?
    var hang: HangInfo?
    var termination: TerminationInfo?
    var frames: [Frame]?
    var images: [Image]?

    static let mechanisms: Set<String> = ["signal", "nsexception", "hang", "termination"]

    /// Nil for anything unreadable (a truncated file, an unknown mechanism).
    static func parse(_ raw: String) -> NativeReport? {
        guard let data = raw.data(using: .utf8), var r = try? JSONDecoder().decode(NativeReport.self, from: data),
              mechanisms.contains(r.mechanism), r.timestamp_ms.isFinite else { return nil }
        if r.mechanism == "hang" && r.hang == nil { return nil }
        if let s = r.session_started_ms, !(s > 0) { r.session_started_ms = nil }
        return r
    }

    /// The session manager's view: which session died, when, and when it started.
    var crashMarker: CrashMarker {
        CrashMarker(sessionId: session_id ?? "", at: timestamp_ms, startedAt: session_started_ms)
    }

    var title: (type: String, message: String) {
        switch mechanism {
        case "hang":
            let s = String(format: "%.1f", (hang?.duration_ms ?? 0) / 1000)
            return ("AppHang", "App hanging for \(s) s\(hang?.fully_blocking == true ? "" : " (not fully blocking)")")
        case "termination":
            return ("WatchdogTermination", "The app was terminated in the foreground without a crash report (cause: \(terminationCause))")
        case "nsexception":
            let name = exception?.name.flatMap { $0.isEmpty ? nil : $0 } ?? "NSException"
            return (name, exception?.reason ?? "")
        default:
            let name = signal?.name ?? "signal"
            var parts = ["\(signal?.mach_exception ?? "EXC_CRASH") (\(name))"]
            if let c = signal?.code_name { parts.append(c) }
            if let a = signal?.address, name == "SIGSEGV" || name == "SIGBUS" { parts.append("at \(a)") }
            return (name, parts.joined(separator: " "))
        }
    }

    var terminationCause: String {
        let c = termination?.cause ?? ""
        return ["memory", "cpu", "launch_timeout", "watchdog", "unknown"].contains(c) ? c : "unknown"
    }

    /// `exception` attributes (session-lifecycle spec) plus what symbolication needs later
    /// (`ouo.crash.frames`, `ouo.crash.images`): `native` for a crash, `hang` (not fatal) and
    /// `termination` (fatal; a stack only when it died during a hang).
    var attributes: Attributes {
        let (type, message) = title
        let kind = mechanism == "hang" || mechanism == "termination" ? mechanism : "native"
        var a: Attributes = [
            "exception.type": .string(type),
            "exception.message": .string(message),
            "ouo.exception.fatal": .bool(kind != "hang"),
            "ouo.exception.handled": false,
            "ouo.exception.kind": .string(kind),
        ]
        if kind == "termination" { a["ouo.termination.cause"] = .string(terminationCause) }
        let fs = frames ?? []
        if kind != "termination" || !fs.isEmpty {
            a["exception.stacktrace"] = .string(Stack.format(type: type, message: message, frames: fs, images: images ?? [], arch: arch,
                                                             threadMain: thread?.main, verb: kind == "native" ? "crashed" : "hung"))
            a["ouo.crash.mechanism"] = .string(mechanism)
            a["ouo.crash.timestamp"] = .int(Int64(timestamp_ms.rounded()))
            a.merge(Stack.symbolication(frames: fs, images: images ?? [])) { _, b in b }
        }
        if let h = hang {
            a["ouo.hang.duration_ms"] = .double(h.duration_ms)
            a["ouo.hang.fully_blocking"] = .bool(h.fully_blocking == true)
        }
        if let s = session_id, !s.isEmpty { a["session.id"] = .string(s) }
        if let arch { a["ouo.crash.arch"] = .string(arch) }
        if let s = signal {
            if let n = s.name { a["ouo.crash.signal"] = .string(n) }
            if let m = s.mach_exception { a["ouo.crash.mach_exception"] = .string(m) }
            if let ad = s.address { a["ouo.crash.address"] = .string(ad) }
        }
        if let m = thread?.main { a["ouo.crash.thread_main"] = .bool(m) }
        return a
    }
}

/// Native stacks as people and symbolication read them.
enum Stack {
    /// The calling thread's stack as frames and binary images (OuoCrash's crash report fields).
    static func current(skipping skip: Int = 0) -> (frames: [NativeReport.Frame], images: [NativeReport.Image]) {
        let addresses = Thread.callStackReturnAddresses.dropFirst(skip + 1).map { UInt($0.uintValue) }
        return fields(OuoCrash.stackFields(Array(addresses)))
    }

    static func fields(_ raw: [String: Any]) -> (frames: [NativeReport.Frame], images: [NativeReport.Image]) {
        guard let data = try? JSONSerialization.data(withJSONObject: raw),
              let r = try? JSONDecoder().decode(Fields.self, from: data) else { return ([], []) }
        return (r.frames ?? [], r.images ?? [])
    }

    private struct Fields: Decodable {
        var frames: [NativeReport.Frame]?
        var images: [NativeReport.Image]?
    }

    static func symbolication(frames: [NativeReport.Frame], images: [NativeReport.Image]) -> Attributes {
        let enc = JSONEncoder()
        enc.outputFormatting = [.sortedKeys]
        func s<T: Encodable>(_ v: T) -> String { (try? enc.encode(v)).flatMap { String(data: $0, encoding: .utf8) } ?? "[]" }
        return ["ouo.crash.frames": .string(s(frames)), "ouo.crash.images": .string(s(images))]
    }

    /// Apple crash report style, so it reads without symbols and `atos -o <dSYM> -l <image_addr>
    /// <instruction_addr>` works line by line (`formatNativeStack` of the React Native SDK):
    ///   0   MyApp                           0x0000000104a1c2f0 0x104a00000 + 115440
    static func format(type: String, message: String, frames: [NativeReport.Frame], images: [NativeReport.Image],
                       arch: String?, threadMain: Bool?, verb: String) -> String {
        let byAddr = Dictionary(images.map { ($0.image_addr, $0) }, uniquingKeysWith: { a, _ in a })
        let thread = threadMain == true ? "main thread" : threadMain == false ? "background thread" : "crashed thread"
        var lines = ["\(type): \(message)".trimmingCharacters(in: .whitespaces), "Thread (\(thread)) \(verb)\(arch.map { ", \($0)" } ?? ""):"]
        for (i, f) in frames.enumerated() {
            let img = f.image_addr.flatMap { byAddr[$0] }
            let name = img.map { basename($0.code_file) } ?? "???"
            let addr = hex(f.instruction_addr)
            let base = hex(f.image_addr)
            let offset = addr != nil && base != nil && addr! >= base! ? " \(f.image_addr!) + \(addr! - base!)" : ""
            let padded = addr.map { "0x" + pad(String($0, radix: 16), 16, "0", left: true) } ?? f.instruction_addr
            lines.append(pad(String(i), 4, " ") + pad(name, 32, " ") + padded + offset)
        }
        if !images.isEmpty {
            lines += ["", "Binary Images:"]
            for img in images {
                let end = hex(img.image_addr).map { "0x" + String($0 + UInt64(max(0, (img.image_size ?? 0) - 1)), radix: 16) } ?? "?"
                lines.append("\(img.image_addr) - \(end) \(basename(img.code_file)) \(arch ?? "") <\((img.debug_id ?? "").lowercased())> \(img.code_file)")
            }
        }
        return lines.joined(separator: "\n")
    }

    private static func basename(_ path: String) -> String {
        let b = (path as NSString).lastPathComponent
        return b.isEmpty ? path : b
    }

    private static func hex(_ s: String?) -> UInt64? {
        guard let s, s.hasPrefix("0x") || s.hasPrefix("0X") else { return nil }
        return UInt64(s.dropFirst(2), radix: 16)
    }

    private static func pad(_ s: String, _ width: Int, _ fill: Character, left: Bool = false) -> String {
        let n = max(0, width - s.count)
        return left ? String(repeating: fill, count: n) + s : s + String(repeating: fill, count: n)
    }
}
