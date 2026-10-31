import Foundation
import Testing
@testable import OuoCrash

private final class BundleToken {}

/// Crashes a real process (OuoCrashProbe) and reads what ouo's handlers left on disk.
@Suite(.serialized) struct OuoCrashTests {
    struct Run {
        let status: Int32
        let signaled: Bool
        let report: [String: Any]?
        let marker: String
    }

    static func probeURL() throws -> URL {
        // The probe is built next to the test bundle (same products directory).
        var candidates: [URL] = [Bundle(for: BundleToken.self).bundleURL.deletingLastPathComponent()]
        candidates += Bundle.allBundles.map { $0.bundleURL.deletingLastPathComponent() }
        candidates.append(URL(fileURLWithPath: CommandLine.arguments[0]).deletingLastPathComponent())
        for dir in candidates {
            var d = dir
            for _ in 0..<4 {
                let p = d.appendingPathComponent("OuoCrashProbe")
                if FileManager.default.isExecutableFile(atPath: p.path) { return p }
                d = d.deletingLastPathComponent()
            }
        }
        throw CocoaError(.fileNoSuchFile)
    }

    func crash(_ kind: String, chain: Bool = false, session: String = "3f0c1d2e-0000-4000-8000-000000000001", context: String? = nil) throws -> Run {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("ouo-crash-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let marker = dir.appendingPathComponent("marker.txt")
        let p = Process()
        p.executableURL = try Self.probeURL()
        p.arguments = [dir.path, session, kind] + (chain ? [marker.path] : [])
        if let context { p.environment = ["OUO_PROBE_CONTEXT": context] }
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        try p.run()
        p.waitUntilExit()
        let raw = OuoCrash.takePendingReport(directory: dir)
        let report = raw.flatMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any] }
        #expect(raw == nil || report != nil, "report is valid JSON: \(raw ?? "")")
        #expect(OuoCrash.takePendingReport(directory: dir) == nil, "taken at most once")
        return Run(
            status: p.terminationStatus,
            signaled: p.terminationReason == .uncaughtSignal,
            report: report,
            marker: (try? String(contentsOf: marker, encoding: .utf8)) ?? ""
        )
    }

    func frames(_ r: [String: Any]) -> [[String: Any]] { r["frames"] as? [[String: Any]] ?? [] }
    func images(_ r: [String: Any]) -> [[String: Any]] { r["images"] as? [[String: Any]] ?? [] }

    /// The crash handler writes the last context the host set (base64 of its JSON): a crash right
    /// after a tap carries the tap, with no file write in between.
    @Test func TheCrashCarriesTheLastContextTheHostSet() throws {
        let json = #"{"sessionId":"s","screen":"Cart","events":[{"ts":1,"name":"ui.tap","body":"Tap pay (button) on Cart ✓"}]}"#
        let run = try crash("segv", context: json)
        let r = try #require(run.report)
        let b64 = try #require(r["context"] as? String)
        #expect(String(data: try #require(Data(base64Encoded: b64)), encoding: .utf8) == json)
        let none = try #require(try crash("abort").report)
        #expect(none["context"] == nil, "no context set, none written")
    }

    @Test func SegfaultIsWrittenWithFramesAndImagesAndTheProcessStillDies() throws {
        let run = try crash("segv")
        #expect(run.signaled && (run.status == SIGSEGV || run.status == SIGBUS), "default action still runs: status \(run.status)")
        let r = try #require(run.report)
        #expect(r["mechanism"] as? String == "signal")
        #expect(r["session_id"] as? String == "3f0c1d2e-0000-4000-8000-000000000001")
        #expect((r["session_started_ms"] as? NSNumber)?.int64Value == 1_760_000_000_123, "N52: the session start travels with the crash")
        let sig = try #require(r["signal"] as? [String: Any])
        #expect(["SIGSEGV", "SIGBUS"].contains(sig["name"] as? String))
        #expect(sig["mach_exception"] as? String == "EXC_BAD_ACCESS")
        #expect(sig["address"] as? String == "0x10")
        let ts = try #require(r["timestamp_ms"] as? Double)
        #expect(abs(ts - Date().timeIntervalSince1970 * 1000) < 60_000)
        #expect((r["thread"] as? [String: Any])?["main"] as? Bool == true)
        // Symbolication inputs: every frame has instruction_addr; the probe's own frames point into
        // the probe image, which is listed with its UUID and load address.
        let fs = frames(r)
        #expect(fs.count >= 4, "pc, crashSegv's caller chain, main, dyld start: \(fs)")
        #expect(fs.allSatisfy { ($0["instruction_addr"] as? String)?.hasPrefix("0x") == true })
        let probe = try #require(images(r).first { ($0["code_file"] as? String)?.hasSuffix("/OuoCrashProbe") == true })
        let probeAddr = try #require(probe["image_addr"] as? String)
        #expect((probe["debug_id"] as? String)?.count == 36)
        #expect((probe["image_size"] as? Int ?? 0) > 0)
        #expect(fs.filter { $0["image_addr"] as? String == probeAddr }.count >= 3, "crashSegv, level2, level1, main live in the probe")
        // Only images that frames point into are listed.
        let used = Set(fs.compactMap { $0["image_addr"] as? String })
        #expect(Set(images(r).compactMap { $0["image_addr"] as? String }) == used)
    }

    @Test func AbortIsWritten() throws {
        let run = try crash("abort")
        #expect(run.signaled && run.status == SIGABRT)
        let r = try #require(run.report)
        #expect((r["signal"] as? [String: Any])?["name"] as? String == "SIGABRT")
        #expect(frames(r).count >= 3)
    }

    @Test func SwiftTrapIsWritten() throws {
        let run = try crash("trap")
        #expect(run.signaled)
        let r = try #require(run.report)
        #expect(["SIGTRAP", "SIGILL"].contains((r["signal"] as? [String: Any])?["name"] as? String))
    }

    @Test func UncaughtNSExceptionIsWrittenOnceWithItsNameAndReason() throws {
        let run = try crash("nsexception")
        #expect(run.signaled && run.status == SIGABRT, "the runtime still aborts")
        let r = try #require(run.report)
        #expect(r["mechanism"] as? String == "nsexception", "the SIGABRT after the exception does not overwrite it")
        let e = try #require(r["exception"] as? [String: Any])
        #expect(e["name"] as? String == "OuoProbeException")
        #expect(e["reason"] as? String == "probe reason \"quoted\"", "JSON escaping")
        #expect(frames(r).count >= 3)
        #expect(!images(r).isEmpty)
    }

    @Test func PreviousHandlersStillRunAfterOurs() throws {
        // Another crash reporter (Sentry) installed first: ouo writes its report, then the
        // previous handler runs and decides how the process dies.
        let segv = try crash("segv", chain: true)
        #expect(segv.report != nil)
        #expect(segv.marker.contains("previous signal handler \(SIGSEGV)") || segv.marker.contains("previous signal handler \(SIGBUS)"), "marker: \(segv.marker)")
        #expect(segv.signaled)

        let exc = try crash("nsexception", chain: true)
        #expect(exc.report?["mechanism"] as? String == "nsexception")
        #expect(exc.marker.contains("previous exception handler OuoProbeException"), "marker: \(exc.marker)")
        #expect(exc.marker.contains("previous signal handler \(SIGABRT)"), "the abort still reaches the previous signal handler: \(exc.marker)")
    }

    @Test func NoCrashNoReport() throws {
        let run = try crash("none")
        #expect(run.status == 0 && !run.signaled)
        #expect(run.report == nil)
    }
}
