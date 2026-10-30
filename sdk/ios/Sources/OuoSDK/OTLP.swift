import Foundation
import OuoReplayCore

/// A log record: an event when `eventName` is set (mobile SDK spec rule 1), else a `log` line.
struct LogRecord: Equatable {
    var timeMs: Double
    var severity: OuoLogLevel
    var body: String
    var attributes: Attributes
    var traceId: String?
    var spanId: String?

    var eventName: String? {
        if case .string(let n)? = attributes["event.name"] { return n }
        return nil
    }
}

/// A finished span.
struct SpanRecord: Equatable {
    enum Kind: Int { case `internal` = 1, server = 2, client = 3, producer = 4, consumer = 5 }
    var traceId: String
    var spanId: String
    var parentSpanId: String?
    var name: String
    var kind: Kind
    var startMs: Double
    var endMs: Double
    var attributes: Attributes
    /// Status error with its message; nil is unset.
    var error: String?
}

/// OTLP/HTTP JSON (opentelemetry-proto's JSON mapping): ids in hex, 64-bit integers and
/// nanosecond times as decimal strings, attributes as `{key, value: {stringValue|intValue|...}}`.
/// ADR-0016: ouo encodes it itself, no opentelemetry-swift.
enum OTLP {
    static let scopeName = "ouo11y-ios"

    static func logsBody(_ records: [LogRecord], resource: Attributes) -> Data {
        let logs: [[String: Any]] = records.map { r in
            var o: [String: Any] = [
                "timeUnixNano": nanos(r.timeMs),
                "observedTimeUnixNano": nanos(r.timeMs),
                "severityNumber": r.severity.number,
                "severityText": r.severity.text,
                "body": ["stringValue": r.body],
                "attributes": attributes(r.attributes),
            ]
            if let n = r.eventName { o["eventName"] = n }
            if let t = r.traceId { o["traceId"] = t }
            if let s = r.spanId { o["spanId"] = s }
            return o
        }
        return encode(["resourceLogs": [["resource": ["attributes": attributes(resource)], "scopeLogs": [["scope": scope, "logRecords": logs]]]]])
    }

    static func tracesBody(_ spans: [SpanRecord], resource: Attributes) -> Data {
        let list: [[String: Any]] = spans.map { s in
            var o: [String: Any] = [
                "traceId": s.traceId,
                "spanId": s.spanId,
                "name": s.name,
                "kind": s.kind.rawValue,
                "startTimeUnixNano": nanos(s.startMs),
                "endTimeUnixNano": nanos(max(s.startMs, s.endMs)),
                "attributes": attributes(s.attributes),
            ]
            if let p = s.parentSpanId { o["parentSpanId"] = p }
            if let e = s.error { o["status"] = ["code": 2, "message": e] }
            return o
        }
        return encode(["resourceSpans": [["resource": ["attributes": attributes(resource)], "scopeSpans": [["scope": scope, "spans": list]]]]])
    }

    private static var scope: [String: Any] { ["name": scopeName, "version": Ouo.sdkVersion] }

    static func attributes(_ a: Attributes) -> [[String: Any]] {
        a.keys.sorted().map { k in ["key": k, "value": value(a[k]!)] }
    }

    static func value(_ v: AttributeValue) -> [String: Any] {
        switch v {
        case .string(let s): return ["stringValue": s]
        case .int(let i): return ["intValue": String(i)]
        // JSON has no NaN or infinity (JSONSerialization would raise): they become strings.
        case .double(let d): return d.isFinite ? ["doubleValue": d] : ["stringValue": String(d)]
        case .bool(let b): return ["boolValue": b]
        }
    }

    static func nanos(_ ms: Double) -> String {
        guard ms.isFinite, ms > 0 else { return "0" }
        return String(UInt64((ms * 1000).rounded()) * 1000)
    }

    private static func encode(_ object: [String: Any]) -> Data {
        (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])) ?? Data()
    }
}

/// Random W3C trace and span ids (lowercase hex, never all zero).
enum Ids {
    static func trace() -> String { hex(16) }
    static func span() -> String { hex(8) }

    private static func hex(_ n: Int) -> String {
        var bytes = [UInt8](repeating: 0, count: n)
        repeat {
            for i in 0..<n { bytes[i] = UInt8.random(in: 0...255) }
        } while bytes.allSatisfy { $0 == 0 }
        return bytes.map { String(format: "%02x", $0) }.joined()
    }
}
