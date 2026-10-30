import Foundation
import OuoVitals
#if canImport(UIKit)
import UIKit
#endif

/// Keeps this run's `run.json` current: the app state, the session, a memory warning, a hang in
/// progress, and a heartbeat every 5 s while active (the time the run was last known alive). All
/// writes happen on one utility queue, each a small atomic file write.
final class RunTracker {
    static let heartbeatSeconds: TimeInterval = 5

    /// The tracker `exit()` marks as terminated (an `atexit` handler: app code that exits, as
    /// react-native-restart or a forced update does, sends no `willTerminate`).
    private static let currentLock = NSLock()
    private static var current: RunTracker?
    private static var atexitRegistered = false

    private let url: URL
    private let queue = DispatchQueue(label: "ouo.run-state", qos: .utility)
    private var state = RunState.current()
    private var timer: DispatchSourceTimer?
    private var observers: [NSObjectProtocol] = []

    init(url: URL) {
        self.url = url
    }

    func start() {
        Self.currentLock.withLock {
            Self.current = self
            if !Self.atexitRegistered {
                Self.atexitRegistered = true
                atexit { RunTracker.currentLock.withLock { RunTracker.current }?.update(sync: true) { $0.terminated = true } }
            }
        }
        update { _ in }
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now() + Self.heartbeatSeconds, repeating: Self.heartbeatSeconds, leeway: .seconds(1))
        t.setEventHandler { [weak self] in
            guard let self, self.state.active else { return }
            self.state.aliveMs = nowMs()
            self.write()
        }
        t.resume()
        timer = t
        #if canImport(UIKit)
        DispatchQueue.main.async {
            let active = UIApplication.shared.applicationState == .active
            self.update { $0.active = active }
        }
        let center = NotificationCenter.default
        let on: (Notification.Name, Bool, @escaping (inout RunState) -> Void) -> Void = { name, sync, change in
            self.observers.append(center.addObserver(forName: name, object: nil, queue: nil) { [weak self] _ in
                self?.update(sync: sync, change)
            })
        }
        on(UIApplication.didBecomeActiveNotification, false) { $0.active = true }
        on(UIApplication.willResignActiveNotification, false) { $0.active = false }
        // The process exits right after: written before the notification returns.
        on(UIApplication.willTerminateNotification, true) { $0.terminated = true }
        on(UIApplication.didReceiveMemoryWarningNotification, false) { $0.memoryWarningMs = nowMs() }
        #endif
    }

    /// Stops tracking and removes the file: a run that turned tracking off is not judged.
    func stop() {
        Self.currentLock.withLock { if Self.current === self { Self.current = nil } }
        timer?.cancel()
        observers.forEach(NotificationCenter.default.removeObserver)
        observers = []
        queue.sync { try? FileManager.default.removeItem(at: url) }
    }

    func update(sync: Bool = false, _ change: @escaping (inout RunState) -> Void) {
        let apply = {
            change(&self.state)
            self.state.aliveMs = nowMs()
            self.write()
        }
        if sync { queue.sync(execute: apply) } else { queue.async(execute: apply) }
    }

    private func write() {
        state.debugger = OuoVitals.isDebuggerAttached
        state.write(url)
    }
}

func nowMs() -> Double { Date().timeIntervalSince1970 * 1000 }
