import Foundation
import Testing
@testable import OuoReplayCore
@testable import OuoSDK

/// The Swift SDK's records through a real collector into rum-api (an `ouo-env` stack): the wire
/// format, gzip and the credential, and the session rules rum-api folds them into. Run with
///
///     eval "$(deploy/envs/ouo-env env <env>)" && OUO_E2E_NATIVE=1 swift test --filter RealCollector
///
/// Mirrors conformance checks C1.1 (background rotation), C2.1 (handled error with context) and
/// C2.2 (a native crash sent by the next launch) on the Swift code, without UIKit.
@Suite(.enabled(if: ProcessInfo.processInfo.environment["OUO_E2E_NATIVE"] == "1"), .serialized)
struct RealCollectorTests {
    let env = ProcessInfo.processInfo.environment
    var otlp: URL { URL(string: env["OUO_OTLP_URL"] ?? "http://localhost:4318")! }
    var rum: String { env["OUO_RUM_API_URL"] ?? env["OUO_RUM_API"] ?? "http://localhost:8080" }

    private func core(_ dir: URL, serviceVersion: String) -> Core {
        let config = OuoConfig(endpoint: otlp, projectId: env["OUO_PROJECT_ID"] ?? "demo", projectToken: env["OUO_PROJECT_TOKEN"] ?? "pt_dev_demo_0000000000000000", serviceName: "w8-native-e2e")
        config.serviceVersion = serviceVersion
        config.environment = "e2e"
        config.backgroundTimeout = 1
        var hooks = Core.Hooks()
        hooks.deviceContext = { ["network.connection.type": "wifi"] }
        return Core(settings: Settings(config), directory: dir, hooks: hooks)
    }

    private func session(_ id: String) async -> [String: Any]? {
        var r = URLRequest(url: URL(string: "\(rum)/v1/sessions/\(id)")!)
        r.setValue("Bearer \(env["OUO_READ_TOKEN"] ?? "rt_dev_0000000000000000")", forHTTPHeaderField: "authorization")
        guard let (data, res) = try? await URLSession.shared.data(for: r), (res as? HTTPURLResponse)?.statusCode == 200 else { return nil }
        return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    }

    private func poll(_ id: String, until ok: ([String: Any]) -> Bool) async -> [String: Any]? {
        var last: [String: Any]?
        for _ in 0..<40 {
            last = await session(id)
            if let d = last, ok(d) { return d }
            try? await Task.sleep(nanoseconds: 3_000_000_000)
        }
        return last
    }

    private func timeline(_ d: [String: Any]?, _ name: String) -> [[String: Any]] {
        (d?["timeline"] as? [[String: Any]] ?? []).filter { $0["name"] as? String == name }
    }

    private func attr(_ e: [String: Any]?, _ key: String) -> String? {
        (e?["attrs"] as? [String: Any])?[key.replacingOccurrences(of: ".", with: "_")] as? String
    }

    @Test func SessionsErrorsAndACrashReachRumAPI() async throws {
        let dir = tempDir("ouo-e2e")
        let version = "w8-\(Int(Date().timeIntervalSince1970))"

        // Launch 1: Home, Cart, a handled error on Cart, then a background stay past the timeout.
        let a = core(dir, serviceVersion: version)
        a.start(previousReport: nil, background: false, appStart: nil)
        let first = a.sessionId
        a.trackScreen("Home")
        a.trackScreen("Cart")
        a.captureError(type: "GoldenError", message: "golden handled error", attrs: [:], stack: Stack.current())
        a.didEnterBackground()
        try await Task.sleep(nanoseconds: 1_300_000_000)
        a.didBecomeActive()
        let second = a.sessionId
        #expect(second != first)
        a.trackScreen("Home")
        a.event("ui.tap", ["ouo.ui.target": "crash-button"], body: "Tap crash-button on Home")
        await flush(a)
        #expect(a.exporter.queue.count == 0, "the collector accepted every request")
        #expect(a.exporter.queue.rejected == 0)

        // The process "crashes" 300 ms later; launch 2 reads its report.
        let crashAt = SteadyClock.nowMs() + 300
        let report = try #require(NativeReport.parse("""
        {"version":1,"mechanism":"signal","timestamp_ms":\(Int64(crashAt)),"session_id":"\(second)","arch":"arm64","thread":{"main":true},
         "signal":{"number":6,"name":"SIGABRT","mach_exception":"EXC_CRASH"},"frames":[],"images":[]}
        """))
        try await Task.sleep(nanoseconds: 500_000_000)
        let b = core(dir, serviceVersion: version)
        b.start(previousReport: report, background: false, appStart: nil)
        await flush(b)
        #expect(b.exporter.queue.count == 0)

        // C1.1
        let d1 = await poll(first) { $0["end_reason"] as? String == "background" }
        #expect(d1?["end_reason"] as? String == "background")
        // C2.1
        let e1 = timeline(d1, "exception").first
        #expect(d1?["status"] as? String == "errored")
        #expect(attr(e1, "ouo.exception.handled") == "true")
        #expect(attr(e1, "app.screen.name") == "Cart")
        #expect((attr(e1, "exception.stacktrace") ?? "").contains("GoldenError: golden handled error"))
        // C2.2
        let d2 = await poll(second) { $0["status"] as? String == "crashed" && !self.timeline($0, "exception").isEmpty }
        #expect(attr(timeline(d2, "session.start").first, "session.previous_id") == first)
        #expect(d2?["status"] as? String == "crashed")
        #expect(d2?["end_reason"] as? String == "crash")
        let ended = (d2?["ended_at"] as? String).flatMap { ISO8601DateFormatter.withFraction.date(from: $0) ?? ISO8601DateFormatter().date(from: $0) }
        #expect(ended.map { abs($0.timeIntervalSince1970 * 1000 - crashAt) <= 1000 } == true)
        let crash = timeline(d2, "exception").first
        #expect(attr(crash, "ouo.exception.fatal") == "true")
        #expect(attr(crash, "ouo.exception.kind") == "native")
        #expect(attr(crash, "app.screen.name") == "Home")
        #expect((attr(crash, "ouo.last_events") ?? "").contains("crash-button"))
    }
}

extension ISO8601DateFormatter {
    static let withFraction: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
}
