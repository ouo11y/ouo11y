import Foundation
import OuoReplayCore

/// Public entry point. All calls are safe to make from any thread; the work happens on the main
/// thread because UIKit snapshots require it.
public enum OuoReplay {
    private static let uploaderLock = NSLock()
    private static var sharedUploader: ChunkUploader?

    /// The process's one chunk uploader, made from the first config that asks (two uploaders on one
    /// folder would send the same files). Its endpoint, credential and `holdUploads` stay for the process.
    static func uploader(_ config: OuoReplayConfig) -> ChunkUploader {
        uploaderLock.lock()
        defer { uploaderLock.unlock() }
        if let u = sharedUploader { return u }
        let u = ChunkUploader(
            endpoint: config.endpoint,
            projectId: config.projectId,
            projectToken: config.projectToken,
            directory: config.outboxURL,
            config: ChunkUploader.Config(hold: config.holdUploads),
            logger: ReplayLogger(enabled: config.debug)
        )
        sharedUploader = u
        return u
    }

    /// Finished sessions whose chunks wait on the device (`holdUploads`), for the host's
    /// next-launch keep/drop decision, listed after the previous run's open chunk was recovered
    /// (it may belong to one). The host leaves out its current session.
    public static func heldSessions(_ config: OuoReplayConfig, completion: @escaping ([ChunkUploader.HeldSession]) -> Void) {
        #if canImport(UIKit)
        ReplayRecorder.afterRecovery(config) { completion(uploader(config).heldSessions()) }
        #else
        completion(uploader(config).heldSessions())
        #endif
    }

    /// Sends (`keep`) or deletes a held session's chunks.
    public static func releaseHeld(_ config: OuoReplayConfig, sessionId: String, keep: Bool) {
        uploader(config).release(sessionId: sessionId, keep: keep)
    }

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

    /// Sends the replay chunk a crash, watchdog kill or force quit left open in the previous run,
    /// with `config`'s endpoint and credential, whether or not this run records. `start` does it
    /// too; call this first when the host decides per session whether to record (sampling), so a
    /// crashed session's last seconds arrive even when the next session is not recorded. Only the
    /// first call in a process (this or `start`) recovers; later ones do nothing.
    /// `crash`: the previous run's crash and its time (epoch ms), so its chunk ends at the crash.
    public static func recoverPendingChunk(_ config: OuoReplayConfig, crash: (sessionId: String, at: EpochMillis)? = nil) {
        ReplayRecorder.recoverSpool(config, crash: crash)
    }

    /// A new screen is showing (a navigation library's route change). In `navigation` mode this is
    /// what takes a frame; in `session` mode it changes nothing.
    public static func screenDidChange() {
        onMain { recorder?.screenDidChange() }
    }

    /// The mode the recorder runs in (`auto` resolved for this device), nil when not started.
    public static var mode: ReplayMode? {
        if Thread.isMainThread { return recorder?.mode }
        return DispatchQueue.main.sync { recorder?.mode }
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
    public static func recoverPendingChunk(_ config: OuoReplayConfig, crash: (sessionId: String, at: EpochMillis)? = nil) {}
    public static func screenDidChange() { warnOnce() }
    public static var mode: ReplayMode? { nil }
    public static func stop() { warnOnce() }
    #endif
}
