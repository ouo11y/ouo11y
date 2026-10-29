import Foundation
import Testing
@testable import OuoReplayCore

/// The open chunk survives a crash (W1): what the builder held is on disk and the next launch
/// sends it with its own session, seq and end time.
@Suite struct ChunkSpoolTests {
    private let url = FileManager.default.temporaryDirectory.appendingPathComponent("ouo-spool-\(UUID().uuidString)/open-chunk.jsonl")

    private func builder(_ spool: ChunkSpool, store: SeqStore, chunks: @escaping (FrameChunk) -> Void = { _ in }) -> ChunkBuilder {
        ChunkBuilder(
            config: ChunkBuilder.Config(flushInterval: 5, maxFrames: 10, platform: "ios", masked: true),
            viewport: Viewport(width: 393, height: 852, scale: 1),
            sessionId: { "crashed-session" },
            seqStore: store,
            now: { 1_000 },
            spool: spool,
            onChunk: chunks
        )
    }

    @Test func CrashMidChunkIsRecoveredOnTheNextLaunch() throws {
        let store = InMemorySeqStore()
        _ = store.next(sessionId: "crashed-session") // seq 0 went out before
        let b = builder(ChunkSpool(url: url), store: store)
        b.add(Touch(ts: 1_000, x: 1, y: 2, phase: .began))
        b.add(makeFrame(ts: 1_100))
        b.viewport = Viewport(width: 393, height: 852, scale: 3)
        b.add(makeFrame(ts: 2_100, bytes: 0x01))
        // The process dies here: no cut, no flush. A touch after the last frame may be lost.

        let chunk = try #require(ChunkSpool(url: url).recover(now: 3_000))
        #expect(chunk.sessionId == "crashed-session")
        #expect(chunk.seq == 1)
        #expect(chunk.startedAt == 1_000)
        #expect(chunk.endedAt == 2_100)
        #expect(chunk.frames == [makeFrame(ts: 1_100), makeFrame(ts: 2_100, bytes: 0x01)])
        #expect(chunk.touches == [Touch(ts: 1_000, x: 1, y: 2, phase: .began)])
        #expect(chunk.viewport.scale == 3)
        #expect(ChunkSpool(url: url).recover(now: 3_000) == nil, "sent at most once")
    }

    @Test func CutChunkLeavesNothingBehind() {
        var out: [FrameChunk] = []
        let b = builder(ChunkSpool(url: url), store: InMemorySeqStore()) { out.append($0) }
        b.add(makeFrame(ts: 1_100))
        b.flush()
        #expect(out.count == 1)
        #expect(ChunkSpool(url: url).recover() == nil)
    }

    /// The crash cut the last line short: the lines before it still count.
    @Test func TornLastLineIsSkipped() throws {
        let b = builder(ChunkSpool(url: url), store: InMemorySeqStore())
        b.add(makeFrame(ts: 1_100))
        let h = try FileHandle(forWritingTo: url)
        try h.seekToEnd()
        try h.write(contentsOf: Data("{\"frame\":{\"ts\":12".utf8))
        try h.close()
        let chunk = try #require(ChunkSpool(url: url).recover(now: 3_000))
        #expect(chunk.frames.map(\.ts) == [1_100])
    }

    /// A spool left by a run more than a day ago is dropped, not sent.
    @Test func StaleSpoolIsDropped() {
        let b = builder(ChunkSpool(url: url), store: InMemorySeqStore())
        b.add(makeFrame(ts: 1_100))
        #expect(ChunkSpool(url: url).recover(now: 1_000 + 25 * 3600 * 1000) == nil)
        #expect(!FileManager.default.fileExists(atPath: url.path))
    }

    @Test func SpoolFolderIsExcludedFromBackups() throws {
        let b = builder(ChunkSpool(url: url), store: InMemorySeqStore())
        b.add(makeFrame(ts: 1_100))
        let values = try url.deletingLastPathComponent().resourceValues(forKeys: [.isExcludedFromBackupKey])
        #expect(values.isExcludedFromBackup == true)
    }

    @Test func NoFileNoChunk() {
        #expect(ChunkSpool(url: url).recover() == nil)
    }
}
