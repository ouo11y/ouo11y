import Foundation

/// Main-thread milliseconds per capture, kept by the iOS pixel recorders for the overhead comparison
/// (`OuoReplay.captureStats`). Bounded: the last `capacity` samples. Thread-safe.
public final class CaptureStats: @unchecked Sendable {
    public struct Snapshot: Equatable, Sendable {
        public let count: Int
        public let totalMillis: Double
        /// The retained samples, oldest first.
        public let samples: [Double]

        public var meanMillis: Double { count == 0 ? 0 : totalMillis / Double(count) }

        public func percentile(_ p: Double) -> Double {
            guard !samples.isEmpty else { return 0 }
            let s = samples.sorted()
            let i = min(s.count - 1, max(0, Int((p * Double(s.count - 1)).rounded())))
            return s[i]
        }
    }

    private let lock = NSLock()
    private let capacity: Int
    private var count = 0
    private var total = 0.0
    private var samples: [Double] = []

    public init(capacity: Int = 4096) {
        self.capacity = capacity
    }

    public func record(millis: Double) {
        lock.lock()
        defer { lock.unlock() }
        count += 1
        total += millis
        samples.append(millis)
        if samples.count > capacity { samples.removeFirst(samples.count - capacity) }
    }

    public func snapshot() -> Snapshot {
        lock.lock()
        defer { lock.unlock() }
        return Snapshot(count: count, totalMillis: total, samples: samples)
    }

    public func reset() {
        lock.lock()
        defer { lock.unlock() }
        count = 0
        total = 0
        samples = []
    }
}
