import Foundation

/// Hands out monotonic chunk sequence numbers per session. `seq` starts at 0 for a new session
/// id and persists across app restarts within the same session (spec: chunk rules).
public protocol SeqStore: AnyObject {
    /// Reserves and returns the next seq for `sessionId`. A different id than the last one
    /// seen restarts at 0.
    func next(sessionId: String) -> Int
    /// Forces the next seq for `sessionId` to be 0.
    func reset(sessionId: String)
}

/// Non-persistent store (tests, hosts that do not want UserDefaults).
public final class InMemorySeqStore: SeqStore {
    private var sessionId: String?
    private var seq = 0
    private let lock = NSLock()

    public init() {}

    public func next(sessionId: String) -> Int {
        lock.lock(); defer { lock.unlock() }
        if self.sessionId != sessionId {
            self.sessionId = sessionId
            seq = 0
        }
        let current = seq
        seq += 1
        return current
    }

    public func reset(sessionId: String) {
        lock.lock(); defer { lock.unlock() }
        self.sessionId = sessionId
        seq = 0
    }

    /// Test helper: the seq the next call would return.
    public func peek() -> Int {
        lock.lock(); defer { lock.unlock() }
        return seq
    }
}

/// UserDefaults-backed store: `{ "session_id": ..., "seq": n }` under one key, so the seq
/// survives a relaunch while the JS/host session id is unchanged.
public final class UserDefaultsSeqStore: SeqStore {
    public static let defaultKey = "ouo.replay.seq"

    private let defaults: UserDefaults
    private let key: String
    private let lock = NSLock()

    public init(defaults: UserDefaults = .standard, key: String = UserDefaultsSeqStore.defaultKey) {
        self.defaults = defaults
        self.key = key
    }

    public func next(sessionId: String) -> Int {
        lock.lock(); defer { lock.unlock() }
        let stored = defaults.dictionary(forKey: key)
        var seq = 0
        if let stored, stored["session_id"] as? String == sessionId, let n = stored["seq"] as? Int {
            seq = n
        }
        defaults.set(["session_id": sessionId, "seq": seq + 1], forKey: key)
        return seq
    }

    public func reset(sessionId: String) {
        lock.lock(); defer { lock.unlock() }
        defaults.set(["session_id": sessionId, "seq": 0], forKey: key)
    }
}
