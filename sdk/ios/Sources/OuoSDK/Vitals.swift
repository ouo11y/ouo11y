import Foundation
import OuoVitals

/// Mobile vitals in the records of docs/specs/mobile-vitals.md, the rules of the React Native SDK's
/// `vitals.ts` without its JavaScript stall loop (a native app has none; main-thread hangs are C3):
///
/// - `ouo.app.start`: from the process start (the image load when iOS prewarmed it) to the first
///   frame drawn after launch, once the session exists; only for a launch in the foreground;
/// - `ouo.screen.display`: per screen, TTID from the screen change (the process start for the
///   first screen) to the next frame, and TTFD to the frame after `reportFullyDisplayed()`, held
///   until the screen is left, the app goes to the background or 30 s passed;
/// - `app.jank`: the display link's frame counters per window: `app_start` until the first screen,
///   then one per screen visit, cut at the background.
///
/// Not thread-safe: the owner serialises calls, including the frame and timer callbacks it injects.
final class Vitals {
    struct Deps {
        var now: () -> Double
        /// Cumulative counters (`OuoVitals.frameStats()`); nil without frames.
        var frameStats: () -> FrameStats?
        /// Calls back with the epoch ms of the next frame drawn.
        var nextFrame: (@escaping (Double) -> Void) -> Void
        /// Runs the block after `ms`; returns a cancel.
        var after: (Double, @escaping () -> Void) -> () -> Void
        var emit: (String, Attributes, Double) -> Void
        var log: (String) -> Void
    }

    /// How long a screen's record waits for `reportFullyDisplayed` (Sentry's TTFD deadline).
    static let ttfdTimeoutMs: Double = 30_000
    /// Spec rule 2: durations above one hour are clock jumps.
    static let maxDurationMs: Double = 3_600_000

    private struct Window {
        var start: Double
        var kind: String
        var screen: String?
        var frames: FrameStats?
    }

    private final class Display {
        let screen: String
        let startAt: Double?
        let measured: Bool
        var ttidAt: Double?
        var fullAt: Double?
        var fullRequested = false
        var cancelTimer: (() -> Void)?
        init(screen: String, startAt: Double?, measured: Bool) {
            self.screen = screen
            self.startAt = startAt
            self.measured = measured
        }
    }

    private let deps: Deps
    private let appStart: AppStartInfo?
    private let launchedInForeground: Bool
    private var ready = false
    private var firstFrameAt: Double?
    private var appStartDone: Bool
    private var firstScreen: String?
    private var lastScreen: String?
    private var window: Window?
    private var display: Display?

    init(deps: Deps, appStart: AppStartInfo?, launchedInForeground: Bool) {
        self.deps = deps
        self.appStart = appStart
        self.launchedInForeground = launchedInForeground
        self.appStartDone = appStart == nil || !launchedInForeground
        self.window = openWindow(kind: "app_start", screen: nil)
    }

    /// The session exists: `ouo.app.start` may be emitted now.
    func sessionReady() {
        ready = true
        maybeAppStart()
    }

    /// The first frame after launch was drawn at `at` (epoch ms).
    func firstFrame(_ at: Double) {
        guard firstFrameAt == nil else { return }
        firstFrameAt = at
        maybeAppStart()
    }

    /// A screen is showing; the same screen again changes nothing.
    func navigated(_ screen: String) {
        guard !screen.isEmpty, screen != lastScreen else { return }
        let isFirst = lastScreen == nil
        lastScreen = screen
        if isFirst { firstScreen = screen }
        emitDisplay(display)
        // First screen: from the process start (mobile-vitals.md section 5); later ones: from the change.
        let d = Display(screen: screen, startAt: isFirst ? appStart?.startMs : deps.now(), measured: !isFirst || launchedInForeground)
        display = d
        deps.nextFrame { [weak self, d] at in
            guard let self else { return }
            self.firstFrame(at)
            guard self.display === d else { return }
            d.ttidAt = at
            if d.fullAt != nil {
                self.emitDisplay(d)
            } else if !d.fullRequested {
                d.cancelTimer = self.deps.after(Self.ttfdTimeoutMs) { [weak self] in self?.emitDisplay(d) }
            }
        }
        closeWindow()
        window = openWindow(kind: "screen", screen: screen)
    }

    /// TTFD: the current screen's content is on screen.
    func fullyDisplayed() {
        guard let d = display, !d.fullRequested else {
            deps.log(display != nil ? "reportFullyDisplayed already called for this screen"
                     : lastScreen == nil ? "reportFullyDisplayed before the first screen, ignored"
                     : "reportFullyDisplayed for \(lastScreen!) after its display record was sent (the 30 s deadline or the background), ignored")
            return
        }
        d.fullRequested = true
        d.cancelTimer?()
        deps.nextFrame { [weak self, d] at in
            d.fullAt = at
            if d.ttidAt != nil { self?.emitDisplay(d) }
        }
    }

    func background() {
        emitDisplay(display)
        closeWindow()
    }

    func foreground() {
        if window == nil { window = openWindow(kind: "screen", screen: lastScreen) }
    }

    // MARK: - internals

    private func maybeAppStart() {
        guard !appStartDone, ready, let at = firstFrameAt, let start = appStart else { return }
        appStartDone = true
        let duration = at - start.startMs
        guard valid(duration) else { return }
        var a: Attributes = ["ouo.app.start.type": .string(start.type.rawValue), "ouo.app.start.duration_ms": .double(ms(duration))]
        if let s = firstScreen { a["app.screen.name"] = .string(s) }
        emit("ouo.app.start", a, at)
    }

    private func emitDisplay(_ d: Display?) {
        guard let d, d === display else { return }
        display = nil
        d.cancelTimer?()
        guard d.measured, let start = d.startAt, let ttidAt = d.ttidAt else { return }
        let ttid = ttidAt - start
        guard valid(ttid) else { return }
        var a: Attributes = ["app.screen.name": .string(d.screen), "ouo.screen.ttid_ms": .double(ms(ttid))]
        // Full display is never before the initial display (Sentry's rule).
        if let full = d.fullAt, valid(max(full, ttidAt) - start) { a["ouo.screen.ttfd_ms"] = .double(ms(max(full, ttidAt) - start)) }
        emit("ouo.screen.display", a, ttidAt)
    }

    private func openWindow(kind: String, screen: String?) -> Window {
        Window(start: deps.now(), kind: kind, screen: screen, frames: deps.frameStats())
    }

    private func closeWindow() {
        guard let w = window else { return }
        window = nil
        let end = deps.now()
        let period = end - w.start
        guard valid(period), period > 0, let before = w.frames, let f = deps.frameStats() else { return }
        let total = f.total - before.total, slow = f.slow - before.slow, frozen = f.frozen - before.frozen
        guard total > 0, slow >= 0, frozen >= 0 else { return }
        var a: Attributes = [
            "ouo.vital.window": .string(w.kind),
            "app.jank.frame_count": .int(Int64(slow + frozen)),
            "app.jank.period": .double(ms(period) / 1000),
            "ouo.frames.total": .int(Int64(total)),
            "ouo.frames.slow": .int(Int64(slow)),
            "ouo.frames.frozen": .int(Int64(frozen)),
        ]
        if let s = w.screen { a["app.screen.name"] = .string(s) }
        if f.expectedFrameMs > 0 { a["app.jank.threshold"] = .double(f.expectedFrameMs / 1000) }
        if f.delayMs >= before.delayMs { a["ouo.frames.delay_ms"] = .double(ms(f.delayMs - before.delayMs)) }
        emit("app.jank", a, end)
    }

    private func emit(_ name: String, _ a: Attributes, _ at: Double) {
        var attrs = a
        attrs["ouo.vital.source"] = "ouo"
        deps.emit(name, attrs, at)
    }

    private func valid(_ v: Double) -> Bool { v.isFinite && v >= 0 && v <= Self.maxDurationMs }
    private func ms(_ v: Double) -> Double { (v * 1000).rounded() / 1000 }
}
