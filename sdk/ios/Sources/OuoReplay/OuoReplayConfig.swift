import Foundation
@_exported import OuoReplayCore

/// Which recorder captures the replay.
public enum ReplayRecorderKind: String, Sendable {
    /// ouo's own recorder: JPEG frames with tile patches, `kind: "frames"` (ADR-0006, ADR-0014).
    case frames
    /// Spike: sentry-cocoa's recorder core (OuoReplaySentryCore): 1 frame/s H.264 segments of 5 s,
    /// `kind: "video"` with `format: "sentry-video"`. Masking is Sentry's (it does not drop a frame
    /// when a masked view moves); `mode`, `jpegQuality`, `maxLongestSide`, `flushInterval`,
    /// `maskInputs` (inputs are masked as text) and `maskWebViews` do not apply.
    case sentryVideo = "sentry-video"
}

/// Host configuration (docs/specs/mobile-replay.md, "Host API").
public struct OuoReplayConfig {
    /// Replay receiver base URL (the collector's `ouoreplay` port, 4319 by default, or the proxy
    /// host that routes `/v1/replay/*` to it); chunks go to `${endpoint}/v1/replay/chunks`.
    public var endpoint: URL
    /// Project id: the user name of the HTTP Basic credential sent on every upload (ADR-0007).
    public var projectId: String
    /// Project token: the password of the Basic credential. Public by nature; the collector
    /// answers 401 without a valid pair.
    public var projectToken: String
    /// Called when a chunk is opened; must return the active `session.id`.
    public var sessionId: () -> String
    /// `session` (a frame per `frameInterval` while the screen changes), `navigation` (a frame per
    /// screen) or `auto` (navigation on devices with less than 3.5 GiB of RAM). Default `auto`.
    public var mode: ReplayMode
    /// Shortest time between two frames in `session` mode. Default 1.
    public var frameInterval: TimeInterval
    /// Redact labels and React Native text. Default true.
    public var maskText: Bool
    /// Redact text inputs (`UITextField`, `UITextView`, RN inputs). Default true; independent
    /// of `maskText`, so inputs stay redacted when labels are shown.
    public var maskInputs: Bool
    public var maskImages: Bool
    public var maskWebViews: Bool
    /// Extra view class names to redact.
    public var maskClasses: Set<String>
    public var debug: Bool
    /// Seconds before an open chunk is flushed (also once its images pass 1 MiB). Default 5.
    public var flushInterval: TimeInterval
    /// JPEG quality. Default 0.5.
    public var jpegQuality: Double
    /// Longest frame side in pixels. Default 1000.
    public var maxLongestSide: Double
    /// Where chunk seq numbers persist. Default UserDefaults.standard.
    public var seqStore: SeqStore
    /// Where the open chunk is kept until it is cut, so a crash does not lose it.
    public var spoolURL: URL
    /// Where cut chunks wait until the receiver accepts them (survives an outage and a kill).
    public var outboxURL: URL
    /// Keep chunks on the device until the host releases their session (`OuoReplay.releaseHeld`):
    /// the next-launch keep/drop decision. Default false: chunks are sent as they are cut.
    public var holdUploads: Bool
    /// Default `.frames`.
    public var recorder: ReplayRecorderKind

    public init(
        endpoint: URL,
        projectId: String,
        projectToken: String,
        sessionId: @escaping () -> String,
        mode: ReplayMode = .auto,
        frameInterval: TimeInterval = 1.0,
        maskText: Bool = true,
        maskInputs: Bool = true,
        maskImages: Bool = true,
        maskWebViews: Bool = true,
        maskClasses: Set<String> = [],
        debug: Bool = false,
        flushInterval: TimeInterval = 5,
        jpegQuality: Double = 0.5,
        maxLongestSide: Double = 1000,
        seqStore: SeqStore = UserDefaultsSeqStore(),
        spoolURL: URL = ChunkSpool.defaultURL,
        outboxURL: URL = ChunkUploader.defaultDirectory,
        holdUploads: Bool = false,
        recorder: ReplayRecorderKind = .frames
    ) {
        self.endpoint = endpoint
        self.projectId = projectId
        self.projectToken = projectToken
        self.sessionId = sessionId
        self.mode = mode
        self.frameInterval = frameInterval
        self.maskText = maskText
        self.maskInputs = maskInputs
        self.maskImages = maskImages
        self.maskWebViews = maskWebViews
        self.maskClasses = maskClasses
        self.debug = debug
        self.flushInterval = flushInterval
        self.jpegQuality = jpegQuality
        self.maxLongestSide = maxLongestSide
        self.seqStore = seqStore
        self.spoolURL = spoolURL
        self.outboxURL = outboxURL
        self.holdUploads = holdUploads
        self.recorder = recorder
    }

    /// `Basic base64("<projectId>:<projectToken>")`, what `ChunkUploader` puts in `Authorization`.
    public var authorization: String {
        ChunkUploader.basicAuthorization(projectId: projectId, projectToken: projectToken)
    }

    public var redactionRules: RedactionRules {
        RedactionRules(maskText: maskText, maskInputs: maskInputs, maskImages: maskImages, maskWebViews: maskWebViews, extraClasses: maskClasses)
    }
}
