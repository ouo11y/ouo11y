import Foundation

/// A `kind: "video"` replay chunk (ADR-0008, rum-api `parseVideo`): one self-contained mp4 segment
/// and the touches during it. The Sentry bridge (collector `ouosentryreceiver`) produces the same
/// kind from Sentry envelopes; the iOS SDK produces it with `OuoReplayConfig.recorder = .sentryVideo`.
/// `format` names the payload (`ouo.replay.format`, sdk-spec section 11.3), so a reader can tell a
/// Sentry-derived video from another vendor's format later. Schema 1 (video stays at 1, ADR-0014).
public struct VideoChunk: Codable, Equatable, Sendable {
    public static let kind = "video"
    public static let schemaVersion = 1

    public struct Video: Codable, Equatable, Sendable {
        public var container: String
        public var encoding: String
        public var durationMs: Int64
        public var frameCount: Int
        public var frameRate: Int
        /// The mp4 file, base64.
        public var mp4: String

        enum CodingKeys: String, CodingKey {
            case container, encoding, mp4
            case durationMs = "duration_ms"
            case frameCount = "frame_count"
            case frameRate = "frame_rate"
        }
    }

    public var kind: String
    public var schemaVersion: Int
    public var format: String
    public var sessionId: String
    public var seq: Int
    public var startedAt: Int64
    public var endedAt: Int64
    public var viewport: Viewport
    public var platform: String
    public var mode: String
    public var video: Video
    public var touches: [Touch]
    public var masked: Bool

    enum CodingKeys: String, CodingKey {
        case kind, format, seq, viewport, platform, mode, video, touches, masked
        case schemaVersion = "schema_version"
        case sessionId = "session_id"
        case startedAt = "started_at"
        case endedAt = "ended_at"
    }

    /// `width` x `height` are video pixels; the viewport is the video at scale 1, which is what the
    /// player maps touches onto (touches are in points, and the core renders at 1 pixel per point).
    public init(
        format: String,
        sessionId: String,
        seq: Int,
        startedAt: Int64,
        endedAt: Int64,
        width: Int,
        height: Int,
        mp4: Data,
        frameCount: Int,
        frameRate: Int,
        touches: [Touch],
        masked: Bool,
        platform: String = "ios",
        mode: String = "session"
    ) {
        self.kind = VideoChunk.kind
        self.schemaVersion = VideoChunk.schemaVersion
        self.format = format
        self.sessionId = sessionId
        self.seq = seq
        self.startedAt = startedAt
        self.endedAt = max(endedAt, startedAt)
        self.viewport = Viewport(width: Double(width), height: Double(height), scale: 1)
        self.platform = platform
        self.mode = mode
        self.video = Video(container: "mp4", encoding: "h264", durationMs: self.endedAt - startedAt, frameCount: frameCount, frameRate: frameRate, mp4: mp4.base64EncodedString())
        self.touches = touches
        self.masked = masked
    }

    public func encodedJSON() throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(self)
    }

    public static func decode(_ data: Data) throws -> VideoChunk {
        try JSONDecoder().decode(VideoChunk.self, from: data)
    }
}

/// Main-thread milliseconds per capture, kept by both iOS recorders for the overhead comparison
/// (`OuoReplay.captureStats`). Bounded: the last `capacity` samples. Thread-safe.
public final class CaptureStats: @unchecked Sendable {
    public struct Snapshot: Equatable, Sendable {
        public let count: Int
        public let totalMillis: Double
        /// The retained samples, oldest first.
        public let samples: [Double]

        public var meanMillis: Double { count == 0 ? 0 : totalMillis / Double(count) }

        public func percentile(_ p: Double) -> Double {
            guard !samples.isEmpty else { return 0 }
            let s = samples.sorted()
            let i = min(s.count - 1, max(0, Int((p * Double(s.count - 1)).rounded())))
            return s[i]
        }
    }

    private let lock = NSLock()
    private let capacity: Int
    private var count = 0
    private var total = 0.0
    private var samples: [Double] = []

    public init(capacity: Int = 4096) {
        self.capacity = capacity
    }

    public func record(millis: Double) {
        lock.lock()
        defer { lock.unlock() }
        count += 1
        total += millis
        samples.append(millis)
        if samples.count > capacity { samples.removeFirst(samples.count - capacity) }
    }

    public func snapshot() -> Snapshot {
        lock.lock()
        defer { lock.unlock() }
        return Snapshot(count: count, totalMillis: total, samples: samples)
    }

    public func reset() {
        lock.lock()
        defer { lock.unlock() }
        count = 0
        total = 0
        samples = []
    }
}
