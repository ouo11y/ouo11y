import Foundation
import Testing
@testable import OuoReplayCore

/// `ouo-video/1` (docs/specs/mobile-replay.md): the adapter's body, and the stream's
/// self-contained segments (RPL-25) with the same identity, sequence, buffer and end rules as
/// every format (RPL-23).
@Suite struct ReplayVideoFormatTests {
    private let t0: EpochMillis = 1_760_000_000_000
    /// The smallest file a reader takes as an mp4: a box header with `ftyp` at offset 4.
    private let mp4 = Data([0, 0, 0, 0x18]) + Data("ftypmp42".utf8) + Data(repeating: 7, count: 300)

    private func look(_ start: EpochMillis, _ end: EpochMillis, touches: [Touch] = [], mp4: Data? = nil) -> VideoLook {
        VideoLook(mp4: mp4 ?? self.mp4, start: start, end: end, width: 402, height: 874, scale: 1, frameCount: 5, frameRate: 1, touches: touches)
    }

    private func make(_ config: ReplayStreamConfig = ReplayStreamConfig(), sink: RecordingSink = RecordingSink()) -> (ReplayStream, RecordingSink) {
        (ReplayStream(sessionId: "0123456789abcdef0123456789abcdef", scope: testScope, config: config, adapter: VideoFormatAdapter(), sink: sink, now: { 42 }), sink)
    }

    // MARK: the body

    @Test func BodyIsOneHeaderLineThenTheMP4Bytes() throws {
        let touches = [
            Touch(ts: t0 - 1, x: 1, y: 1, phase: .began), // before the segment: left out
            Touch(ts: t0 + 1200, x: 120.5, y: 640, phase: .began),
            Touch(ts: t0 + 1300, x: 121, y: 641.25, phase: .ended),
            Touch(ts: t0 + 5000, x: 9, y: 9, phase: .began), // at the end: the next segment's
        ]
        let events = try VideoFormatAdapter().events(for: look(t0, t0 + 5000, touches: touches), at: t0)
        let event = try #require(events.first)
        #expect(events.count == 1)
        #expect(event.keyframe)
        #expect(event.t == t0)
        #expect(event.until == t0 + 5000)
        let (header, body) = try #require(VideoFormatAdapter.parse(event.json))
        #expect(body == mp4)
        let nl = try #require(event.json.firstIndex(of: UInt8(ascii: "\n")))
        let line = String(decoding: event.json[..<nl], as: UTF8.self)
        #expect(line == "{\"t\":\(t0),\"type\":\"video\",\"end\":\(t0 + 5000),\"w\":402,\"h\":874,\"scale\":1,\"fps\":1,\"frames\":5,\"mp4\":\(mp4.count),\"touches\":[{\"t\":\(t0 + 1200),\"x\":120.50,\"y\":640,\"phase\":\"began\"},{\"t\":\(t0 + 1300),\"x\":121,\"y\":641.25,\"phase\":\"ended\"}]}")
        #expect(header["type"] as? String == "video")
        #expect((header["touches"] as? [Any])?.count == 2)
    }

    @Test func RefusesWhatIsNotAnMP4OrNotAVideoLook() {
        let adapter = VideoFormatAdapter()
        #expect(throws: ReplayFormatError.encodingFailed) { try adapter.events(for: look(t0, t0 + 1, mp4: Data("not a video file".utf8)), at: t0) }
        #expect(throws: ReplayFormatError.encodingFailed) { try adapter.events(for: look(t0, t0 + 1, mp4: Data()), at: t0) }
        #expect(throws: ReplayFormatError.encodingFailed) { try adapter.events(for: look(t0 + 1, t0), at: t0) }
        #expect(throws: ReplayFormatError.wrongLook) { try adapter.events(for: StubLook(content: "x"), at: t0) }
        #expect(VideoFormatAdapter.parse(Data("{\"mp4\":3}\nabc".utf8)) == nil)
    }

    @Test func IdentityEncodingAndNoTouchEventsOfItsOwn() throws {
        let adapter = VideoFormatAdapter()
        #expect(adapter.formatId == "ouo-video/1")
        #expect(adapter.encoding == "identity")
        #expect(adapter.selfContainedSegments)
        #expect(try adapter.compress(mp4) == mp4)
        #expect(adapter.touchEvent(Touch(ts: t0, x: 1, y: 1, phase: .began)) == nil)
    }

    // MARK: the stream (RPL-25)

    @Test func EverySegmentIsOneKeyframeChunkOfItsOwnSegment() throws {
        let (s, sink) = make()
        s.look(look(t0, t0 + 5000), at: t0)
        s.touch(Touch(ts: t0 + 5100, x: 1, y: 1, phase: .began)) // not a line of its own
        s.look(look(t0 + 5000, t0 + 10000), at: t0 + 5000)
        s.look(look(t0 + 10000, t0 + 12000), at: t0 + 10000)
        s.end(reason: .stop)
        let chunks = try sink.chunks()
        #expect(chunks.count == 3)
        for (i, c) in chunks.enumerated() {
            #expect(c.int("ouo.replay.sequence") == i)
            #expect(c.int("ouo.replay.segment.index") == i)
            #expect(c.bool("ouo.replay.keyframe") == true)
            #expect(c.string("ouo.replay.format") == "ouo-video/1")
            #expect(c.string("ouo.replay.encoding") == "identity")
            #expect(c.bool("ouo.replay.masked") == true)
            let body = try #require(c.body)
            #expect(c.int("ouo.replay.byte_size") == body.count)
            #expect(c.string("ouo.replay.sha256") == ReplayEnvelope.sha256Hex(body))
            #expect(VideoFormatAdapter.parse(body)?.mp4 == mp4)
        }
        #expect(chunks[0].int("ouo.replay.start_time") == Int(t0))
        #expect(chunks[0].int("ouo.replay.end_time") == Int(t0 + 5000))
        #expect(chunks[2].int("ouo.replay.end_time") == Int(t0 + 12000))
        let ended = try #require(try sink.ended().first)
        #expect(ended.int("ouo.replay.last_sequence") == 2)
        #expect(ended.string("ouo.replay.end_state") == "complete")
    }

    @Test func ASegmentOverTheHardLimitIsDroppedWholeNeverCut() throws {
        let (s, sink) = make()
        let big = mp4 + Data(repeating: 1, count: ReplayStreamConfig.hardLimitBytes)
        s.look(look(t0, t0 + 5000, mp4: big), at: t0)
        s.look(look(t0 + 5000, t0 + 10000), at: t0 + 5000)
        let chunks = try sink.chunks()
        #expect(chunks.count == 1)
        #expect(chunks[0].int("ouo.replay.sequence") == 0)
        #expect(chunks[0].int("ouo.replay.segment.index") == 0)
        #expect(s.stats.framesDropped == 1)
        #expect(s.stats.splits == 0)
        #expect(s.isActive)
    }

    @Test func BufferKeepsWholeSegmentsAndSendsThemOnTheTrigger() throws {
        let (s, sink) = make(ReplayStreamConfig(mode: .buffer, bufferSeconds: 10))
        for i in 0..<6 {
            let start = t0 + EpochMillis(i) * 5000
            s.look(look(start, start + 5000), at: start)
        }
        #expect(try sink.chunks().isEmpty)
        // 30 s recorded, 10 s window: the ring keeps the segments that cover it (20 to 30 s); an
        // older one goes once the one after it started 10 s ago or earlier.
        let sent = try #require(s.capture(trigger: .error))
        #expect(sent == 2)
        s.look(look(t0 + 30000, t0 + 35000), at: t0 + 30000)
        let chunks = try sink.chunks()
        #expect(chunks.map { $0.int("ouo.replay.sequence") } == [0, 1, 2])
        #expect(chunks.map { $0.int("ouo.replay.segment.index") } == [0, 1, 2])
        #expect(chunks.allSatisfy { $0.string("ouo.replay.mode") == "buffer" && $0.string("ouo.replay.trigger") == "error" })
        #expect(chunks.first?.int("ouo.replay.start_time") == Int(t0 + 20000))
    }

    @Test func AbandonSendsNothingMore() throws {
        let (s, sink) = make()
        s.look(look(t0, t0 + 5000), at: t0)
        s.abandon()
        s.look(look(t0 + 5000, t0 + 10000), at: t0 + 5000)
        s.end(reason: .stop)
        #expect(try sink.chunks().count == 1)
        #expect(try sink.ended().isEmpty)
    }
}
