#if canImport(UIKit)
import UIKit
import OuoReplayCore

/// Owns the capture loop: 1 Hz timer on the main run loop, touch-triggered captures limited per
/// second, app lifecycle (background stops and flushes, foreground resumes with an immediate
/// frame), the chunk builder and the uploader. Main thread only.
final class ReplayRecorder {
    private let config: OuoReplayConfig
    private let logger: ReplayLogger
    private let capturer: ScreenCapturer
    private let deduper = FrameDeduper()
    private let builder: ChunkBuilder
    private let uploader: ChunkUploader
    private let touchObserver = TouchObserver.make()

    private var timer: Timer?
    private var observers: [NSObjectProtocol] = []
    private var attachedWindow: UIWindow?
    private var touchCaptureTimes: [TimeInterval] = []
    private(set) var isRecording = false
    /// Set by `pause()`; a background/foreground cycle must not resume a paused recorder.
    private var pausedByHost = false

    init(config: OuoReplayConfig) {
        let logger = ReplayLogger(enabled: config.debug)
        let rules = config.redactionRules
        let uploader = ChunkUploader(endpoint: config.endpoint, projectId: config.projectId, projectToken: config.projectToken, logger: logger)
        let screen = UIScreen.main.bounds
        self.config = config
        self.logger = logger
        self.capturer = ScreenCapturer(rules: rules, jpegQuality: config.jpegQuality, maxLongestSide: config.maxLongestSide, logger: logger)
        self.uploader = uploader
        self.builder = ChunkBuilder(
            config: ChunkBuilder.Config(flushInterval: config.flushInterval, maxFrames: config.maxFramesPerChunk, platform: "ios", masked: rules.masksAnything),
            viewport: Viewport(width: Double(screen.width), height: Double(screen.height), scale: 1),
            sessionId: config.sessionId,
            seqStore: config.seqStore,
            onChunk: { chunk in uploader.enqueue(chunk) }
        )
        touchObserver.onTouch = { [weak self] touch in self?.handle(touch) }
    }

    // MARK: lifecycle

    func start() {
        let center = NotificationCenter.default
        observers = [
            center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
                self?.logger.log("background: stop timer, flush")
                self?.stopTimer()
                self?.flush(completion: nil)
            },
            center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
                guard let self, !self.pausedByHost else { return }
                self.logger.log("active: resume with immediate frame")
                self.resumeCapture(reason: .resume)
            },
        ]
        pausedByHost = false
        resumeCapture(reason: .resume)
        logger.log("started endpoint=\(config.endpoint.absoluteString) project=\(config.projectId) interval=\(config.frameInterval)s")
    }

    func pause() {
        pausedByHost = true
        stopTimer()
        flush(completion: nil)
        logger.log("paused")
    }

    func resume() {
        pausedByHost = false
        resumeCapture(reason: .resume)
        logger.log("resumed")
    }

    func stop() {
        stopTimer()
        flush(completion: nil)
        observers.forEach { NotificationCenter.default.removeObserver($0) }
        observers = []
        detachTouchObserver()
    }

    func flush(completion: (() -> Void)?) {
        builder.flush()
        uploader.drain { DispatchQueue.main.async { completion?() } }
    }

    func sessionDidRotate(newId: String) {
        logger.log("session rotated -> \(newId)")
        builder.sessionDidRotate(newId: newId)
        deduper.reset()
    }

    // MARK: capture loop

    private func resumeCapture(reason: FrameReason) {
        guard timer == nil else { return }
        isRecording = true
        deduper.reset()
        attachTouchObserverIfNeeded()
        captureFrame(reason: reason)
        let t = Timer(timeInterval: config.frameInterval, repeats: true) { [weak self] _ in self?.tick() }
        // `.common` so capture keeps running while a scroll view is tracking.
        RunLoop.main.add(t, forMode: .common)
        timer = t
    }

    private func stopTimer() {
        timer?.invalidate()
        timer = nil
        isRecording = false
    }

    private func tick() {
        attachTouchObserverIfNeeded()
        captureFrame(reason: .timer)
        builder.flushIfDue()
    }

    private func handle(_ touch: Touch) {
        guard isRecording else { return }
        builder.add(touch)
        guard touch.phase != .moved else { return }
        let now = ProcessInfo.processInfo.systemUptime
        touchCaptureTimes.removeAll { now - $0 > 1 }
        guard touchCaptureTimes.count < config.maxTouchCapturesPerSecond else { return }
        touchCaptureTimes.append(now)
        // Next run-loop turn so the touch's own UI update is on screen first.
        DispatchQueue.main.async { [weak self] in self?.captureFrame(reason: .touch) }
    }

    private func captureFrame(reason: FrameReason) {
        guard isRecording, let window = ScreenCapturer.keyWindow() else { return }
        guard let capture = capturer.capture(window: window) else { return }
        builder.viewport = capture.viewport
        guard deduper.shouldKeep(capture.thumbnail) else { return }
        builder.add(Frame(ts: Clock.nowMillis(), jpegData: capture.jpeg, reason: reason))
        logger.log("frame \(reason.rawValue) \(capture.jpeg.count) bytes, \(capture.redactedRects) redacted rects")
    }

    private func attachTouchObserverIfNeeded() {
        guard let window = ScreenCapturer.keyWindow() else { return }
        if attachedWindow === window { return }
        detachTouchObserver()
        window.addGestureRecognizer(touchObserver)
        attachedWindow = window
    }

    private func detachTouchObserver() {
        attachedWindow?.removeGestureRecognizer(touchObserver)
        attachedWindow = nil
    }
}
#endif
