import Foundation

/// One finished replay segment: a self-contained video (an H.264 mp4 that starts with a keyframe)
/// covering `start` ..< `end`. What every borrowed recorder core hands to ouo; the host wraps it
/// as an `ouo.replay.chunk` and knows nothing about the vendor the core came from.
public struct OuoReplaySegment: Sendable, Equatable {
    public let mp4: Data
    public let start: Date
    public let end: Date
    /// Video size in pixels.
    public let width: Int
    public let height: Int
    public let frameCount: Int
    public let frameRate: Int

    public init(mp4: Data, start: Date, end: Date, width: Int, height: Int, frameCount: Int, frameRate: Int) {
        self.mp4 = mp4
        self.start = start
        self.end = end
        self.width = width
        self.height = height
        self.frameCount = frameCount
        self.frameRate = frameRate
    }

    public var durationMillis: Int64 { Int64((end.timeIntervalSince(start) * 1000).rounded()) }
}

/// Main-thread cost of one capture, as the core measures it (Sentry: redaction + render).
public struct OuoCaptureTiming: Sendable, Equatable {
    public let mainThread: TimeInterval
    /// Off the main thread (Sentry: drawing the masks), not counted against the app.
    public let background: TimeInterval

    public init(mainThread: TimeInterval, background: TimeInterval) {
        self.mainThread = mainThread
        self.background = background
    }
}

/// The seam between ouo and a borrowed recorder core. A core captures, masks and packs on its
/// own; ouo only starts, pauses and flushes it and receives finished segments. Callbacks arrive
/// on the core's own queue, not the main thread. Lifecycle calls are main-thread only.
public protocol OuoSegmentRecorder: AnyObject {
    /// The payload format, written on every chunk as `format` / `ouo.replay.format`.
    var format: String { get }
    var onSegment: ((OuoReplaySegment) -> Void)? { get set }
    var onCapture: ((OuoCaptureTiming) -> Void)? { get set }
    func start()
    /// Stops capturing and cuts the open segment.
    func pause()
    func resume()
    /// Cuts the open segment; `completion` runs (main thread) once `onSegment` was called for it.
    func flush(completion: (() -> Void)?)
    func stop()
}
