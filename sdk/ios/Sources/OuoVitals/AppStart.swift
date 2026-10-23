import Foundation

public enum AppStartType: String {
    case cold
    case warm
}

/// The start of the launch the host is measuring, to its first frame (mobile vitals spec 2.1).
public struct AppStartInfo: Equatable {
    public let type: AppStartType
    /// Epoch ms: the process start (cold), the load of the app image (cold, prewarmed) or the
    /// relaunch of the JS runtime in a live process (warm).
    public let startMs: Double
    /// iOS prewarmed the process (`ActivePrewarm=1`): the start is the image load, not the process start.
    public let prewarmed: Bool

    /// Picks the start of this launch. `firstRuntime` is false when a runtime (React Native) was
    /// already started in this process, which makes it a warm start from `runtimeStartMs`. A
    /// prewarmed cold start is measured from the image load, as sentry-cocoa does from its module
    /// initialization: the process may have been created minutes before the user opened the app.
    /// Nil when the start time is unknown (spec rule 1: no record for a value not measured).
    public static func resolve(
        firstRuntime: Bool,
        processStartMs: Double,
        loadTimeMs: Double,
        runtimeStartMs: Double,
        prewarmed: Bool
    ) -> AppStartInfo? {
        if !firstRuntime {
            return runtimeStartMs > 0 ? AppStartInfo(type: .warm, startMs: runtimeStartMs, prewarmed: false) : nil
        }
        let start = prewarmed ? loadTimeMs : processStartMs
        return start > 0 ? AppStartInfo(type: .cold, startMs: start, prewarmed: prewarmed) : nil
    }
}
