import Foundation
import OuoVitalsCore
#if canImport(UIKit)
import UIKit
#endif

/// Native measurements for the mobile vitals (checklist G2, docs/specs/mobile-vitals.md): the
/// start of the current launch and cumulative frame counters from a `CADisplayLink`. The host SDK
/// (the React Native Expo module) turns them into `ouo.app.start` and `app.jank` records.
public enum OuoVitals {
    private static let lock = UnfairLock()
    private static var runtimes = 0
    private static var counter = FrameCounter()
    private static var hangs = HangDetector()
    #if canImport(UIKit)
    private static var tracker: DisplayLinkTracker?
    private static var watchdog: HangWatchdog?
    #endif

    /// Process start (epoch ms), from the kernel; negative when unknown.
    public static var processStartMs: Double { ouo_vitals_process_start_ms() }

    /// Load time of the app image (epoch ms), recorded before `main`.
    public static var loadTimeMs: Double { ouo_vitals_load_time_ms() }

    /// True when a debugger is attached to this process (`P_TRACED`, as sentry-cocoa and KSCrash
    /// check): breakpoints stop the main thread, and Xcode's stop button kills the app.
    public static var isDebuggerAttached: Bool {
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()]
        guard sysctl(&mib, 4, &info, &size, nil, 0) == 0 else { return false }
        return info.kp_proc.p_flag & P_TRACED != 0
    }

    /// True when iOS prewarmed this process before the user launched the app (iOS 15+).
    public static var isPrewarmed: Bool { ProcessInfo.processInfo.environment["ActivePrewarm"] == "1" }

    /// Registers a new runtime (a React Native JS runtime) started at `runtimeStartMs` and returns
    /// the start of its launch: cold for the first runtime of the process, warm for later ones
    /// (a JS reload in a live process). Call once per runtime.
    public static func beginRuntime(at runtimeStartMs: Double) -> AppStartInfo? {
        lock.lock()
        runtimes += 1
        let first = runtimes == 1
        lock.unlock()
        return AppStartInfo.resolve(
            firstRuntime: first,
            processStartMs: processStartMs,
            loadTimeMs: loadTimeMs,
            runtimeStartMs: runtimeStartMs,
            prewarmed: isPrewarmed
        )
    }

    /// Starts the display link on the main run loop. Idempotent; callable from any thread.
    public static func startFrameTracking() {
        #if canImport(UIKit)
        let begin = {
            guard tracker == nil else { return }
            let t = DisplayLinkTracker(
                onFrame: { timestamp, target in
                    lock.lock()
                    counter.frame(timestamp: timestamp, targetTimestamp: target)
                    hangs.frame(timestamp: timestamp, targetTimestamp: target)
                    lock.unlock()
                },
                onInterrupt: { active in
                    lock.lock()
                    counter.reset()
                    let ended = hangs.interrupt(now: CACurrentMediaTime())
                    let w = watchdog
                    lock.unlock()
                    w?.active = active
                    if let ended { w?.onEnd(ended) }
                }
            )
            tracker = t
            t.start()
        }
        if Thread.isMainThread { begin() } else { DispatchQueue.main.async(execute: begin) }
        #endif
    }

    /// Starts the app hang watchdog (mobile SDK spec C3.1, rules in `HangDetector`): a thread that
    /// wakes every 400 ms while the app is active and no debugger is attached. `onStart` runs on
    /// that thread when a hang is detected, while the main thread is still blocked (the moment to
    /// read its stack); `onEnd` runs once when it is over, with its start in epoch ms. Also starts
    /// the frame tracking. Idempotent; no-op without UIKit.
    public static func startHangTracking(onStart: @escaping () -> Void, onEnd: @escaping (_ hang: Hang, _ startMs: Double) -> Void) {
        #if canImport(UIKit)
        lock.lock()
        let started = watchdog != nil
        if !started {
            let w = HangWatchdog(interval: hangs.tickInterval, onStart: onStart, onEnd: { onEnd($0, epochMs($0.start)) }) { now in
                lock.lock()
                defer { lock.unlock() }
                return hangs.tick(now: now)
            }
            watchdog = w
            w.start()
        }
        lock.unlock()
        guard !started else { return }
        startFrameTracking()
        DispatchQueue.main.async {
            lock.lock()
            let w = watchdog
            lock.unlock()
            w?.active = UIApplication.shared.applicationState == .active
        }
        #endif
    }

    #if canImport(UIKit)
    /// Epoch ms of a display link timestamp (`CACurrentMediaTime` clock).
    static func epochMs(_ t: CFTimeInterval) -> Double {
        (Date().timeIntervalSince1970 - (CACurrentMediaTime() - t)) * 1000
    }
    #endif

    /// Cumulative counters since `startFrameTracking()`; nil when frames are not tracked (no UIKit).
    public static func frameStats() -> FrameStats? {
        #if canImport(UIKit)
        lock.lock()
        defer { lock.unlock() }
        return counter.stats
        #else
        return nil
        #endif
    }
}

/// os_unfair_lock on a stable heap address (a lock stored inline in a Swift var may move).
final class UnfairLock {
    private let pointer: UnsafeMutablePointer<os_unfair_lock>

    init() {
        pointer = .allocate(capacity: 1)
        pointer.initialize(to: os_unfair_lock())
    }

    deinit {
        pointer.deinitialize(count: 1)
        pointer.deallocate()
    }

    func lock() { os_unfair_lock_lock(pointer) }
    func unlock() { os_unfair_lock_unlock(pointer) }
}

#if canImport(UIKit)
/// The `CADisplayLink`: one callback per frame on the main thread, which only reads two
/// timestamps and updates the counters under an uncontended lock. The link keeps its target
/// alive, so it points at a weak proxy.
final class DisplayLinkTracker {
    private let onFrame: (CFTimeInterval, CFTimeInterval) -> Void
    /// The app became active (true) or stopped being active (false).
    private let onInterrupt: (Bool) -> Void
    private var link: CADisplayLink?
    private var observers: [NSObjectProtocol] = []

    init(onFrame: @escaping (CFTimeInterval, CFTimeInterval) -> Void, onInterrupt: @escaping (Bool) -> Void) {
        self.onFrame = onFrame
        self.onInterrupt = onInterrupt
    }

    func start() {
        let link = CADisplayLink(target: Proxy(self), selector: #selector(Proxy.tick(_:)))
        link.add(to: .main, forMode: .common)
        self.link = link
        // No callbacks while inactive or in the background: restart the interval on both edges
        // so that time is not counted as a frozen frame.
        let center = NotificationCenter.default
        for name in [UIApplication.willResignActiveNotification, UIApplication.didBecomeActiveNotification] {
            let active = name == UIApplication.didBecomeActiveNotification
            observers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                self?.onInterrupt(active)
            })
        }
    }

    deinit {
        link?.invalidate()
        observers.forEach(NotificationCenter.default.removeObserver)
    }

    fileprivate func tick(_ link: CADisplayLink) {
        onFrame(link.timestamp, link.targetTimestamp)
    }

    private final class Proxy: NSObject {
        weak var owner: DisplayLinkTracker?
        init(_ owner: DisplayLinkTracker) { self.owner = owner }
        @objc func tick(_ link: CADisplayLink) { owner?.tick(link) }
    }
}

/// The app hang watchdog thread (sentry-cocoa runs the same loop on its own thread). It only reads
/// a clock and the detector under the vitals lock; it calls back when a hang starts and ends.
final class HangWatchdog: Thread {
    private let interval: CFTimeInterval
    private let onStart: () -> Void
    let onEnd: (Hang) -> Void
    private let tick: (CFTimeInterval) -> HangDetector.Tick?
    private let state = UnfairLock()
    private var isActive = false

    /// Ticks are skipped while the app is not active (a hang then is not one the user waits on).
    var active: Bool {
        get { state.lock(); defer { state.unlock() }; return isActive }
        set { state.lock(); isActive = newValue; state.unlock() }
    }

    init(interval: CFTimeInterval, onStart: @escaping () -> Void, onEnd: @escaping (Hang) -> Void, tick: @escaping (CFTimeInterval) -> HangDetector.Tick?) {
        self.interval = interval
        self.onStart = onStart
        self.onEnd = onEnd
        self.tick = tick
        super.init()
        name = "ouo.hang-watchdog"
        qualityOfService = .userInteractive
    }

    override func main() {
        while !isCancelled {
            Thread.sleep(forTimeInterval: interval)
            // A debugger stops the main thread at breakpoints: those are not hangs.
            guard active, !OuoVitals.isDebuggerAttached else { continue }
            switch tick(CACurrentMediaTime()) {
            case .started: onStart()
            case .ended(let hang): onEnd(hang)
            case nil: break
            }
        }
    }
}

#endif
