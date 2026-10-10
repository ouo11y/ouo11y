import Foundation
@_exported import OuoReplayCore

/// Host configuration (docs/specs/mobile-replay.md, "Host API").
public struct OuoReplayConfig {
    /// rum-api base URL; chunks go to `${endpoint}/v1/replay/chunks`.
    public var endpoint: URL
    /// Project token sent as `X-Ouo-Project-Token` on every upload (ADR-0007). Public by nature;
    /// rum-api answers 401 without it.
    public var projectToken: String
    /// Called when a chunk is opened; must return the active `session.id`.
    public var sessionId: () -> String
    /// Seconds between timer frames. Default 1.
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
    /// Seconds before an open chunk is flushed. Default 5.
    public var flushInterval: TimeInterval
    /// Frames per chunk before it is flushed. Default 10.
    public var maxFramesPerChunk: Int
    /// JPEG quality. Default 0.5.
    public var jpegQuality: Double
    /// Longest frame side in pixels. Default 1000.
    public var maxLongestSide: Double
    /// Touch-triggered captures per second. Default 4.
    public var maxTouchCapturesPerSecond: Int
    /// Where chunk seq numbers persist. Default UserDefaults.standard.
    public var seqStore: SeqStore

    public init(
        endpoint: URL,
        projectToken: String,
        sessionId: @escaping () -> String,
        frameInterval: TimeInterval = 1.0,
        maskText: Bool = true,
        maskInputs: Bool = true,
        maskImages: Bool = true,
        maskWebViews: Bool = true,
        maskClasses: Set<String> = [],
        debug: Bool = false,
        flushInterval: TimeInterval = 5,
        maxFramesPerChunk: Int = 10,
        jpegQuality: Double = 0.5,
        maxLongestSide: Double = 1000,
        maxTouchCapturesPerSecond: Int = 4,
        seqStore: SeqStore = UserDefaultsSeqStore()
    ) {
        self.endpoint = endpoint
        self.projectToken = projectToken
        self.sessionId = sessionId
        self.frameInterval = frameInterval
        self.maskText = maskText
        self.maskInputs = maskInputs
        self.maskImages = maskImages
        self.maskWebViews = maskWebViews
        self.maskClasses = maskClasses
        self.debug = debug
        self.flushInterval = flushInterval
        self.maxFramesPerChunk = maxFramesPerChunk
        self.jpegQuality = jpegQuality
        self.maxLongestSide = maxLongestSide
        self.maxTouchCapturesPerSecond = maxTouchCapturesPerSecond
        self.seqStore = seqStore
    }

    public var redactionRules: RedactionRules {
        RedactionRules(maskText: maskText, maskInputs: maskInputs, maskImages: maskImages, maskWebViews: maskWebViews, extraClasses: maskClasses)
    }
}
