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
    #if canImport(UIKit)
    private static var tracker: DisplayLinkTracker?
    #endif

    /// Process start (epoch ms), from the kernel; negative when unknown.
    public static var processStartMs: Double { ouo_vitals_process_start_ms() }

    /// Load time of the app image (epoch ms), recorded before `main`.
    public static var loadTimeMs: Double { ouo_vitals_load_time_ms() }

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
                    lock.unlock()
                },
                onInterrupt: {
                    lock.lock()
                    counter.reset()
                    lock.unlock()
                }
            )
            tracker = t
            t.start()
        }
        if Thread.isMainThread { begin() } else { DispatchQueue.main.async(execute: begin) }
        #endif
    }

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
    private let onInterrupt: () -> Void
    private var link: CADisplayLink?
    private var observers: [NSObjectProtocol] = []

    init(onFrame: @escaping (CFTimeInterval, CFTimeInterval) -> Void, onInterrupt: @escaping () -> Void) {
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
            observers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                self?.onInterrupt()
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
#endif
