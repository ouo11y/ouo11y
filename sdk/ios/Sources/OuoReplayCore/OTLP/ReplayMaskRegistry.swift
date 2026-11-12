import Foundation

/// The one place a recorder asks "did the host mask or unmask this view?" (ADR-0021 decision 5:
/// every pixel recorder masks identically). It answers for both ways a host says it:
///
/// - the accessibility identifiers `ouo-mask` and `ouo-unmask`, which is what SwiftUI's
///   `.ouoMask()` / `.ouoUnmask()` and a UIKit host set on the view;
/// - React Native's `mask(reactTag)` / `unmask(reactTag)`, kept here by tag.
///
/// It does not depend on a recorder: the frames recorder reads it on every walk, and another
/// recorder reads the same snapshot. For one view, a mask wins over an unmask; for a tag, the last
/// call decides which set it is in. What an override means in a tree (a mask inside an unmasked
/// subtree still masks, a secure field is masked whatever is said here: PRV-6, PRV-7) is the
/// redaction planner's, under `RedactionRules.strict`. Thread-safe and bounded.
public final class ReplayMaskRegistry {
    public static let shared = ReplayMaskRegistry()
    /// Tags kept per set (ERR-9). Beyond it a new tag is refused and counted: a refused unmask
    /// leaves the view masked, which is the safe side.
    public static let limit = 10_000

    /// What a walk reads: the two tag sets as they were when it started.
    public struct Snapshot: Sendable, Equatable {
        public var masked: Set<Int>
        public var unmasked: Set<Int>

        public init(masked: Set<Int> = [], unmasked: Set<Int> = []) {
            self.masked = masked
            self.unmasked = unmasked
        }

        /// The host's override for one view, from its React tag (nil for a view that has none) and
        /// its accessibility identifier. Mask wins.
        public func override(reactTag: Int?, accessibilityIdentifier: String?) -> ViewNode.MaskOverride? {
            if accessibilityIdentifier == RedactionRules.maskIdentifier { return .mask }
            if let reactTag, masked.contains(reactTag) { return .mask }
            if accessibilityIdentifier == RedactionRules.unmaskIdentifier { return .unmask }
            if let reactTag, unmasked.contains(reactTag) { return .unmask }
            return nil
        }
    }

    private let lock = NSLock()
    private var state = Snapshot()
    private var refusedCount = 0

    public init() {}

    public func mask(reactTag tag: Int) {
        lock.withLock {
            state.unmasked.remove(tag)
            guard state.masked.contains(tag) || state.masked.count < Self.limit else { refusedCount += 1; return }
            state.masked.insert(tag)
        }
    }

    public func unmask(reactTag tag: Int) {
        lock.withLock {
            state.masked.remove(tag)
            guard state.unmasked.contains(tag) || state.unmasked.count < Self.limit else { refusedCount += 1; return }
            state.unmasked.insert(tag)
        }
    }

    /// Forgets every tag (a JavaScript reload hands out tags again).
    public func reset() {
        lock.withLock { state = Snapshot() }
    }

    public func snapshot() -> Snapshot {
        lock.withLock { state }
    }

    /// Calls refused because a set was full.
    public var refused: Int { lock.withLock { refusedCount } }
}
