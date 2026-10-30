import Foundation
import Testing
@testable import OuoCrash

/// The next-launch termination heuristic (spec C3.2) and its report.
@Suite struct TerminationTests {
    let now = RunState(release: "1.2.0 (42)", os: "Version 27.0 (Build 24A1)", bootMs: 1_760_000_000_000)

    /// A previous run that died while active, 10 s after its last heartbeat.
    func killedWhileActive() -> RunState {
        var p = now
        p.active = true
        p.sessionId = "s-1"
        p.sessionStartedMs = 1_760_000_100_000
        p.aliveMs = 1_760_000_200_000
        return p
    }

    @Test func aForegroundKillIsATerminationWithUnknownCause() throws {
        let t = try #require(Termination.decide(previous: killedWhileActive(), now: now))
        #expect(t == Termination(cause: .unknown, atMs: 1_760_000_200_000, sessionId: "s-1", sessionStartedMs: 1_760_000_100_000))
    }

    @Test func aRecentMemoryWarningMakesItMemory() throws {
        var p = killedWhileActive()
        p.memoryWarningMs = p.aliveMs - 5_000
        #expect(Termination.decide(previous: p, now: now)?.cause == .memory)
        p.memoryWarningMs = p.aliveMs - Termination.memoryWarningWindowMs - 1
        #expect(Termination.decide(previous: p, now: now)?.cause == .unknown, "an old warning says nothing")
    }

    @Test func aHangInProgressMakesItWatchdog() throws {
        var p = killedWhileActive()
        p.hangStartedMs = p.aliveMs - 8_000
        #expect(Termination.decide(previous: p, now: now)?.cause == .watchdog)
        p.memoryWarningMs = p.aliveMs - 1_000
        #expect(Termination.decide(previous: p, now: now)?.cause == .memory, "jetsam does not need the main thread")
    }

    @Test func noPreviousRunIsNoTermination() {
        #expect(Termination.decide(previous: nil, now: now) == nil)
    }

    @Test func runsTheHeuristicExcludesAreNoTermination() {
        let cases: [(String, (inout RunState) -> Void)] = [
            ("in the background or inactive", { $0.active = false }),
            ("willTerminate (closed in an orderly way)", { $0.terminated = true }),
            ("a debugger was attached", { $0.debugger = true }),
            ("the app was updated", { $0.release = "1.1.0 (41)" }),
            ("the OS was updated", { $0.os = "Version 26.4 (Build 23E1)" }),
            ("the device rebooted", { $0.bootMs -= 60_000 }),
            ("never wrote a heartbeat", { $0.aliveMs = 0 }),
        ]
        for (name, change) in cases {
            var p = killedWhileActive()
            change(&p)
            #expect(Termination.decide(previous: p, now: now) == nil, "\(name)")
        }
    }

    @Test func aClockCorrectionOfTheBootTimeIsTheSameBoot() {
        var p = killedWhileActive()
        p.bootMs += 1_200
        #expect(Termination.decide(previous: p, now: now) != nil)
    }

    @Test func theReportReadsLikeACrashReport() throws {
        var p = killedWhileActive()
        p.memoryWarningMs = p.aliveMs
        let raw = try #require(Termination.decide(previous: p, now: now)?.report)
        let r = try #require(try JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any])
        #expect(r["version"] as? Int == 1)
        #expect(r["mechanism"] as? String == "termination")
        #expect((r["timestamp_ms"] as? NSNumber)?.doubleValue == 1_760_000_200_000)
        #expect(r["session_id"] as? String == "s-1")
        #expect((r["session_started_ms"] as? NSNumber)?.int64Value == 1_760_000_100_000)
        #expect((r["termination"] as? [String: Any])?["cause"] as? String == "memory")
    }

    // ---- through OuoCrash.takePendingReport ----

    func dir() throws -> URL {
        let d = FileManager.default.temporaryDirectory.appendingPathComponent("ouo-run-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }

    @Test func theNextLaunchTakesTheTerminationOnce() throws {
        let d = try dir()
        defer { try? FileManager.default.removeItem(at: d) }
        var p = killedWhileActive()
        let current = RunState.current()
        (p.release, p.os, p.bootMs) = (current.release, current.os, current.bootMs)
        p.write(d.appendingPathComponent("run.json"))
        let raw = try #require(OuoCrash.takePendingReport(directory: d))
        #expect(raw.contains("\"mechanism\":\"termination\""))
        #expect(OuoCrash.takePendingReport(directory: d) == nil, "at most once per process")
        // Read once: a launch that dies before writing its own state does not report it twice.
        #expect(!FileManager.default.fileExists(atPath: d.appendingPathComponent("run.json").path))
    }

    @Test func aCrashReportWinsAndNoTerminationFollows() throws {
        let d = try dir()
        defer { try? FileManager.default.removeItem(at: d) }
        var p = killedWhileActive()
        let current = RunState.current()
        (p.release, p.os, p.bootMs) = (current.release, current.os, current.bootMs)
        p.write(d.appendingPathComponent("run.json"))
        try Data(#"{"version":1,"mechanism":"signal","timestamp_ms":1}"#.utf8).write(to: d.appendingPathComponent("report.json"))
        #expect(OuoCrash.takePendingReport(directory: d)?.contains("\"signal\"") == true)
        #expect(OuoCrash.takePendingReport(directory: d) == nil)
    }

    @Test func theTrackerWritesTheRunAndRemovesItWhenStopped() throws {
        let d = try dir()
        defer { try? FileManager.default.removeItem(at: d) }
        let url = d.appendingPathComponent("run.json")
        let t = RunTracker(url: url)
        t.start()
        t.update { $0.sessionId = "s-2" }
        t.update(sync: true) { $0.hangStartedMs = 5 }
        let s = try #require(RunState.load(url))
        #expect(s.sessionId == "s-2")
        #expect(s.hangStartedMs == 5)
        #expect(s.release == RunState.current().release)
        #expect(abs(s.aliveMs - Date().timeIntervalSince1970 * 1000) < 10_000)
        #expect(!s.terminated)
        t.stop()
        #expect(!FileManager.default.fileExists(atPath: url.path))
    }
}
