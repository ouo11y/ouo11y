import Foundation
import OuoReplayCore

/// Public entry point. All calls are main-thread safe to make from anywhere; the work happens
/// on the main thread because UIKit snapshots require it.
public enum OuoReplay {
    #if canImport(UIKit)
    private static var recorder: ReplayRecorder?

    /// Starts capturing. Calling it again replaces the previous configuration.
    public static func start(_ config: OuoReplayConfig) {
        onMain {
            recorder?.stop()
            let r = ReplayRecorder(config: config)
            recorder = r
            r.start()
        }
    }

    /// Stops the timer and flushes. Frames are not captured until `resume()`.
    public static func pause() {
        onMain { recorder?.pause() }
    }

    /// Resumes with an immediate frame.
    public static func resume() {
        onMain { recorder?.resume() }
    }

    public static var isRecording: Bool {
        if Thread.isMainThread { return recorder?.isRecording ?? false }
        return DispatchQueue.main.sync { recorder?.isRecording ?? false }
    }

    /// Flushes the open chunk and drains the upload queue; `completion` runs when done.
    public static func flush(completion: (() -> Void)? = nil) {
        onMain {
            guard let r = recorder else { completion?(); return }
            r.flush(completion: completion)
        }
    }

    /// The session rotated: flushes the old session's chunk, restarts seq at 0 for `newId`.
    public static func sessionDidRotate(newId: String) {
        onMain { recorder?.sessionDidRotate(newId: newId) }
    }

    /// Stops everything and releases the window observers.
    public static func stop() {
        onMain {
            recorder?.stop()
            recorder = nil
        }
    }

    private static func onMain(_ block: @escaping () -> Void) {
        if Thread.isMainThread { block() } else { DispatchQueue.main.async(execute: block) }
    }
    #else
    // macOS / Linux: the capture needs UIKit. The API exists so hosts and `swift build` compile.
    private static var warned = false
    private static func warnOnce() {
        if !warned {
            warned = true
            print("[ouo replay] iOS only: OuoReplay capture is a no-op on this platform")
        }
    }
    public static func start(_ config: OuoReplayConfig) { warnOnce() }
    public static func pause() { warnOnce() }
    public static func resume() { warnOnce() }
    public static var isRecording: Bool { false }
    public static func flush(completion: (() -> Void)? = nil) { warnOnce(); completion?() }
    public static func sessionDidRotate(newId: String) { warnOnce() }
    public static func stop() { warnOnce() }
    #endif
}
