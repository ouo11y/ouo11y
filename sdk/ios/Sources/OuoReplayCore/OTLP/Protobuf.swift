import Foundation

/// The few protobuf wire primitives the replay envelope needs (ADR-0019 decision 5): varint,
/// fixed64 and length-delimited fields, written by hand so the SDK takes no dependency for one
/// message shape. Fields are written in the order the caller asks, which the envelope keeps
/// ascending by field number so two platforms produce the same bytes.
public struct ProtoWriter {
    public private(set) var bytes: [UInt8] = []

    public init() {}

    public var data: Data { Data(bytes) }

    public mutating func varint(_ value: UInt64) {
        var v = value
        while v >= 0x80 {
            bytes.append(UInt8(v & 0x7f) | 0x80)
            v >>= 7
        }
        bytes.append(UInt8(v))
    }

    private mutating func tag(_ field: Int, _ wireType: UInt64) {
        varint(UInt64(max(0, field)) << 3 | wireType)
    }

    /// Wire type 0. Written even when zero: the caller decides what is left out.
    public mutating func uint(_ field: Int, _ value: UInt64) {
        tag(field, 0)
        varint(value)
    }

    /// int64 as protobuf writes it: two's complement, so a negative value takes ten bytes.
    public mutating func int(_ field: Int, _ value: Int64) {
        uint(field, UInt64(bitPattern: value))
    }

    public mutating func bool(_ field: Int, _ value: Bool) {
        uint(field, value ? 1 : 0)
    }

    /// Wire type 1, little endian.
    public mutating func fixed64(_ field: Int, _ value: UInt64) {
        tag(field, 1)
        var v = value
        for _ in 0..<8 {
            bytes.append(UInt8(v & 0xff))
            v >>= 8
        }
    }

    public mutating func double(_ field: Int, _ value: Double) {
        fixed64(field, value.bitPattern)
    }

    /// Wire type 2.
    public mutating func bytes(_ field: Int, _ value: Data) {
        tag(field, 2)
        varint(UInt64(value.count))
        bytes.append(contentsOf: value)
    }

    public mutating func string(_ field: Int, _ value: String) {
        let utf8 = Array(value.utf8)
        tag(field, 2)
        varint(UInt64(utf8.count))
        bytes.append(contentsOf: utf8)
    }

    /// An embedded message: what `body` writes, length-prefixed.
    public mutating func message(_ field: Int, _ body: (inout ProtoWriter) -> Void) {
        var inner = ProtoWriter()
        body(&inner)
        tag(field, 2)
        varint(UInt64(inner.bytes.count))
        bytes.append(contentsOf: inner.bytes)
    }
}

/// Reads the fields of one message, enough for the collector's answer
/// (`ExportLogsServiceResponse.partial_success`). Malformed input ends the iteration; it never traps.
public struct ProtoReader {
    public enum Value: Equatable {
        case varint(UInt64)
        case fixed64(UInt64)
        case fixed32(UInt32)
        case bytes(Data)
    }

    private let bytes: [UInt8]
    private var offset = 0
    /// The input ended inside a field or used a wire type that does not exist.
    public private(set) var malformed = false

    public init(_ data: Data) {
        bytes = [UInt8](data)
    }

    private mutating func readVarint() -> UInt64? {
        var result: UInt64 = 0
        var shift: UInt64 = 0
        while offset < bytes.count, shift < 64 {
            let b = bytes[offset]
            offset += 1
            result |= UInt64(b & 0x7f) << shift
            if b & 0x80 == 0 { return result }
            shift += 7
        }
        return nil
    }

    public mutating func next() -> (field: Int, value: Value)? {
        guard !malformed, offset < bytes.count else { return nil }
        guard let key = readVarint() else { malformed = true; return nil }
        let field = Int(truncatingIfNeeded: key >> 3)
        switch key & 7 {
        case 0:
            guard let v = readVarint() else { malformed = true; return nil }
            return (field, .varint(v))
        case 1:
            guard bytes.count - offset >= 8 else { malformed = true; return nil }
            var v: UInt64 = 0
            for i in 0..<8 { v |= UInt64(bytes[offset + i]) << UInt64(8 * i) }
            offset += 8
            return (field, .fixed64(v))
        case 2:
            guard let n = readVarint(), n <= UInt64(bytes.count - offset) else { malformed = true; return nil }
            let end = offset + Int(n)
            let slice = Data(bytes[offset..<end])
            offset = end
            return (field, .bytes(slice))
        case 5:
            guard bytes.count - offset >= 4 else { malformed = true; return nil }
            var v: UInt32 = 0
            for i in 0..<4 { v |= UInt32(bytes[offset + i]) << UInt32(8 * i) }
            offset += 4
            return (field, .fixed32(v))
        default:
            malformed = true
            return nil
        }
    }
}
