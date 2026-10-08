import Foundation

/// Epoch milliseconds in the device clock (the timeline aligns them with telemetry the same way
/// as rrweb chunks, which use `Date.now()`).
public typealias EpochMillis = Int64

public enum Clock {
    public static func nowMillis() -> EpochMillis {
        EpochMillis((Date().timeIntervalSince1970 * 1000).rounded())
    }
}

/// Minimal logger shared by the core and the UIKit target. `[ouo replay]` prefix, silent unless
/// `enabled`.
public struct ReplayLogger: Sendable {
    public let enabled: Bool
    public init(enabled: Bool) { self.enabled = enabled }
    public func log(_ message: @autoclosure () -> String) {
        if enabled { print("[ouo replay] \(message())") }
    }
    public func warn(_ message: @autoclosure () -> String) {
        if enabled { print("[ouo replay] warning: \(message())") }
    }
}
