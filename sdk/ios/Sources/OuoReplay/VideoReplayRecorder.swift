#if canImport(UIKit)
import UIKit
import OuoReplayCore
import OuoReplaySentryCore

/// Spike, legacy upload path (`OuoReplayConfig.recorder = .sentryVideo`, no `otlp`): replay
/// captured by sentry-cocoa's recorder core (OuoReplaySentryCore, `SentryCoreRecorder`) with ouo's
/// masking (`ReplayMaskPlanner`), shipped as ouo `kind: "video"` chunks with `format:
/// "ouo-video/1"` through the same uploader, outbox and credential as the frames recorder. The
/// OTLP path (`replay.mode: "pixel/video"`) is `OTLPReplayRecorder`.
///
/// The core captures, masks and encodes; this class only feeds it the app lifecycle, adds ouo's
/// touches, session id and seq, and wraps every finished segment as one chunk. A chunk is one
/// segment (5 s of 1 frame/s H.264, a keyframe first), so it is decodable alone. Not done in the
/// spike: the crash spool (the core keeps its frames as PNG files, so recovery is possible but
/// not wired), `navigation` mode and feedback frames (both are frames-recorder concepts).
final class VideoReplayRecorder: ReplayRecording {
    let kind = ReplayRecorderKind.sentryVideo
    /// Video segments are always taken at the core's own pace.
    let mode = ReplayMode.session

    private let config: OuoReplayConfig
    private let logger: ReplayLogger
    private let uploader: ChunkUploader
    private let core: SentryCoreRecorder
    private let touchObserver = TouchObserver.make()
    /// Touches and the session label, off the main thread: segments arrive on the core's queue.
    private let lock = NSLock()
    private var touches: [Touch] = []
    /// The session the open segment belongs to, read when it is shipped (a rotation relabels only
    /// segments that start after it).
    private var sessionId = ""
    private var observers: [NSObjectProtocol] = []
    private var attachedWindow: UIWindow?
    private var keepAlive: Timer?
    private(set) var isRecording = false
    private var pausedByHost = false

    init(config: OuoReplayConfig) {
        self.config = config
        let logger = ReplayLogger(enabled: config.debug)
        self.logger = logger
        uploader = OuoReplay.uploader(config)
        let planner = ReplayMaskPlanner(rules: config.redactionRules)
        core = SentryCoreRecorder(options: .init(plan: { planner.plan($0) }))
        if config.debug {
            OuoSentryCoreLog.minimum = .debug
            OuoSentryCoreLog.sink = { level, message in logger.log("sentry-core \(level): \(message)") }
        }
        // Secure fields are always masked (strict rules), so masking ran on every frame.
        let masked = true
        core.onCapture = { timing in OuoReplay.captureStats.record(millis: timing.mainThread * 1000) }
        core.onSegment = { [weak self] segment in self?.ship(segment, masked: masked) }
        touchObserver.onTouch = { [weak self] touch in self?.add(touch) }
    }

    func start() {
        ReplayRecorder.recoverSpool(config)
        let center = NotificationCenter.default
        observers = [
            center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
                self?.logger.log("background: pause the sentry core, cut the segment")
                self?.pauseCapture()
            },
            center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
                guard let self, !self.pausedByHost else { return }
                self.resumeCapture()
            },
        ]
        pausedByHost = false
        resumeCapture()
        logger.log("started sentry-video recorder endpoint=\(config.endpoint.absoluteString) project=\(config.projectId)")
    }

    func pause() {
        pausedByHost = true
        pauseCapture()
    }

    func resume() {
        pausedByHost = false
        resumeCapture()
    }

    func stop() {
        pauseCapture()
        observers.forEach { NotificationCenter.default.removeObserver($0) }
        observers = []
        detachTouchObserver()
    }

    func flush(completion: (() -> Void)?) {
        core.flush { [uploader] in
            uploader.drain { DispatchQueue.main.async { completion?() } }
        }
    }

    /// The segment open now belongs to the old session: cut it before the id changes, then the
    /// new session's seq starts at 0.
    func sessionDidRotate(newId: String) {
        core.flush { [weak self, config] in
            config.seqStore.reset(sessionId: newId)
            self?.lock.withLock { self?.sessionId = newId }
        }
    }

    func screenDidChange() {}

    func frameForFeedback() {}

    private func resumeCapture() {
        guard !isRecording else { return }
        isRecording = true
        let sid = config.sessionId()
        lock.withLock { sessionId = sid }
        if let w = Self.keyWindow() { attachTouchObserver(w) }
        core.start()
        let t = Timer(timeInterval: 1, repeats: true) { [weak self] _ in
            if let w = Self.keyWindow() { self?.attachTouchObserver(w) }
        }
        RunLoop.main.add(t, forMode: .common)
        keepAlive = t
    }

    private func pauseCapture() {
        guard isRecording else { return }
        isRecording = false
        keepAlive?.invalidate()
        keepAlive = nil
        // Cuts the open segment; `ship` sends it.
        core.pause()
    }

    private func add(_ touch: Touch) {
        guard isRecording else { return }
        lock.withLock { touches.append(touch) }
    }

    /// The core's processing queue: one segment becomes one chunk.
    private func ship(_ segment: OuoReplaySegment, masked: Bool) {
        let start = EpochMillis((segment.start.timeIntervalSince1970 * 1000).rounded())
        let end = EpochMillis((segment.end.timeIntervalSince1970 * 1000).rounded())
        // Touches up to the segment's end go with it; later ones wait for the next segment.
        let inSegment: [Touch] = lock.withLock {
            let taken = touches.filter { $0.ts < end }
            touches.removeAll { $0.ts < end }
            return taken.filter { $0.ts >= start }
        }
        let sessionId = lock.withLock { self.sessionId }
        let seq = config.seqStore.next(sessionId: sessionId)
        let chunk = VideoChunk(
            format: SentryCoreRecorder.formatName,
            sessionId: sessionId, seq: seq, startedAt: start, endedAt: end,
            width: segment.width, height: segment.height, mp4: segment.mp4,
            frameCount: segment.frameCount, frameRate: segment.frameRate,
            touches: inSegment, masked: masked
        )
        logger.log("segment \(sessionId)#\(seq) \(segment.frameCount) frames \(segment.width)x\(segment.height) \(segment.mp4.count) bytes mp4")
        uploader.enqueue(chunk)
        uploader.drain {}
    }

    private func attachTouchObserver(_ window: UIWindow) {
        if attachedWindow === window { return }
        detachTouchObserver()
        window.addGestureRecognizer(touchObserver)
        attachedWindow = window
    }

    private func detachTouchObserver() {
        attachedWindow?.removeGestureRecognizer(touchObserver)
        attachedWindow = nil
    }

    private static func keyWindow() -> UIWindow? { ScreenCapturer.keyWindow() }
}
#endif
