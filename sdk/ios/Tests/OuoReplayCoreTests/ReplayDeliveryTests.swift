import Foundation
import Testing
@testable import OuoReplayCore

/// Item D: the replay disk queue of the OTLP path (RPL-15 to RPL-18, TRN-6 to TRN-8, TRN-10, TRN-12).
@Suite struct ReplayDeliveryTests {
    private let url = URL(string: "http://localhost:4318/v1/logs")!
    private let authorization = ChunkUploader.basicAuthorization(projectId: "demo", projectToken: "pt_test_token_0000000000000000")
    private let stream = "202122232425262728292a2b2c2d2e2f"

    private func delivery(_ transport: ChunkTransport, dir: URL? = nil, maxQueueBytes: Int = 1 << 20) -> ReplayDelivery {
        ReplayDelivery(
            logsUrl: url, authorization: authorization, directory: dir ?? tempReplayDir("otlp"),
            config: ReplayDelivery.Config(maxQueueBytes: maxQueueBytes, retryDelay: { _ in 0.01 }),
            transport: transport
        )
    }

    private func files(_ dir: URL) -> [String] {
        ((try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []).sorted()
    }

    @Test func OneProtobufRequestPerRecordWithTheUploadersAuthorization() async throws {
        let transport = FakeTransport()
        let d = delivery(transport)
        let body = Data([0x0a, 0x00, 0xff, 0x1f, 0x8b])
        #expect(d.put(body, streamId: stream, sequence: 0))
        await eventually("sent") { d.queuedCount == 0 }
        #expect(transport.count == 1)
        let sent = transport.sent[0]
        #expect(sent.request.httpMethod == "POST")
        #expect(sent.request.url == url)
        #expect(sent.request.value(forHTTPHeaderField: "Content-Type") == "application/x-protobuf")
        // The record's body is already compressed by the format: no second gzip.
        #expect(sent.request.value(forHTTPHeaderField: "Content-Encoding") == nil)
        #expect(sent.request.value(forHTTPHeaderField: "Authorization") == "Basic ZGVtbzpwdF90ZXN0X3Rva2VuXzAwMDAwMDAwMDAwMDAwMDA=")
        #expect(sent.request.value(forHTTPHeaderField: "x-ouo-session-id") == nil)
        #expect(sent.body == body)
        #expect(d.stats.accepted == 1)
    }

    @Test func ARecordIsOnDiskBeforeItsFirstSend() async throws {
        let dir = tempReplayDir("otlp")
        let transport = FakeTransport()
        var onDiskAtSend: [String] = []
        transport.onSend = { onDiskAtSend = self.files(dir) }
        let d = delivery(transport, dir: dir)
        #expect(d.put(Data([1, 2, 3]), streamId: stream, sequence: 4))
        // Before `put` returned, whatever the transport did.
        await eventually("sent") { d.queuedCount == 0 }
        #expect(onDiskAtSend.count == 1)
        #expect(onDiskAtSend[0].hasSuffix(".\(stream).4.chunk.pb"))
        #expect(files(dir).isEmpty)
    }

    @Test func WhatAnEarlierProcessQueuedIsSentUnchanged() async throws {
        let dir = tempReplayDir("otlp")
        let hanging = HangingTransport()
        let first = delivery(hanging, dir: dir)
        let body = Data((0..<200).map { UInt8($0) })
        #expect(first.put(body, streamId: stream, sequence: 0))
        #expect(first.put(Data([9]), streamId: stream, sequence: nil))
        // The process dies with both on disk; the next one sends them, oldest first.
        let transport = FakeTransport()
        let second = delivery(transport, dir: dir)
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in second.drain { c.resume() } }
        await eventually("sent") { second.queuedCount == 0 }
        #expect(transport.sent.map(\.body) == [body, Data([9])])
    }

    // MARK: the response table (TRN-6)

    private func answer(_ responses: [Result<ChunkResponse, Error>], sequence: Int? = 0) async -> (delivery: ReplayDelivery, transport: FakeTransport, lost: [String]) {
        let transport = FakeTransport()
        transport.responses = responses
        let d = delivery(transport)
        let lock = NSLock()
        var lost: [String] = []
        d.onLoss = { id in lock.withLock { lost.append(id) } }
        #expect(d.put(Data([1, 2, 3, 4]), streamId: stream, sequence: sequence))
        // `queuedCount` reads on the queue's thread, after the step that removed the record and counted it.
        await eventually("answered") { d.queuedCount == 0 && transport.count >= responses.count }
        // Loss callbacks come later, on the delivery's queue: wait for one per chunk counted lost.
        let s = d.stats
        let losses = sequence == nil ? 0 : s.partialRejected + s.rejectedStatus + s.evicted
        await eventually("losses reported") { lock.withLock { lost.count } >= losses }
        // And a little longer, so a callback that should not come (an end record's) has had its chance.
        try? await Task.sleep(nanoseconds: 30_000_000)
        return (d, transport, lock.withLock { lost })
    }

    @Test func AcceptedWhenTwoHundredCarriesNoRejection() async {
        for response in [ChunkResponse(status: 200), ChunkResponse(status: 204), ChunkResponse(status: 200, body: Data()), ChunkResponse(status: 202, body: Data([0x0a, 0x00]))] {
            let r = await answer([.success(response)])
            #expect(r.transport.count == 1)
            #expect(r.delivery.stats == ReplayDelivery.Stats(accepted: 1))
            #expect(r.lost.isEmpty)
        }
    }

    @Test func PartialRejectionIsDeletedCountedAndNotRetried() async {
        let rejected = ChunkResponse(status: 200, body: Data([0x0a, 0x02, 0x08, 0x01]))
        let r = await answer([.success(rejected)])
        #expect(r.transport.count == 1)
        #expect(r.delivery.stats == ReplayDelivery.Stats(partialRejected: 1))
        #expect(r.lost == [stream])
    }

    @Test func RetryableAnswersKeepTheRecordAndResendTheSameBytes() async {
        let cases: [Result<ChunkResponse, Error>] = [
            .success(ChunkResponse(status: 429, retryAfter: 0.01)), .success(503), .success(502), .success(504), .failure(TransportError()),
        ]
        for first in cases {
            let r = await answer([first, .success(200)])
            #expect(r.transport.count == 2)
            #expect(r.transport.sent[0].body == r.transport.sent[1].body)
            #expect(r.delivery.stats == ReplayDelivery.Stats(accepted: 1))
            #expect(r.lost.isEmpty)
        }
    }

    @Test func AnyOtherStatusIsDeletedAndCounted() async {
        for status in [400, 401, 404, 413, 500, 501, 301] {
            let r = await answer([.success(ChunkResponse(status: status))])
            #expect(r.transport.count == 1)
            #expect(r.delivery.stats == ReplayDelivery.Stats(rejectedStatus: 1))
            #expect(r.lost == [stream])
        }
    }

    @Test func ALostEndRecordLeavesNoHoleInTheStream() async {
        let r = await answer([.success(ChunkResponse(status: 400))], sequence: nil)
        #expect(r.delivery.stats.rejectedStatus == 1)
        #expect(r.lost.isEmpty)
    }

    // MARK: waits (TRN-7, TRN-8)

    @Test func RetryAfterIsHonouredAndCappedAtThreeHundredSeconds() {
        var config = DiskQueue.Config(maxBytes: 1, retryDelay: { _ in 7 })
        config.retryAfterCap = 300
        #expect(DiskQueue.delay(config, failures: 1, status: 429, retryAfter: 5) == 5)
        #expect(DiskQueue.delay(config, failures: 1, status: 503, retryAfter: 120) == 120)
        #expect(DiskQueue.delay(config, failures: 1, status: 429, retryAfter: 3600) == 300)
        // `Retry-After: 0` (or a negative value) does not make the queue spin: the minimum wait.
        #expect(DiskQueue.delay(config, failures: 1, status: 503, retryAfter: 0) == 0.1)
        var jitter = DiskQueue.Config(maxBytes: 1 << 20, retryDelay: ReplayDelivery.fullJitter())
        jitter.retryAfterCap = 300
        #expect(DiskQueue.delay(jitter, failures: 10, status: 503, retryAfter: 0) >= 0.1)
        // No header, or not a usable one: the backoff.
        #expect(DiskQueue.delay(config, failures: 1, status: 429, retryAfter: nil) == 7)
        #expect(DiskQueue.delay(config, failures: 1, status: 429, retryAfter: -1) == 7)
        #expect(DiskQueue.delay(config, failures: 1, status: 429, retryAfter: .nan) == 7)
        // 502, 504 and a transport failure back off whatever a header says.
        #expect(DiskQueue.delay(config, failures: 1, status: 502, retryAfter: 60) == 7)
        #expect(DiskQueue.delay(config, failures: 1, status: 504, retryAfter: nil) == 7)
        #expect(DiskQueue.delay(config, failures: 1, status: nil, retryAfter: nil) == 7)
        // The backoff itself never passes the cap either.
        config.retryDelay = { _ in 10_000 }
        #expect(DiskQueue.delay(config, failures: 9, status: 502, retryAfter: nil) == 300)
        config.retryDelay = { _ in .infinity }
        #expect(DiskQueue.delay(config, failures: 9, status: nil, retryAfter: nil) == 300)
    }

    @Test func WithoutACapTheQueueWaitsAsItAlwaysDid() {
        let config = DiskQueue.Config(maxBytes: 1, retryDelay: { _ in 7 })
        #expect(DiskQueue.delay(config, failures: 1, status: 429, retryAfter: 3600) == 3600)
        #expect(DiskQueue.delay(config, failures: 1, status: 502, retryAfter: 2) == 7)
        #expect(DiskQueue.delay(config, failures: 1, status: nil, retryAfter: nil) == 7)
    }

    @Test func BackoffIsExponentialWithFullJitterFromOneToThreeHundredSeconds() {
        let top = ReplayDelivery.fullJitter(random: { 1 })
        #expect((1...12).map { top($0) } == [1, 2, 4, 8, 16, 32, 64, 128, 256, 300, 300, 300])
        #expect(top(0) == 1)
        #expect(top(10_000) == 300)
        let half = ReplayDelivery.fullJitter(random: { 0.5 })
        #expect(half(1) == 0.5)
        #expect(half(5) == 8)
        #expect(half(40) == 150)
        // Full jitter reaches down, but a failing endpoint is never retried at once.
        let bottom = ReplayDelivery.fullJitter(random: { 0 })
        #expect(bottom(1) == 0.1)
        #expect(bottom(20) == 0.1)
        #expect(ReplayDelivery.fullJitter(random: { .nan })(3) == 4)
        let real = ReplayDelivery.fullJitter()
        for n in 1...40 {
            let d = real(n)
            #expect(d >= 0.1 && d <= min(300, pow(2, Double(n - 1))))
        }
    }

    // MARK: backlog and store (RPL-17, RPL-18)

    @Test func ABacklogEvictsWholeChunksOldestFirstAndReportsEachLoss() async {
        let dir = tempReplayDir("otlp")
        // Nothing gets through; room for about three 1000-byte chunks.
        let d = delivery(HangingTransport(), dir: dir, maxQueueBytes: 3500)
        let lock = NSLock()
        var lost: [String] = []
        d.onLoss = { id in lock.withLock { lost.append(id) } }
        for seq in 0..<8 {
            #expect(d.put(Data(repeating: UInt8(seq), count: 1000), streamId: stream, sequence: seq))
        }
        await eventually("losses reported") { lock.withLock { lost.count } == d.stats.evicted && d.stats.evicted > 0 }
        let left = files(dir)
        // Whole files, never a truncated one, and the newest are the ones kept.
        for name in left {
            let size = (try? FileManager.default.attributesOfItem(atPath: dir.appendingPathComponent(name).path)[.size] as? Int) ?? 0
            #expect(size == 1000)
        }
        let sequences = left.compactMap { Int($0.split(separator: ".")[2]) }
        // The one in flight (0) is never pulled from under its request; the rest are the newest.
        #expect(sequences.contains(7) && sequences.contains(6))
        #expect(!sequences.contains(1) && !sequences.contains(2))
        #expect(d.stats.evicted == 8 - left.count)
        #expect(lock.withLock { lost }.allSatisfy { $0 == stream })
        // Sequences are never renumbered: the names still carry what the stream gave them.
        #expect(sequences == sequences.sorted())
    }

    @Test func AnEvictedChunkMarksItsStreamPartialAndStartsANewSegment() async throws {
        let d = delivery(HangingTransport(), maxQueueBytes: 2500)
        let adapter = StubAdapter()
        let s = ReplayStream(sessionId: "s", scope: testScope, adapter: adapter, sink: d)
        let lock = NSLock()
        var reported = 0
        d.onLoss = { id in
            s.chunkLost(streamId: id)
            lock.withLock { reported += 1 }
        }
        let filler = String(repeating: "x", count: 600)
        func chunk(_ t: Int64) {
            s.look(StubLook(content: filler), at: t)
            s.flush()
        }
        // A put evicts before it returns; the stream hears of it later, on the delivery's queue.
        func lossesReported() async { await eventually("losses reported") { lock.withLock { reported } == d.stats.evicted } }
        for i in 0..<8 { chunk(Int64(i)) }
        await lossesReported()
        #expect(s.isPartial)
        // A loss reported before a look of the loop was already answered by that look's keyframe:
        // one more chunk, and no look until its eviction has reached the stream.
        let evicted = d.stats.evicted
        chunk(8)
        #expect(d.stats.evicted > evicted)
        await lossesReported()
        let before = adapter.keyframeRequests
        s.look(StubLook(content: "after"), at: 100)
        #expect(adapter.keyframeRequests == before + 1)
        #expect(s.isActive)
    }

    @Test func AStoreThatCannotBeWrittenRefusesAndSendsNothingFromMemory() async throws {
        // The queue folder's path is a file: nothing can be created under it.
        let blocker = tempReplayDir("blocked")
        try Data([1]).write(to: blocker)
        let transport = FakeTransport()
        let d = delivery(transport, dir: blocker.appendingPathComponent("outbox-otlp"))
        #expect(!d.put(Data([1, 2, 3]), streamId: stream, sequence: 0))
        try? await Task.sleep(nanoseconds: 50_000_000)
        #expect(transport.count == 0)
        #expect(d.stats.refused == 1)

        let s = ReplayStream(sessionId: "s", scope: testScope, adapter: StubAdapter(), sink: d)
        s.look(StubLook(content: "a"), at: 1)
        s.flush()
        #expect(!s.isActive)
        #expect(s.isPartial)
    }

    @Test func DiscardPendingDeletesEverythingUnsentWithoutReportingALoss() async throws {
        let dir = tempReplayDir("otlp")
        let d = delivery(HangingTransport(), dir: dir)
        var lost = 0
        d.onLoss = { _ in lost += 1 }
        for seq in 0..<5 { #expect(d.put(Data([UInt8(seq)]), streamId: stream, sequence: seq)) }
        #expect(d.put(Data([9]), streamId: stream, sequence: nil))
        #expect(d.discardPending() == 6)
        #expect(files(dir).isEmpty)
        #expect(d.queuedCount == 0)
        try? await Task.sleep(nanoseconds: 30_000_000)
        #expect(lost == 0)

        // Without a delivery in this process: the folder is emptied all the same.
        let other = tempReplayDir("otlp")
        let earlier = delivery(HangingTransport(), dir: other)
        #expect(earlier.put(Data([1]), streamId: stream, sequence: 0))
        try Data("keep".utf8).write(to: other.appendingPathComponent("notes.txt"))
        #expect(ReplayDelivery.discardPending(in: other) == 1)
        #expect(files(other) == ["notes.txt"])
        #expect(ReplayDelivery.discardPending(in: tempReplayDir("missing")) == 0)
    }
}
