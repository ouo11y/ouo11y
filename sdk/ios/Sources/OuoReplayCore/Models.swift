import Foundation

/// Why a frame was captured (`docs/specs/mobile-replay.md`).
public enum FrameReason: String, Codable, Sendable {
    case timer
    case touch
    case navigation
    case resume
}

public enum TouchPhase: String, Codable, Sendable {
    case began
    case moved
    case ended
}

/// One captured screen. `ts` is epoch milliseconds, `jpeg` is base64 of the encoded frame.
public struct Frame: Codable, Equatable, Sendable {
    public var ts: Int64
    public var jpeg: String
    public var reason: FrameReason

    public init(ts: Int64, jpeg: String, reason: FrameReason) {
        self.ts = ts
        self.jpeg = jpeg
        self.reason = reason
    }

    /// Convenience: base64-encodes the JPEG bytes.
    public init(ts: Int64, jpegData: Data, reason: FrameReason) {
        self.init(ts: ts, jpeg: jpegData.base64EncodedString(), reason: reason)
    }
}

/// One touch sample in points of the unscaled viewport.
public struct Touch: Codable, Equatable, Sendable {
    public var ts: Int64
    public var x: Double
    public var y: Double
    public var phase: TouchPhase

    public init(ts: Int64, x: Double, y: Double, phase: TouchPhase) {
        self.ts = ts
        self.x = x
        self.y = y
        self.phase = phase
    }
}

/// Viewport in points plus the pixels-per-point scale the frames were rendered at.
public struct Viewport: Codable, Equatable, Sendable {
    public var width: Double
    public var height: Double
    public var scale: Double

    public init(width: Double, height: Double, scale: Double) {
        self.width = width
        self.height = height
        self.scale = scale
    }
}

/// The chunk posted to `POST /v1/replay/chunks`. Keys are snake_case exactly as the spec shows.
public struct FrameChunk: Codable, Equatable, Sendable {
    public static let kind = "frames"
    public static let schemaVersion = 1

    public var kind: String
    public var schemaVersion: Int
    public var sessionId: String
    public var seq: Int
    public var startedAt: Int64
    public var endedAt: Int64
    public var viewport: Viewport
    public var platform: String
    public var frames: [Frame]
    public var touches: [Touch]
    public var masked: Bool

    enum CodingKeys: String, CodingKey {
        case kind
        case schemaVersion = "schema_version"
        case sessionId = "session_id"
        case seq
        case startedAt = "started_at"
        case endedAt = "ended_at"
        case viewport
        case platform
        case frames
        case touches
        case masked
    }

    public init(
        sessionId: String,
        seq: Int,
        startedAt: Int64,
        endedAt: Int64,
        viewport: Viewport,
        platform: String = "ios",
        frames: [Frame],
        touches: [Touch],
        masked: Bool
    ) {
        self.kind = FrameChunk.kind
        self.schemaVersion = FrameChunk.schemaVersion
        self.sessionId = sessionId
        self.seq = seq
        self.startedAt = startedAt
        self.endedAt = endedAt
        self.viewport = viewport
        self.platform = platform
        self.frames = frames
        self.touches = touches
        self.masked = masked
    }

    /// JSON with keys in a stable order (sorted), without escaped slashes. The server does not
    /// care about order; the tests compare against the spec fixture by key set.
    public func encodedJSON() throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(self)
    }

    public static func decode(_ data: Data) throws -> FrameChunk {
        try JSONDecoder().decode(FrameChunk.self, from: data)
    }
}
