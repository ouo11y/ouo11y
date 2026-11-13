// The ouo driver of the vendored sentry-cocoa recorder core: it replaces `SentrySessionReplay`
// (Sources/Swift/Integrations/SessionReplay/SentrySessionReplay.swift), which also owns the
// Sentry hub, replay ids, envelopes, breadcrumbs and error buffering. Kept from it, adapted:
// the capture pacing of `captureFrameIfNeeded` (1 frame/s, adaptive backoff when a capture is
// slow, deferral while animations run, the base rate while the user interacts) and the
// full-session segment cut (`prepareFullSessionSegmentsIfNeeded`, 5 s windows). Cut: everything
// that talks to Sentry. The segments go out through `OuoSegmentRecorder.onSegment`.
//
// Portions adapted from sentry-cocoa 9.33.0, SentrySessionReplay.swift and
// SentrySessionReplayIntegration.swift. Copyright (c) 2015 Sentry. MIT License, see
// sdk/ios/THIRD_PARTY_NOTICES.

import Foundation

#if canImport(UIKit) && (os(iOS) || os(tvOS) || os(visionOS))
import UIKit

/// What ouo's masking says about one capture (main thread), answered by the plan the frames
/// recorder uses (`ViewTreeBuilder` + `RedactionPlanner`, strict rules, `ReplayMaskRegistry`).
public enum OuoMaskPlan: Equatable {
    /// Paint these rectangles (window points) black, then the frame may be encoded.
    case mask([CGRect])
    /// Not now (a view controller transition runs, or animations are about to settle): look again
    /// shortly. No frame is taken.
    case wait
    /// The masked state cannot be established (a masked view is moving, the walk failed): no
    /// frame (PRV-8).
    case drop
}

public final class SentryCoreRecorder: OuoSegmentRecorder {
    public struct Options {
        public var maskAllText: Bool
        public var maskAllImages: Bool
        public var maskedViewClasses: [AnyClass]
        public var unmaskedViewClasses: [AnyClass]
        /// Frames per second; Sentry's default and minimum is 1.
        public var frameRate: Int
        /// Length of one segment; Sentry's `sessionSegmentDuration`, 5 s.
        public var segmentDuration: TimeInterval
        /// H.264 average bit rate; Sentry's quality `medium`, 40 000.
        public var bitRate: Int
        /// Video scale; Sentry's quality `medium`, 1.0 (frames are rendered at 1x point size).
        public var sizeScale: Float
        public var enableViewRendererV2: Bool
        public var enableFastViewRendering: Bool
        /// Where frames (PNG, for the encoder) and the mp4 files are written while a segment is open.
        public var directory: URL
        /// ouo's masking. Set: Sentry's redaction walk (`SentryUIRedactBuilder`, presentation
        /// layers) is not used; every capture asks this first, renders only on `.mask`, and paints
        /// the rectangles black off the main thread, so masking is the frames recorder's exactly.
        /// Nil: the spike's behaviour, Sentry's own masking.
        public var plan: ((UIView) -> OuoMaskPlan)?

        public init(
            maskAllText: Bool = true,
            maskAllImages: Bool = true,
            maskedViewClasses: [AnyClass] = [],
            unmaskedViewClasses: [AnyClass] = [],
            frameRate: Int = 1,
            segmentDuration: TimeInterval = 5,
            bitRate: Int = 40_000,
            sizeScale: Float = 1,
            enableViewRendererV2: Bool = true,
            enableFastViewRendering: Bool = false,
            directory: URL = SentryCoreRecorder.defaultDirectory,
            plan: ((UIView) -> OuoMaskPlan)? = nil
        ) {
            self.maskAllText = maskAllText
            self.maskAllImages = maskAllImages
            self.maskedViewClasses = maskedViewClasses
            self.unmaskedViewClasses = unmaskedViewClasses
            self.frameRate = max(1, frameRate)
            self.segmentDuration = segmentDuration
            self.bitRate = bitRate
            self.sizeScale = sizeScale
            self.enableViewRendererV2 = enableViewRendererV2
            self.enableFastViewRendering = enableFastViewRendering
            self.directory = directory
            self.plan = plan
        }
    }

    public static var defaultDirectory: URL {
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        return caches.appendingPathComponent("ouo/replay/sentry-core", isDirectory: true)
    }

    /// `ouo.replay.format` of what this recorder produces: H.264 mp4 segments (`ouo-video/1` on the
    /// OTLP path; the spike's legacy chunk carries the same name).
    public static let formatName = "ouo-video/1"
    public var format: String { Self.formatName }
    public var onSegment: ((OuoReplaySegment) -> Void)?
    public var onCapture: ((OuoCaptureTiming) -> Void)?
    /// A capture the plan refused with `.drop` (main thread).
    public var onDrop: (() -> Void)?

    private let options: Options
    private let redactOptions: SentryRedactDefaultOptions
    private let photographer: SentryViewPhotographer
    private let renderer: SentryViewRenderer
    private let maskQueue = SentryDispatchQueueWrapper(utility: "dev.ouo.replay.sentry-core.mask", relativePriority: 0)
    private let replayMaker: SentryOnDemandReplay
    private let scheduler = DefaultSentrySessionReplayRunLoopCaptureScheduler<CFRunLoopObserver>()
    private let framesDirectory: URL

    // Main thread from here on (upstream: the main-thread confined pacing state and the
    // segment state it guards with its lock).
    private var running = false
    private var token: NSObject?
    private var processingScreenshot = false
    private var lastScreenshotAt: Date?
    private var nextScreenshotAt: Date?
    private var nextCaptureActivityCheckAt: Date?
    private var adaptiveScreenshotInterval: TimeInterval = 0
    private var deferredScreenshotStart: Date?
    private var segmentStart: Date?
    private var segmentPending = false
    private var pendingFlushes: [(Date, (() -> Void)?)] = []

    public init(options: Options = Options()) {
        self.options = options
        let redact = SentryRedactDefaultOptions()
        redact.maskAllText = options.maskAllText
        redact.maskAllImages = options.maskAllImages
        redact.maskedViewClasses = options.maskedViewClasses
        redact.unmaskedViewClasses = options.unmaskedViewClasses
        redactOptions = redact
        let renderer: SentryViewRenderer = options.enableViewRendererV2
            ? SentryViewRendererV2(enableFastViewRendering: options.enableFastViewRendering)
            : SentryDefaultViewRenderer()
        self.renderer = renderer
        photographer = SentryViewPhotographer(renderer: renderer, redactOptions: redact, enableMaskRendererV2: options.enableViewRendererV2)
        // The asset worker must have a higher priority than the processing queue, which waits on
        // it (upstream createDispatchQueues).
        let assetWorker = SentryDispatchQueueWrapper(utility: "dev.ouo.replay.sentry-core.asset-worker", relativePriority: -1)
        let processing = SentryDispatchQueueWrapper(utility: "dev.ouo.replay.sentry-core.processing", relativePriority: -2)
        framesDirectory = options.directory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try? FileManager.default.createDirectory(at: framesDirectory, withIntermediateDirectories: true)
        let maker = SentryOnDemandReplay(outputPath: framesDirectory.path, processingQueue: processing, assetWorkerQueue: assetWorker)
        maker.bitRate = options.bitRate
        maker.videoScale = options.sizeScale
        maker.frameRate = options.frameRate
        maker.cacheMaxSize = UInt(Int(options.segmentDuration) * options.frameRate + 1)
        replayMaker = maker
    }

    deinit {
        try? FileManager.default.removeItem(at: framesDirectory)
    }

    // MARK: lifecycle

    public func start() {
        guard !running else { return }
        running = true
        let now = Date()
        segmentStart = now
        resetCapturePacing(at: now, immediate: true)
        let token = NSObject()
        self.token = token
        scheduler.start(token: token) { [weak self] isInteractive in
            self?.captureFrameIfNeeded(isInteractiveRunLoopMode: isInteractive)
        }
    }

    public func pause() {
        guard running else { return }
        stopScheduler()
        flush(completion: nil)
    }

    public func resume() {
        guard !running else { return }
        start()
    }

    public func stop() {
        stopScheduler()
        flush(completion: nil)
    }

    public func flush(completion: (() -> Void)?) {
        let now = Date()
        if segmentPending {
            pendingFlushes.append((now, completion))
            return
        }
        guard let start = segmentStart, now > start else {
            completion?()
            return
        }
        makeSegment(from: start, until: now) { completion?() }
    }

    private func stopScheduler() {
        running = false
        if let token { scheduler.stop(token: token) }
        token = nil
        nextCaptureActivityCheckAt = nil
    }

    // MARK: capture pacing (upstream captureFrameIfNeeded and helpers)

    private var baseScreenshotInterval: TimeInterval { 1.0 / Double(options.frameRate) }

    private enum CapturePacing {
        static let captureDeferralInterval: TimeInterval = 0.25
        static let slowCaptureThreshold: TimeInterval = 0.15
        static let maximumAdaptiveCaptureInterval: TimeInterval = 2
        static let maximumAnimationCaptureDeferralInterval: TimeInterval = 1
        static let screenshotIntervalTolerance: TimeInterval = 0.001
    }

    private enum DeferralDecision { case none, `defer`, captureAfterDeferral }

    private func captureFrameIfNeeded(isInteractiveRunLoopMode: Bool) {
        guard running else { return }
        let now = Date()
        guard !processingScreenshot else {
            cutSegmentIfDue(now)
            return
        }
        guard shouldCheckCaptureActivity(at: now, isInteractiveRunLoopMode: isInteractiveRunLoopMode),
              let rootView = Self.keyWindow() else {
            cutSegmentIfDue(now)
            return
        }
        let activity = isInteractiveRunLoopMode
            ? nil
            : SentrySessionReplayCaptureGuard.captureActivityReason(rootView: rootView, options: redactOptions)
        let isInteraction = isInteractiveRunLoopMode || activity == .interaction
        guard shouldCaptureScreenshot(at: now, usesAdaptiveBackoff: !isInteraction) else {
            let check = nextScreenshotAt.map { max(0, min(baseScreenshotInterval, $0.timeIntervalSince(now))) } ?? baseScreenshotInterval
            nextCaptureActivityCheckAt = now.addingTimeInterval(check)
            cutSegmentIfDue(now)
            return
        }
        let deferral = deferralDecision(activity: isInteraction ? nil : activity, at: now)
        if deferral == .defer {
            scheduleNextScreenshot(after: CapturePacing.captureDeferralInterval, from: now)
            cutSegmentIfDue(now)
            return
        }

        if let plan = options.plan {
            captureWithOuoMasking(rootView, plan: plan, at: now, deferral: deferral, isInteraction: isInteraction)
            return
        }
        processingScreenshot = true
        photographer.timedImage(view: rootView) { [weak self, replayMaker] image, metadata in
            replayMaker.addFrameAsync(timestamp: now, maskedViewImage: image, forScreen: nil)
            self?.onCapture?(OuoCaptureTiming(mainThread: metadata.mainThreadDuration, background: metadata.maskDuration))
            DispatchQueue.main.async {
                self?.captureFinished(mainThread: metadata.mainThreadDuration, deferral: deferral, isInteraction: isInteraction)
            }
        }
    }

    /// ouo's masking: plan, then render, on the main thread back to back (the same pass sees the
    /// same committed tree); paint and encode off it. A refused plan takes no frame and looks again
    /// after the deferral interval.
    private func captureWithOuoMasking(_ rootView: UIView, plan: (UIView) -> OuoMaskPlan, at now: Date, deferral: DeferralDecision, isInteraction: Bool) {
        let t0 = ProcessInfo.processInfo.systemUptime
        let decision = plan(rootView)
        guard case .mask(let rects) = decision else {
            if decision == .drop { onDrop?() }
            onCapture?(OuoCaptureTiming(mainThread: ProcessInfo.processInfo.systemUptime - t0, background: 0))
            scheduleNextScreenshot(after: CapturePacing.captureDeferralInterval, from: Date())
            cutSegmentIfDue(now)
            return
        }
        let size = rootView.bounds.size
        let image = renderer.render(view: rootView)
        let mainThread = ProcessInfo.processInfo.systemUptime - t0
        processingScreenshot = true
        maskQueue.dispatchAsync { [weak self, replayMaker] in
            let b0 = ProcessInfo.processInfo.systemUptime
            let masked = Self.paint(image, size: size, rects: rects)
            replayMaker.addFrameAsync(timestamp: now, maskedViewImage: masked, forScreen: nil)
            self?.onCapture?(OuoCaptureTiming(mainThread: mainThread, background: ProcessInfo.processInfo.systemUptime - b0))
            DispatchQueue.main.async {
                self?.captureFinished(mainThread: mainThread, deferral: deferral, isInteraction: isInteraction)
            }
        }
    }

    /// The frame at 1x (one pixel per point, what the video is encoded at) with `rects` filled
    /// black: the frames recorder's mask, so both pixel recorders look the same where they mask.
    static func paint(_ image: UIImage, size: CGSize, rects: [CGRect]) -> UIImage {
        SentryGraphicsImageRenderer(size: size, scale: 1).image { context in
            image.draw(in: CGRect(origin: .zero, size: size))
            context.cgContext.setFillColor(UIColor.black.cgColor)
            context.cgContext.fill(rects)
        }
    }

    private func captureFinished(mainThread: TimeInterval, deferral: DeferralDecision, isInteraction: Bool) {
        processingScreenshot = false
        if deferral == .captureAfterDeferral {
            adaptiveScreenshotInterval = 0
        } else if !isInteraction {
            updateAdaptiveScreenshotInterval(mainThread)
        }
        let finishedAt = Date()
        lastScreenshotAt = finishedAt
        scheduleNextScreenshot(after: screenshotInterval(usesAdaptiveBackoff: !isInteraction), from: finishedAt)
        if running { cutSegmentIfDue(finishedAt) }
    }

    /// `immediate`: the first frame is due now (ouo: a start or resume opens with a frame).
    private func resetCapturePacing(at date: Date, immediate: Bool) {
        lastScreenshotAt = immediate ? nil : date
        adaptiveScreenshotInterval = 0
        deferredScreenshotStart = nil
        scheduleNextScreenshot(after: immediate ? 0 : screenshotInterval(), from: date)
    }

    private func screenshotInterval(usesAdaptiveBackoff: Bool = true) -> TimeInterval {
        usesAdaptiveBackoff ? max(baseScreenshotInterval, adaptiveScreenshotInterval) : baseScreenshotInterval
    }

    private func shouldCaptureScreenshot(at date: Date, usesAdaptiveBackoff: Bool = true) -> Bool {
        if !usesAdaptiveBackoff, let last = lastScreenshotAt {
            return isDeadlineReached(last.addingTimeInterval(baseScreenshotInterval), at: date)
        }
        guard let next = nextScreenshotAt else { return true }
        return isDeadlineReached(next, at: date)
    }

    private func isDeadlineReached(_ deadline: Date, at date: Date) -> Bool {
        date.timeIntervalSince(deadline) >= -CapturePacing.screenshotIntervalTolerance
    }

    private func scheduleNextScreenshot(after interval: TimeInterval, from date: Date) {
        nextScreenshotAt = date.addingTimeInterval(interval)
        nextCaptureActivityCheckAt = date.addingTimeInterval(min(interval, baseScreenshotInterval))
    }

    private func shouldCheckCaptureActivity(at date: Date, isInteractiveRunLoopMode: Bool) -> Bool {
        if isInteractiveRunLoopMode { return shouldCaptureScreenshot(at: date, usesAdaptiveBackoff: false) }
        if shouldCaptureScreenshot(at: date) { return true }
        guard let check = nextCaptureActivityCheckAt else { return true }
        return isDeadlineReached(check, at: date)
    }

    private func deferralDecision(activity: SentrySessionReplayCaptureGuard.CaptureActivityReason?, at date: Date) -> DeferralDecision {
        guard activity == .animation else {
            deferredScreenshotStart = nil
            return .none
        }
        guard let started = deferredScreenshotStart else {
            deferredScreenshotStart = date
            return .defer
        }
        guard date.timeIntervalSince(started) >= CapturePacing.maximumAnimationCaptureDeferralInterval else { return .defer }
        deferredScreenshotStart = nil
        return .captureAfterDeferral
    }

    private func updateAdaptiveScreenshotInterval(_ duration: TimeInterval) {
        guard duration > 0 else { return }
        guard duration >= CapturePacing.slowCaptureThreshold else {
            guard adaptiveScreenshotInterval > 0 else { return }
            let next = adaptiveScreenshotInterval / 2
            adaptiveScreenshotInterval = next <= baseScreenshotInterval ? 0 : next
            return
        }
        let next = adaptiveScreenshotInterval > 0 ? adaptiveScreenshotInterval * 2 : baseScreenshotInterval * 2
        adaptiveScreenshotInterval = min(next, CapturePacing.maximumAdaptiveCaptureInterval)
    }

    // MARK: segments (upstream prepareFullSessionSegmentsIfNeeded / createAndCaptureInBackground)

    private func cutSegmentIfDue(_ date: Date) {
        guard !segmentPending, let start = segmentStart, date.timeIntervalSince(start) >= options.segmentDuration else { return }
        makeSegment(from: start, until: start.addingTimeInterval(options.segmentDuration), completion: nil)
    }

    /// Encodes [start, end) on the processing queue, hands every video to `onSegment` there, then
    /// (main thread) advances the segment start and runs flushes that waited.
    private func makeSegment(from start: Date, until end: Date, completion: (() -> Void)?) {
        segmentPending = true
        replayMaker.createVideoInBackgroundWith(beginning: start, end: end) { [weak self, replayMaker] videos in
            var last = end
            for video in videos {
                if let mp4 = try? Data(contentsOf: video.path) {
                    self?.onSegment?(OuoReplaySegment(
                        mp4: mp4, start: video.start, end: video.end,
                        width: video.width, height: video.height,
                        frameCount: video.frameCount, frameRate: video.frameRate))
                } else {
                    SentrySDKLog.error("[ouo] could not read segment \(video.path.lastPathComponent)")
                }
                try? FileManager.default.removeItem(at: video.path)
                replayMaker.releaseFramesUntil(video.end)
                last = max(last, video.end)
            }
            if videos.isEmpty { replayMaker.releaseFramesUntil(end) }
            DispatchQueue.main.async {
                guard let self else { completion?(); return }
                self.segmentPending = false
                // Never move the start backwards (upstream advanceSegmentStart). Without a video
                // (no frame yet) the window is skipped, so it is not re-encoded on every pass.
                self.segmentStart = max(self.segmentStart ?? last, last)
                if !self.running && self.pendingFlushes.isEmpty { self.segmentStart = nil }
                completion?()
                if !self.pendingFlushes.isEmpty {
                    let (at, done) = self.pendingFlushes.removeFirst()
                    if let s = self.segmentStart, at > s {
                        self.makeSegment(from: s, until: at, completion: done)
                    } else {
                        done?()
                    }
                }
            }
        }
    }

    static func keyWindow() -> UIWindow? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let active = scenes.filter { $0.activationState == .foregroundActive }
        for scene in active + scenes {
            if let w = scene.windows.first(where: { $0.isKeyWindow }) { return w }
        }
        return scenes.first?.windows.first
    }
}
#endif
