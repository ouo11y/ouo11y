#if canImport(UIKit)
import UIKit
import os
import OuoReplayCore

/// Owns the capture loop (ADR-0006 rev 2, docs/specs/mobile-replay.md "Capture scheduling"):
/// a main run-loop observer captures after the pass's UI work is committed, when the
/// `CapturePacer` says a frame is due (interval or screen change, no view controller transition,
/// animation deferral, settle time, time bank), one capture in flight. A one-shot timer wakes an
/// idle run loop when the next frame can be due; a 1 s keep-alive tick cuts chunks on time.
/// Touches are recorded but never trigger a capture. The walk, the masking plan (an unsafe frame
/// is dropped before the render) and the render run on the main thread; downscale, redaction,
/// the tile diff, encoding, chunking, the spool and the upload hand-off run on `queue`, which
/// alone touches `differ` and `builder`. A chunk's first frame, the frame after a resume or a
/// screen change, and a frame whose tiles changed over more than half its area are full images;
/// other frames carry only their changed rectangles (ADR-0014).
final class ReplayRecorder {
    /// Instruments: "snapshot" intervals are the main-thread part of each capture ("walk" inside
    /// it), "compose" the capture-queue part (subsystem dev.ouo.replay, category capture).
    static let signposter = OSSignposter(subsystem: "dev.ouo.replay", category: "capture")
    /// Shared by every recorder, so a restarted recorder recovers the spool only after the
    /// previous one cut its chunk.
    private static let queue = DispatchQueue(label: "dev.ouo.replay.capture", qos: .utility)
    /// `queue` only.
    private static var recovered = false

    private let config: OuoReplayConfig
    private let logger: ReplayLogger
    private let capturer: ScreenCapturer
    private let differ = TileDiffer()
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
    private var wakeTimer: Timer?
    private var observers: [NSObjectProtocol] = []
    private var attachedWindow: UIWindow?
    private(set) var isRecording = false
    /// Set by `pause()`; a background/foreground cycle must not resume a paused recorder.
    private var pausedByHost = false

    init(config: OuoReplayConfig) {
        let logger = ReplayLogger(enabled: config.debug)
        let rules = config.redactionRules
        let uploader = OuoReplay.uploader(config)
        let screen = UIScreen.main.bounds
        let spool = ChunkSpool(url: config.spoolURL)
        self.config = config
        self.logger = logger
        let mode = config.mode.resolved(physicalMemory: ProcessInfo.processInfo.physicalMemory)
        self.mode = mode
        self.pacer = CapturePacer(mode: mode, interval: config.frameInterval)
        self.capturer = ScreenCapturer(rules: rules, jpegQuality: config.jpegQuality, maxLongestSide: config.maxLongestSide, logger: logger)
        self.uploader = uploader
        self.spool = spool
        self.builder = ChunkBuilder(
            config: ChunkBuilder.Config(flushInterval: config.flushInterval, platform: "ios", masked: rules.masksAnything, mode: mode.rawValue),
            viewport: Viewport(width: Double(screen.width), height: Double(screen.height), scale: 1),
            sessionId: config.sessionId,
            seqStore: config.seqStore,
            spool: spool,
            onChunk: { chunk in uploader.enqueue(chunk) }
        )
        touchObserver.onTouch = { [weak self] touch in self?.handle(touch) }
    }

    // MARK: lifecycle

    /// Sends the chunk the previous process left open (crash, watchdog, force quit), whether or
    /// not this launch records: the host calls it before its sampling decision. On the capture
    /// queue, so it runs before any frame of this process and after a stopped recorder's flush.
    /// Once per process: a later call would read this process's own open chunk. Also starts
    /// sending the chunks earlier processes queued and could not send.
    static func recoverSpool(_ config: OuoReplayConfig) {
        let logger = ReplayLogger(enabled: config.debug)
        queue.async {
            guard !recovered else { return }
            recovered = true
            let uploader = OuoReplay.uploader(config)
            let spool = ChunkSpool(url: config.spoolURL)
            if let chunk = spool.recover() {
                logger.log("recovered open chunk \(chunk.sessionId)#\(chunk.seq): \(chunk.frames.count) frames")
                uploader.enqueue(chunk)
            }
            // After enqueue stored it in the outbox: a kill before this line sends it again.
            spool.clear()
            uploader.drain {}
        }
    }

    /// Runs `body` on the capture queue once the previous run's open chunk was recovered.
    static func afterRecovery(_ config: OuoReplayConfig, _ body: @escaping () -> Void) {
        recoverSpool(config)
        queue.async(execute: body)
    }

    func start() {
        Self.recoverSpool(config)
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
        Self.queue.async { [builder, differ] in
            builder.sessionDidRotate(newId: newId)
            differ.reset()
        }
    }

    /// A new screen is showing: the frame for it in `navigation` mode (in `session` mode the next
    /// interval frame shows it). Either way that frame is a full image, a seek point.
    func screenDidChange() {
        Self.queue.async { [differ] in differ.reset() }
        let now = ProcessInfo.processInfo.systemUptime
        pacer.screenDidChange(now: now)
        scheduleWake(now: now)
    }

    // MARK: capture loop

    private func resumeCapture() {
        guard !isRecording else { return }
        isRecording = true
        Self.queue.async { [differ] in differ.reset() }
        pacer.requestFrame(.resume, at: ProcessInfo.processInfo.systemUptime)
        // After Core Animation's commit observer (order 2000000), so the walk and the render see
        // the pass's committed UI; common modes so capture continues while a scroll view tracks.
        let observer = CFRunLoopObserverCreateWithHandler(nil, CFRunLoopActivity.beforeWaiting.rawValue, true, CFIndex.max) { [weak self] _, _ in
            self?.captureIfDue()
        }
        CFRunLoopAddObserver(CFRunLoopGetMain(), observer, .commonModes)
        runLoopObserver = observer
        // Cuts chunks on time and keeps the touch window current when no frame is due (navigation
        // mode, a static screen); frames themselves are woken for by `scheduleWake`.
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
        wakeTimer?.invalidate()
        wakeTimer = nil
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
        guard isRecording, let window = ScreenCapturer.keyWindow() else { return }
        let start = ProcessInfo.processInfo.systemUptime
        defer { scheduleWake(now: start) }
        // On every pass, not only due ones: a transition that ends just before a frame is due
        // still delays it by the settle time.
        if Self.isTransitioning(window.rootViewController) {
            pacer.motion(now: start)
            return
        }
        guard !captureInFlight, pacer.isDue(now: start) else { return }
        attachTouchObserverIfNeeded(window)
        let ts = Clock.nowMillis()
        let sp = Self.signposter
        let snapshotState = sp.beginInterval("snapshot", id: sp.makeSignpostID())
        let walkState = sp.beginInterval("walk", id: sp.makeSignpostID())
        let walk = ViewTreeBuilder.walk(window)
        sp.endInterval("walk", walkState)
        let decision = pacer.decide(now: start, animations: walk.animations)
        // Masking fails closed, decided before paying for the render: a masked view on a moving
        // layer drops the frame.
        let rects = decision == .wait ? nil : capturer.plan(walk.tree, bounds: window.bounds)
        guard case .capture(let reason) = decision, let rects else {
            sp.endInterval("snapshot", snapshotState)
            pacer.spent(ProcessInfo.processInfo.systemUptime - start, now: start)
            if case .capture(let reason) = decision {
                logger.log("frame \(reason.rawValue) dropped: a masked view was moving")
                pacer.dropped(reason, now: start)
            }
            return
        }
        let snapshot = capturer.snapshot(window: window, tree: walk.tree, rects: rects)
        sp.endInterval("snapshot", snapshotState)
        pacer.spent(ProcessInfo.processInfo.systemUptime - start, now: start)
        guard let snapshot else {
            pacer.dropped(reason, now: start)
            return
        }
        captureInFlight = true
        Self.queue.async { [weak self, capturer, differ, builder, logger] in
            let state = sp.beginInterval("compose", id: sp.makeSignpostID())
            var failed = false
            // A new size cuts the chunk, so the frame below opens the next one with a full image.
            builder.update(viewport: ScreenCapturer.viewport(of: snapshot))
            switch capturer.compose(snapshot, differ: differ, forceFull: builder.needsFullFrame, ts: ts, reason: reason) {
            case .frame(let frame):
                builder.add(frame)
                let kind = frame.isFull ? "full" : "\(frame.patches?.count ?? 0) patches"
                logger.log("frame \(reason.rawValue) \(kind) \(frame.imageBytes) bytes, \(snapshot.rects.count) redacted rects")
            case .failed:
                failed = true
            case .unchanged:
                break
            }
            sp.endInterval("compose", state)
            DispatchQueue.main.async {
                guard let self else { return }
                self.captureInFlight = false
                let now = ProcessInfo.processInfo.systemUptime
                if failed { self.pacer.dropped(reason, now: now) }
                self.scheduleWake(now: now)
            }
        }
    }

    /// Wakes the run loop when the pacer's next frame can be due, so a frame on an idle screen does
    /// not wait for the keep-alive tick (a navigation frame lands 0.4 s after the route change).
    /// Passes before it skip the walk (`isDue`).
    private func scheduleWake(now: TimeInterval) {
        guard isRecording, let at = pacer.wakeAt(now: now), at > now else { return }
        let fire = Date(timeIntervalSinceNow: at - now)
        if let t = wakeTimer, t.isValid, t.fireDate <= fire, t.fireDate > Date() { return }
        wakeTimer?.invalidate()
        // Does nothing itself: the pass it causes runs the observer.
        let t = Timer(fire: fire, interval: 0, repeats: false) { _ in }
        RunLoop.main.add(t, forMode: .common)
        wakeTimer = t
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
