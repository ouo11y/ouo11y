import Foundation

/// One look of the video format: a finished segment, already masked and encoded by the recorder
/// core (an H.264 mp4 that starts with a keyframe), and the touches made while it was recorded.
public struct VideoLook: ReplayLook {
    public var mp4: Data
    public var start: EpochMillis
    public var end: EpochMillis
    /// Video size in pixels.
    public var width: Int
    public var height: Int
    /// Video pixels per window point (the core renders at 1x: 1).
    public var scale: Double
    public var frameCount: Int
    public var frameRate: Int
    /// Touches in window points; those outside `start ..< end` are left out.
    public var touches: [Touch]

    public init(mp4: Data, start: EpochMillis, end: EpochMillis, width: Int, height: Int, scale: Double, frameCount: Int, frameRate: Int, touches: [Touch]) {
        self.mp4 = mp4
        self.start = start
        self.end = end
        self.width = width
        self.height = height
        self.scale = scale
        self.frameCount = frameCount
        self.frameRate = frameRate
        self.touches = touches
    }
}

/// The video format, `ouo-video/1` (docs/specs/mobile-replay.md, "ouo-video/1"). One chunk is one
/// segment (RPL-25): its body is one JSON header line, a newline, then the mp4 bytes:
///
///     {"t":ms,"type":"video","end":ms,"w":px,"h":px,"scale":n,"fps":n,"frames":n,"mp4":bytes,
///      "touches":[{"t":ms,"x":pt,"y":pt,"phase":"began|moved|ended"}]}\n<mp4>
///
/// `mp4` is the byte length of what follows the newline. The body is not compressed again
/// (`ouo.replay.encoding` `identity`): H.264 is already compressed. Masking happened before
/// encoding, in the recorder core, with the same plan as `ouo-frames/3`; a frame whose mask could
/// not be established never reached the encoder (PRV-8).
public final class VideoFormatAdapter: ReplayFormatAdapter {
    public static let format = "ouo-video/1"
    /// The body as sent is the body as built.
    public static let identityEncoding = "identity"

    public let formatId = VideoFormatAdapter.format
    public let encoding = VideoFormatAdapter.identityEncoding
    public let masked: Bool
    public let selfContainedSegments = true

    public init(masked: Bool = true) {
        self.masked = masked
    }

    /// Every segment starts with a keyframe already.
    public func requestKeyframe() {}

    /// Touches travel inside the segment they belong to.
    public func touchEvent(_ touch: Touch) -> ReplayEvent? { nil }

    public func compress(_ payload: Data) throws -> Data { payload }

    public func events(for look: ReplayLook, at t: EpochMillis) throws -> [ReplayEvent] {
        guard let look = look as? VideoLook else { throw ReplayFormatError.wrongLook }
        guard Self.isMP4(look.mp4), look.width > 0, look.height > 0, look.end >= look.start,
              look.scale.isFinite, look.scale > 0 else {
            throw ReplayFormatError.encodingFailed
        }
        let touches = look.touches
            .filter { $0.ts >= look.start && $0.ts < look.end }
            .map { "{\"t\":\($0.ts),\"x\":\(ReplayJSON.number($0.x)),\"y\":\(ReplayJSON.number($0.y)),\"phase\":\"\($0.phase.rawValue)\"}" }
        let header = "{\"t\":\(look.start),\"type\":\"video\",\"end\":\(look.end),\"w\":\(look.width),\"h\":\(look.height),\"scale\":\(ReplayJSON.number(look.scale)),\"fps\":\(look.frameRate),\"frames\":\(look.frameCount),\"mp4\":\(look.mp4.count),\"touches\":[\(touches.joined(separator: ","))]}\n"
        var body = Data(header.utf8)
        body.append(look.mp4)
        return [ReplayEvent(t: look.start, keyframe: true, json: body, until: look.end)]
    }

    /// An ISO base media file: a `ftyp` box first.
    public static func isMP4(_ data: Data) -> Bool {
        data.count > 8 && data.dropFirst(4).prefix(4).elementsEqual("ftyp".utf8)
    }

    /// Splits a body back into its header (JSON object) and mp4 bytes; nil when it is not one.
    public static func parse(_ body: Data) -> (header: [String: Any], mp4: Data)? {
        guard let nl = body.firstIndex(of: UInt8(ascii: "\n")),
              let header = try? JSONSerialization.jsonObject(with: body[body.startIndex..<nl]) as? [String: Any],
              let length = header["mp4"] as? Int else { return nil }
        let mp4 = body[(nl + 1)...]
        guard mp4.count == length, isMP4(Data(mp4)) else { return nil }
        return (header, Data(mp4))
    }
}
