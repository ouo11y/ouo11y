import Foundation

/// Why a frame was captured (`docs/specs/mobile-replay.md`).
public enum FrameReason: String, Codable, Sendable {
    case timer
    case touch
    case navigation
    case resume
    /// The screen when the user sent feedback (mobile SDK spec C10): taken in every mode, a full
    /// image even when nothing changed, so the replay holds the screenshot at the feedback.
    case feedback
}

public enum TouchPhase: String, Codable, Sendable {
    case began
    case moved
    case ended
}

/// A rectangle of a patch frame in pixels of the chunk's full image, with its own JPEG (base64).
public struct Patch: Codable, Equatable, Sendable {
    public var x: Int
    public var y: Int
    public var w: Int
    public var h: Int
    public var jpeg: String

    public init(_ rect: PixelRect, jpegData: Data) {
        self.x = rect.x
        self.y = rect.y
        self.w = rect.w
        self.h = rect.h
        self.jpeg = jpegData.base64EncodedString()
    }
}

/// One captured screen (schema 2, ADR-0014): exactly one of `jpeg` (a full image, base64) and
/// `patches` (rectangles drawn over the frame before it in the same chunk). `ts` is epoch
/// milliseconds.
public struct Frame: Codable, Equatable, Sendable {
    public var ts: Int64
    public var jpeg: String?
    public var patches: [Patch]?
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

    public init(ts: Int64, patches: [Patch], reason: FrameReason) {
        self.ts = ts
        self.patches = patches
        self.reason = reason
    }

    public var isFull: Bool { jpeg != nil }

    /// Base64 characters of its images (what the chunk's 1 MiB cut counts).
    public var imageBytes: Int {
        (jpeg?.utf8.count ?? 0) + (patches ?? []).reduce(0) { $0 + $1.jpeg.utf8.count }
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
    public static let schemaVersion = 2

    public var kind: String
    public var schemaVersion: Int
    public var sessionId: String
    public var seq: Int
    public var startedAt: Int64
    public var endedAt: Int64
    public var viewport: Viewport
    public var platform: String
    /// The capture mode of the session (`session`, `navigation`), informational.
    public var mode: String
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
        case mode
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
        mode: String = "session",
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
        self.mode = mode
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
