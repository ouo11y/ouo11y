import Foundation
import Testing
@testable import OuoReplayCore

@Suite struct VideoChunkTests {
    /// The smallest file the collector and rum-api take as an mp4: a box header with `ftyp` at 4.
    private let mp4 = Data([0, 0, 0, 0x18]) + Data("ftypmp42".utf8)

    private func chunk(seq: Int = 0) -> VideoChunk {
        VideoChunk(
            format: "sentry-video", sessionId: "sess-1", seq: seq,
            startedAt: 1_760_000_000_000, endedAt: 1_760_000_005_000,
            width: 402, height: 874, mp4: mp4, frameCount: 5, frameRate: 1,
            touches: [Touch(ts: 1_760_000_001_000, x: 10, y: 20, phase: .began)], masked: true
        )
    }

    @Test func encodesTheVideoKindTheReceiversRead() throws {
        let json = try JSONSerialization.jsonObject(with: chunk().encodedJSON()) as! [String: Any]
        // The keys of the Sentry bridge's video chunk (ouosentryreceiver/replay.go videoChunk) minus
        // `source`, plus `format` and `mode`.
        #expect(Set(json.keys) == ["kind", "schema_version", "format", "session_id", "seq", "started_at", "ended_at", "viewport", "platform", "mode", "video", "touches", "masked"])
        #expect(json["kind"] as? String == "video")
        #expect(json["schema_version"] as? Int == 1)
        #expect(json["format"] as? String == "sentry-video")
        let video = json["video"] as! [String: Any]
        #expect(Set(video.keys) == ["container", "encoding", "duration_ms", "frame_count", "frame_rate", "mp4"])
        #expect(video["container"] as? String == "mp4")
        #expect(video["duration_ms"] as? Int == 5000)
        #expect(Data(base64Encoded: video["mp4"] as! String) == mp4)
        let viewport = json["viewport"] as! [String: Any]
        #expect(viewport["width"] as? Double == 402)
        #expect(viewport["scale"] as? Double == 1)
    }

    @Test func roundTrips() throws {
        let c = chunk()
        #expect(try VideoChunk.decode(c.encodedJSON()) == c)
    }

    @Test func endNeverBeforeStart() {
        let c = VideoChunk(format: "sentry-video", sessionId: "s", seq: 0, startedAt: 10, endedAt: 5, width: 1, height: 1, mp4: mp4, frameCount: 1, frameRate: 1, touches: [], masked: true)
        #expect(c.endedAt == 10)
        #expect(c.video.durationMs == 0)
    }

    @Test func uploaderSendsAVideoChunkWithTheSameHeaders() async throws {
        let transport = FakeTransport()
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("ouo-outbox-\(UUID().uuidString)", isDirectory: true)
        let u = ChunkUploader(endpoint: URL(string: "http://localhost:4319")!, projectId: "demo", projectToken: "pt_test_token_0000000000000000", directory: dir, transport: transport)
        u.enqueue(chunk(seq: 3))
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in u.drain { c.resume() } }
        #expect(transport.count == 1)
        let sent = transport.sent[0]
        #expect(sent.request.url?.absoluteString == "http://localhost:4319/v1/replay/chunks")
        #expect(sent.request.value(forHTTPHeaderField: "x-ouo-seq") == "3")
        #expect(sent.request.value(forHTTPHeaderField: "x-ouo-session-id") == "sess-1")
        #expect(sent.request.value(forHTTPHeaderField: "content-encoding") == "gzip")
        #expect(try VideoChunk.decode(Gzip.decompress(sent.body)) == chunk(seq: 3))
    }

    @Test func captureStats() {
        let s = CaptureStats(capacity: 3)
        for ms in [4.0, 1, 3, 2] { s.record(millis: ms) }
        let snap = s.snapshot()
        #expect(snap.count == 4)
        #expect(snap.totalMillis == 10)
        #expect(snap.samples == [1, 3, 2])
        #expect(snap.percentile(0.5) == 2)
        #expect(snap.percentile(1) == 3)
        s.reset()
        #expect(s.snapshot().count == 0)
    }
}
