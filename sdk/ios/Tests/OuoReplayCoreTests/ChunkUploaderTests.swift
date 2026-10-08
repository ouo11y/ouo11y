import Foundation
import Testing
@testable import OuoReplayCore

@Suite struct ChunkUploaderTests {
    private func chunk(seq: Int, session: String = "sess-1", frames: Int = 1) -> FrameChunk {
        FrameChunk(
            sessionId: session, seq: seq, startedAt: 1_760_000_000_000, endedAt: 1_760_000_005_000,
            viewport: Viewport(width: 393, height: 852, scale: 1),
            frames: (0..<frames).map { makeFrame(ts: 1_760_000_000_000 + Int64($0), bytes: UInt8($0 & 0xff)) },
            touches: [], masked: true
        )
    }

    private func drain(_ u: ChunkUploader) async {
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            u.drain { c.resume() }
        }
    }

    @Test func PostsGzipJSONWithSpecHeaders() async throws {
        let transport = FakeTransport()
        let u = ChunkUploader(endpoint: URL(string: "http://localhost:8080/")!, transport: transport)
        #expect(u.url.absoluteString == "http://localhost:8080/v1/replay/chunks")
        let c = chunk(seq: 7)
        u.enqueue(c)
        await drain(u)

        #expect(transport.count == 1)
        let sent = transport.sent[0]
        #expect(sent.request.httpMethod == "POST")
        #expect(sent.request.url?.absoluteString == "http://localhost:8080/v1/replay/chunks")
        #expect(sent.request.value(forHTTPHeaderField: "content-type") == "application/json")
        #expect(sent.request.value(forHTTPHeaderField: "content-encoding") == "gzip")
        #expect(sent.request.value(forHTTPHeaderField: "x-ouo-session-id") == "sess-1")
        #expect(sent.request.value(forHTTPHeaderField: "x-ouo-seq") == "7")
        #expect(try FrameChunk.decode(try Gzip.decompress(sent.body)) == c)
        #expect(u.uploaded == 1)
    }

    @Test func SendsInOrderAndRetriesWithBackoff() async {
        let transport = FakeTransport()
        transport.responses = [.failure(TransportError()), .success(500), .success(202), .success(202)]
        var delays: [Int] = []
        let lock = NSLock()
        let u = ChunkUploader(
            endpoint: URL(string: "http://localhost:8080")!,
            config: ChunkUploader.Config(maxAttempts: 3, retryDelay: { attempt in
                lock.lock(); delays.append(attempt); lock.unlock()
                return 0
            }),
            transport: transport
        )
        u.enqueue(chunk(seq: 0))
        u.enqueue(chunk(seq: 1))
        await drain(u)
        // seq 0: fail, 500, ok. seq 1: ok.
        #expect(transport.sent.map { $0.request.value(forHTTPHeaderField: "x-ouo-seq") } == ["0", "0", "0", "1"])
        #expect(delays == [1, 2])
        #expect(u.uploaded == 2)
        #expect(u.failed == 0)
        // Default backoff is 1 s, 2 s.
        let defaults = ChunkUploader.Config()
        #expect(defaults.retryDelay(1) == 1)
        #expect(defaults.retryDelay(2) == 2)
        #expect(defaults.maxAttempts == 3)
        #expect(defaults.maxQueueBytes == 2 * 1024 * 1024)
    }

    @Test func GivesUpAfterMaxAttemptsAndContinues() async {
        let transport = FakeTransport()
        transport.responses = [.success(503), .success(503), .success(503), .success(202)]
        let u = ChunkUploader(
            endpoint: URL(string: "http://localhost:8080")!,
            config: ChunkUploader.Config(maxAttempts: 3, retryDelay: { _ in 0 }),
            transport: transport
        )
        u.enqueue(chunk(seq: 0))
        u.enqueue(chunk(seq: 1))
        await drain(u)
        #expect(transport.sent.map { $0.request.value(forHTTPHeaderField: "x-ouo-seq") } == ["0", "0", "0", "1"])
        #expect(u.failed == 1)
        #expect(u.uploaded == 1)
        #expect(u.queuedCount == 0)
    }

    @Test func BoundedQueueDropsOldest() async {
        let transport = FakeTransport()
        // Block the first send until we have queued everything.
        let gate = DispatchSemaphore(value: 0)
        let blocking = BlockingTransport(gate: gate, inner: transport)
        let big = chunk(seq: 0, frames: 1)
        let bodySize = try! Gzip.compress(try! big.encodedJSON()).count
        let u = ChunkUploader(
            endpoint: URL(string: "http://localhost:8080")!,
            config: ChunkUploader.Config(maxAttempts: 1, maxQueueBytes: bodySize * 3 + 10, retryDelay: { _ in 0 }),
            transport: blocking
        )
        for seq in 0..<6 { u.enqueue(chunk(seq: seq)) }
        // Wait until the uploader has processed the enqueues (the head is in flight, 5 queued).
        try? await Task.sleep(nanoseconds: 200_000_000)
        gate.signal()
        await drain(u)
        let seqs = transport.sent.map { $0.request.value(forHTTPHeaderField: "x-ouo-seq")! }
        #expect(seqs.first == "0", "the in-flight head is never dropped")
        #expect(seqs.suffix(2) == ["4", "5"], "the newest chunks survive")
        #expect(u.dropped > 0)
        #expect(u.uploaded + u.dropped == 6)
    }

    /// Set OUO_REPLAY_STUB_URL=http://localhost:8080 (rum-api, or the Node stub in the agent
    /// summary) to push real gzip chunks through URLSession. The session id is unique per run so
    /// rum-api's seq ordering never conflicts with an earlier run.
    @Test(.enabled(if: ProcessInfo.processInfo.environment["OUO_REPLAY_STUB_URL"] != nil))
    func RealHTTPAgainstStubWhenConfigured() async throws {
        let url = try #require(URL(string: ProcessInfo.processInfo.environment["OUO_REPLAY_STUB_URL"] ?? ""))
        let session = "swift-uploader-\(Int(Date().timeIntervalSince1970))"
        let u = ChunkUploader(endpoint: url, logger: ReplayLogger(enabled: true))
        u.enqueue(chunk(seq: 0, session: session, frames: 3))
        u.enqueue(chunk(seq: 1, session: session, frames: 2))
        await drain(u)
        #expect(u.uploaded == 2)
        #expect(u.failed == 0)
    }
}

/// Holds the first send until `gate` is signalled, then behaves like `inner`.
final class BlockingTransport: ChunkTransport {
    private let gate: DispatchSemaphore
    private let inner: ChunkTransport
    private var first = true
    init(gate: DispatchSemaphore, inner: ChunkTransport) {
        self.gate = gate
        self.inner = inner
    }
    func send(_ request: URLRequest, completion: @escaping (Result<Int, Error>) -> Void) {
        let wait = first
        first = false
        if wait {
            DispatchQueue.global().async {
                self.gate.wait()
                self.inner.send(request, completion: completion)
            }
        } else {
            inner.send(request, completion: completion)
        }
    }
}
