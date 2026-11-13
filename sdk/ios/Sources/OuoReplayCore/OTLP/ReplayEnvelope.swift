import Foundation
import CryptoKit

/// One OTLP attribute: a key and a string, int, double or bool. Codable so the open stream's
/// resource survives a kill (`ReplayStreamState`).
public struct ReplayAttribute: Codable, Equatable, Sendable {
    public enum Value: Equatable, Sendable {
        case string(String)
        case int(Int64)
        case double(Double)
        case bool(Bool)
    }

    public var key: String
    var s: String?
    var i: Int64?
    var d: Double?
    var b: Bool?

    public init(_ key: String, _ value: Value) {
        self.key = key
        switch value {
        case .string(let v): s = v
        case .int(let v): i = v
        case .double(let v): d = v
        case .bool(let v): b = v
        }
    }

    public init(_ key: String, _ value: String) { self.init(key, .string(value)) }
    public init(_ key: String, _ value: Int64) { self.init(key, .int(value)) }
    public init(_ key: String, _ value: Bool) { self.init(key, .bool(value)) }

    public var value: Value {
        if let s { return .string(s) }
        if let i { return .int(i) }
        if let d { return .double(d) }
        return .bool(b ?? false)
    }
}

/// What every record of a stream shares: the resource the caller passed in and the scope
/// (`ouo.replay`, RPL-3) with its version and schema URL.
public struct ReplayScope: Codable, Equatable, Sendable {
    public var resource: [ReplayAttribute]
    public var scopeVersion: String
    public var schemaUrl: String

    public init(resource: [ReplayAttribute], scopeVersion: String, schemaUrl: String) {
        self.resource = resource
        self.scopeVersion = scopeVersion
        self.schemaUrl = schemaUrl
    }
}

/// The attributes of one `ouo.replay.chunk` record (spec 11.3), apart from the three computed from
/// the body: `ouo.replay.sha256`, `ouo.replay.byte_size` and the body itself.
public struct ReplayChunkMeta: Equatable, Sendable {
    public var sessionId: String
    public var replayId: String
    public var streamId: String
    public var segmentIndex: Int
    public var sequence: Int
    public var keyframe: Bool
    public var startTime: EpochMillis
    public var endTime: EpochMillis
    public var format: String
    public var encoding: String
    public var masked: Bool
    /// `session` or `buffer`.
    public var mode: String
    /// Buffer mode only: `error`, `crash`, `anr`, `hang` or `manual`.
    public var trigger: String?
    public var viewId: String?

    public init(sessionId: String, replayId: String, streamId: String, segmentIndex: Int, sequence: Int, keyframe: Bool, startTime: EpochMillis, endTime: EpochMillis, format: String, encoding: String, masked: Bool, mode: String, trigger: String? = nil, viewId: String? = nil) {
        self.sessionId = sessionId
        self.replayId = replayId
        self.streamId = streamId
        self.segmentIndex = segmentIndex
        self.sequence = sequence
        self.keyframe = keyframe
        self.startTime = startTime
        self.endTime = endTime
        self.format = format
        self.encoding = encoding
        self.masked = masked
        self.mode = mode
        self.trigger = trigger
        self.viewId = viewId
    }
}

/// The attributes of one `ouo.replay.ended` record (spec 11.5).
public struct ReplayEnded: Equatable, Sendable {
    public var sessionId: String
    public var replayId: String
    public var streamId: String
    /// `complete` or `partial`.
    public var endState: String
    /// Highest sequence produced, nil when the stream produced no chunk.
    public var lastSequence: Int?
    public var endReason: String

    public init(sessionId: String, replayId: String, streamId: String, endState: String, lastSequence: Int?, endReason: String) {
        self.sessionId = sessionId
        self.replayId = replayId
        self.streamId = streamId
        self.endState = endState
        self.lastSequence = lastSequence
        self.endReason = endReason
    }
}

/// Builds the OTLP/HTTP protobuf request of one replay record (spec 11.3, 11.5; TRN-1, TRN-5):
/// `ExportLogsServiceRequest` with one ResourceLogs, one ScopeLogs (scope `ouo.replay`) and one
/// LogRecord. Fields are written in ascending field number, attributes in the order of the spec
/// table, so the Android writer produces the same bytes (the golden vector in the tests).
///
/// Field numbers (opentelemetry-proto v1, logs):
/// ExportLogsServiceRequest.resource_logs = 1; ResourceLogs.resource = 1, .scope_logs = 2;
/// Resource.attributes = 1; ScopeLogs.scope = 1, .log_records = 2, .schema_url = 3;
/// InstrumentationScope.name = 1, .version = 2; LogRecord.time_unix_nano = 1 (fixed64),
/// .severity_number = 2, .body = 5, .attributes = 6, .observed_time_unix_nano = 11 (fixed64),
/// .event_name = 12; KeyValue.key = 1, .value = 2; AnyValue.string_value = 1, .bool_value = 2,
/// .int_value = 3, .double_value = 4, .bytes_value = 7.
public enum ReplayEnvelope {
    public static let scopeName = "ouo.replay"
    public static let chunkEvent = "ouo.replay.chunk"
    public static let endedEvent = "ouo.replay.ended"
    /// SEVERITY_NUMBER_INFO.
    public static let severityInfo: UInt64 = 9

    /// Lowercase hex SHA-256 of `data` (RPL-12: of the exact body bytes as sent).
    public static func sha256Hex(_ data: Data) -> String {
        hex(Data(SHA256.hash(data: data)))
    }

    public static func hex(_ data: Data) -> String {
        let digits = Array("0123456789abcdef".utf8)
        var out = [UInt8]()
        out.reserveCapacity(data.count * 2)
        for byte in data {
            out.append(digits[Int(byte >> 4)])
            out.append(digits[Int(byte & 0x0f)])
        }
        return String(decoding: out, as: UTF8.self)
    }

    /// `body` is the compressed chunk body, written as `bytes_value`. `observedTime` (epoch ms)
    /// defaults to the chunk start.
    public static func chunkRequest(scope: ReplayScope, meta: ReplayChunkMeta, body: Data, observedTime: EpochMillis? = nil) -> Data {
        var attributes: [ReplayAttribute] = [
            ReplayAttribute("session.id", meta.sessionId),
            ReplayAttribute("ouo.replay.id", meta.replayId),
            ReplayAttribute("ouo.replay.stream.id", meta.streamId),
            ReplayAttribute("ouo.replay.segment.index", Int64(meta.segmentIndex)),
            ReplayAttribute("ouo.replay.sequence", Int64(meta.sequence)),
            ReplayAttribute("ouo.replay.keyframe", meta.keyframe),
            ReplayAttribute("ouo.replay.start_time", meta.startTime),
            ReplayAttribute("ouo.replay.end_time", meta.endTime),
            ReplayAttribute("ouo.replay.format", meta.format),
            ReplayAttribute("ouo.replay.encoding", meta.encoding),
            ReplayAttribute("ouo.replay.sha256", sha256Hex(body)),
            ReplayAttribute("ouo.replay.byte_size", Int64(body.count)),
            ReplayAttribute("ouo.replay.masked", meta.masked),
            ReplayAttribute("ouo.replay.mode", meta.mode),
        ]
        if let trigger = meta.trigger { attributes.append(ReplayAttribute("ouo.replay.trigger", trigger)) }
        if let viewId = meta.viewId, !viewId.isEmpty { attributes.append(ReplayAttribute("ouo.view.id", viewId)) }
        return request(scope: scope, event: chunkEvent, time: meta.startTime, observedTime: observedTime ?? meta.startTime, body: body, attributes: attributes)
    }

    /// The end of a stream: the same envelope with no body field.
    public static func endedRequest(scope: ReplayScope, ended: ReplayEnded, time: EpochMillis) -> Data {
        var attributes: [ReplayAttribute] = [
            ReplayAttribute("session.id", ended.sessionId),
            ReplayAttribute("ouo.replay.id", ended.replayId),
            ReplayAttribute("ouo.replay.stream.id", ended.streamId),
            ReplayAttribute("ouo.replay.end_state", ended.endState),
        ]
        if let last = ended.lastSequence { attributes.append(ReplayAttribute("ouo.replay.last_sequence", Int64(last))) }
        attributes.append(ReplayAttribute("ouo.replay.end_reason", ended.endReason))
        return request(scope: scope, event: endedEvent, time: time, observedTime: time, body: nil, attributes: attributes)
    }

    static func request(scope: ReplayScope, event: String, time: EpochMillis, observedTime: EpochMillis, body: Data?, attributes: [ReplayAttribute]) -> Data {
        var out = ProtoWriter()
        out.message(1) { resourceLogs in
            resourceLogs.message(1) { resource in
                for a in scope.resource { keyValue(&resource, 1, a) }
            }
            resourceLogs.message(2) { scopeLogs in
                scopeLogs.message(1) { s in
                    s.string(1, scopeName)
                    if !scope.scopeVersion.isEmpty { s.string(2, scope.scopeVersion) }
                }
                scopeLogs.message(2) { record in
                    record.fixed64(1, nanos(time))
                    record.uint(2, severityInfo)
                    if let body {
                        record.message(5) { $0.bytes(7, body) }
                    }
                    for a in attributes { keyValue(&record, 6, a) }
                    record.fixed64(11, nanos(observedTime))
                    record.string(12, event)
                }
                if !scope.schemaUrl.isEmpty { scopeLogs.string(3, scope.schemaUrl) }
            }
        }
        return out.data
    }

    private static func nanos(_ millis: EpochMillis) -> UInt64 {
        UInt64(max(0, millis)) &* 1_000_000
    }

    /// A KeyValue whose AnyValue always carries its one field, a zero or an empty string included
    /// (a oneof has presence, so `int_value: 0` is not the same as no value).
    private static func keyValue(_ out: inout ProtoWriter, _ field: Int, _ a: ReplayAttribute) {
        out.message(field) { kv in
            kv.string(1, a.key)
            kv.message(2) { v in
                switch a.value {
                case .string(let s): v.string(1, s)
                case .bool(let b): v.bool(2, b)
                case .int(let i): v.int(3, i)
                case .double(let d): v.double(4, d)
                }
            }
        }
    }

    /// `partial_success.rejected_log_records` of an `ExportLogsServiceResponse` (TRN-6): 0 when
    /// the body is empty (a 204 counts as accepted), carries no partial success or cannot be read.
    public static func rejectedLogRecords(in response: Data?) -> Int {
        guard let response, !response.isEmpty else { return 0 }
        var top = ProtoReader(response)
        while let (field, value) = top.next() {
            guard field == 1, case .bytes(let partial) = value else { continue }
            var inner = ProtoReader(partial)
            while let (f, v) = inner.next() {
                if f == 1, case .varint(let n) = v {
                    let signed = Int64(bitPattern: n)
                    return signed > 0 ? Int(clamping: signed) : 0
                }
            }
        }
        return 0
    }
}
