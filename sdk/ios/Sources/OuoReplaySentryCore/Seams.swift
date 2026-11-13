// The seams that tied sentry-cocoa's replay core to the Sentry SDK, re-implemented for ouo.
// Names and signatures match what the vendored files in Upstream/ call (sentry-cocoa, see
// UPSTREAM_TAG), so those files compile unmodified. Each seam says which upstream type it stands
// in for; none carries Sentry behaviour beyond what the recorder core needs.
//
// Portions adapted from sentry-cocoa (Sources/Swift/Helper/SentryDispatchQueueWrapper.swift,
// Sources/Swift/Integrations/AppHangTracking/SentryRunLoopDelayTracker.swift).
// Copyright (c) 2015 Sentry. MIT License, see sdk/ios/THIRD_PARTY_NOTICES.

import Foundation

// MARK: logging (upstream: SentrySDKLog, wired to SentryOptions.debug)

/// Where the vendored core logs. Off by default; `SentryCoreRecorder` points it at the ouo logger.
public enum OuoSentryCoreLog {
    public enum Level: Int, Comparable, Sendable {
        case debug, info, warning, error, fatal
        public static func < (a: Level, b: Level) -> Bool { a.rawValue < b.rawValue }
    }
    nonisolated(unsafe) public static var sink: ((Level, String) -> Void)?
    nonisolated(unsafe) public static var minimum: Level = .warning
}

enum SentrySDKLog {
    private static func log(_ level: OuoSentryCoreLog.Level, _ message: @autoclosure () -> String) {
        guard level >= OuoSentryCoreLog.minimum, let sink = OuoSentryCoreLog.sink else { return }
        sink(level, message())
    }
    static func debug(_ message: @autoclosure () -> String) { log(.debug, message()) }
    static func info(_ message: @autoclosure () -> String) { log(.info, message()) }
    static func warning(_ message: @autoclosure () -> String) { log(.warning, message()) }
    static func error(_ message: @autoclosure () -> String) { log(.error, message()) }
    static func fatal(_ message: @autoclosure () -> String) { log(.fatal, message()) }
}

// MARK: queues (upstream: SentryDispatchQueueWrapper, built by the SDK's dispatch factory)

/// A serial dispatch queue. An NSObject so `!=` is identity, as upstream asserts on it.
@_spi(Private) public final class SentryDispatchQueueWrapper: NSObject {
    public let queue: DispatchQueue

    public override init() {
        queue = DispatchQueue(label: "dev.ouo.replay.sentry-core", qos: .utility)
    }

    /// Upstream's `createUtilityQueue(name, relativePriority:)`.
    init(utility label: String, relativePriority: Int32) {
        let qos = DispatchQoS(qosClass: .utility, relativePriority: Int(relativePriority))
        queue = DispatchQueue(label: label, qos: qos)
    }

    public func dispatchAsync(_ block: @escaping () -> Void) {
        queue.async(execute: block)
    }

    func dispatchSync(_ block: () -> Void) {
        queue.sync(execute: block)
    }
}

// MARK: time (upstream: SentryCurrentDateProvider from the dependency container)

@_spi(Private) public protocol SentryCurrentDateProvider {
    func date() -> Date
    /// Monotonic nanoseconds.
    func getAbsoluteTime() -> UInt64
}

@_spi(Private) public final class SentryDefaultCurrentDateProvider: SentryCurrentDateProvider {
    public init() {}
    public func date() -> Date { Date() }
    public func getAbsoluteTime() -> UInt64 { DispatchTime.now().uptimeNanoseconds }
}

// MARK: run loop (upstream: SentryRunLoopDelayTracker.swift, the DEBUG branch)

protocol SentryRunLoopObserver {}
extension CFRunLoopObserver: SentryRunLoopObserver {}

typealias CreateObserverFunc<T> = (_ allocator: CFAllocator?, _ activities: CFOptionFlags, _ repeats: Bool, _ order: CFIndex, _ block: ((T?, CFRunLoopActivity) -> Void)?) -> T?
typealias AddObserverFunc<T> = (_ rl: CFRunLoop?, _ observer: T?, _ mode: CFRunLoopMode?) -> Void
typealias RemoveObserverFunc<T> = (_ rl: CFRunLoop?, _ observer: T?, _ mode: CFRunLoopMode?) -> Void
