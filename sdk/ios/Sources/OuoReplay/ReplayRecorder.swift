#if canImport(UIKit)
import UIKit
import os
import OuoReplayCore

/// Owns the capture loop (ADR-0006 rev 2, docs/specs/mobile-replay.md "Capture scheduling"):
/// a main run-loop observer captures after the pass's UI work is committed, when the
/// `CapturePacer` says a frame is due (interval or screen change, no view controller transition,
/// animation deferral, settle time, time bank), one capture in flight. A keep-alive timer wakes an idle run loop once per interval so a due
/// frame is not left waiting for the next touch, and cuts chunks on time. Touches are recorded but never trigger a capture.
/// The walk and the render run on the main thread; planning, downscale, redaction, dedupe,
/// encoding, chunking, the spool and the upload hand-off run on `queue`, which alone touches
/// `deduper` and `builder`.
final class ReplayRecorder {
    /// Instruments: "snapshot" intervals are the main-thread part of each capture ("walk" inside
    /// it), "compose" the capture-queue part (subsystem dev.ouo.replay, category capture).
    static let signposter = OSSignposter(subsystem: "dev.ouo.replay", category: "capture")
    /// Shared by every recorder, so a restarted recorder recovers the spool only after the
    /// previous one cut its chunk.
    private static let queue = DispatchQueue(label: "dev.ouo.replay.capture", qos: .utility)

    private let config: OuoReplayConfig
    private let logger: ReplayLogger
    private let capturer: ScreenCapturer
    private let deduper = FrameDeduper()
    private let builder: ChunkBuilder
    private let uploader: ChunkUploader
    private let spool: ChunkSpool
    private let touchObserver = TouchObserver.make()
    let mode: ReplayMode

    /// Main thread from here on.
    private var pacer: CapturePacer
    private var captureInFlight = false
    private var runLoopObserver: CFRunLoopObserver?
    private var keepAlive: Timer?
    private var observers: [NSObjectProtocol] = []
    private var attachedWindow: UIWindow?
    private(set) var isRecording = false
    /// Set by `pause()`; a background/foreground cycle must not resume a paused recorder.
    private var pausedByHost = false

    init(config: OuoReplayConfig) {
        let logger = ReplayLogger(enabled: config.debug)
        let rules = config.redactionRules
        let uploader = ChunkUploader(endpoint: config.endpoint, projectId: config.projectId, projectToken: config.projectToken, logger: logger)
        let screen = UIScreen.main.bounds
        let spool = ChunkSpool(url: config.spoolURL)
        self.config = config
        self.logger = logger
        self.mode = config.mode.resolved(physicalMemory: ProcessInfo.processInfo.physicalMemory)
        self.pacer = CapturePacer(mode: mode, interval: config.frameInterval)
        self.capturer = ScreenCapturer(rules: rules, jpegQuality: config.jpegQuality, maxLongestSide: config.maxLongestSide, logger: logger)
        self.uploader = uploader
        self.spool = spool
        self.builder = ChunkBuilder(
            config: ChunkBuilder.Config(flushInterval: config.flushInterval, maxFrames: config.maxFramesPerChunk, platform: "ios", masked: rules.masksAnything),
            viewport: Viewport(width: Double(screen.width), height: Double(screen.height), scale: 1),
            sessionId: config.sessionId,
            seqStore: config.seqStore,
            spool: spool,
            onChunk: { chunk in uploader.enqueue(chunk) }
        )
        touchObserver.onTouch = { [weak self] touch in self?.handle(touch) }
    }

    // MARK: lifecycle

    func start() {
        // The chunk the previous process left open (crash, watchdog, force quit) goes first.
        Self.queue.async { [spool, uploader, logger] in
            if let chunk = spool.recover() {
                logger.log("recovered open chunk \(chunk.sessionId)#\(chunk.seq): \(chunk.frames.count) frames")
                uploader.enqueue(chunk)
            }
        }
        let center = NotificationCenter.default
        observers = [
            center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
                self?.logger.log("background: stop capturing, flush")
                self?.stopCapture()
                self?.flush(completion: nil)
            },
            center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
                guard let self, !self.pausedByHost else { return }
                self.logger.log("active: resume with an immediate frame")
                self.resumeCapture()
            },
        ]
        pausedByHost = false
        resumeCapture()
        logger.log("started endpoint=\(config.endpoint.absoluteString) project=\(config.projectId) mode=\(mode.rawValue) interval=\(config.frameInterval)s")
    }

    func pause() {
        pausedByHost = true
        stopCapture()
        flush(completion: nil)
        logger.log("paused")
    }

    func resume() {
        pausedByHost = false
        resumeCapture()
        logger.log("resumed")
    }

    func stop() {
        stopCapture()
        flush(completion: nil)
        observers.forEach { NotificationCenter.default.removeObserver($0) }
        observers = []
        detachTouchObserver()
    }

    func flush(completion: (() -> Void)?) {
        // Behind every capture already handed to the queue, so their frames are in the chunk.
        Self.queue.async { [builder, uploader] in
            builder.flush()
            uploader.drain { DispatchQueue.main.async { completion?() } }
        }
    }

    func sessionDidRotate(newId: String) {
        logger.log("session rotated -> \(newId)")
        Self.queue.async { [builder, deduper] in
            builder.sessionDidRotate(newId: newId)
            deduper.reset()
        }
    }

    /// A new screen is showing: the frame for it in `navigation` mode (ignored in `session` mode,
    /// where the next interval frame shows it anyway).
    func screenDidChange() {
        pacer.screenDidChange(now: ProcessInfo.processInfo.systemUptime)
    }

    // MARK: capture loop

    private func resumeCapture() {
        guard !isRecording else { return }
        isRecording = true
        Self.queue.async { [deduper] in deduper.reset() }
        pacer.requestFrame(.resume, now: ProcessInfo.processInfo.systemUptime)
        // After Core Animation's commit observer (order 2000000), so the walk and the render see
        // the pass's committed UI; common modes so capture continues while a scroll view tracks.
        let observer = CFRunLoopObserverCreateWithHandler(nil, CFRunLoopActivity.beforeWaiting.rawValue, true, CFIndex.max) { [weak self] _, _ in
            self?.captureIfDue()
        }
        CFRunLoopAddObserver(CFRunLoopGetMain(), observer, .commonModes)
        runLoopObserver = observer
        // Wakes an idle run loop so the observer runs, and keeps the chunk timing and the touch
        // window current when no frame is due (navigation mode, a static screen).
        let timer = Timer(timeInterval: min(config.frameInterval, 1), repeats: true) { [weak self] _ in self?.tick() }
        RunLoop.main.add(timer, forMode: .common)
        keepAlive = timer
    }

    private func stopCapture() {
        if let observer = runLoopObserver {
            CFRunLoopRemoveObserver(CFRunLoopGetMain(), observer, .commonModes)
            runLoopObserver = nil
        }
        keepAlive?.invalidate()
        keepAlive = nil
        isRecording = false
    }

    private func tick() {
        if let window = ScreenCapturer.keyWindow() { attachTouchObserverIfNeeded(window) }
        Self.queue.async { [builder] in builder.flushIfDue() }
    }

    private func handle(_ touch: Touch) {
        guard isRecording else { return }
        Self.queue.async { [builder] in builder.add(touch) }
    }

    private func captureIfDue() {
        let start = ProcessInfo.processInfo.systemUptime
        guard isRecording, !captureInFlight, pacer.isDue(now: start), let window = ScreenCapturer.keyWindow() else { return }
        attachTouchObserverIfNeeded(window)
        if Self.isTransitioning(window.rootViewController) {
            _ = pacer.decide(now: start, animations: 0, transitioning: true)
            return
        }
        let ts = Clock.nowMillis()
        let sp = Self.signposter
        let snapshotState = sp.beginInterval("snapshot", id: sp.makeSignpostID())
        let walkState = sp.beginInterval("walk", id: sp.makeSignpostID())
        let walk = ViewTreeBuilder.walk(window)
        sp.endInterval("walk", walkState)
        guard case .capture(let reason) = pacer.decide(now: start, animations: walk.animations) else {
            sp.endInterval("snapshot", snapshotState)
            pacer.spent(ProcessInfo.processInfo.systemUptime - start, now: start)
            return
        }
        let snapshot = capturer.snapshot(window: window, tree: walk.tree)
        sp.endInterval("snapshot", snapshotState)
        pacer.spent(ProcessInfo.processInfo.systemUptime - start, now: start)
        guard let snapshot else { return }
        captureInFlight = true
        Self.queue.async { [weak self, capturer, deduper, builder, logger] in
            let state = sp.beginInterval("compose", id: sp.makeSignpostID())
            switch capturer.compose(snapshot, deduper: deduper) {
            case .frame(let capture):
                builder.viewport = capture.viewport
                builder.add(Frame(ts: ts, jpegData: capture.jpeg, reason: reason))
                logger.log("frame \(reason.rawValue) \(capture.jpeg.count) bytes, \(capture.redactedRects) redacted rects")
            case .unsafe:
                logger.log("frame \(reason.rawValue) dropped: a masked view was moving")
            case .unchanged, .failed:
                break
            }
            sp.endInterval("compose", state)
            DispatchQueue.main.async { self?.captureInFlight = false }
        }
    }

    /// A push, pop or presentation is running somewhere in the window's view controllers.
    private static func isTransitioning(_ vc: UIViewController?) -> Bool {
        guard let vc else { return false }
        if vc.transitionCoordinator != nil { return true }
        return isTransitioning(vc.presentedViewController) || vc.children.contains { isTransitioning($0) }
    }

    private func attachTouchObserverIfNeeded(_ window: UIWindow) {
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
