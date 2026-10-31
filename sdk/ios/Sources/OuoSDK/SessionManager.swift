import Foundation
import OuoReplayCore

/// Why a session ended (`ouo.session.end_reason`, docs/specs/session-lifecycle.md).
enum EndReason: String, Codable {
    case inactivity, max_duration, background, crash, terminated, user_change, manual
}

/// A session as persisted (`session.json`). Times are epoch ms.
struct SessionRecord: Codable, Equatable {
    var id: String
    var startedAt: Double
    var lastActivity: Double
    var userId: String
    /// `service.version` the session ran on, so a `session.end` sent after an update names it.
    var serviceVersion: String?
    var previousId: String?
    /// Set while the app is in the background.
    var backgroundAt: Double?
    var endedAt: Double?
    var endReason: EndReason?
}

struct UserRecord: Codable, Equatable {
    var id: String
    var anonymous: Bool
}

/// Everything the session manager keeps across launches, in one small file.
struct PersistedSession: Codable, Equatable {
    var session: SessionRecord?
    var user: UserRecord?
    /// `device.id`: random, survives rotation, login and logout.
    var deviceId: String?
}

/// What the store holds. `unreadable` is not `missing`: before the first unlock after a reboot (a
/// background launch: a push, a fetch, a location event) the file exists and cannot be read, and
/// treating it as a fresh install would end no session and give the device a new `device.id`.
enum StoredSession: Equatable {
    case missing
    case unreadable
    case state(PersistedSession)
}

protocol SessionStore: AnyObject {
    func load() -> StoredSession
    func save(_ state: PersistedSession)
}

/// `session.json`, written atomically and readable after the first unlock (also when the app's
/// default protection is `complete`). A file that is not valid JSON is `missing` (it is replaced).
final class FileSessionStore: SessionStore {
    let url: URL
    init(url: URL) { self.url = url }

    func load() -> StoredSession {
        guard FileManager.default.fileExists(atPath: url.path) else { return .missing }
        guard let data = try? Data(contentsOf: url) else { return .unreadable }
        guard let state = try? JSONDecoder().decode(PersistedSession.self, from: data) else { return .missing }
        return .state(state)
    }

    func save(_ state: PersistedSession) {
        guard let data = try? JSONEncoder().encode(state) else { return }
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? DiskQueue.write(data, to: url)
    }
}

/// The previous run's crash or termination report, as far as sessions care: which session died, when.
struct CrashMarker: Equatable {
    var sessionId: String
    var at: Double
    /// The crashed session's start (`session_started_ms`, N52), when the report has it.
    var startedAt: Double?
}

/// The mobile session state machine (docs/specs/session-lifecycle.md, mobile rules; mobile SDK spec
/// C1), the rules of `@ouo11y/react-native`'s `SessionManager` made synchronous: the persisted state
/// is a local file, so the cold start reads it, ends the previous run's session and starts the new
/// one before `start` returns. Not thread-safe: its owner serialises calls. Expiry is checked on
/// every use (no timer): an idle session ends at its deadline when the next record, activity or
/// foreground comes, or at the next launch.
final class SessionManager {
    struct Timeouts: Equatable {
        var inactivity: Double = 30 * 60 * 1000
        var maxDuration: Double = 4 * 60 * 60 * 1000
        var background: Double = 30 * 1000
    }

    /// Activity is persisted at most once per second.
    static let persistThrottleMs: Double = 1000

    private let store: SessionStore
    private let now: () -> Double
    private let timeouts: Timeouts
    private let serviceVersion: String
    /// `session.start` / `session.end`: name, attributes, timestamp (epoch ms).
    private let emit: (String, Attributes, Double) -> Void
    /// A new session is current (after its `session.start`).
    private let onRotate: (SessionRecord) -> Void

    private(set) var current: SessionRecord?
    private(set) var lastEnded: SessionRecord?
    private(set) var user = UserRecord(id: UUID().uuidString.lowercased(), anonymous: true)
    private(set) var deviceId = UUID().uuidString.lowercased()
    private var inBackground = false
    private var lastPersist: Double = -.infinity
    /// The file could not be read at start: nothing is saved over it until it can be (`adoptStored`).
    private(set) var storeUnreadable = false

    init(store: SessionStore, now: @escaping () -> Double, timeouts: Timeouts = Timeouts(), serviceVersion: String,
         emit: @escaping (String, Attributes, Double) -> Void, onRotate: @escaping (SessionRecord) -> Void) {
        self.store = store
        self.now = now
        self.timeouts = timeouts
        self.serviceVersion = serviceVersion
        self.emit = emit
        self.onRotate = onRotate
    }

    /// Cold start (mobile start rule 1): ends the session the previous run left (`crash` when the
    /// crash report names it, else the deadline it passed, else `terminated`), and the one a crash
    /// report names that the file never saw (a crash in its first second, N52); then starts a new
    /// session with `session.previous_id`. `background`: the process was launched in the background
    /// (its session ends with `background` unless the app comes to the foreground in time).
    func start(crash: CrashMarker?, background: Bool) {
        let t = now()
        inBackground = background
        let persisted: PersistedSession?
        switch store.load() {
        case .state(let p): persisted = p
        case .missing: persisted = nil
        case .unreadable:
            persisted = nil
            storeUnreadable = true
        }
        if let d = persisted?.deviceId, !d.isEmpty { deviceId = d }
        if let u = persisted?.user, !u.id.isEmpty { user = u }
        var previousId: String?
        if let p = persisted?.session {
            if p.endedAt == nil {
                let reason = coldStartReason(p, crash: crash, now: t)
                endPersisted(p, reason, at: coldStartEndedAt(p, reason, crash: crash, now: t))
            } else {
                lastEnded = p
            }
            previousId = p.id
        }
        if let crash, !crash.sessionId.isEmpty, crash.sessionId != persisted?.session?.id {
            let at = min(crash.at, t)
            let startedAt = crash.startedAt.map { $0 <= at ? $0 : at } ?? at
            let lost = SessionRecord(id: crash.sessionId, startedAt: startedAt, lastActivity: at, userId: user.id, serviceVersion: serviceVersion)
            endPersisted(lost, .crash, at: at)
            previousId = lost.id
        }
        create(at: t, previousId: previousId)
    }

    /// The active session, a new one when the last ended or expired.
    @discardableResult
    func ensure() -> SessionRecord {
        let t = now()
        if let c = current {
            guard let reason = expiredReason(c, now: t) else { return c }
            end(c, reason, now: t)
        }
        return create(at: t, previousId: lastEnded?.id)
    }

    /// Activity (a touch, a navigation, a request, a foreground): refreshes `lastActivity`, persisted
    /// at most once a second.
    func touch() {
        var c = ensure()
        c.lastActivity = now()
        current = c
        persist(force: false)
    }

    /// The app entered the background: persisted at once, so a kill there is dated.
    func background() {
        inBackground = true
        guard var c = current, c.backgroundAt == nil else { return }
        c.backgroundAt = now()
        current = c
        persist(force: true)
    }

    /// The app is active again: rotates the session when the background stay (or another deadline)
    /// passed (mobile start rule 2). A foreground is activity.
    func foreground() {
        inBackground = false
        if let c = current {
            if let reason = expiredReason(c, now: now()) {
                end(c, reason, now: now())
            } else {
                current?.backgroundAt = nil
            }
        }
        touch()
    }

    /// Anonymous to identified keeps the session; one identified user to another ends it with
    /// `user_change` and starts a new one.
    func setUser(_ id: String) {
        guard !id.isEmpty, !(user.id == id && !user.anonymous) else { return }
        if user.anonymous {
            user = UserRecord(id: id, anonymous: false)
            current?.userId = id
            persist(force: true)
            return
        }
        changeUser(to: UserRecord(id: id, anonymous: false))
    }

    /// Logout: a fresh anonymous id, in a new session (`user_change`). Nothing when already anonymous.
    func clearUser() {
        guard !user.anonymous else { return }
        changeUser(to: UserRecord(id: UUID().uuidString.lowercased(), anonymous: true))
    }

    /// `manual`: the session ends now; the next record or activity starts a new one.
    func endSession() {
        guard let c = current else { return }
        end(c, .manual, now: now())
    }

    /// Persists the current state at once (flush, background).
    func persistNow() {
        persist(force: true)
    }

    // MARK: - internals

    private func changeUser(to next: UserRecord) {
        let t = now()
        if let c = current { end(c, .user_change, now: t) }
        user = next
        create(at: t, previousId: lastEnded?.id)
    }

    @discardableResult
    private func create(at t: Double, previousId: String?) -> SessionRecord {
        var rec = SessionRecord(id: UUID().uuidString.lowercased(), startedAt: t, lastActivity: t, userId: user.id, serviceVersion: serviceVersion)
        rec.previousId = previousId
        if inBackground { rec.backgroundAt = t }
        current = rec
        persist(force: true)
        var attrs: Attributes = ["session.id": .string(rec.id), "user.id": .string(rec.userId), "ouo.session.started_at": .int(Int64(t.rounded())), "device.id": .string(deviceId)]
        if let p = previousId { attrs["session.previous_id"] = .string(p) }
        emit("session.start", attrs, t)
        onRotate(rec)
        return rec
    }

    /// Earliest deadline wins: inactivity, max duration, or the background stay.
    func expiredReason(_ rec: SessionRecord, now t: Double) -> EndReason? {
        var deadlines: [(EndReason, Double)] = [
            (.inactivity, rec.lastActivity + timeouts.inactivity),
            (.max_duration, rec.startedAt + timeouts.maxDuration),
        ]
        if let b = rec.backgroundAt { deadlines.append((.background, b + timeouts.background)) }
        let first = deadlines.min { $0.1 < $1.1 }!
        return t >= first.1 ? first.0 : nil
    }

    private func end(_ rec: SessionRecord, _ reason: EndReason, now t: Double) {
        let at: Double
        switch reason {
        case .inactivity: at = min(rec.lastActivity + timeouts.inactivity, t)
        case .max_duration: at = min(rec.startedAt + timeouts.maxDuration, t)
        case .background: at = min((rec.backgroundAt ?? t) + timeouts.background, t)
        default: at = t
        }
        endPersisted(rec, reason, at: at)
    }

    private func coldStartReason(_ p: SessionRecord, crash: CrashMarker?, now t: Double) -> EndReason {
        if let crash, crash.sessionId.isEmpty || crash.sessionId == p.id { return .crash }
        return expiredReason(p, now: t) ?? .terminated
    }

    private func coldStartEndedAt(_ p: SessionRecord, _ reason: EndReason, crash: CrashMarker?, now t: Double) -> Double {
        switch reason {
        case .crash: return max(p.startedAt, min(crash?.at ?? p.lastActivity, t))
        case .inactivity: return p.lastActivity + timeouts.inactivity
        case .max_duration: return p.startedAt + timeouts.maxDuration
        case .background: return (p.backgroundAt ?? p.lastActivity) + timeouts.background
        default: return min(p.lastActivity, t)
        }
    }

    /// Marks `rec` ended, persists it (the next launch must not end it again), emits `session.end`.
    private func endPersisted(_ rec: SessionRecord, _ reason: EndReason, at endedAt: Double) {
        var r = rec
        r.endedAt = endedAt
        r.endReason = reason
        r.backgroundAt = nil
        lastEnded = r
        if current?.id == r.id {
            current = nil
            save(r)
        }
        var attrs: Attributes = [
            "session.id": .string(r.id),
            "user.id": .string(r.userId),
            "ouo.session.end_reason": .string(reason.rawValue),
            "ouo.session.duration_ms": .int(Int64(max(0, endedAt - r.startedAt).rounded())),
            "ouo.session.started_at": .int(Int64(r.startedAt.rounded())),
            "ouo.session.ended_at": .int(Int64(endedAt.rounded())),
            "device.id": .string(deviceId),
        ]
        if let v = r.serviceVersion { attrs["service.version"] = .string(v) }
        if let p = r.previousId { attrs["session.previous_id"] = .string(p) }
        emit("session.end", attrs, endedAt)
    }

    private func persist(force: Bool) {
        let t = now()
        guard force || t - lastPersist >= Self.persistThrottleMs else { return }
        save(current ?? lastEnded)
    }

    private func save(_ session: SessionRecord?) {
        lastPersist = now()
        guard !storeUnreadable || adoptStored() else { return }
        store.save(PersistedSession(session: (current ?? session), user: user, deviceId: deviceId))
    }

    /// The file became readable (the first unlock): what a cold start would have done with it. Its
    /// `device.id` and its user (unless the app identified one since) are kept from now on, and its
    /// session, if it was not ended, ends with the reason and time a cold start gives it. False while
    /// it is still unreadable.
    private func adoptStored() -> Bool {
        let p: PersistedSession
        switch store.load() {
        case .unreadable: return false
        case .missing:
            storeUnreadable = false
            return true
        case .state(let s): p = s
        }
        storeUnreadable = false
        if let d = p.deviceId, !d.isEmpty { deviceId = d }
        if user.anonymous, let u = p.user, !u.id.isEmpty {
            user = u
            current?.userId = u.id
        }
        if let old = p.session, old.endedAt == nil, old.id != current?.id {
            let reason = coldStartReason(old, crash: nil, now: now())
            endPersisted(old, reason, at: coldStartEndedAt(old, reason, crash: nil, now: now()))
        }
        return true
    }

    /// Tries to save now: after the device's protected data became available.
    func retryStore() {
        guard storeUnreadable else { return }
        persist(force: true)
    }
}
