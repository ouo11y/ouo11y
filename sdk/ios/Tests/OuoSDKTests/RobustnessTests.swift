import Foundation
import Testing
@testable import OuoReplayCore
@testable import OuoSDK

/// The risks of the kb's table (project/kb-archive/ios-native-sdk.md), each with a test that fails when the
/// handling is removed.
@Suite struct RobustnessTests {
    /// B1: the launch kind comes from the task role, not `applicationState` (which is `.background`
    /// in `didFinishLaunching` of every scene-based app).
    @Test func LaunchKindFromTheTaskRole() {
        #expect(!LaunchRole.isBackground(TASK_FOREGROUND_APPLICATION.rawValue))
        #expect(LaunchRole.isBackground(TASK_BACKGROUND_APPLICATION.rawValue))
        #expect(LaunchRole.isBackground(TASK_DARWINBG_APPLICATION.rawValue))
        #expect(LaunchRole.isBackground(TASK_NONUI_APPLICATION.rawValue))
        #expect(!LaunchRole.isBackground(TASK_UNSPECIFIED.rawValue))
        #expect(!LaunchRole.isBackground(TASK_DEFAULT_APPLICATION.rawValue))
        #expect(!LaunchRole.isBackground(nil))
        #expect(LaunchRole.current() != nil, "the kernel answers")
    }

    /// B4: `device.id` is a resource attribute, the session store's.
    @Test func DeviceIdIsOnTheResource() async throws {
        let h = Harness()
        let c = h.core()
        c.start(previousReport: nil, background: false, appStart: nil)
        await flush(c)
        let start = try #require(h.sink.events("session.start").first)
        let device = try #require(start.s("device.id"))
        #expect(h.sink.resources.allSatisfy { $0["device.id"] as? String == device })
    }

    /// Item 1: session changes reach OuoCrash and replay in the order they were made.
    @Test func SessionChangesAreDeliveredInOrder() {
        let order = InOrder<String>()
        var seen: [String] = []
        order.deliver(2, "s2") { seen.append($0) }
        order.deliver(1, "s1") { seen.append($0) }
        order.deliver(3, "s3") { seen.append($0) }
        #expect(seen == ["s2", "s3"], "a change older than one delivered is skipped")
    }

    /// Item 2: the context is written off the caller's thread and out of the lock: a write that
    /// hangs neither blocks the call that asked for it nor the next record.
    @Test func ContextWritesDoNotBlockTheCaller() async {
        let gate = DispatchSemaphore(value: 0)
        let lock = NSLock()
        var saved: [String] = []
        let h = Harness()
        let c = h.core(saveContext: { ctx, _ in
            gate.wait()
            lock.withLock { saved.append(ctx.screen) }
        })
        c.start(previousReport: nil, background: false, appStart: nil)
        let done = DispatchSemaphore(value: 0)
        DispatchQueue.global().async {
            c.trackScreen("Home")
            c.event("x", [:])
            c.trackScreen("Cart")
            done.signal()
        }
        #expect(done.wait(timeout: .now() + 2) == .success, "the calls returned while the write hangs")
        gate.signal()
        gate.signal()
        settle(c)
        #expect(lock.withLock { saved } == ["Home", "Cart"])
    }

    /// Item 3: `start` takes a copy; changing the config afterwards changes nothing.
    @Test func TheConfigIsCopiedAtStart() async {
        let h = Harness()
        let config = Harness.config()
        let c = h.core(config: config)
        c.start(previousReport: nil, background: false, appStart: nil)
        config.sessionSampleRate = 0
        config.lifecycleEvents = false
        c.willResignActive()
        await flush(c)
        #expect(!h.sink.events("app.lifecycle").isEmpty)
    }

    /// Clock changes: the wall clock is read once; a change of it mid-run moves nothing.
    @Test func TheDeviceClockChangingMidRunMovesNothing() async {
        var wall = 1_760_000_000_000.0
        var mono: UInt64 = 5_000_000_000
        let clock = SteadyClock(wall: { wall }, mono: { mono })
        wall -= 3_600_000
        mono += 1_000_000_000
        #expect(clock.nowMs() == 1_760_000_001_000, "1 s later, not an hour earlier")

        // Through the core: the wall clock jumps 2 h forward; the session (30 min inactivity) stays.
        var hooks = Core.Hooks()
        let sink = Sink()
        hooks.transport = sink
        hooks.now = { clock.nowMs() }
        let c = Core(settings: Settings(Harness.config()), directory: tempDir(), hooks: hooks)
        c.start(previousReport: nil, background: false, appStart: nil)
        let id = c.sessionId
        wall += 2 * 3_600_000
        mono += 2_000_000_000
        c.event("later", [:])
        #expect(c.sessionId == id)
        await flush(c)
        #expect(sink.events("session.end").isEmpty)
    }

    /// Item 7: one flush on background, and its completion (where the host ends the background task)
    /// comes once the records left.
    @Test func BackgroundFlushCompletesAfterDelivery() async {
        let h = Harness()
        let c = h.core()
        c.start(previousReport: nil, background: false, appStart: nil)
        await withCheckedContinuation { (k: CheckedContinuation<Void, Never>) in c.didEnterBackground { k.resume() } }
        #expect(h.sink.events("app.lifecycle").map { $0.s("ouo.app.state") } == ["background"])
        #expect(c.exporter.queue.count == 0)
    }

    /// Before the first unlock the outbox folder cannot be written (`chmod 555` stands in for it): the
    /// batch goes once from memory.
    @Test func AnUnwritableOutboxSendsOnceFromMemory() async throws {
        let dir = tempDir()
        let otlp = dir.appendingPathComponent("otlp")
        try FileManager.default.createDirectory(at: otlp, withIntermediateDirectories: true)
        try FileManager.default.setAttributes([.posixPermissions: 0o555], ofItemAtPath: otlp.path)
        defer { try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: otlp.path) }
        let h = Harness(dir: dir)
        let c = h.core()
        c.start(previousReport: nil, background: false, appStart: nil)
        c.event("e", [:])
        await flush(c)
        for _ in 0..<50 where h.sink.events("e").isEmpty { try? await Task.sleep(nanoseconds: 10_000_000) }
        #expect(h.sink.events("e").count == 1)
        #expect(c.exporter.queue.count == 0)
    }
}

@Suite(.serialized) struct StartRefusalTests {
    /// App extensions: `start` itself refuses, whatever the config.
    @Test func StartRefusesInAnAppExtension() {
        let saved = Ouo.bundleURL
        Ouo.bundleURL = { URL(fileURLWithPath: "/x/App.app/PlugIns/Share.appex") }
        defer { Ouo.bundleURL = saved }
        #expect(!Ouo.start(Harness.config()))
        #expect(Ouo.sessionId == nil)
    }
}
