import Foundation
import Testing
@testable import OuoReplayCore

@Suite final class ChunkBuilderTests {
    private var clock = FakeClock()
    private var chunks: [FrameChunk] = []
    private var sessionId = "session-a"
    private var store = InMemorySeqStore()

    private func makeBuilder(flushInterval: TimeInterval = 5, maxImageBytes: Int = 1 << 20, mode: String = "session") -> ChunkBuilder {
        ChunkBuilder(
            config: ChunkBuilder.Config(flushInterval: flushInterval, maxImageBytes: maxImageBytes, platform: "ios", masked: true, mode: mode),
            viewport: Viewport(width: 393, height: 852, scale: 1),
            sessionId: { self.sessionId },
            seqStore: store,
            now: { self.clock.now },
            onChunk: { self.chunks.append($0) }
        )
    }

    /// ADR-0014: no frame count limit; a chunk is cut once its images reach `maxImageBytes`.
    @Test func FlushesOnceImagesReachTheByteLimit() {
        // makeFrame is 4 JPEG bytes, 8 base64 characters.
        let b = makeBuilder(maxImageBytes: 40)
        for i in 0..<4 {
            b.add(makeFrame(ts: clock.now + Int64(i)))
            #expect(chunks.isEmpty)
        }
        b.add(makeFrame(ts: clock.now + 4))
        #expect(chunks.count == 1)
        #expect(chunks[0].frames.count == 5)
        #expect(chunks[0].seq == 0)
        #expect(chunks[0].startedAt == clock.now)
        #expect(chunks[0].endedAt == clock.now + 4)
        #expect(b.isEmpty)
        // Patch images count too, and the count restarts with the next chunk.
        b.add(makeFrame(ts: clock.now + 5))
        b.add(Frame(ts: clock.now + 6, patches: [Patch(PixelRect(x: 0, y: 0, w: 64, h: 64), jpegData: Data(count: 24))], reason: .timer))
        #expect(chunks.count == 2)
        #expect(chunks[1].frames.count == 2)
    }

    @Test func FirstFrameOfAChunkMustBeFull() {
        let b = makeBuilder()
        let patch = Frame(ts: clock.now, patches: [Patch(PixelRect(x: 0, y: 0, w: 64, h: 64), jpegData: Data([0xff, 0xd8]))], reason: .timer)
        #expect(b.needsFullFrame)
        b.add(Touch(ts: clock.now, x: 1, y: 1, phase: .began))
        #expect(b.needsFullFrame, "touches do not count")
        b.add(patch)
        #expect(b.frameCount == 0, "a patch frame with nothing to apply to is dropped")
        b.add(makeFrame(ts: clock.now))
        #expect(!b.needsFullFrame)
        b.add(patch)
        b.flush()
        #expect(chunks[0].frames.map(\.isFull) == [true, false])
        #expect(b.needsFullFrame)
    }

    @Test func ViewportChangeCutsTheChunk() {
        let b = makeBuilder()
        b.add(makeFrame(ts: clock.now))
        b.update(viewport: Viewport(width: 393, height: 852, scale: 1))
        #expect(chunks.isEmpty, "same viewport: nothing happens")
        b.update(viewport: Viewport(width: 852, height: 393, scale: 1))
        #expect(chunks.count == 1)
        #expect(chunks[0].viewport == Viewport(width: 393, height: 852, scale: 1))
        #expect(b.needsFullFrame)
        b.add(makeFrame(ts: clock.now))
        b.flush()
        #expect(chunks[1].viewport == Viewport(width: 852, height: 393, scale: 1))
    }

    @Test func FlushesWhenFiveSecondsElapsed() {
        let b = makeBuilder()
        b.add(makeFrame(ts: clock.now))
        clock.advance(ms: 4_999)
        #expect(!(b.flushIfDue()))
        b.add(Touch(ts: clock.now, x: 1, y: 2, phase: .began))
        #expect(chunks.isEmpty)
        clock.advance(ms: 1)
        #expect(b.flushIfDue())
        #expect(chunks.count == 1)
        #expect(chunks[0].frames.count == 1)
        #expect(chunks[0].touches.count == 1)
        #expect(chunks[0].endedAt - chunks[0].startedAt == 4_999)
    }

    @Test func AddingPastTheIntervalFlushesImmediately() {
        let b = makeBuilder()
        b.add(makeFrame(ts: clock.now))
        clock.advance(ms: 6_000)
        b.add(makeFrame(ts: clock.now))
        // The late frame joins the overdue chunk, which is then cut at once.
        #expect(chunks.count == 1)
        #expect(chunks[0].frames.count == 2)
    }

    @Test func ExplicitFlushAndEmptyFlushIsNoop() {
        let b = makeBuilder()
        b.flush()
        #expect(chunks.isEmpty)
        b.add(Touch(ts: clock.now, x: 0, y: 0, phase: .ended))
        b.flush()
        #expect(chunks.count == 1)
        #expect(chunks[0].frames.count == 0)
        #expect(chunks[0].touches.count == 1)
        b.flush()
        #expect(chunks.count == 1)
    }

    @Test func SeqIsMonotonicAndStartsAtZeroPerSession() {
        let b = makeBuilder(maxImageBytes: 1)
        b.add(makeFrame(ts: clock.now))
        b.add(makeFrame(ts: clock.now))
        b.add(makeFrame(ts: clock.now))
        #expect(chunks.map(\.seq) == [0, 1, 2])
        #expect(chunks.map(\.sessionId) == ["session-a", "session-a", "session-a"])
    }

    @Test func RotationFlushesOldSessionAndResetsSeq() {
        let b = makeBuilder()
        b.add(makeFrame(ts: clock.now))
        b.add(makeFrame(ts: clock.now))
        sessionId = "session-b"
        b.sessionDidRotate(newId: "session-b")
        #expect(chunks.count == 1)
        #expect(chunks[0].sessionId == "session-a")
        #expect(chunks[0].seq == 0)
        b.add(makeFrame(ts: clock.now))
        b.flush()
        #expect(chunks[1].sessionId == "session-b")
        #expect(chunks[1].seq == 0)
        b.add(makeFrame(ts: clock.now))
        b.flush()
        #expect(chunks[2].seq == 1)
    }

    @Test func SessionIdCapturedWhenChunkOpens() {
        let b = makeBuilder()
        b.add(makeFrame(ts: clock.now))
        // The host's session id changes without a rotation call (should not happen, but must not relabel).
        sessionId = "session-c"
        b.add(makeFrame(ts: clock.now))
        b.flush()
        #expect(chunks[0].sessionId == "session-a")
        b.add(makeFrame(ts: clock.now))
        b.flush()
        #expect(chunks[1].sessionId == "session-c")
        #expect(chunks[1].seq == 0, "a new session id restarts the seq in the store")
    }

    @Test func ViewportModeAndMaskedAreCopied() {
        let b = makeBuilder(mode: "navigation")
        b.update(viewport: Viewport(width: 1, height: 2, scale: 3))
        b.add(makeFrame(ts: clock.now))
        b.flush()
        #expect(chunks[0].viewport == Viewport(width: 1, height: 2, scale: 3))
        #expect(chunks[0].mode == "navigation")
        #expect(chunks[0].schemaVersion == 2)
        #expect(chunks[0].masked)
        #expect(chunks[0].platform == "ios")
        #expect(chunks[0].kind == "frames")
    }
}
