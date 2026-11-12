import Foundation
import Testing
@testable import OuoReplayCore

// MARK: an independent protobuf reader (shares nothing with `ProtoWriter` / `ProtoReader`)

struct PBField {
    var number: Int
    var wire: Int
    var varint: UInt64 = 0
    var bytes = Data()
}

struct PBError: Error { let at: Int }

/// The fields of one message, in wire order.
func pbFields(_ data: Data) throws -> [PBField] {
    let b = [UInt8](data)
    var i = 0
    func readVarint() throws -> UInt64 {
        var value: UInt64 = 0
        var shift: UInt64 = 0
        while true {
            guard i < b.count, shift < 70 else { throw PBError(at: i) }
            let byte = b[i]
            i += 1
            value |= UInt64(byte & 0x7f) << shift
            if byte < 0x80 { return value }
            shift += 7
        }
    }
    var out: [PBField] = []
    while i < b.count {
        let key = try readVarint()
        var field = PBField(number: Int(key >> 3), wire: Int(key & 7))
        switch field.wire {
        case 0:
            field.varint = try readVarint()
        case 1:
            guard i + 8 <= b.count else { throw PBError(at: i) }
            field.varint = (0..<8).reduce(UInt64(0)) { $0 | UInt64(b[i + $1]) << UInt64(8 * $1) }
            i += 8
        case 2:
            let n = Int(try readVarint())
            guard i + n <= b.count else { throw PBError(at: i) }
            field.bytes = Data(b[i..<(i + n)])
            i += n
        default:
            throw PBError(at: i)
        }
        out.append(field)
    }
    return out
}

enum PBValue: Equatable {
    case string(String)
    case bool(Bool)
    case int(Int64)
    case double(Double)
    case bytes(Data)
}

/// One replay request as the collector would read it.
struct DecodedRequest {
    var resource: [(key: String, value: PBValue)] = []
    var scopeName = ""
    var scopeVersion = ""
    var schemaUrl = ""
    var time: UInt64 = 0
    var observedTime: UInt64 = 0
    var severity: UInt64 = 0
    var severityText: String?
    var body: Data?
    var event = ""
    var attributes: [(key: String, value: PBValue)] = []
    /// Field numbers of the LogRecord, in wire order.
    var recordFieldOrder: [Int] = []
    var logRecords = 0

    func string(_ key: String) -> String? {
        if case .string(let s)? = attributes.first(where: { $0.key == key })?.value { return s }
        return nil
    }

    func int(_ key: String) -> Int? {
        if case .int(let i)? = attributes.first(where: { $0.key == key })?.value { return Int(i) }
        return nil
    }

    func bool(_ key: String) -> Bool? {
        if case .bool(let b)? = attributes.first(where: { $0.key == key })?.value { return b }
        return nil
    }

    var keys: [String] { attributes.map(\.key) }
}

private func pbKeyValue(_ data: Data) throws -> (key: String, value: PBValue) {
    var key = ""
    var value = PBValue.string("")
    for f in try pbFields(data) {
        if f.number == 1 { key = String(decoding: f.bytes, as: UTF8.self) }
        if f.number == 2 {
            let any = try pbFields(f.bytes)
            let v = try #require(any.first)
            #expect(any.count == 1)
            switch v.number {
            case 1: value = .string(String(decoding: v.bytes, as: UTF8.self))
            case 2: value = .bool(v.varint != 0)
            case 3: value = .int(Int64(bitPattern: v.varint))
            case 4: value = .double(Double(bitPattern: v.varint))
            case 7: value = .bytes(v.bytes)
            default: Issue.record("unexpected AnyValue field \(v.number)")
            }
        }
    }
    return (key, value)
}

func decodeRequest(_ data: Data) throws -> DecodedRequest {
    var out = DecodedRequest()
    let top = try pbFields(data)
    #expect(top.count == 1)
    let resourceLogs = try pbFields(try #require(top.first { $0.number == 1 }).bytes)
    for f in resourceLogs {
        switch f.number {
        case 1:
            for a in try pbFields(f.bytes) where a.number == 1 { out.resource.append(try pbKeyValue(a.bytes)) }
        case 2:
            for s in try pbFields(f.bytes) {
                switch s.number {
                case 1:
                    for x in try pbFields(s.bytes) {
                        if x.number == 1 { out.scopeName = String(decoding: x.bytes, as: UTF8.self) }
                        if x.number == 2 { out.scopeVersion = String(decoding: x.bytes, as: UTF8.self) }
                    }
                case 2:
                    out.logRecords += 1
                    for r in try pbFields(s.bytes) {
                        out.recordFieldOrder.append(r.number)
                        switch r.number {
                        case 1: out.time = r.varint
                        case 2: out.severity = r.varint
                        case 3: out.severityText = String(decoding: r.bytes, as: UTF8.self)
                        case 5:
                            let any = try pbFields(r.bytes)
                            #expect(any.count == 1 && any[0].number == 7)
                            out.body = any.first?.bytes
                        case 6: out.attributes.append(try pbKeyValue(r.bytes))
                        case 11: out.observedTime = r.varint
                        case 12: out.event = String(decoding: r.bytes, as: UTF8.self)
                        default: Issue.record("unexpected LogRecord field \(r.number)")
                        }
                    }
                case 3: out.schemaUrl = String(decoding: s.bytes, as: UTF8.self)
                default: Issue.record("unexpected ScopeLogs field \(s.number)")
                }
            }
        default: Issue.record("unexpected ResourceLogs field \(f.number)")
        }
    }
    return out
}

func hexString(_ data: Data) -> String {
    data.map { String(format: "%02x", $0) }.joined()
}

// MARK: a stub format (RPL-27 / RPL-23 contract tests, fault injection)

struct StubLook: ReplayLook {
    var content: String
}

struct OtherLook: ReplayLook {}

struct StubFailure: Error {}

/// A format that is nothing like frames: its own id, no compression, a keyframe only when asked
/// (or for its first look). Faults are switched on per test.
final class StubAdapter: ReplayFormatAdapter {
    let formatId = "stub/1"
    var encoding: String { gzip ? "gzip" : "none" }
    var masked = true
    var gzip = false
    var keyframeRequests = 0
    private var wantKeyframe = true

    var throwOnLook: Error?
    var throwOnCompress = false
    /// Returned instead of the real events.
    var garbage: [ReplayEvent]?

    func requestKeyframe() {
        keyframeRequests += 1
        wantKeyframe = true
    }

    func events(for look: ReplayLook, at t: EpochMillis) throws -> [ReplayEvent] {
        if let throwOnLook { throw throwOnLook }
        if let garbage { return garbage }
        guard let look = look as? StubLook else { throw ReplayFormatError.wrongLook }
        let key = wantKeyframe
        wantKeyframe = false
        return [ReplayEvent(t: t, keyframe: key, json: Data("{\"t\":\(t),\"type\":\"\(key ? "key" : "delta")\",\"c\":\(ReplayJSON.string(look.content))}".utf8))]
    }

    func compress(_ payload: Data) throws -> Data {
        if throwOnCompress { throw StubFailure() }
        return gzip ? try Gzip.compress(payload) : payload
    }
}

/// Keeps what the stream hands over; can refuse like a full store.
final class RecordingSink: ReplaySink {
    struct Record {
        let request: Data
        let streamId: String
        let sequence: Int?
    }

    private let lock = NSLock()
    private var stored: [Record] = []
    /// Records accepted before every later one is refused.
    var capacity = Int.max

    func put(_ request: Data, streamId: String, sequence: Int?) -> Bool {
        lock.withLock {
            guard stored.count < capacity else { return false }
            stored.append(Record(request: request, streamId: streamId, sequence: sequence))
            return true
        }
    }

    var records: [Record] { lock.withLock { stored } }
    func decoded() throws -> [DecodedRequest] { try records.map { try decodeRequest($0.request) } }
    func chunks() throws -> [DecodedRequest] { try decoded().filter { $0.event == ReplayEnvelope.chunkEvent } }
    func ended() throws -> [DecodedRequest] { try decoded().filter { $0.event == ReplayEnvelope.endedEvent } }
}

final class MemoryStateStore: ReplayStateStore {
    var state: ReplayStreamState?
    var failing = false
    var saves = 0

    func save(_ state: ReplayStreamState) -> Bool {
        saves += 1
        guard !failing else { return false }
        self.state = state
        return true
    }

    func load() -> ReplayStreamState? { state }
    func clear() { state = nil }
}

let testScope = ReplayScope(resource: [ReplayAttribute("service.name", "tests")], scopeVersion: "0.0.1", schemaUrl: "https://example.test/schema")

func tempReplayDir(_ name: String = "replay") -> URL {
    FileManager.default.temporaryDirectory.appendingPathComponent("ouo-\(name)-\(UUID().uuidString)", isDirectory: true)
}

/// A transport that never answers: the request stays in flight.
final class HangingTransport: ChunkTransport {
    private let lock = NSLock()
    private var n = 0
    func send(_ request: URLRequest, completion: @escaping (Result<ChunkResponse, Error>) -> Void) {
        lock.withLock { n += 1 }
    }
    var count: Int { lock.withLock { n } }
}

/// Polls until `condition` holds (the queues under test are asynchronous).
func eventually(_ what: String = "condition", timeout: TimeInterval = 5, _ condition: () -> Bool) async {
    let deadline = Date().addingTimeInterval(timeout)
    while !condition(), Date() < deadline {
        try? await Task.sleep(nanoseconds: 5_000_000)
    }
    #expect(condition(), "timed out waiting for \(what)")
}
