import Foundation
import Testing
@testable import OuoReplayCore

/// What `DiskQueue` adds to the chunk queue's rules (those are in ChunkUploaderTests).
@Suite struct DiskQueueTests {
    private func dir() -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("ouo-dq-\(UUID().uuidString)", isDirectory: true)
    }

    private func queue(_ d: URL, _ t: ChunkTransport?, maxEntries: Int = .max, retry: @escaping @Sendable (Int) -> TimeInterval = { _ in 3600 }) -> DiskQueue {
        DiskQueue(directory: d, config: DiskQueue.Config(maxBytes: 1 << 20, maxEntries: maxEntries, maxAge: 3600, retryDelay: retry), transport: t) { e, body in
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
}
