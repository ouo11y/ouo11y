import Foundation
import OuoReplayCore

/// One entry of `ouo.last_events` (mobile SDK spec C10): when, which record, the step as a person reads it.
struct RecentEvent: Codable, Equatable {
    var ts: Int64
    var name: String
    var body: String
}

/// The session's last 20 records (events and log lines) as they are emitted, before sampling: what an
/// `exception` (C2) and a `feedback` (C10) carry as `ouo.last_events`. The rules of the React
/// Native SDK's `RecentEvents`.
struct RecentEvents {
    static let capacity = 20
    static let bodyMaxBytes = 200

    private var entries: [(event: RecentEvent, session: String)] = []

    mutating func add(_ r: LogRecord) {
        guard case .string(let session)? = r.attributes["session.id"] else { return }
        let name = r.eventName ?? "log"
        let e = RecentEvent(ts: Int64(r.timeMs.rounded()), name: name, body: cutUtf8(Self.summary(name, r.body, r.attributes), Self.bodyMaxBytes))
        entries.append((e, session))
        if entries.count > Self.capacity { entries.removeFirst(entries.count - Self.capacity) }
    }

    /// The entries of `sessionId`, oldest first by `ts` (stable: vitals and a native crash are
    /// stamped earlier than the records before them).
    func read(_ sessionId: String) -> [RecentEvent] {
        entries.enumerated().filter { $0.element.session == sessionId }
            .sorted { ($0.element.event.ts, $0.offset) < ($1.element.event.ts, $1.offset) }
            .map(\.element.event)
    }

    /// The step: the path of a `navigation`, `type: message` of an `exception`, `METHOD url status`
    /// of a request, else the body when it is more than the name.
    static func summary(_ name: String, _ body: String, _ a: Attributes) -> String {
        func s(_ k: String) -> String { a[k]?.text ?? "" }
        switch name {
        case "navigation": return s("url.path")
        case "exception": return [s("exception.type"), s("exception.message")].filter { !$0.isEmpty }.joined(separator: ": ")
        case "http.request", "http.request.failed":
            return [s("http.request.method"), s("url.full"), s("http.response.status_code")].filter { !$0.isEmpty }.joined(separator: " ")
        default: return body != name ? body : ""
        }
    }

    static func attribute(_ events: [RecentEvent]) -> AttributeValue {
        let enc = JSONEncoder()
        enc.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return .string((try? enc.encode(events)).flatMap { String(data: $0, encoding: .utf8) } ?? "[]")
    }
}

/// What a crash or a termination reported by the next launch carries about the run that died
/// (`context.json`, C2): its session, screen and last events.
struct ScreenContext: Codable, Equatable {
    var sessionId: String
    var screen: String
    var events: [RecentEvent]

    /// Records after which the context is written at once (the steps a reader needs, and the tap
    /// that triggered a synchronous crash); after others at most every 5 s.
    static let persistAtOnce: Set<String> = ["ui.tap", "navigation", "exception"]
    static let persistDelayMs: Double = 5000

    /// `app.screen.name` and `ouo.last_events`, when there are a screen and events.
    var attributes: Attributes {
        var a: Attributes = [:]
        if !screen.isEmpty { a["app.screen.name"] = .string(screen) }
        if !events.isEmpty { a["ouo.last_events"] = RecentEvents.attribute(events) }
        return a
    }

    static func load(_ url: URL) -> ScreenContext? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(ScreenContext.self, from: data)
    }

    func save(_ url: URL) {
        guard let data = try? JSONEncoder().encode(self) else { return }
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? DiskQueue.write(data, to: url)
    }
}
