import Foundation

/// The host's view-level masking by React tag (`mask(reactTag)`, `unmask(reactTag)`), read by the
/// OTLP replay recorder on every walk. The last call for a tag decides which set it is in; between
/// views mask wins (a masked view inside an unmasked one stays masked) and a secure field is
/// masked whatever is said here (PRV-6, PRV-7). Thread-safe and bounded.
final class ReplayViewMasks {
    static let shared = ReplayViewMasks()
    /// Tags kept per set (ERR-9). Beyond it new tags are refused: an unmask is then not honoured,
    /// which is the safe side; a refused mask is counted so it is not silent.
    static let limit = 10_000

    private let lock = NSLock()
    private var masked = Set<Int>()
    private var unmasked = Set<Int>()
    private var refusedCount = 0

    func mask(_ tag: Int) {
        lock.withLock {
            unmasked.remove(tag)
            guard masked.count < Self.limit else { refusedCount += 1; return }
            masked.insert(tag)
        }
    }

    func unmask(_ tag: Int) {
        lock.withLock {
            masked.remove(tag)
            guard unmasked.count < Self.limit else { refusedCount += 1; return }
            unmasked.insert(tag)
        }
    }

    func snapshot() -> (masked: Set<Int>, unmasked: Set<Int>) {
        lock.withLock { (masked, unmasked) }
    }

    var refused: Int { lock.withLock { refusedCount } }
}
