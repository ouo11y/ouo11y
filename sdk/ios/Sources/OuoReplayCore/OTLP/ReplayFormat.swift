import Foundation

/// One event of a replay payload: a single JSON object (no newline inside), written as one line
/// of the chunk body. Both formats are newline-delimited JSON, so the decompressed bodies of a
/// segment's chunks concatenate into a valid payload (RPL-7).
public struct ReplayEvent: Sendable, Equatable {
    /// Epoch milliseconds, the event's `t`.
    public var t: EpochMillis
    /// The event alone restores the whole screen: a segment can start with it (RPL-6).
    public var keyframe: Bool
    /// The JSON object, UTF-8, without the trailing newline.
    public var json: Data

    public init(t: EpochMillis, keyframe: Bool, json: Data) {
        self.t = t
        self.keyframe = keyframe
        self.json = json
    }
}

/// What one look at the screen saw, handed from the capture side to the format adapter. Each
/// format has its own (`PixelLook` for `ouo-frames/3`); an adapter given another one drops the frame.
public protocol ReplayLook {}

public enum ReplayFormatError: Error, Equatable {
    /// The look is not the one this format reads.
    case wrongLook
    /// Masking could not be applied or its result could not be established: the frame is dropped
    /// (PRV-8).
    case maskingFailed
    case encodingFailed
}

/// The seam between "when to look" and "what is recorded" (spec 11.6, RPL-27; ADR-0019 decision
/// 5). Everything above it (replay, stream, segment, sequence, chunk attributes, delivery, end
/// record) is the same for every format (RPL-23).
///
/// | Capability (RPL-27) | Here |
/// |---|---|
/// | Format id and version | `formatId` |
/// | Keyframe on request | `requestKeyframe()`: the next look yields a keyframe event |
/// | Encoding and compression | `encoding`, `compress(_:)` |
/// | Masking | applied inside `events(for:at:)`; an event never carries unmasked content, and a look whose masked state is unknown throws |
/// | Bounded output | events are lines: the stream cuts a chunk between them, or inside one that alone exceeds the hard limit |
///
/// Not thread-safe: `ReplayStream` calls it under its own lock.
public protocol ReplayFormatAdapter: AnyObject {
    /// `ouo.replay.format`, for example `ouo-frames/3`.
    var formatId: String { get }
    /// `ouo.replay.encoding`, for example `gzip`.
    var encoding: String { get }
    /// `ouo.replay.masked`: masking ran on this content.
    var masked: Bool { get }
    /// The next look must produce a keyframe, even when the screen did not change.
    func requestKeyframe()
    /// The events of one look, already masked: none when nothing changed. Throws when the frame
    /// must be dropped.
    func events(for look: ReplayLook, at t: EpochMillis) throws -> [ReplayEvent]
    /// A touch sample as an event; nil when the format does not record touches.
    func touchEvent(_ touch: Touch) -> ReplayEvent?
    /// Compresses the bytes of a chunk (`encoding`). Each result decompresses on its own.
    func compress(_ payload: Data) throws -> Data
}

public extension ReplayFormatAdapter {
    var encoding: String { "gzip" }

    func compress(_ payload: Data) throws -> Data {
        try Gzip.compress(payload)
    }

    /// `{"t":ms,"type":"touch","x":..,"y":..,"phase":"began|moved|ended"}`, the same in both
    /// formats. `x` and `y` are points of the viewport (pixels divided by the frame's `scale`).
    func touchEvent(_ touch: Touch) -> ReplayEvent? {
        let json = "{\"t\":\(touch.ts),\"type\":\"touch\",\"x\":\(ReplayJSON.number(touch.x)),\"y\":\(ReplayJSON.number(touch.y)),\"phase\":\"\(touch.phase.rawValue)\"}"
        return ReplayEvent(t: touch.ts, keyframe: false, json: Data(json.utf8))
    }
}

/// The JSON the formats write by hand: fixed key order (so an unchanged tree hashes the same) and
/// no escaping surprises.
public enum ReplayJSON {
    /// An integer when the value is one, else two decimals. Never `nan` or `inf`.
    public static func number(_ value: Double) -> String {
        guard value.isFinite else { return "0" }
        let clamped = min(max(value, -9_007_199_254_740_992), 9_007_199_254_740_992)
        let rounded = (clamped * 100).rounded() / 100
        if rounded == rounded.rounded() { return String(Int64(rounded)) }
        return String(format: "%.2f", locale: Locale(identifier: "en_US_POSIX"), rounded)
    }

    /// A JSON string literal, quotes included. Control characters, the line separators U+2028 and
    /// U+2029 and DEL are escaped, so the result never holds a raw newline.
    public static func string(_ value: String) -> String {
        var out = "\""
        out.reserveCapacity(value.utf8.count + 2)
        for scalar in value.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            default:
                if scalar.value < 0x20 || scalar.value == 0x7f || scalar.value == 0x2028 || scalar.value == 0x2029 {
                    let hex = String(scalar.value, radix: 16)
                    out += "\\u" + String(repeating: "0", count: max(0, 4 - hex.count)) + hex
                } else {
                    out.unicodeScalars.append(scalar)
                }
            }
        }
        out += "\""
        return out
    }

    /// `#rrggbbaa` from `0xRRGGBBAA`.
    public static func color(_ rgba: UInt32) -> String {
        let hex = String(rgba, radix: 16)
        return "\"#" + String(repeating: "0", count: max(0, 8 - hex.count)) + hex + "\""
    }
}
