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

    // MARK: OTLP replay (ADR-0021 decision 5), the parts that need no UIKit

    private static let otlpLock = NSLock()
    private static var sharedDelivery: ReplayDelivery?
    private static var counters: [String: Int] = [:]

    /// The process's one OTLP replay queue, made from the first config that asks (two on one folder
    /// would send the same files). Its URL and credential stay for the process.
    static func delivery(_ config: OuoReplayConfig, _ options: ReplayOTLPOptions) -> ReplayDelivery {
        otlpLock.lock()
        defer { otlpLock.unlock() }
        if let d = sharedDelivery { return d }
        let d = ReplayDelivery(logsUrl: options.logsUrl, authorization: config.authorization, directory: config.otlpOutboxURL, logger: ReplayLogger(enabled: config.debug))
        sharedDelivery = d
        return d
    }

    /// Counts something the SDK dropped or could not do (ERR-7), reported by `diagnostics()`.
    static func count(_ key: String, _ n: Int = 1) {
        otlpLock.withLock { counters[key, default: 0] += n }
    }

    /// Problems found in the start options (a wrong type, a value out of range, a mode this build
    /// does not record): counted, and logged when `debug` is on. Never thrown.
    public static func noteOptionProblems(_ problems: [String], debug: Bool = false) {
        guard !problems.isEmpty else { return }
        count("replay.option_problems", problems.count)
        let logger = ReplayLogger(enabled: debug)
        problems.forEach { logger.warn("option: \($0)") }
    }

    /// Masks the React Native view with this tag in every recorder (`ReplayMaskRegistry`). The
    /// native equivalents are `.ouoMask()` and the accessibility identifier `ouo-mask`.
    public static func mask(reactTag: Int) {
        ReplayMaskRegistry.shared.mask(reactTag: reactTag)
    }

    /// Shows the React Native view with this tag (and what is inside it) although its class is
    /// masked. A mask inside it still masks, and a secure field is always masked.
    public static func unmask(reactTag: Int) {
        ReplayMaskRegistry.shared.unmask(reactTag: reactTag)
    }

    /// Deletes replay records not yet accepted by the collector and stops the OTLP recorder without
    /// an end record (consent withdrawn, PRV-4). `config` names the folders when they are not the
    /// default ones. `completion` runs when the files are gone.
    public static func discardPending(_ config: OuoReplayConfig? = nil, completion: (() -> Void)? = nil) {
        let finish = {
            let existing = otlpLock.withLock { sharedDelivery }
            if let existing {
                existing.discardPending()
            } else {
                ReplayDelivery.discardPending(in: config?.otlpOutboxURL ?? ReplayDelivery.defaultDirectory)
            }
            FileReplayStateStore(url: config?.otlpStateURL ?? FileReplayStateStore.defaultURL).clear()
            completion?()
        }
        #if canImport(UIKit)
        onMain {
            if let r = recorder as? OTLPReplayRecorder {
                recorder = nil
                r.discard { finish() }
            } else {
                DispatchQueue.global(qos: .utility).async(execute: finish)
            }
        }
        #else
        finish()
        #endif
    }

    /// Counters of what replay dropped or could not do in this process (ERR-7), by reason.
    public static func diagnostics() -> [String: Int] {
        var out = otlpLock.withLock { counters }
        out["replay.mask_registry_refused"] = ReplayMaskRegistry.shared.refused
        #if canImport(UIKit)
        let live: [String: Int] = {
            if Thread.isMainThread { return (recorder as? OTLPReplayRecorder)?.diagnostics() ?? [:] }
            return DispatchQueue.main.sync { (recorder as? OTLPReplayRecorder)?.diagnostics() ?? [:] }
        }()
        out.merge(live) { $0 + $1 }
        #endif
        return out
    }

    #if canImport(UIKit)
    private static var recorder: ReplayRecording?

    /// Starts capturing. Calling it again replaces the previous configuration. With `config.otlp`
    /// the frames recorder sends OTLP log records; without it, chunks go to `/v1/replay/chunks`.
    public static func start(_ config: OuoReplayConfig) {
        onMain {
            recorder?.stop()
            if let options = config.otlp {
                let r = OTLPReplayRecorder(config: config, options: options, delivery: delivery(config, options), store: FileReplayStateStore(url: config.otlpStateURL))
                recorder = r
                r.start()
                return
            }
            let r = ReplayRecorder(config: config)
            recorder = r
            r.start()
        }
    }

    /// Buffer mode (`buffer: { seconds }`): sends the ring and records on as a session.
    /// `trigger` is `error`, `crash`, `anr`, `hang` or `manual`; anything else counts as `manual`.
    /// Does nothing when no buffer is waiting.
    public static func capture(trigger: String) {
        let known = ReplayTrigger(rawValue: trigger)
        if known == nil { count("replay.unknown_trigger") }
        onMain { (recorder as? OTLPReplayRecorder)?.capture(trigger: known ?? .manual) }
    }

    /// The screen the next chunks belong to (`ouo.view.id`).
    public static func setViewId(_ id: String) {
        onMain { (recorder as? OTLPReplayRecorder)?.setViewId(id) }
    }

    /// Stops and ends the stream with `ouo.replay.ended` and this reason (the OTLP recorder; the
    /// legacy recorder just stops).
    public static func stop(reason: ReplayEndReason) {
        onMain {
            if let r = recorder as? OTLPReplayRecorder { r.end(reason) } else { recorder?.stop() }
            recorder = nil
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

    /// The user sent feedback (mobile SDK spec C10): a frame of the screen as it is now, in every
    /// mode, with reason `feedback`, kept even when the screen did not change.
    public static func frameForFeedback() {
        onMain { recorder?.frameForFeedback() }
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

    static func onMain(_ block: @escaping () -> Void) {
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
    public static func frameForFeedback() { warnOnce() }
    public static var mode: ReplayMode? { nil }
    public static func stop() { warnOnce() }
    public static func capture(trigger: String) { warnOnce() }
    public static func setViewId(_ id: String) { warnOnce() }
    public static func stop(reason: ReplayEndReason) { warnOnce() }
    #endif
}
