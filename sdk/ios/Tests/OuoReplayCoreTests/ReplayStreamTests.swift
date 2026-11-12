import Foundation
import Testing
@testable import OuoReplayCore

/// Items B, E and F: segments, chunks and sequences (spec 11.2), the end record (11.5) and the
/// buffer ring (9.1), all on a stub format so nothing here knows about frames (RPL-23).
@Suite struct ReplayStreamTests {
    private let t0: EpochMillis = 1_760_000_000_000

    private func make(
        _ config: ReplayStreamConfig = ReplayStreamConfig(),
        adapter: StubAdapter = StubAdapter(),
        sink: RecordingSink = RecordingSink(),
        store: ReplayStateStore? = nil,
        replayId: String? = nil,
        session: String = "0123456789abcdef0123456789abcdef"
    ) -> (ReplayStream, StubAdapter, RecordingSink) {
        let stream = ReplayStream(sessionId: session, replayId: replayId, scope: testScope, config: config, adapter: adapter, sink: sink, store: store, now: { 42 })
        return (stream, adapter, sink)
    }

    private func lines(_ body: Data) -> [String] {
        String(decoding: body, as: UTF8.self).split(separator: "\n").map(String.init)
    }

    // MARK: identity

    @Test func IdsAre128BitHexAndTheStreamIdIsFresh() {
        let (a, _, _) = make(replayId: "00112233445566778899aabbccddeeff")
        let (b, _, _) = make(replayId: "00112233445566778899aabbccddeeff")
        #expect(a.replayId == "00112233445566778899aabbccddeeff")
        #expect(ReplayStream.isValidId(a.streamId))
        #expect(a.streamId != b.streamId)
        // Not an id: a new one is generated rather than sent as it is.
        for bad in ["", "abc", "00112233445566778899AABBCCDDEEFF", "0011223344556677-8899aabbccddeeff", String(repeating: "0", count: 32), String(repeating: "g", count: 32)] {
            let (s, _, _) = make(replayId: bad)
            #expect(s.replayId != bad)
            #expect(ReplayStream.isValidId(s.replayId))
        }
    }

    // MARK: chunks and segments (item B)

    @Test func FirstChunkStartsSegmentZeroWithAKeyframeAndClosesAfterFiveSeconds() throws {
        let (s, adapter, sink) = make()
        s.look(StubLook(content: "a"), at: t0)
        s.look(StubLook(content: "b"), at: t0 + 1000)
        s.touch(Touch(ts: t0 + 1500, x: 1, y: 2, phase: .began))
        #expect(sink.records.isEmpty)
        s.tick(now: t0 + 4999)
        #expect(sink.records.isEmpty)
        s.tick(now: t0 + 5000)
        let chunks = try sink.chunks()
        #expect(chunks.count == 1)
        let c = chunks[0]
        #expect(c.int("ouo.replay.segment.index") == 0)
        #expect(c.int("ouo.replay.sequence") == 0)
        #expect(c.bool("ouo.replay.keyframe") == true)
        #expect(c.int("ouo.replay.start_time") == Int(t0))
        #expect(c.int("ouo.replay.end_time") == Int(t0 + 1500))
        #expect(c.time == UInt64(t0) * 1_000_000)
        #expect(c.observedTime == 42_000_000)
        #expect(c.string("session.id") == "0123456789abcdef0123456789abcdef")
        #expect(c.string("ouo.replay.id") == s.replayId)
        #expect(c.string("ouo.replay.stream.id") == s.streamId)
        #expect(c.string("ouo.replay.mode") == "session")
        #expect(!c.keys.contains("ouo.replay.trigger"))
        #expect(!c.keys.contains("ouo.replay.ref"))
        #expect(c.scopeName == "ouo.replay")
        #expect(c.resource.first?.key == "service.name")
        let body = try #require(c.body)
        let ls = lines(body)
        #expect(ls.count == 3)
        #expect(ls[0].contains("\"type\":\"key\""))
        #expect(ls[1].contains("\"type\":\"delta\""))
        #expect(ls[2].contains("\"type\":\"touch\""))
        #expect(body.last == UInt8(ascii: "\n"))
        #expect(adapter.keyframeRequests == 1)
        #expect(sink.records[0].sequence == 0)
        #expect(sink.records[0].streamId == s.streamId)
    }

    @Test func AnEventClosesAChunkThatIsOldEnough() throws {
        let (s, _, sink) = make()
        s.look(StubLook(content: "a"), at: t0)
        s.look(StubLook(content: "b"), at: t0 + 5000)
        // The second event is the last of the first chunk: it arrived at its 5000 ms.
        #expect(try sink.chunks().count == 1)
        s.look(StubLook(content: "c"), at: t0 + 6000)
        s.flush()
        let chunks = try sink.chunks()
        #expect(chunks.map { $0.int("ouo.replay.sequence") } == [0, 1])
        #expect(chunks.map { $0.int("ouo.replay.segment.index") } == [0, 0])
        #expect(chunks.map { $0.bool("ouo.replay.keyframe") } == [true, false])
    }

    @Test func SequenceRisesByOneAndNeverResetsAtASegmentBoundary() throws {
        let (s, adapter, sink) = make(ReplayStreamConfig(keyframeIntervalMs: 10_000))
        var t = t0
        // start
        s.look(StubLook(content: "1"), at: t); s.flush()
        // same segment
        t += 100; s.look(StubLook(content: "2"), at: t); s.flush()
        // background, then foreground: a new segment
        s.background()
        t += 100; s.look(StubLook(content: "3"), at: t); s.flush()
        // a capture gap
        s.markGap()
        t += 100; s.look(StubLook(content: "4"), at: t); s.flush()
        // a local loss
        s.chunkLost(streamId: s.streamId)
        t += 100; s.look(StubLook(content: "5"), at: t); s.flush()
        // another stream's loss is not this one's
        s.chunkLost(streamId: "ffffffffffffffffffffffffffffffff")
        t += 100; s.look(StubLook(content: "6"), at: t); s.flush()
        // the keyframe interval
        t += 10_000; s.look(StubLook(content: "7"), at: t); s.flush()
        let chunks = try sink.chunks()
        #expect(chunks.map { $0.int("ouo.replay.sequence") } == [0, 1, 2, 3, 4, 5, 6])
        #expect(chunks.map { $0.int("ouo.replay.segment.index") } == [0, 0, 1, 2, 3, 3, 4])
        #expect(chunks.map { $0.bool("ouo.replay.keyframe") } == [true, false, true, true, true, false, true])
        // Every segment's first line is a keyframe event: it decodes alone (RPL-6).
        for c in chunks where c.bool("ouo.replay.keyframe") == true {
            #expect(lines(try #require(c.body))[0].contains("\"type\":\"key\""))
        }
        #expect(adapter.keyframeRequests == 5)
        #expect(s.producedChunks == 7)
        #expect(s.stats.lost == 1)
    }

    @Test func EventsBeforeTheKeyframeOfANewSegmentAreDropped() throws {
        let (s, _, sink) = make()
        // A touch before anything was seen has no frame to belong to.
        s.touch(Touch(ts: t0, x: 0, y: 0, phase: .began))
        s.look(StubLook(content: "a"), at: t0 + 10)
        s.background()
        s.touch(Touch(ts: t0 + 20, x: 0, y: 0, phase: .ended))
        s.look(StubLook(content: "b"), at: t0 + 30)
        s.flush()
        let chunks = try sink.chunks()
        #expect(chunks.count == 2)
        #expect(lines(try #require(chunks[0].body)).count == 1)
        #expect(lines(try #require(chunks[1].body)).count == 1)
        #expect(s.stats.eventsDropped == 2)
    }

    @Test func AChunkClosesWhenItsCompressedBodyReachesTheLimit() throws {
        // The stub does not compress, so the body is what was written.
        let (s, _, sink) = make(ReplayStreamConfig(chunkMaxBytes: 2048))
        let filler = String(repeating: "x", count: 600)
        for i in 0..<8 { s.look(StubLook(content: filler), at: t0 + Int64(i)) }
        s.flush()
        let chunks = try sink.chunks()
        #expect(chunks.count >= 2)
        for c in chunks.dropLast() {
            let size = try #require(c.int("ouo.replay.byte_size"))
            #expect(size >= 2048 && size < 2048 + 700)
        }
        #expect(chunks.map { $0.int("ouo.replay.sequence") } == Array(0..<chunks.count))
        #expect(chunks.map { $0.bool("ouo.replay.keyframe") } == [true] + Array(repeating: false, count: chunks.count - 1))
        // Nothing lost between them.
        let all = chunks.reduce(Data()) { $0 + ($1.body ?? Data()) }
        #expect(lines(all).count == 8)
    }

    @Test func CompressibleContentIsMeasuredCompressed() throws {
        // 40 KiB of repeated text gzips to well under 4 KiB: one chunk, not ten.
        let adapter = StubAdapter()
        adapter.gzip = true
        let (s, _, sink) = make(ReplayStreamConfig(chunkMaxBytes: 4096), adapter: adapter)
        for i in 0..<40 { s.look(StubLook(content: String(repeating: "a", count: 1000)), at: t0 + Int64(i)) }
        s.flush()
        let chunks = try sink.chunks()
        #expect(chunks.count == 1)
        #expect(chunks[0].string("ouo.replay.encoding") == "gzip")
        #expect(lines(try Gzip.decompress(try #require(chunks[0].body))).count == 40)
    }

    @Test func ABodyOverTheHardLimitIsSplitNeverTruncated() throws {
        let (s, _, sink) = make(ReplayStreamConfig(chunkMaxBytes: 1 << 20))
        // One event of 2.5 MiB (no line break to cut at), after a small one.
        let big = String(repeating: "0123456789", count: 262_144)
        s.look(StubLook(content: "small"), at: t0)
        s.look(StubLook(content: big), at: t0 + 1)
        s.flush()
        let chunks = try sink.chunks()
        #expect(chunks.count >= 3)
        var joined = Data()
        for (i, c) in chunks.enumerated() {
            let body = try #require(c.body)
            #expect(body.count <= ReplayStreamConfig.hardLimitBytes)
            #expect(c.int("ouo.replay.byte_size") == body.count)
            #expect(c.string("ouo.replay.sha256") == ReplayEnvelope.sha256Hex(body))
            #expect(c.int("ouo.replay.sequence") == i)
            #expect(c.int("ouo.replay.segment.index") == 0)
            #expect(c.bool("ouo.replay.keyframe") == (i == 0))
            joined.append(body)
        }
        // The pieces concatenate to exactly what was written (RPL-7).
        let ls = lines(joined)
        #expect(ls.count == 2)
        #expect(ls[0].contains("small"))
        #expect(ls[1].utf8.count > 2_600_000)
        #expect(ls[1].hasSuffix("0123456789\"}"))
        #expect(s.stats.splits == chunks.count - 1)
    }

    @Test func ASplitPrefersLineBreaks() throws {
        let (s, _, sink) = make(ReplayStreamConfig(chunkMaxBytes: 1 << 20, chunkMaxMs: 600_000))
        // Five events of 300 KiB: 1.5 MiB closes over the limit and is cut between lines.
        let block = String(repeating: "z", count: 300 * 1024)
        for i in 0..<5 { s.look(StubLook(content: block), at: t0 + Int64(i)) }
        s.flush()
        for c in try sink.chunks() {
            let body = try #require(c.body)
            #expect(body.count <= ReplayStreamConfig.hardLimitBytes)
            #expect(body.last == UInt8(ascii: "\n"))
            for line in lines(body) { #expect(line.hasPrefix("{") && line.hasSuffix("}")) }
        }
    }

    @Test func ChunksOfASegmentConcatenateIntoAValidPayloadAndEachDecompressesAlone() throws {
        let adapter = StubAdapter()
        adapter.gzip = true
        let (s, _, sink) = make(adapter: adapter)
        var expected: [String] = []
        for i in 0..<30 {
            let content = "event \(i) \"quoted\" \n newline \u{2028} é"
            expected.append(content)
            s.look(StubLook(content: content), at: t0 + Int64(i) * 700)
        }
        s.flush()
        let chunks = try sink.chunks()
        #expect(chunks.count > 2)
        var payload = Data()
        for c in chunks {
            let body = try #require(c.body)
            #expect(c.string("ouo.replay.sha256") == ReplayEnvelope.sha256Hex(body))
            #expect(c.int("ouo.replay.byte_size") == body.count)
            payload.append(try Gzip.decompress(body))
        }
        let decoded = try lines(payload).map { try jsonObject(Data($0.utf8)) }
        #expect(decoded.count == 30)
        #expect(decoded.map { $0["c"] as? String } == expected)
        #expect(decoded[0]["type"] as? String == "key")
    }

    @Test func ViewIdIsTheOneAtTheChunkStart() throws {
        let (s, _, sink) = make()
        s.look(StubLook(content: "a"), at: t0); s.flush()
        s.setViewId("home")
        s.look(StubLook(content: "b"), at: t0 + 1)
        s.setViewId("cart")
        s.look(StubLook(content: "c"), at: t0 + 2); s.flush()
        s.setViewId("")
        s.look(StubLook(content: "d"), at: t0 + 3); s.flush()
        #expect(try sink.chunks().map { $0.string("ouo.view.id") } == [nil, "home", nil])
    }

    // MARK: the format seam (RPL-27, RPL-23)

    @Test func FormatEncodingAndMaskedComeFromTheAdapterAndNothingElseChanges() throws {
        let plain = StubAdapter()
        plain.masked = false
        let (a, _, sinkA) = make(adapter: plain)
        a.look(StubLook(content: "x"), at: t0); a.end(reason: .stop)
        let c = try #require(try sinkA.chunks().first)
        #expect(c.string("ouo.replay.format") == "stub/1")
        #expect(c.string("ouo.replay.encoding") == "none")
        #expect(c.bool("ouo.replay.masked") == false)

        let zipped = StubAdapter()
        zipped.gzip = true
        let (b, _, sinkB) = make(adapter: zipped)
        b.look(StubLook(content: "x"), at: t0); b.end(reason: .stop)
        let d = try #require(try sinkB.chunks().first)
        #expect(d.string("ouo.replay.encoding") == "gzip")
        #expect(d.bool("ouo.replay.masked") == true)
        // Same attribute set, same order, whatever the format.
        #expect(c.keys == d.keys)
        #expect(try sinkA.ended().first?.keys == sinkB.ended().first?.keys)
    }

    @Test func ALookOfAnotherFormatIsDroppedNotSent() throws {
        let (s, _, sink) = make()
        s.look(OtherLook(), at: t0)
        s.flush()
        #expect(sink.records.isEmpty)
        #expect(s.stats.framesDropped == 1)
    }

    // MARK: end of stream (item E)

    @Test func EndedIsCompleteWhenEveryChunkWasProduced() throws {
        let store = MemoryStateStore()
        let (s, _, sink) = make(store: store)
        s.look(StubLook(content: "a"), at: t0); s.flush()
        s.look(StubLook(content: "b"), at: t0 + 1)
        #expect(store.state?.lastSequence == 0)
        #expect(store.state?.streamId == s.streamId)
        s.end(reason: .stop)
        // The open chunk closed first, then the end record.
        #expect(sink.records.map(\.sequence) == [0, 1, nil])
        let e = try #require(try sink.ended().first)
        #expect(e.string("session.id") == s.sessionId)
        #expect(e.string("ouo.replay.id") == s.replayId)
        #expect(e.string("ouo.replay.stream.id") == s.streamId)
        #expect(e.string("ouo.replay.end_state") == "complete")
        #expect(e.int("ouo.replay.last_sequence") == 1)
        #expect(e.string("ouo.replay.end_reason") == "stop")
        #expect(e.body == nil)
        #expect(e.scopeName == "ouo.replay")
        #expect(!s.isActive)
        // Ended normally: nothing left for the next launch.
        #expect(store.state == nil)
        // Ending twice, or looking after the end, does nothing.
        s.end(reason: .sessionEnd)
        s.look(StubLook(content: "late"), at: t0 + 2)
        s.flush()
        #expect(sink.records.count == 3)
    }

    @Test func EndReasonsAreTheSpecsStrings() throws {
        let expected: [(ReplayEndReason, String)] = [
            (.sessionEnd, "session_end"), (.stop, "stop"), (.consent, "consent"), (.backgroundKill, "background_kill"),
            (.crash, "crash"), (.maxSize, "max_size"), (.error, "error"),
        ]
        for (reason, name) in expected {
            let (s, _, sink) = make()
            s.end(reason: reason)
            let e = try #require(try sink.ended().first)
            #expect(e.string("ouo.replay.end_reason") == name)
            // No chunk: complete, and no last sequence to name.
            #expect(e.string("ouo.replay.end_state") == "complete")
            #expect(!e.keys.contains("ouo.replay.last_sequence"))
        }
    }

    @Test func ALostChunkMakesTheStreamPartial() throws {
        let store = MemoryStateStore()
        let (s, _, sink) = make(store: store)
        s.look(StubLook(content: "a"), at: t0); s.flush()
        s.chunkLost(streamId: s.streamId)
        #expect(s.isPartial)
        #expect(store.state?.partial == true)
        s.end(reason: .sessionEnd)
        let e = try #require(try sink.ended().first)
        #expect(e.string("ouo.replay.end_state") == "partial")
        #expect(e.int("ouo.replay.last_sequence") == 0)
    }

    @Test func AFullStoreStopsCaptureAndMarksTheStreamPartial() throws {
        let sink = RecordingSink()
        sink.capacity = 2
        let store = MemoryStateStore()
        let (s, _, _) = make(sink: sink, store: store)
        s.look(StubLook(content: "a"), at: t0); s.flush()
        s.look(StubLook(content: "b"), at: t0 + 1); s.flush()
        #expect(s.isActive)
        // The third chunk is refused: its sequence is spent, the stream has a hole and stops.
        s.look(StubLook(content: "c"), at: t0 + 2); s.flush()
        #expect(!s.isActive)
        #expect(s.isPartial)
        #expect(s.stats.refused == 2)
        s.look(StubLook(content: "d"), at: t0 + 3); s.flush()
        #expect(sink.records.count == 2)
        // The end record was refused too, so the next launch ends the stream for it.
        let left = try #require(store.state)
        #expect(left.partial)
        #expect(left.lastSequence == 2)
        sink.capacity = .max
        #expect(ReplayStream.endOpenStream(store: store, sink: sink, reason: .backgroundKill, now: 7))
        let e = try #require(try sink.ended().first)
        #expect(e.string("ouo.replay.end_state") == "partial")
        #expect(e.int("ouo.replay.last_sequence") == 2)
        #expect(store.state == nil)
    }

    @Test func AStreamAKillLeftOpenIsEndedAsPartialAtTheNextLaunch() throws {
        let url = tempReplayDir("state").appendingPathComponent("open-stream.json")
        let sink = RecordingSink()
        // The run that gets killed: two chunks, no end.
        var killedStream = ""
        var killedReplay = ""
        do {
            let (s, _, _) = make(sink: sink, store: FileReplayStateStore(url: url))
            s.look(StubLook(content: "a"), at: t0); s.flush()
            s.look(StubLook(content: "b"), at: t0 + 1); s.flush()
            killedStream = s.streamId
            killedReplay = s.replayId
        }
        // The next launch.
        let store = FileReplayStateStore(url: url)
        #expect(ReplayStream.endOpenStream(store: store, sink: sink, reason: .crash, now: 99))
        let e = try #require(try sink.ended().first)
        #expect(e.string("ouo.replay.stream.id") == killedStream)
        #expect(e.string("ouo.replay.id") == killedReplay)
        #expect(e.string("session.id") == "0123456789abcdef0123456789abcdef")
        #expect(e.string("ouo.replay.end_state") == "partial")
        #expect(e.int("ouo.replay.last_sequence") == 1)
        #expect(e.string("ouo.replay.end_reason") == "crash")
        #expect(e.time == 99_000_000)
        // The resource it was recorded with, not the next launch's.
        #expect(e.resource.first?.value == .string("tests"))
        // Once: the file is gone.
        #expect(!ReplayStream.endOpenStream(store: store, sink: sink))
        #expect(try sink.ended().count == 1)
    }

    @Test func AnUnreadableStateFileIsRemovedNotTrippedOver() throws {
        let url = tempReplayDir("state").appendingPathComponent("open-stream.json")
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("{not json".utf8).write(to: url)
        let store = FileReplayStateStore(url: url)
        let sink = RecordingSink()
        #expect(!ReplayStream.endOpenStream(store: store, sink: sink))
        #expect(sink.records.isEmpty)
        #expect(!FileManager.default.fileExists(atPath: url.path))
    }

    // MARK: buffer mode (item F)

    private func bufferConfig(seconds: Double = 60) -> ReplayStreamConfig {
        ReplayStreamConfig(mode: .buffer, bufferSeconds: seconds)
    }

    @Test func TheRingSendsNothingUntilTriggeredAndAlwaysStartsWithAKeyframe() throws {
        let store = MemoryStateStore()
        let (s, _, sink) = make(bufferConfig(), store: store)
        // Ten minutes, a look every second.
        for i in 0..<600 {
            let t = t0 + Int64(i) * 1000
            s.look(StubLook(content: "frame \(i)"), at: t)
            s.tick(now: t)
        }
        #expect(sink.records.isEmpty)
        // Nothing reaches disk before a trigger, the open-stream state included.
        #expect(store.saves == 0)
        #expect(s.bufferedChunks > 0)
        #expect(s.stats.ringEvictedSegments > 0)

        let flushed = try #require(s.capture(trigger: .error))
        let chunks = try sink.chunks()
        #expect(chunks.count == flushed)
        // Numbered from 0 at the trigger: what the ring let go never had a number.
        #expect(chunks.map { $0.int("ouo.replay.sequence") } == Array(0..<chunks.count))
        #expect(chunks.first?.int("ouo.replay.segment.index") == 0)
        #expect(chunks.first?.bool("ouo.replay.keyframe") == true)
        #expect(lines(try #require(chunks.first?.body))[0].contains("\"type\":\"key\""))
        // Whole segments: every segment's first chunk is its keyframe chunk.
        var lastSegment = -1
        for c in chunks {
            let segment = try #require(c.int("ouo.replay.segment.index"))
            #expect(segment == lastSegment || segment == lastSegment + 1)
            #expect(c.bool("ouo.replay.keyframe") == (segment != lastSegment))
            lastSegment = segment
            #expect(c.string("ouo.replay.mode") == "buffer")
            #expect(c.string("ouo.replay.trigger") == "error")
        }
        // At least the last 60 s are there, and not much more than five quarters of it.
        let last = t0 + 599_000
        let first = try #require(chunks.first?.int("ouo.replay.start_time"))
        #expect(Int(last) - first >= 60_000)
        #expect(Int(last) - first <= 80_000)
        #expect(chunks.last?.int("ouo.replay.end_time") == Int(last))
        #expect(s.bufferedChunks == 0)
        #expect(store.state?.lastSequence == chunks.count - 1)
    }

    @Test func AfterTheTriggerRecordingContinuesAsASessionWithBufferAttributes() throws {
        let (s, _, sink) = make(bufferConfig(seconds: 20))
        for i in 0..<30 {
            let t = t0 + Int64(i) * 1000
            s.look(StubLook(content: "f\(i)"), at: t)
            s.tick(now: t)
        }
        #expect(s.capture(trigger: .hang) != nil)
        let before = try sink.chunks().count
        // A second trigger has nothing to flush.
        #expect(s.capture(trigger: .manual) == nil)
        for i in 30..<45 {
            let t = t0 + Int64(i) * 1000
            s.look(StubLook(content: "f\(i)"), at: t)
            s.tick(now: t)
        }
        s.end(reason: .sessionEnd)
        let chunks = try sink.chunks()
        #expect(chunks.count > before)
        #expect(chunks.map { $0.int("ouo.replay.sequence") } == Array(0..<chunks.count))
        #expect(chunks.allSatisfy { $0.string("ouo.replay.mode") == "buffer" && $0.string("ouo.replay.trigger") == "hang" })
        // The segment in progress at the trigger goes on: no new keyframe was needed.
        let segmentAtTrigger = chunks[before - 1].int("ouo.replay.segment.index")
        #expect(chunks[before].int("ouo.replay.segment.index") == segmentAtTrigger)
        #expect(chunks[before].bool("ouo.replay.keyframe") == false)
        // Nothing is missing across the trigger.
        let all = chunks.reduce(Data()) { $0 + ($1.body ?? Data()) }
        let contents = try lines(all).map { try jsonObject(Data($0.utf8))["c"] as? String }
        let firstIndex = try #require(contents.first.flatMap { $0 }.flatMap { Int($0.dropFirst()) })
        #expect(contents == (firstIndex..<45).map { "f\($0)" })
        let e = try #require(try sink.ended().first)
        #expect(e.string("ouo.replay.end_state") == "complete")
        #expect(e.int("ouo.replay.last_sequence") == chunks.count - 1)
    }

    @Test func OnlyWholeSegmentsLeaveTheRing() throws {
        let (s, _, sink) = make(bufferConfig(seconds: 8))
        // Segments start every 2 s (a quarter of the window).
        for i in 0..<100 {
            let t = t0 + Int64(i) * 250
            s.look(StubLook(content: "f\(i)"), at: t)
            s.tick(now: t)
        }
        s.capture(trigger: .manual)
        let chunks = try sink.chunks()
        let all = chunks.reduce(Data()) { $0 + ($1.body ?? Data()) }
        let types = try lines(all).map { try jsonObject(Data($0.utf8))["type"] as? String }
        #expect(types.first == "key")
        #expect(types.filter { $0 == "key" }.count >= 4)
        let span = Int(t0 + 99 * 250) - (try #require(chunks.first?.int("ouo.replay.start_time")))
        #expect(span >= 8000 && span <= 10_250)
    }

    @Test func TheRingIsBoundedInBytes() throws {
        let (s, _, sink) = make(ReplayStreamConfig(mode: .buffer, bufferSeconds: 600, chunkMaxMs: 1000, ringMaxBytes: 1 << 16))
        // 600 s would keep everything; 64 KiB cannot.
        for i in 0..<400 {
            let t = t0 + Int64(i) * 1000
            s.look(StubLook(content: String(repeating: "q", count: 4000)), at: t)
            s.tick(now: t)
        }
        s.capture(trigger: .manual)
        let chunks = try sink.chunks()
        let total = chunks.reduce(0) { $0 + ($1.body?.count ?? 0) }
        #expect(total <= (1 << 16) + 8192)
        #expect(chunks.first?.bool("ouo.replay.keyframe") == true)
    }

    @Test func SessionModeHasNothingToTriggerAndAnUntriggeredBufferEndsSilently() throws {
        let (session, _, sessionSink) = make()
        session.look(StubLook(content: "a"), at: t0)
        #expect(session.capture(trigger: .error) == nil)
        session.end(reason: .stop)
        #expect(try sessionSink.chunks().allSatisfy { !$0.keys.contains("ouo.replay.trigger") })

        let (buffer, _, bufferSink) = make(bufferConfig())
        buffer.look(StubLook(content: "a"), at: t0)
        buffer.end(reason: .sessionEnd)
        // Nothing was ever sent for this replay, so there is nothing to end.
        #expect(bufferSink.records.isEmpty)
        #expect(!buffer.isActive)
    }

    @Test func ATriggerOnAnEmptyRingStartsRecordingFromTheNextKeyframe() throws {
        let (s, _, sink) = make(bufferConfig())
        #expect(s.capture(trigger: .crash) == 0)
        s.look(StubLook(content: "a"), at: t0)
        s.end(reason: .stop)
        let c = try #require(try sink.chunks().first)
        #expect(c.int("ouo.replay.sequence") == 0)
        #expect(c.int("ouo.replay.segment.index") == 0)
        #expect(c.bool("ouo.replay.keyframe") == true)
        #expect(c.string("ouo.replay.trigger") == "crash")
    }

    @Test func AbandonSendsNothingAndForgetsTheStream() throws {
        let store = MemoryStateStore()
        let (s, _, sink) = make(store: store)
        s.look(StubLook(content: "a"), at: t0); s.flush()
        s.look(StubLook(content: "b"), at: t0 + 1)
        s.abandon()
        s.end(reason: .consent)
        #expect(sink.records.count == 1)
        #expect(store.state == nil)
        #expect(!s.isActive)
    }

    // MARK: the main thread never waits for the stream's work (ERR-4)

    /// A sink whose write takes 300 ms, like a slow disk.
    private final class SlowSink: ReplaySink {
        let started = DispatchSemaphore(value: 0)
        func put(_ request: Data, streamId: String, sequence: Int?) -> Bool {
            started.signal()
            Thread.sleep(forTimeInterval: 0.3)
            return true
        }
    }

    @Test func StateReadsDoNotWaitForASlowWrite() async throws {
        let sink = SlowSink()
        let s = ReplayStream(sessionId: "0123456789abcdef0123456789abcdef", scope: testScope, adapter: StubAdapter(), sink: sink)
        let done = DispatchSemaphore(value: 0)
        DispatchQueue(label: "encode").async {
            s.look(StubLook(content: "a"), at: 1)
            s.flush()
            done.signal()
        }
        // The write has begun and holds the stream's lock.
        #expect(sink.started.wait(timeout: .now() + 2) == .success)
        let t0 = Date()
        let active = s.isActive
        _ = s.stats
        _ = s.isPartial
        _ = s.producedChunks
        let waited = Date().timeIntervalSince(t0)
        #expect(active)
        #expect(waited < 0.05, "state reads blocked \(Int(waited * 1000)) ms behind the sink write")
        #expect(done.wait(timeout: .now() + 2) == .success)
        #expect(s.stats.chunks == 1)
        #expect(s.producedChunks == 1)
    }
}
