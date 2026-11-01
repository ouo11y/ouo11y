import Foundation
import Testing
@testable import OuoReplayCore

/// What `DiskQueue` adds to the chunk queue's rules (those are in ChunkUploaderTests).
@Suite struct DiskQueueTests {
    private func dir() -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("ouo-dq-\(UUID().uuidString)", isDirectory: true)
    }

    private func queue(_ d: URL, _ t: ChunkTransport?, maxEntries: Int = .max, clock: FakeClock? = nil,
                       retry: @escaping @Sendable (Int) -> TimeInterval = { _ in 3600 }) -> DiskQueue {
        DiskQueue(directory: d, config: DiskQueue.Config(maxBytes: 1 << 20, maxEntries: maxEntries, retryDelay: retry), transport: t,
                  now: { clock?.now ?? Clock.nowMillis() }) { e, body in
            var r = URLRequest(url: URL(string: "http://x/\(e.tag)")!)
            r.httpBody = body
            return r
        }
    }

    private func drain(_ q: DiskQueue) async {
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in q.drain { c.resume() } }
    }

    @Test func EntryBoundDropsTheOldest() async {
        let d = dir()
        let q = queue(d, nil, maxEntries: 3)
        for i in 0..<5 { #expect(q.put(Data("\(i)".utf8), tag: "t\(i)")) }
        #expect(q.entries().map(\.tag) == ["t2", "t3", "t4"])
        #expect(q.dropped == 2)
    }

    private static let day: Int64 = 24 * 3600 * 1000

    /// N77: a clock moved two days forward (by the user, or a wrong clock corrected) drops nothing:
    /// the queue has no age, only its bounds.
    @Test func AClockMovedForwardDropsNothing() async {
        let d = dir()
        let clock = FakeClock()
        let held = queue(d, nil, clock: clock)
        held.put(Data("a".utf8), tag: "a")
        held.put(Data("b".utf8), tag: "b")
        clock.advance(ms: 2 * Self.day)
        #expect(held.entries().map(\.tag) == ["a", "b"])
        // The next process, still two days ahead, sends both, then its own.
        let t = FakeTransport()
        let next = queue(d, t, clock: clock)
        next.put(Data("c".utf8), tag: "c")
        await drain(next)
        #expect(t.sent.map { $0.request.url!.lastPathComponent } == ["a", "b", "c"])
        #expect(held.dropped == 0 && next.dropped == 0)
    }

    /// N77: a clock moved back does not put a new entry before the older ones, in this process or
    /// the next (its counter starts again), so the order is still the order of `put` and the bound
    /// drops the oldest, never the newest.
    @Test func AClockMovedBackKeepsTheOrder() async {
        let d = dir()
        let clock = FakeClock()
        let q = queue(d, nil, maxEntries: 3, clock: clock)
        q.put(Data("a".utf8), tag: "a")
        q.put(Data("b".utf8), tag: "b")
        clock.advance(ms: -2 * Self.day)
        q.put(Data("c".utf8), tag: "c")
        #expect(q.entries().map(\.tag) == ["a", "b", "c"])
        let t = FakeTransport()
        let next = queue(d, t, maxEntries: 3, clock: clock)
        next.put(Data("d".utf8), tag: "d")
        #expect(next.entries().map(\.tag) == ["b", "c", "d"], "the bound dropped the oldest")
        await drain(next)
        #expect(t.sent.map { $0.request.url!.lastPathComponent } == ["b", "c", "d"])
        // Back on time, names follow the clock again.
        clock.advance(ms: 2 * Self.day + 1000)
        next.put(Data("e".utf8), tag: "e")
        #expect(next.entries().last?.queuedAt == clock.now)
    }

    /// N55: OTLP/HTTP's retryable answers only; anything else is final.
    @Test func RetriesOnlyOTLPRetryableAnswers() {
        #expect([429, 502, 503, 504].allSatisfy(DiskQueue.retryable))
        #expect(![100, 200, 304, 400, 401, 408, 413, 500, 501, 505, 599].contains(where: DiskQueue.retryable))
    }

    /// N55: a request the collector answers 500 to every time is tried once, counted as rejected
    /// and removed; the entries behind it go out at once instead of waiting for the bound.
    @Test func AFiveHundredEveryTimeDoesNotBlockTheQueue() async {
        let d = dir()
        let t = PoisonTransport(poison: "poison", status: 500)
        let q = queue(d, t)
        for tag in ["poison", "a", "b"] { q.put(Data(tag.utf8), tag: tag) }
        await drain(q)
        #expect(t.sent == ["poison", "a", "b"])
        #expect(q.rejected == 1 && q.sent == 2 && q.dropped == 0)
        #expect(q.count == 0)
    }

    /// During a backoff a new entry waits for the retry: an outage costs one request per backoff.
    @Test func NoSendDuringABackoff() async {
        let t = FakeTransport()
        t.responses = Array(repeating: .success(503), count: 10)
        let q = queue(dir(), t)
        q.put(Data("a".utf8), tag: "a")
        await drain(q)
        for i in 0..<5 { q.put(Data("\(i)".utf8), tag: "n\(i)") }
        try? await Task.sleep(nanoseconds: 100_000_000)
        #expect(t.count == 1)
        // `drain` (foreground, flush) tries again at once.
        await drain(q)
        #expect(t.count == 2)
    }

    /// Files that are not entries (a temporary file of an interrupted atomic write, a folder) are ignored.
    @Test func ForeignFilesAreIgnored() async throws {
        let d = dir()
        try FileManager.default.createDirectory(at: d.appendingPathComponent("held"), withIntermediateDirectories: true)
        try Data("x".utf8).write(to: d.appendingPathComponent(".dat.nosync1234"))
        try Data("x".utf8).write(to: d.appendingPathComponent("12-ab.tag"))
        let t = FakeTransport()
        let q = queue(d, t)
        q.put(Data("a".utf8), tag: "real")
        await drain(q)
        #expect(t.sent.map { $0.request.url!.lastPathComponent } == ["real"])
        #expect(DiskQueue.Entry(url: URL(fileURLWithPath: "/q/1760000000000-000001.logs.json"))?.tag == "logs.json")
        #expect(DiskQueue.Entry(url: URL(fileURLWithPath: "/q/1760000000000-000001."))  == nil)
    }

    /// A move keeps the name, so the entry keeps its place in the order.
    @Test func MoveKeepsTheOrder() async {
        let held = queue(dir(), nil)
        let t = FakeTransport()
        let out = queue(dir(), t)
        held.put(Data("old".utf8), tag: "old")
        out.put(Data("new".utf8), tag: "new")
        await drain(out)
        t.responses = []
        held.move(held.entries()[0], to: out)
        await drain(out)
        #expect(t.sent.map { $0.request.url!.lastPathComponent } == ["new", "old"])
        #expect(held.count == 0)
    }

    /// A refused write is sent once from memory, unless the caller says not to (held chunks).
    @Test func ARefusedWriteIsSentOnceFromMemory() async throws {
        let d = dir()
        try FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        try FileManager.default.setAttributes([.posixPermissions: 0o555], ofItemAtPath: d.path)
        defer { try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: d.path) }
        let t = FakeTransport()
        let q = queue(d, t)
        #expect(!q.put(Data("a".utf8), tag: "a"))
        #expect(!q.put(Data("b".utf8), tag: "b", sendIfRefused: false))
        for _ in 0..<50 where t.count == 0 { try? await Task.sleep(nanoseconds: 10_000_000) }
        #expect(t.sent.map { $0.request.url!.lastPathComponent } == ["a"])
    }
}

/// Answers `status` to every request for the entry tagged `poison`, 202 to the others.
private final class PoisonTransport: ChunkTransport {
    private let lock = NSLock()
    private var tags: [String] = []
    let poison: String
    let status: Int

    init(poison: String, status: Int) {
        self.poison = poison
        self.status = status
    }

    var sent: [String] { lock.withLock { tags } }

    func send(_ request: URLRequest, completion: @escaping (Result<ChunkResponse, Error>) -> Void) {
        let tag = request.url!.lastPathComponent
        lock.withLock { tags.append(tag) }
        let status = tag == poison ? self.status : 202
        DispatchQueue.global().async { completion(.success(ChunkResponse(status: status))) }
    }
}
