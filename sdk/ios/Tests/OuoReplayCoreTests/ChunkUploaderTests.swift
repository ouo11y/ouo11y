import Foundation
import Testing
@testable import OuoReplayCore

@Suite struct ChunkUploaderTests {
    private let projectId = "demo"
    private let token = "pt_test_token_0000000000000000"
    /// Basic base64("demo:pt_test_token_0000000000000000"), computed with `Buffer.from(...).toString("base64")`.
    private let expectedAuthorization = "Basic ZGVtbzpwdF90ZXN0X3Rva2VuXzAwMDAwMDAwMDAwMDAwMDA="

    private func chunk(seq: Int, session: String = "sess-1", frames: Int = 1) -> FrameChunk {
        FrameChunk(
            sessionId: session, seq: seq, startedAt: 1_760_000_000_000, endedAt: 1_760_000_005_000,
            viewport: Viewport(width: 393, height: 852, scale: 1),
            frames: (0..<frames).map { makeFrame(ts: 1_760_000_000_000 + Int64($0), bytes: UInt8($0 & 0xff)) },
            touches: [], masked: true
        )
    }

    private func tempDir() -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("ouo-outbox-\(UUID().uuidString)", isDirectory: true)
    }

    private func uploader(_ transport: ChunkTransport, dir: URL? = nil, config: ChunkUploader.Config = ChunkUploader.Config(), now: @escaping () -> EpochMillis = { Clock.nowMillis() }) -> ChunkUploader {
        ChunkUploader(endpoint: URL(string: "http://localhost:4319")!, projectId: projectId, projectToken: token, directory: dir ?? tempDir(), config: config, transport: transport, now: now)
    }

    /// Drains until the folder is empty (a drain returns early when the head fails).
    private func settle(_ u: ChunkUploader) async {
        for _ in 0..<50 where u.queuedCount > 0 {
            await drain(u)
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
    }

    private func drain(_ u: ChunkUploader) async {
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            u.drain { c.resume() }
        }
    }

    @Test func PostsGzipJSONWithSpecHeaders() async throws {
        let transport = FakeTransport()
        let u = ChunkUploader(endpoint: URL(string: "http://localhost:4319/")!, projectId: projectId, projectToken: token, directory: tempDir(), transport: transport)
        #expect(u.url.absoluteString == "http://localhost:4319/v1/replay/chunks")
        let c = chunk(seq: 7)
        u.enqueue(c)
        await drain(u)

        #expect(transport.count == 1)
        let sent = transport.sent[0]
        #expect(sent.request.httpMethod == "POST")
        #expect(sent.request.url?.absoluteString == "http://localhost:4319/v1/replay/chunks")
        #expect(sent.request.value(forHTTPHeaderField: "content-type") == "application/json")
        #expect(sent.request.value(forHTTPHeaderField: "content-encoding") == "gzip")
        #expect(sent.request.value(forHTTPHeaderField: "x-ouo-session-id") == "sess-1")
        #expect(sent.request.value(forHTTPHeaderField: "x-ouo-seq") == "7")
        #expect(sent.request.value(forHTTPHeaderField: "Authorization") == expectedAuthorization)
        #expect(sent.request.value(forHTTPHeaderField: "X-Ouo-Project-Token") == nil)
        #expect(try FrameChunk.decode(try Gzip.decompress(sent.body)) == c)
        #expect(u.uploaded == 1)
    }

    /// ADR-0007 section 2: the credential is HTTP Basic with the project id as user name and the
    /// token as password, standard base64 with padding. Vectors computed with Node's Buffer.
    @Test func BasicAuthorizationValue() {
        #expect(ChunkUploader.authorizationHeader == "Authorization")
        #expect(ChunkUploader.basicAuthorization(projectId: "demo", projectToken: "pt_dev_demo_0000000000000000") == "Basic ZGVtbzpwdF9kZXZfZGVtb18wMDAwMDAwMDAwMDAwMDAw")
        #expect(ChunkUploader.basicAuthorization(projectId: "web-store", projectToken: "pt_live_9f3c") == "Basic d2ViLXN0b3JlOnB0X2xpdmVfOWYzYw==")
        // UTF-8, not Latin-1, so the JS SDK's encoder and this one agree on non-ASCII input.
        #expect(ChunkUploader.basicAuthorization(projectId: "pröjekt", projectToken: "tökén✓🙂") == "Basic cHLDtmpla3Q6dMO2a8OpbuKck/CfmYI=")
    }

    /// ADR-0007: every upload, including retries, carries the Basic credential; header lookup is case-insensitive.
    @Test func EveryRequestCarriesTheBasicCredential() async {
        let transport = FakeTransport()
        transport.responses = [.success(401), .success(202), .success(202)]
        let u = ChunkUploader(
            endpoint: URL(string: "https://otel.example.com")!,
            projectId: "web-store",
            projectToken: "pt_live_9f3c",
            directory: tempDir(),
            config: ChunkUploader.Config(retryDelay: { _ in 0 }),
            transport: transport
        )
        #expect(u.projectId == "web-store")
        #expect(u.projectToken == "pt_live_9f3c")
        #expect(u.authorization == "Basic d2ViLXN0b3JlOnB0X2xpdmVfOWYzYw==")
        u.enqueue(chunk(seq: 0))
        u.enqueue(chunk(seq: 1))
        await settle(u)
        // 401 is a rejection (dropped), the next chunk goes on.
        #expect(transport.sent.count == 2)
        for s in transport.sent {
            #expect(s.request.url?.absoluteString == "https://otel.example.com/v1/replay/chunks")
            #expect(s.request.value(forHTTPHeaderField: "authorization") == "Basic d2ViLXN0b3JlOnB0X2xpdmVfOWYzYw==")
            #expect(s.request.value(forHTTPHeaderField: "x-ouo-project-token") == nil)
        }
        let direct = ChunkUploader.makeRequest(url: u.url, authorization: "Basic other", sessionId: "s", seq: 3, gzipBody: Data())
        #expect(direct.allHTTPHeaderFields?["Authorization"] == "Basic other")
    }

    @Test func SendsInOrderAndRetriesWithBackoff() async {
        let transport = FakeTransport()
        transport.responses = [.failure(TransportError()), .success(500), .success(202), .success(202)]
        let delays = Recorded<Int>()
        let u = uploader(transport, config: ChunkUploader.Config(retryDelay: { n in delays.append(n); return 0 }))
        u.enqueue(chunk(seq: 0))
        u.enqueue(chunk(seq: 1))
        await settle(u)
        // seq 0: fail, 500, ok. seq 1: ok.
        #expect(transport.sent.map { $0.request.value(forHTTPHeaderField: "x-ouo-seq") } == ["0", "0", "0", "1"])
        #expect(delays.values == [1, 2])
        #expect(u.uploaded == 2)
        #expect(u.failed == 0)
        #expect(u.queuedCount == 0)
        // Default backoff doubles from 1 s and stops growing at 60 s.
        let defaults = ChunkUploader.Config()
        #expect(defaults.retryDelay(1) == 1)
        #expect(defaults.retryDelay(2) == 2)
        #expect(defaults.retryDelay(10) == 60)
        #expect(defaults.maxQueueBytes == 10 * 1024 * 1024)
    }

    /// C11: a chunk that could not be sent stays on disk, and the next process sends it.
    @Test func AnOutageLosesNothingAcrossProcesses() async throws {
        let dir = tempDir()
        let offline = FakeTransport()
        offline.responses = Array(repeating: .failure(TransportError()), count: 10)
        let first = uploader(offline, dir: dir, config: ChunkUploader.Config(retryDelay: { _ in 3600 }))
        for seq in 0..<3 { first.enqueue(chunk(seq: seq)) }
        await drain(first)
        #expect(first.uploaded == 0)
        #expect(first.queuedCount == 3, "kept on disk, not given up")

        // Next launch: a new uploader on the same folder.
        let online = FakeTransport()
        let second = uploader(online, dir: dir)
        await drain(second)
        #expect(online.sent.map { $0.request.value(forHTTPHeaderField: "x-ouo-seq") } == ["0", "1", "2"])
        #expect(try FrameChunk.decode(try Gzip.decompress(online.sent[2].body)) == chunk(seq: 2))
        #expect(second.uploaded == 3)
        #expect(second.queuedCount == 0)
    }

    /// The file is written before the request leaves, so a kill mid-upload resends it.
    @Test func AKillMidUploadResendsTheChunk() async {
        let dir = tempDir()
        let hung = HungTransport()
        let first = uploader(hung, dir: dir)
        first.enqueue(chunk(seq: 4))
        for _ in 0..<100 where hung.count == 0 { try? await Task.sleep(nanoseconds: 5_000_000) }
        #expect(hung.count == 1, "in flight")
        #expect(first.queuedCount == 1, "and still on disk")

        let online = FakeTransport()
        let second = uploader(online, dir: dir)
        await drain(second)
        #expect(online.sent.map { $0.request.value(forHTTPHeaderField: "x-ouo-seq") } == ["4"])
    }

    @Test func RejectedChunksAreDroppedAndTheQueueContinues() async {
        let transport = FakeTransport()
        // 400 and a 3xx are final; 408 is retried.
        transport.responses = [.success(400), .success(408), .success(202), .success(304), .success(202)]
        let u = uploader(transport, config: ChunkUploader.Config(retryDelay: { _ in 0 }))
        for seq in 0..<4 { u.enqueue(chunk(seq: seq)) }
        await settle(u)
        #expect(transport.sent.map { $0.request.value(forHTTPHeaderField: "x-ouo-seq") } == ["0", "1", "1", "2", "3"])
        #expect(u.failed == 2)
        #expect(u.uploaded == 2)
        #expect(u.queuedCount == 0)
    }

    @Test func BoundedQueueDropsOldest() async throws {
        let bodySize = try Gzip.compress(try chunk(seq: 0).encodedJSON()).count
        let dir = tempDir()
        // seq 0 is in flight (never answered) while the rest arrive: it is never dropped.
        let u = uploader(HungTransport(), dir: dir, config: ChunkUploader.Config(maxQueueBytes: bodySize * 3 + 10))
        for seq in 0..<6 { u.enqueue(chunk(seq: seq)) }
        #expect(u.queuedCount == 3)
        #expect(u.dropped == 3)

        let online = FakeTransport()
        await drain(uploader(online, dir: dir))
        #expect(online.sent.map { $0.request.value(forHTTPHeaderField: "x-ouo-seq")! } == ["0", "4", "5"], "the in-flight head and the newest chunks survive")
    }

    /// N77: a chunk left unsent survives a clock moved more than a day forward and is sent.
    @Test func AClockMovedForwardKeepsTheChunks() async {
        let dir = tempDir()
        let clock = FakeClock()
        let offline = FakeTransport()
        offline.responses = [.failure(TransportError())]
        let first = uploader(offline, dir: dir, config: ChunkUploader.Config(retryDelay: { _ in 3600 }), now: { clock.now })
        first.enqueue(chunk(seq: 0))
        await drain(first)

        clock.advance(ms: 24 * 3600 * 1000 + 1)
        let online = FakeTransport()
        let second = uploader(online, dir: dir, now: { clock.now })
        await drain(second)
        #expect(online.sent.map { $0.request.value(forHTTPHeaderField: "x-ouo-seq")! } == ["0"])
        #expect(second.dropped == 0)
    }

    /// The next-launch keep/drop hook: held chunks wait for the host's decision per session.
    @Test func HeldSessionsWaitForTheDecision() async throws {
        let dir = tempDir()
        let clock = FakeClock()
        let transport = FakeTransport()
        let first = uploader(transport, dir: dir, config: ChunkUploader.Config(hold: true), now: { clock.now })
        first.enqueue(chunk(seq: 0, session: "a"))
        clock.advance(ms: 5000)
        first.enqueue(chunk(seq: 1, session: "a"))
        first.enqueue(chunk(seq: 0, session: "b"))
        await drain(first)
        #expect(transport.count == 0, "nothing leaves while held")

        let second = uploader(transport, dir: dir, now: { clock.now })
        let held = second.heldSessions()
        #expect(held.map(\.sessionId) == ["a", "b"])
        #expect(held[0].chunks == 2)
        #expect(held[0].lastAt - held[0].firstAt == 5000)
        #expect(held[0].bytes > 0)
        second.release(sessionId: "a", keep: true)
        second.release(sessionId: "b", keep: false)
        await drain(second)
        #expect(transport.sent.map { "\($0.request.value(forHTTPHeaderField: "x-ouo-session-id")!)#\($0.request.value(forHTTPHeaderField: "x-ouo-seq")!)" } == ["a#0", "a#1"])
        #expect(second.heldSessions().isEmpty)
    }

    /// The receiver's 429 + `Retry-After` sets the wait when it is longer than the backoff.
    @Test func HonoursRetryAfter() async {
        let transport = FakeTransport()
        transport.responses = [.success(ChunkResponse(status: 429, retryAfter: 3600))]
        let u = uploader(transport, config: ChunkUploader.Config(retryDelay: { _ in 0 }))
        u.enqueue(chunk(seq: 0))
        await drain(u)
        try? await Task.sleep(nanoseconds: 100_000_000)
        #expect(transport.count == 1, "no retry before Retry-After")
        #expect(u.queuedCount == 1)
    }

    /// A held chunk never leaves the device before its session's decision, not even when the disk fails.
    @Test func AHeldChunkIsDroppedWhenTheDiskFails() async throws {
        let blocker = tempDir()
        try Data().write(to: blocker)  // a file where the folder should be: the write fails
        let transport = FakeTransport()
        let u = uploader(transport, dir: blocker, config: ChunkUploader.Config(hold: true))
        u.enqueue(chunk(seq: 0))
        await drain(u)
        #expect(transport.count == 0)
        #expect(u.dropped == 1)
    }

    @Test func FileNamesCarryTheRequestHeaders() throws {
        let url = URL(fileURLWithPath: "/tmp/1760000000000-000012.3f2a-77.5.json.gz")
        let e = try #require(ChunkUploader.Entry(url: url))
        #expect(e.sessionId == "3f2a-77")
        #expect(e.seq == 5)
        #expect(e.queuedAt == 1_760_000_000_000)
        #expect(ChunkUploader.Entry(url: URL(fileURLWithPath: "/tmp/held")) == nil)
        #expect(ChunkUploader.Entry(url: URL(fileURLWithPath: "/tmp/x.s.1.json.gz.tmp")) == nil)
    }

    /// Set OUO_REPLAY_STUB_URL=http://localhost:4319 (the collector's replay receiver, or a stub),
    /// OUO_PROJECT_ID (default demo) and OUO_PROJECT_TOKEN (default: the development token) to
    /// push real gzip chunks through URLSession. The session id is unique per run so rum-api's
    /// seq ordering never conflicts with an earlier run.
    @Test(.enabled(if: ProcessInfo.processInfo.environment["OUO_REPLAY_STUB_URL"] != nil))
    func RealHTTPAgainstStubWhenConfigured() async throws {
        let env = ProcessInfo.processInfo.environment
        let url = try #require(URL(string: env["OUO_REPLAY_STUB_URL"] ?? ""))
        let session = "swift-uploader-\(Int(Date().timeIntervalSince1970))"
        let u = ChunkUploader(
            endpoint: url,
            projectId: env["OUO_PROJECT_ID"] ?? "demo",
            projectToken: env["OUO_PROJECT_TOKEN"] ?? "pt_dev_demo_0000000000000000",
            directory: tempDir(),
            logger: ReplayLogger(enabled: true)
        )
        u.enqueue(chunk(seq: 0, session: session, frames: 3))
        u.enqueue(chunk(seq: 1, session: session, frames: 2))
        await drain(u)
        #expect(u.uploaded == 2)
        #expect(u.failed == 0)
    }
}

/// Never answers: the request stays in flight (a process killed mid-upload).
final class HungTransport: ChunkTransport {
    private let lock = NSLock()
    private var n = 0
    func send(_ request: URLRequest, completion: @escaping (Result<ChunkResponse, Error>) -> Void) {
        lock.lock(); n += 1; lock.unlock()
    }
    var count: Int { lock.lock(); defer { lock.unlock() }; return n }
}

/// Values appended from any thread.
final class Recorded<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [T] = []
    func append(_ v: T) { lock.lock(); items.append(v); lock.unlock() }
    var values: [T] { lock.lock(); defer { lock.unlock() }; return items }
}
