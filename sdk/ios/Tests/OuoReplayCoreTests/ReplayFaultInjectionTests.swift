import Foundation
import Testing
@testable import OuoReplayCore

/// Item H: failure isolation (ERR-1, ERR-6, ERR-7, ERR-9). Each test breaks one seam and expects
/// the same thing: no crash, no hang, capture degrades or stops, and what was dropped is counted.
@Suite struct ReplayFaultInjectionTests {
    private let t0: EpochMillis = 1_760_000_000_000

    private func make(_ adapter: StubAdapter, sink: ReplaySink = RecordingSink(), store: ReplayStateStore? = nil, config: ReplayStreamConfig = ReplayStreamConfig()) -> ReplayStream {
        ReplayStream(sessionId: "s", scope: testScope, config: config, adapter: adapter, sink: sink, store: store)
    }

    // MARK: the adapter

    @Test func AnAdapterThatThrowsLosesFramesThenDisablesReplay() throws {
        let adapter = StubAdapter()
        let sink = RecordingSink()
        let s = make(adapter, sink: sink)
        s.look(StubLook(content: "good"), at: t0)
        adapter.throwOnLook = StubFailure()
        for i in 1...19 { s.look(StubLook(content: "x"), at: t0 + Int64(i)) }
        #expect(s.isActive)
        #expect(s.stats.framesDropped == 19)
        #expect(s.stats.errors == 19)
        // The twentieth internal error (ERR-6): capture stops and the stream says why.
        s.look(StubLook(content: "x"), at: t0 + 20)
        #expect(!s.isActive)
        let e = try #require(try sink.ended().first)
        #expect(e.string("ouo.replay.end_reason") == "error")
        // What was captured before the fault still went out, whole.
        #expect(try sink.chunks().count == 1)
        #expect(e.int("ouo.replay.last_sequence") == 0)
        // A dead stream takes anything without a sound.
        adapter.throwOnLook = nil
        s.look(StubLook(content: "late"), at: t0 + 30)
        s.touch(Touch(ts: t0 + 31, x: 0, y: 0, phase: .began))
        s.tick(now: t0 + 9000)
        s.flush()
        s.background()
        s.capture(trigger: .error)
        s.end(reason: .stop)
        #expect(sink.records.count == 2)
    }

    @Test func AMaskingFailureDropsTheFrameWithoutCountingAsAnSDKError() {
        let adapter = StubAdapter()
        let sink = RecordingSink()
        let s = make(adapter, sink: sink)
        adapter.throwOnLook = ReplayFormatError.maskingFailed
        for i in 0..<100 { s.look(StubLook(content: "x"), at: t0 + Int64(i)) }
        // PRV-8 is the format doing its job: nothing sent, replay still on.
        #expect(s.isActive)
        #expect(s.stats.framesDropped == 100)
        #expect(s.stats.errors == 0)
        s.flush()
        #expect(sink.records.isEmpty)
    }

    @Test func GarbageEventsNeverReachTheWire() throws {
        let adapter = StubAdapter()
        let sink = RecordingSink()
        let s = make(adapter, sink: sink, config: ReplayStreamConfig(maxEventBytes: 4096))
        s.look(StubLook(content: "good"), at: t0)
        let garbage: [ReplayEvent] = [
            ReplayEvent(t: t0, keyframe: true, json: Data()),
            ReplayEvent(t: t0, keyframe: true, json: Data("{\"a\":1}\n{\"b\":2}".utf8)),
            ReplayEvent(t: t0, keyframe: true, json: Data("not json".utf8)),
            ReplayEvent(t: t0, keyframe: true, json: Data("[1,2]".utf8)),
            ReplayEvent(t: t0, keyframe: true, json: Data("{".utf8)),
            ReplayEvent(t: t0, keyframe: true, json: Data([0xff, 0xfe, 0x00])),
            ReplayEvent(t: .min, keyframe: true, json: Data("{\"x\":\"\(String(repeating: "y", count: 5000))\"}".utf8)),
        ]
        adapter.garbage = garbage
        s.look(StubLook(content: "x"), at: t0 + 1)
        #expect(s.stats.eventsDropped == garbage.count)
        #expect(s.stats.errors == garbage.count)
        #expect(s.isActive)
        // What it dropped may have been a frame later ones build on: a keyframe is asked for again.
        adapter.garbage = nil
        let before = adapter.keyframeRequests
        s.look(StubLook(content: "recovered"), at: t0 + 2)
        #expect(adapter.keyframeRequests == before + 1)
        s.end(reason: .stop)
        let chunks = try sink.chunks()
        #expect(chunks.map { $0.int("ouo.replay.segment.index") } == [0, 1])
        for c in chunks {
            for line in String(decoding: try #require(c.body), as: UTF8.self).split(separator: "\n") {
                #expect((try? jsonObject(Data(line.utf8))) != nil)
            }
        }
    }

    @Test func AnAdapterThatCannotCompressLosesTheChunkNotTheApp() throws {
        let adapter = StubAdapter()
        let sink = RecordingSink()
        let s = make(adapter, sink: sink)
        adapter.throwOnCompress = true
        s.look(StubLook(content: "a"), at: t0)
        s.flush()
        #expect(sink.records.isEmpty)
        #expect(s.stats.errors == 1)
        #expect(s.isActive)
        adapter.throwOnCompress = false
        s.look(StubLook(content: "b"), at: t0 + 1)
        s.end(reason: .stop)
        // No sequence was spent on the lost chunk, so the stream has no hole.
        let c = try #require(try sink.chunks().first)
        #expect(c.int("ouo.replay.sequence") == 0)
        #expect(c.bool("ouo.replay.keyframe") == true)
        #expect(try sink.ended().first?.string("ouo.replay.end_state") == "complete")
    }

    @Test func AnAdapterThatReturnsNothingForeverSendsNothing() {
        let adapter = StubAdapter()
        adapter.garbage = []
        let sink = RecordingSink()
        let s = make(adapter, sink: sink)
        for i in 0..<1000 {
            s.look(StubLook(content: "x"), at: t0 + Int64(i) * 1000)
            s.tick(now: t0 + Int64(i) * 1000)
        }
        s.flush()
        #expect(sink.records.isEmpty)
        #expect(s.isActive)
    }

    // MARK: the disk

    @Test func AStateFileThatCannotBeWrittenDoesNotStopCapture() throws {
        let store = MemoryStateStore()
        store.failing = true
        let sink = RecordingSink()
        let s = make(StubAdapter(), sink: sink, store: store)
        for i in 0..<5 {
            s.look(StubLook(content: "x"), at: t0 + Int64(i))
            s.flush()
        }
        #expect(s.isActive)
        #expect(s.stats.stateFailures == 5)
        #expect(try sink.chunks().count == 5)
        s.end(reason: .stop)
        #expect(try sink.ended().count == 1)

        // The real store on a path that cannot exist.
        let blocker = tempReplayDir("blocked")
        try Data([1]).write(to: blocker)
        let file = FileReplayStateStore(url: blocker.appendingPathComponent("dir/open-stream.json"))
        #expect(!file.save(ReplayStreamState(sessionId: "s", replayId: "r", streamId: "st", lastSequence: nil, partial: false, scope: testScope)))
        #expect(file.load() == nil)
        file.clear()
    }

    @Test func ADiskThatRefusesEveryWriteStopsCaptureOnce() async throws {
        let blocker = tempReplayDir("blocked")
        try Data([1]).write(to: blocker)
        let transport = FakeTransport()
        let delivery = ReplayDelivery(logsUrl: URL(string: "http://localhost:4318/v1/logs")!, authorization: "", directory: blocker.appendingPathComponent("outbox-otlp"), transport: transport)
        let store = FileReplayStateStore(url: blocker.appendingPathComponent("open-stream.json"))
        let s = make(StubAdapter(), sink: delivery, store: store)
        for i in 0..<50 {
            s.look(StubLook(content: "x"), at: t0 + Int64(i) * 6000)
            s.tick(now: t0 + Int64(i) * 6000)
        }
        #expect(!s.isActive)
        #expect(s.isPartial)
        // One chunk refused, then the end record: nothing after that is even tried.
        #expect(s.stats.refused == 2)
        #expect(s.stats.chunks == 1)
        #expect(delivery.stats.refused == 2)
        try? await Task.sleep(nanoseconds: 30_000_000)
        #expect(transport.count == 0)
        #expect(ReplayStream.endOpenStream(store: store, sink: delivery) == false)
    }

    // MARK: the uploader

    @Test func AnUploaderThatAlwaysFailsKeepsRecordsOnDiskAndCaptureRunning() async throws {
        let dir = tempReplayDir("otlp")
        let transport = FakeTransport()
        transport.responses = Array(repeating: .failure(TransportError()), count: 500)
        let delivery = ReplayDelivery(
            logsUrl: URL(string: "http://localhost:4318/v1/logs")!, authorization: "", directory: dir,
            config: ReplayDelivery.Config(retryDelay: { _ in 0.005 }), transport: transport
        )
        let s = make(StubAdapter(), sink: delivery)
        delivery.onLoss = { s.chunkLost(streamId: $0) }
        for i in 0..<10 {
            s.look(StubLook(content: "x"), at: t0 + Int64(i))
            s.flush()
        }
        await eventually("retries") { transport.count >= 3 }
        #expect(s.isActive)
        #expect(!s.isPartial)
        #expect(delivery.queuedCount == 10)
        #expect(delivery.stats == ReplayDelivery.Stats())
        // Every retry carried the first chunk's bytes: the queue is in order and nothing was rebuilt.
        #expect(Set(transport.sent.map(\.body)).count == 1)
    }

    @Test func AnUploaderThatAnswersNonsenseIsHandledByTheTable() async {
        let transport = FakeTransport()
        transport.responses = [
            .success(ChunkResponse(status: 0)), .success(ChunkResponse(status: -1)), .success(ChunkResponse(status: 999)),
            .success(ChunkResponse(status: 200, body: Data([0xff, 0xff, 0xff]))),
            .success(ChunkResponse(status: 200, body: Data(repeating: 0x0a, count: 4096))),
            .success(ChunkResponse(status: 429, retryAfter: -.infinity)), .success(ChunkResponse(status: 503, retryAfter: .nan)),
        ]
        let delivery = ReplayDelivery(
            logsUrl: URL(string: "http://localhost:4318/v1/logs")!, authorization: "", directory: tempReplayDir("otlp"),
            config: ReplayDelivery.Config(retryDelay: { _ in 0.005 }), transport: transport
        )
        for seq in 0..<6 { #expect(delivery.put(Data([UInt8(seq)]), streamId: "st", sequence: seq)) }
        await eventually("drained") { delivery.queuedCount == 0 }
        let stats = delivery.stats
        #expect(stats.rejectedStatus == 3)
        #expect(stats.accepted + stats.partialRejected == 3)
    }

    // MARK: options from JavaScript

    @Test func MalformedOptionsNeverTrap() {
        let values: [Any] = [
            NSNull(), true, false, 0, -1, 1e308, -1e308, Double.nan, Double.infinity, -Double.infinity, Int.max, Int.min,
            "", "x", String(repeating: "a", count: 100_000), "pixel/frames", "\u{0}\n",
            [Any](), [1, 2, 3], ["a": "b"], ["seconds": Double.nan], ["seconds": "1"], ["logsUrl": 1], ["logsUrl": "http://h/v1/logs"],
            ["logsUrl": "http://h/v1/logs", "resource": ["k": NSNull(), "": "empty", "n": Double.nan, "l": [1], "ok": 1]],
            NSNumber(value: true), NSNumber(value: 3.7), Date(), Data([1, 2]),
        ]
        let keys = ["otlp", "mode", "cadence", "buffer", "replayId", "keyframeIntervalMs", "chunkMaxBytes", "sessionId", "projectId", "projectToken", "frameInterval", "maskText", "debug"]
        var outcomes = (legacy: 0, otlp: 0, off: 0)
        // Every value in every key, alone and beside a usable `otlp`.
        for key in keys {
            for value in values {
                for base in [[String: Any](), ["otlp": ["logsUrl": "http://localhost:4318/v1/logs"]]] {
                    var raw = base
                    raw[key] = value
                    switch ReplayOTLPOptions.parse(raw) {
                    case .legacy: outcomes.legacy += 1
                    case .off(let problems):
                        outcomes.off += 1
                        #expect(!problems.isEmpty)
                    case .otlp(let options, _):
                        outcomes.otlp += 1
                        // Whatever came in, what comes out is inside the bounds.
                        #expect((1000...3_600_000).contains(options.keyframeIntervalMs))
                        #expect((4096...ReplayStreamConfig.hardLimitBytes).contains(options.chunkMaxBytes))
                        if let seconds = options.bufferSeconds { #expect((5...600).contains(seconds)) }
                        #expect(options.replayId.map(ReplayStream.isValidId) ?? true)
                        #expect(options.recorder == .pixelFrames)
                        #expect(options.scope.resource.count <= 128)
                        let config = options.streamConfig
                        #expect(config.chunkMaxBytes <= ReplayStreamConfig.hardLimitBytes)
                    }
                    let (common, _) = ReplayOTLPOptions.Common.parse(raw)
                    #expect((0.1...60).contains(common.frameInterval))
                }
            }
        }
        #expect(outcomes.legacy > 0 && outcomes.otlp > 0 && outcomes.off > 0)
    }

    @Test func AbsurdNumbersAreClamped() throws {
        let otlp: [String: Any] = ["logsUrl": "http://localhost:4318/v1/logs"]
        for (value, interval, bytes) in [(-1.0, Int64(1000), 4096), (0.0, 1000, 4096), (1e18, 3_600_000, 1 << 20), (-1e18, 1000, 4096)] {
            guard case .otlp(let o, let problems) = ReplayOTLPOptions.parse(["otlp": otlp, "keyframeIntervalMs": value, "chunkMaxBytes": value]) else {
                Issue.record("expected otlp options")
                continue
            }
            #expect(o.keyframeIntervalMs == interval)
            #expect(o.chunkMaxBytes == bytes)
            #expect(problems.count == 2)
        }
        // The stream's own configuration clamps too, for hosts that build it by hand.
        let wild = ReplayStreamConfig(bufferSeconds: .nan, keyframeIntervalMs: .min, chunkMaxBytes: .max, chunkMaxMs: -5, ringMaxBytes: -1, maxEventBytes: 0, selfDisableThreshold: -3)
        #expect(wild.bufferSeconds == 60)
        #expect(wild.keyframeIntervalMs == 1000)
        #expect(wild.chunkMaxBytes == ReplayStreamConfig.hardLimitBytes)
        #expect(wild.chunkMaxMs == 100)
        #expect(wild.ringMaxBytes == 1 << 16)
        #expect(wild.maxEventBytes == 1024)
        #expect(wild.selfDisableThreshold == 1)
        #expect(ReplayStreamConfig(bufferSeconds: .infinity).bufferSeconds == 60)
    }

    @Test func AResourceWithTooManyOrUnusableValuesIsTrimmedNotRefused() throws {
        var resource: [String: Any] = [:]
        for i in 0..<300 { resource[String(format: "k%03d", i)] = i }
        resource["bad"] = [1]
        resource["long"] = String(repeating: "v", count: 10_000)
        guard case .otlp(let o, let problems) = ReplayOTLPOptions.parse(["otlp": ["logsUrl": "http://h/v1/logs", "resource": resource]]) else {
            Issue.record("expected otlp options")
            return
        }
        #expect(o.scope.resource.count == 128)
        #expect(!problems.isEmpty)
        // The envelope still encodes and decodes.
        let meta = ReplayChunkMeta(sessionId: "s", replayId: "r", streamId: "st", segmentIndex: 0, sequence: 0, keyframe: true, startTime: 0, endTime: 0, format: "f", encoding: "e", masked: true, mode: "session")
        let decoded = try decodeRequest(ReplayEnvelope.chunkRequest(scope: o.scope, meta: meta, body: Data()))
        #expect(decoded.resource.count == 128)
    }

    // MARK: time

    @Test func AClockThatJumpsBackwardsDoesNotWedgeTheStream() throws {
        let sink = RecordingSink()
        let s = make(StubAdapter(), sink: sink)
        s.look(StubLook(content: "a"), at: t0)
        // A day back, then far ahead, then zero and negative.
        s.look(StubLook(content: "b"), at: t0 - 86_400_000)
        s.tick(now: t0 - 86_400_000)
        s.look(StubLook(content: "c"), at: t0 + 1_000_000_000)
        s.look(StubLook(content: "d"), at: 0)
        s.look(StubLook(content: "e"), at: -5)
        s.tick(now: .max)
        s.tick(now: .min)
        s.end(reason: .stop)
        let chunks = try sink.chunks()
        #expect(chunks.map { $0.int("ouo.replay.sequence") } == Array(0..<chunks.count))
        for c in chunks {
            let start = try #require(c.int("ouo.replay.start_time"))
            let end = try #require(c.int("ouo.replay.end_time"))
            #expect(end >= start)
        }
        #expect(try sink.ended().count == 1)
    }

    @Test func ConcurrentCallersDoNotCorruptTheStream() async throws {
        let sink = RecordingSink()
        let s = make(StubAdapter(), sink: sink, config: ReplayStreamConfig(chunkMaxBytes: 4096))
        let t0 = self.t0
        await withTaskGroup(of: Void.self) { group in
            for worker in 0..<8 {
                group.addTask {
                    for i in 0..<200 {
                        let t = t0 + Int64(worker * 1000 + i)
                        switch i % 5 {
                        case 0: s.touch(Touch(ts: t, x: 1, y: 1, phase: .moved))
                        case 1: s.tick(now: t)
                        case 2: s.chunkLost(streamId: s.streamId)
                        case 3: s.setViewId("v\(i)")
                        default: s.look(StubLook(content: "w\(worker) \(i)"), at: t)
                        }
                    }
                }
            }
        }
        s.end(reason: .stop)
        let chunks = try sink.chunks()
        #expect(chunks.map { $0.int("ouo.replay.sequence") } == Array(0..<chunks.count))
        #expect(try sink.ended().first?.int("ouo.replay.last_sequence") == chunks.count - 1)
        #expect(try sink.ended().first?.string("ouo.replay.end_state") == "partial")
    }
}
