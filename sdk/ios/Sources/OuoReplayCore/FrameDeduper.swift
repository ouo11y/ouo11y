import Foundation

/// Drops a frame whose downsampled bytes hash the same as the previous kept frame (spec: "The SDK
/// drops a frame whose downsampled hash equals the previous one"). The hasher is injectable; the
/// default is 64-bit FNV-1a over the bytes.
public final class FrameDeduper {
    public typealias Hasher = (Data) -> UInt64

    private let hasher: Hasher
    private var lastHash: UInt64?

    public init(hasher: @escaping Hasher = FrameDeduper.fnv1a) {
        self.hasher = hasher
    }

    /// True when the frame differs from the last kept one (and records it as the new reference).
    public func shouldKeep(_ downsampled: Data) -> Bool {
        let h = hasher(downsampled)
        if h == lastHash { return false }
        lastHash = h
        return true
    }

    /// Forgets the reference so the next frame is always kept (resume, rotation).
    public func reset() {
        lastHash = nil
    }

    public static func fnv1a(_ data: Data) -> UInt64 {
        var hash: UInt64 = 0xcbf2_9ce4_8422_2325
        for byte in data {
            hash ^= UInt64(byte)
            hash = hash &* 0x0000_0100_0000_01b3
        }
        return hash
    }
}
