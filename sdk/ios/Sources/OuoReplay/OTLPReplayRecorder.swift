#if canImport(UIKit)
import UIKit
import OuoReplayCore
import OuoReplayObjC

/// What `OuoReplay` drives: the recorder that uploads to `/v1/replay/chunks` (`ReplayRecorder`) or
/// the one that sends OTLP log records (`OTLPReplayRecorder`).
protocol ReplayRecording: AnyObject {
    var isRecording: Bool { get }
    var mode: ReplayMode { get }
    func start()
    func pause()
    func resume()
    func stop()
    func flush(completion: (() -> Void)?)
    func sessionDidRotate(newId: String)
    func screenDidChange()
    func frameForFeedback()
}

extension ReplayRecorder: ReplayRecording {}

/// The frames recorder (`mode: "pixel/frames"`) over OTLP (ADR-0021 decision 5, client SDK spec
/// 11). "When to look" is the legacy recorder's: the main run-loop observer and the `CapturePacer`.
/// What a look becomes is the format adapter's (`ouo-frames/3`); numbering, chunking, the buffer
/// ring and the end record are `ReplayStream`'s; the disk queue is `ReplayDelivery`'s. Host mask
/// overrides come from `ReplayMaskRegistry`, which does not depend on this recorder.
///
/// Main thread: the pacer, the view walk, the masking plan and the render.
/// `queue`: everything else. Failure isolation (ERR-1): UIKit calls that can raise run inside
/// `OuoReplayCatch`; a look that fails is dropped and counted; after `faultLimit` faults on the
/// main thread, or the stream's own limit, capture stops and the stream ends with reason `error`.
final class OTLPReplayRecorder: ReplayRecording {
    private static let queue = DispatchQueue(label: "dev.ouo.replay.otlp", qos: .utility)
    private static let faultLimit = 20

    private let config: OuoReplayConfig
    private let options: ReplayOTLPOptions
    private let rules: RedactionRules
    private let logger: ReplayLogger
    private let capturer: ScreenCapturer
    private let delivery: ReplayDelivery
    private let store: FileReplayStateStore
    private let touchObserver = TouchObserver.make()
    let mode: ReplayMode

    /// Main thread from here on. The stream itself is thread-safe; the reference changes on a
    /// session rotation.
    private var stream: ReplayStream
    private var pacer: CapturePacer
    private var captureInFlight = false
    private var runLoopObserver: CFRunLoopObserver?
    private var keepAlive: Timer?
    private var wakeTimer: Timer?
    private var observers: [NSObjectProtocol] = []
    private var attachedWindow: UIWindow?
    private(set) var isRecording = false
    private var pausedByHost = false
    private var stopped = false
    private var faults = 0
    private var maskDrops = 0

    init(config: OuoReplayConfig, options: ReplayOTLPOptions, delivery: ReplayDelivery, store: FileReplayStateStore) {
        var rules = config.redactionRules
        rules.strict = true
        let logger = ReplayLogger(enabled: config.debug)
        self.config = config
        self.options = options
        self.rules = rules
        self.logger = logger
        self.delivery = delivery
        self.store = store
        let mode = options.cadence.resolved(physicalMemory: ProcessInfo.processInfo.physicalMemory)
        self.mode = mode
        self.pacer = CapturePacer(mode: mode, interval: config.frameInterval)
        self.capturer = ScreenCapturer(rules: rules, jpegQuality: config.jpegQuality, maxLongestSide: config.maxLongestSide, logger: logger)
        self.stream = Self.makeStream(sessionId: config.sessionId(), replayId: options.replayId, config: config, options: options, rules: rules, delivery: delivery, store: store, logger: logger)
    }

    private static func makeStream(sessionId: String, replayId: String?, config: OuoReplayConfig, options: ReplayOTLPOptions, rules: RedactionRules, delivery: ReplayDelivery, store: FileReplayStateStore, logger: ReplayLogger) -> ReplayStream {
        // Secure fields are masked whatever the options say, so masking always ran on a frame.
        let adapter = PixelFormatAdapter(jpegQuality: config.jpegQuality, masked: true)
        return ReplayStream(sessionId: sessionId, replayId: replayId, scope: options.scope, config: options.streamConfig, adapter: adapter, sink: delivery, store: store, logger: logger)
    }

    // MARK: lifecycle

    func start() {
        // The stream a kill left open ends first (RPL-20), then what earlier runs queued is sent.
        // On the queue, so before any chunk of this process.
        let previousExit = options.previousExit
        Self.queue.async { [delivery, store] in
            ReplayStream.endOpenStream(store: store, sink: delivery, reason: previousExit)
            delivery.drain {}
        }
        delivery.onLoss = { [weak self] streamId in
            DispatchQueue.main.async { self?.stream.chunkLost(streamId: streamId) }
        }
        guard !stream.sessionId.isEmpty else {
            // `session.id` is required on every chunk (RPL-13): without one nothing is recorded.
            logger.warn("no session id: replay not started")
            OuoReplay.count("replay.no_session")
            stopped = true
            return
        }
        let center = NotificationCenter.default
        observers = [
            center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
                guard let self, !self.stopped else { return }
                self.stopCapture()
                self.closeForGap()
            },
            center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
                guard let self, !self.pausedByHost, !self.stopped else { return }
                self.resumeCapture()
            },
        ]
        pausedByHost = false
        resumeCapture()
        logger.log("started otlp logs=\(options.logsUrl.absoluteString) mode=\(options.recorder.rawValue) cadence=\(mode.rawValue) buffer=\(options.bufferSeconds.map { "\($0)s" } ?? "off") replay=\(stream.replayId) stream=\(stream.streamId)")
    }

    func pause() {
        pausedByHost = true
        stopCapture()
        closeForGap()
    }

    func resume() {
        pausedByHost = false
        guard !stopped else { return }
        resumeCapture()
    }

    func stop() {
        end(.stop)
    }

    /// Stops capture and ends the stream with `ouo.replay.ended`.
    func end(_ reason: ReplayEndReason) {
        stopCapture()
        stopped = true
        observers.forEach { NotificationCenter.default.removeObserver($0) }
        observers = []
        detachTouchObserver()
        let stream = self.stream
        Self.queue.async { [delivery] in
            stream.end(reason: reason)
            delivery.drain {}
        }
    }

    /// Consent withdrawn (PRV-4): capture stops, nothing further is sent (no end record either) and
    /// what is queued is deleted.
    func discard(completion: (() -> Void)?) {
        stopCapture()
        stopped = true
        observers.forEach { NotificationCenter.default.removeObserver($0) }
        observers = []
        detachTouchObserver()
        let stream = self.stream
        Self.queue.async { [delivery] in
            stream.abandon()
            delivery.discardPending()
            completion?()
        }
    }

    func flush(completion: (() -> Void)?) {
        let stream = self.stream
        Self.queue.async { [delivery] in
            stream.flush()
            delivery.drain { DispatchQueue.main.async { completion?() } }
        }
    }

    /// A new session is a new replay (spec 11.1): the stream ends with `session_end` and a new
    /// replay and stream start for `newId`. A buffer starts over untriggered.
    func sessionDidRotate(newId: String) {
        guard !stopped, !newId.isEmpty, newId != stream.sessionId else { return }
        let old = stream
        stream = Self.makeStream(sessionId: newId, replayId: nil, config: config, options: options, rules: rules, delivery: delivery, store: store, logger: logger)
        Self.queue.async { [delivery] in
            old.end(reason: .sessionEnd)
            delivery.drain {}
        }
        logger.log("session rotated -> \(newId): replay=\(stream.replayId) stream=\(stream.streamId)")
    }

    func screenDidChange() {
        guard isRecording else { return }
        let now = ProcessInfo.processInfo.systemUptime
        pacer.screenDidChange(now: now)
        scheduleWake(now: now)
    }

    /// The screen at a feedback, kept even when nothing changed: a keyframe (and so a segment).
    func frameForFeedback() {
        guard isRecording else { return }
        stream.markGap()
        let now = ProcessInfo.processInfo.systemUptime
        pacer.requestFrame(.feedback, at: now)
        scheduleWake(now: now)
    }

    func capture(trigger: ReplayTrigger) {
        let stream = self.stream
        Self.queue.async { [delivery] in
            stream.capture(trigger: trigger)
            delivery.drain {}
        }
    }

    func setViewId(_ id: String) {
        let stream = self.stream
        Self.queue.async { stream.setViewId(id) }
    }

    func diagnostics() -> [String: Int] {
        let s = stream.stats
        let d = delivery.stats
        return [
            "replay.frames_dropped": s.framesDropped + maskDrops,
            "replay.events_dropped": s.eventsDropped,
            "replay.errors": s.errors + faults,
            "replay.chunks": s.chunks,
            "replay.chunk_splits": s.splits,
            "replay.ring_evicted_segments": s.ringEvictedSegments,
            "replay.store_refused": s.refused,
            "replay.chunks_lost": s.lost,
            "replay.state_failures": s.stateFailures,
            "replay.accepted": d.accepted,
            "replay.partial_rejected": d.partialRejected,
            "replay.rejected_status": d.rejectedStatus,
            "replay.evicted": d.evicted,
        ]
    }

    // MARK: capture loop

    /// Closes the chunk; what is captured next starts a new segment (RPL-8, RPL-9).
    private func closeForGap() {
        let stream = self.stream
        Self.queue.async { [delivery] in
            stream.background()
            delivery.drain {}
        }
    }

    private func resumeCapture() {
        guard !isRecording, !stopped else { return }
        isRecording = true
        let now = ProcessInfo.processInfo.systemUptime
        pacer.requestFrame(.resume, at: now)
        let observer = CFRunLoopObserverCreateWithHandler(nil, CFRunLoopActivity.beforeWaiting.rawValue, true, CFIndex.max) { [weak self] _, _ in
            self?.captureIfDue()
        }
        CFRunLoopAddObserver(CFRunLoopGetMain(), observer, .commonModes)
        runLoopObserver = observer
        let timer = Timer(timeInterval: min(config.frameInterval, 1), repeats: true) { [weak self] _ in self?.tick() }
        RunLoop.main.add(timer, forMode: .common)
        keepAlive = timer
        scheduleWake(now: now)
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

    /// The stream ended on its own (the store refused a chunk, or too many errors): stop looking.
    private func stopIfEnded() -> Bool {
        guard !stream.isActive else { return false }
        if isRecording {
            logger.warn("replay stream ended: capture stops")
            stopCapture()
            stopped = true
            detachTouchObserver()
        }
        return true
    }

    private func fault(_ what: String, _ reason: String?) {
        faults += 1
        logger.warn("\(what) failed: \(reason ?? "unknown")")
        if faults >= Self.faultLimit, !stopped {
            logger.warn("replay disabled after \(faults) faults")
            end(.error)
        }
    }

    private func tick() {
        guard isRecording, !stopIfEnded() else { return }
        if let window = ScreenCapturer.keyWindow() { attachTouchObserverIfNeeded(window) }
        let stream = self.stream
        Self.queue.async { stream.tick(now: Clock.nowMillis()) }
    }

    private func handle(_ touch: Touch) {
        guard isRecording else { return }
        let stream = self.stream
        Self.queue.async { stream.touch(touch) }
    }

    private func captureIfDue() {
        guard isRecording, !stopIfEnded(), let window = ScreenCapturer.keyWindow() else { return }
        let start = ProcessInfo.processInfo.systemUptime
        defer { scheduleWake(now: start) }
        if Self.isTransitioning(window.rootViewController) {
            pacer.motion(now: start)
            return
        }
        guard !captureInFlight, pacer.isDue(now: start) else { return }
        attachTouchObserverIfNeeded(window)
        let ts = Clock.nowMillis()
        let detail = ViewTreeBuilder.Detail(masks: ReplayMaskRegistry.shared.snapshot())
        var walked: ViewTreeBuilder.Walk?
        let walkFault = OuoReplayCatch { walked = ViewTreeBuilder.walk(window, detail: detail) }
        guard let walk = walked, walkFault == nil else {
            // The tree is not known, so neither is what must be masked: no frame (PRV-8).
            pacer.spent(ProcessInfo.processInfo.systemUptime - start, now: start)
            fault("view walk", walkFault)
            return
        }
        guard case .capture(let reason) = pacer.decide(now: start, animations: walk.animations) else {
            pacer.spent(ProcessInfo.processInfo.systemUptime - start, now: start)
            return
        }
        let bounds = window.bounds
        // Masking fails closed before the render: a masked view on a moving layer drops the frame.
        guard let rects = capturer.plan(walk.tree, bounds: bounds) else {
            pacer.spent(ProcessInfo.processInfo.systemUptime - start, now: start)
            pacer.dropped(reason, now: start)
            maskDrops += 1
            logger.log("look \(reason.rawValue) dropped: a masked view is moving (\(maskDrops) so far)")
            return
        }
        var snapshot: ScreenCapturer.Snapshot?
        let renderFault = OuoReplayCatch { snapshot = self.capturer.snapshot(window: window, tree: walk.tree, rects: rects) }
        guard let snap = snapshot, renderFault == nil else {
            pacer.spent(ProcessInfo.processInfo.systemUptime - start, now: start)
            pacer.dropped(reason, now: start)
            if renderFault != nil { fault("render", renderFault) }
            return
        }
        let look = PixelLook(image: snap.image, rects: snap.rects, width: Double(bounds.width), height: Double(bounds.height), scale: Double(snap.scale), reason: reason)
        let mainSeconds = ProcessInfo.processInfo.systemUptime - start
        pacer.spent(mainSeconds, now: start)
        captureInFlight = true
        let stream = self.stream
        let logger = self.logger
        let handedAt = ProcessInfo.processInfo.systemUptime
        Self.queue.async { [weak self] in
            let queuedAt = ProcessInfo.processInfo.systemUptime
            stream.look(look, at: ts)
            // What one look cost: on the main thread (counted against the time bank) and on the queue.
            logger.log(String(format: "look %@: main %.0f ms, waited %.0f ms, encode %.0f ms", reason.rawValue, mainSeconds * 1000, (queuedAt - handedAt) * 1000, (ProcessInfo.processInfo.systemUptime - queuedAt) * 1000))
            DispatchQueue.main.async {
                guard let self else { return }
                self.captureInFlight = false
                self.scheduleWake(now: ProcessInfo.processInfo.systemUptime)
            }
        }
    }

    private func scheduleWake(now: TimeInterval) {
        guard isRecording, let at = pacer.wakeAt(now: now), at > now else { return }
        let fire = Date(timeIntervalSinceNow: at - now)
        if let t = wakeTimer, t.isValid, t.fireDate <= fire, t.fireDate > Date() { return }
        wakeTimer?.invalidate()
        let t = Timer(fire: fire, interval: 0, repeats: false) { _ in }
        RunLoop.main.add(t, forMode: .common)
        wakeTimer = t
    }

    private static func isTransitioning(_ vc: UIViewController?) -> Bool {
        guard let vc else { return false }
        if vc.transitionCoordinator != nil { return true }
        return isTransitioning(vc.presentedViewController) || vc.children.contains { isTransitioning($0) }
    }

    private func attachTouchObserverIfNeeded(_ window: UIWindow) {
        if attachedWindow === window { return }
        detachTouchObserver()
        touchObserver.onTouch = { [weak self] touch in self?.handle(touch) }
        window.addGestureRecognizer(touchObserver)
        attachedWindow = window
    }

    private func detachTouchObserver() {
        attachedWindow?.removeGestureRecognizer(touchObserver)
        attachedWindow = nil
    }
}
#endif
