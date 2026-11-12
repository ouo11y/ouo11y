import Foundation
import Testing
@testable import OuoReplayCore

/// Item C: the hand-written protobuf writer and the OTLP envelope (RPL-1 to RPL-3, RPL-12 to
/// RPL-14, TRN-1, TRN-5).
@Suite struct ReplayEnvelopeTests {
    /// The cross-platform golden vector: the Android writer must produce these bytes. They were
    /// first produced by a separate encoder written in Python (not by the code under test).
    static let goldenHex = "0ace050a1a0a180a0c736572766963652e6e616d6512080a06676f6c64656e12af050a130a0a6f756f2e7265706c61791205312e302e3012db040900002a36fe9c971710092a083a06676f6c64656e32300a0a73657373696f6e2e696412220a20303030313032303330343035303630373038303930613062306330643065306632330a0d6f756f2e7265706c61792e696412220a203130313131323133313431353136313731383139316131623163316431653166323a0a146f756f2e7265706c61792e73747265616d2e696412220a203230323132323233323432353236323732383239326132623263326432653266321e0a186f756f2e7265706c61792e7365676d656e742e696e6465781202180032190a136f756f2e7265706c61792e73657175656e63651202180032190a136f756f2e7265706c61792e6b65796672616d651202100132200a156f756f2e7265706c61792e73746172745f74696d6512071880d095ffbc31321e0a136f756f2e7265706c61792e656e645f74696d6512071888f795ffbc3132230a116f756f2e7265706c61792e666f726d6174120e0a0c6f756f2d6672616d65732f33321d0a136f756f2e7265706c61792e656e636f64696e6712060a04677a697032570a116f756f2e7265706c61792e73686132353612420a4064643536646534313337393531643963393236383162303334313665633135663838366234343832613237653361353137643332663038353234346362653564321a0a146f756f2e7265706c61792e627974655f73697a651202180632170a116f756f2e7265706c61792e6d61736b656412021001321c0a0f6f756f2e7265706c61792e6d6f646512090a0773657373696f6e5900002a36fe9c971762106f756f2e7265706c61792e6368756e6b1a3a68747470733a2f2f6f70656e74656c656d657472792e696f2f736368656d61732f636c69656e742d736964652d6465762f302e312e302d646576"

    private func goldenRequest() -> Data {
        let scope = ReplayScope(
            resource: [ReplayAttribute("service.name", "golden")],
            scopeVersion: "1.0.0",
            schemaUrl: "https://opentelemetry.io/schemas/client-side-dev/0.1.0-dev"
        )
        let meta = ReplayChunkMeta(
            sessionId: "000102030405060708090a0b0c0d0e0f",
            replayId: "101112131415161718191a1b1c1d1e1f",
            streamId: "202122232425262728292a2b2c2d2e2f",
            segmentIndex: 0, sequence: 0, keyframe: true,
            startTime: 1_700_000_000_000, endTime: 1_700_000_005_000,
            format: "ouo-frames/3", encoding: "gzip", masked: true, mode: "session"
        )
        return ReplayEnvelope.chunkRequest(scope: scope, meta: meta, body: Data("golden".utf8))
    }

    @Test func GoldenChunkRequestMatchesByteForByte() {
        let hex = hexString(goldenRequest())
        print("ouo.replay.chunk golden request (\(hex.count / 2) bytes): \(hex)")
        #expect(hex == Self.goldenHex)
    }

    @Test func GoldenDecodesWithAnIndependentReader() throws {
        let r = try decodeRequest(goldenRequest())
        #expect(r.logRecords == 1)
        #expect(r.resource.count == 1)
        #expect(r.resource[0].key == "service.name")
        #expect(r.resource[0].value == .string("golden"))
        #expect(r.scopeName == "ouo.replay")
        #expect(r.scopeVersion == "1.0.0")
        #expect(r.schemaUrl == "https://opentelemetry.io/schemas/client-side-dev/0.1.0-dev")
        #expect(r.time == 1_700_000_000_000_000_000)
        #expect(r.observedTime == 1_700_000_000_000_000_000)
        #expect(r.severity == 9)
        #expect(r.severityText == nil)
        #expect(r.event == "ouo.replay.chunk")
        #expect(r.body == Data("golden".utf8))
        // Ascending field numbers: time, severity, body, attributes, observed time, event name.
        #expect(r.recordFieldOrder == [1, 2, 5] + Array(repeating: 6, count: 14) + [11, 12])
        #expect(r.keys == [
            "session.id", "ouo.replay.id", "ouo.replay.stream.id", "ouo.replay.segment.index",
            "ouo.replay.sequence", "ouo.replay.keyframe", "ouo.replay.start_time", "ouo.replay.end_time",
            "ouo.replay.format", "ouo.replay.encoding", "ouo.replay.sha256", "ouo.replay.byte_size",
            "ouo.replay.masked", "ouo.replay.mode",
        ])
        #expect(r.string("session.id") == "000102030405060708090a0b0c0d0e0f")
        #expect(r.string("ouo.replay.id") == "101112131415161718191a1b1c1d1e1f")
        #expect(r.string("ouo.replay.stream.id") == "202122232425262728292a2b2c2d2e2f")
        // Zero is written, not left out.
        #expect(r.int("ouo.replay.segment.index") == 0)
        #expect(r.int("ouo.replay.sequence") == 0)
        #expect(r.bool("ouo.replay.keyframe") == true)
        #expect(r.int("ouo.replay.start_time") == 1_700_000_000_000)
        #expect(r.int("ouo.replay.end_time") == 1_700_000_005_000)
        #expect(r.string("ouo.replay.format") == "ouo-frames/3")
        #expect(r.string("ouo.replay.encoding") == "gzip")
        // sha256("golden"), from `printf golden | shasum -a 256`.
        #expect(r.string("ouo.replay.sha256") == "dd56de4137951d9c92681b03416ec15f886b4482a27e3a517d32f085244cbe5d")
        #expect(r.int("ouo.replay.byte_size") == 6)
        #expect(r.bool("ouo.replay.masked") == true)
        #expect(r.string("ouo.replay.mode") == "session")
        #expect(!r.keys.contains("ouo.replay.ref"))
        #expect(!r.keys.contains("ouo.replay.trigger"))
        #expect(!r.keys.contains("ouo.view.id"))
    }

    @Test func BufferTriggerAndViewIdFollowTheRequiredAttributes() throws {
        let meta = ReplayChunkMeta(
            sessionId: "s", replayId: "r", streamId: "st", segmentIndex: 3, sequence: 41, keyframe: false,
            startTime: 10, endTime: 20, format: "stub/1", encoding: "none", masked: false,
            mode: "buffer", trigger: "error", viewId: "view-7"
        )
        let r = try decodeRequest(ReplayEnvelope.chunkRequest(scope: testScope, meta: meta, body: Data([0, 1, 2]), observedTime: 99))
        #expect(Array(r.keys.suffix(3)) == ["ouo.replay.mode", "ouo.replay.trigger", "ouo.view.id"])
        #expect(r.string("ouo.replay.mode") == "buffer")
        #expect(r.string("ouo.replay.trigger") == "error")
        #expect(r.string("ouo.view.id") == "view-7")
        #expect(r.int("ouo.replay.segment.index") == 3)
        #expect(r.int("ouo.replay.sequence") == 41)
        #expect(r.bool("ouo.replay.keyframe") == false)
        #expect(r.bool("ouo.replay.masked") == false)
        #expect(r.time == 10_000_000)
        #expect(r.observedTime == 99_000_000)
        #expect(r.body == Data([0, 1, 2]))
        #expect(r.string("ouo.replay.sha256") == ReplayEnvelope.sha256Hex(Data([0, 1, 2])))
    }

    @Test func EndedRecordHasNoBodyAndTheEndAttributes() throws {
        let ended = ReplayEnded(sessionId: "s", replayId: "r", streamId: "st", endState: "complete", lastSequence: 7, endReason: "stop")
        let r = try decodeRequest(ReplayEnvelope.endedRequest(scope: testScope, ended: ended, time: 5000))
        #expect(r.event == "ouo.replay.ended")
        #expect(r.scopeName == "ouo.replay")
        #expect(r.body == nil)
        #expect(r.recordFieldOrder == [1, 2, 6, 6, 6, 6, 6, 6, 11, 12])
        #expect(r.keys == ["session.id", "ouo.replay.id", "ouo.replay.stream.id", "ouo.replay.end_state", "ouo.replay.last_sequence", "ouo.replay.end_reason"])
        #expect(r.string("ouo.replay.end_state") == "complete")
        #expect(r.int("ouo.replay.last_sequence") == 7)
        #expect(r.string("ouo.replay.end_reason") == "stop")
        #expect(r.time == 5_000_000_000)

        // No chunk was produced: no last sequence to name.
        let none = ReplayEnded(sessionId: "s", replayId: "r", streamId: "st", endState: "partial", lastSequence: nil, endReason: "crash")
        let n = try decodeRequest(ReplayEnvelope.endedRequest(scope: testScope, ended: none, time: 1))
        #expect(!n.keys.contains("ouo.replay.last_sequence"))
        #expect(n.string("ouo.replay.end_state") == "partial")
    }

    @Test func ResourceAttributeTypesAreWritten() throws {
        let scope = ReplayScope(resource: [
            ReplayAttribute("a", "x"), ReplayAttribute("b", Int64(-1)), ReplayAttribute("c", .double(1.5)), ReplayAttribute("d", false), ReplayAttribute("e", ""),
        ], scopeVersion: "", schemaUrl: "")
        let meta = ReplayChunkMeta(sessionId: "s", replayId: "r", streamId: "st", segmentIndex: 0, sequence: 0, keyframe: true, startTime: 0, endTime: 0, format: "f", encoding: "e", masked: true, mode: "session")
        let r = try decodeRequest(ReplayEnvelope.chunkRequest(scope: scope, meta: meta, body: Data()))
        #expect(r.resource.map(\.value) == [.string("x"), .int(-1), .double(1.5), .bool(false), .string("")])
        #expect(r.scopeVersion.isEmpty)
        #expect(r.schemaUrl.isEmpty)
        #expect(r.body == Data())
        #expect(r.int("ouo.replay.byte_size") == 0)
    }

    @Test func WriterPrimitives() {
        var w = ProtoWriter()
        w.uint(1, 300)
        #expect(w.bytes == [0x08, 0xac, 0x02])
        w = ProtoWriter()
        w.int(3, -1)
        #expect(w.bytes == [0x18] + Array(repeating: 0xff, count: 9) + [0x01])
        w = ProtoWriter()
        w.fixed64(1, 0x0102_0304_0506_0708)
        #expect(w.bytes == [0x09, 8, 7, 6, 5, 4, 3, 2, 1])
        w = ProtoWriter()
        w.string(12, "é")
        #expect(w.bytes == [0x62, 2, 0xc3, 0xa9])
        w = ProtoWriter()
        w.bool(2, true)
        w.bytes(7, Data([9]))
        #expect(w.bytes == [0x10, 1, 0x3a, 1, 9])
        // A length above 127 takes a two-byte varint.
        w = ProtoWriter()
        w.bytes(1, Data(repeating: 0, count: 200))
        #expect(Array(w.bytes.prefix(3)) == [0x0a, 0xc8, 0x01])
        #expect(w.bytes.count == 203)
    }

    @Test func Sha256KnownVector() {
        #expect(ReplayEnvelope.sha256Hex(Data("abc".utf8)) == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
        #expect(ReplayEnvelope.sha256Hex(Data()) == "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
    }

    @Test func PartialSuccessIsReadFromTheResponse() {
        #expect(ReplayEnvelope.rejectedLogRecords(in: nil) == 0)
        #expect(ReplayEnvelope.rejectedLogRecords(in: Data()) == 0)
        // ExportLogsServiceResponse{partial_success{rejected_log_records: 3, error_message: "no"}}
        #expect(ReplayEnvelope.rejectedLogRecords(in: Data([0x0a, 0x06, 0x08, 0x03, 0x12, 0x02, 0x6e, 0x6f])) == 3)
        // partial_success present, nothing rejected (a warning only).
        #expect(ReplayEnvelope.rejectedLogRecords(in: Data([0x0a, 0x04, 0x12, 0x02, 0x6e, 0x6f])) == 0)
        #expect(ReplayEnvelope.rejectedLogRecords(in: Data([0x0a, 0x00])) == 0)
        // Not protobuf (a JSON or HTML answer), or cut short: accepted, never a trap.
        #expect(ReplayEnvelope.rejectedLogRecords(in: Data("{\"partialSuccess\":{}}".utf8)) == 0)
        #expect(ReplayEnvelope.rejectedLogRecords(in: Data([0x0a, 0x7f, 0x08])) == 0)
        #expect(ReplayEnvelope.rejectedLogRecords(in: Data([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])) == 0)
    }

    @Test func ReaderNeverTrapsOnRandomBytes() {
        var generator = SystemRandomNumberGenerator()
        for _ in 0..<2000 {
            let n = Int.random(in: 0...64, using: &generator)
            let data = Data((0..<n).map { _ in UInt8.random(in: 0...255, using: &generator) })
            var reader = ProtoReader(data)
            var fields = 0
            while reader.next() != nil, fields < 1000 { fields += 1 }
            _ = ReplayEnvelope.rejectedLogRecords(in: data)
        }
    }
}
