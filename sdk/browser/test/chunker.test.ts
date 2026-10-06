import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { ReplayChunker, estimateBytes, type ReplayChunk, type UploadOptions } from "../src/replay/chunker";
import type { Clock } from "../src/session/clock";

const clock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

function event(size = 10, timestamp = Date.now()) {
  return { type: 3, timestamp, data: { p: "x".repeat(size) } };
}

type Upload = Mock<(chunk: ReplayChunk, options: UploadOptions) => Promise<void>>;

function makeChunker(upload: Upload = vi.fn(async () => undefined), extra: Partial<ConstructorParameters<typeof ReplayChunker>[0]> = {}) {
  let seq = 0;
  const chunker = new ReplayChunker({
    sessionId: () => "sess-1",
    nextSeq: () => seq++,
    upload,
    clock,
    ...extra,
  });
  return { chunker, upload };
}

describe("ReplayChunker (ADR-0003)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-06T10:00:00Z"));
  });

  it("flushes after 5 s with the chunk envelope and monotonic seq", async () => {
    const { chunker, upload } = makeChunker();
    const t0 = Date.now();
    chunker.push(event(10, t0));
    vi.advanceTimersByTime(4999);
    expect(upload).not.toHaveBeenCalled();
    chunker.push(event(10, t0 + 4999));
    vi.advanceTimersByTime(1);
    await vi.runOnlyPendingTimersAsync();
    expect(upload).toHaveBeenCalledTimes(1);
    const [chunk, opts] = upload.mock.calls[0] as unknown as [ReplayChunk, { keepalive: boolean }];
    expect(chunk).toMatchObject({ session_id: "sess-1", seq: 0, started_at: t0, ended_at: t0 + 4999 });
    expect(chunk.events).toHaveLength(2);
    expect(opts.keepalive).toBe(false);

    chunker.push(event());
    vi.advanceTimersByTime(5000);
    await vi.runOnlyPendingTimersAsync();
    expect(upload).toHaveBeenCalledTimes(2);
    expect((upload.mock.calls[1] as unknown as [ReplayChunk])[0].seq).toBe(1);
  });

  it("flushes early when the buffer reaches 256 KB", async () => {
    const { chunker, upload } = makeChunker();
    const big = event(100 * 1024);
    const bytes = estimateBytes(big);
    chunker.push(big);
    chunker.push(big);
    expect(upload).not.toHaveBeenCalled();
    expect(chunker.pendingBytes()).toBe(2 * bytes);
    chunker.push(big); // crosses 256 KB
    await Promise.resolve();
    expect(upload).toHaveBeenCalledTimes(1);
    expect((upload.mock.calls[0] as unknown as [ReplayChunk])[0].events).toHaveLength(3);
    expect(chunker.bufferedEvents()).toBe(0);
    // The 5 s timer was cancelled by the early flush.
    vi.advanceTimersByTime(5000);
    await vi.runOnlyPendingTimersAsync();
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it("retries with backoff up to 3 attempts, then drops the chunk", async () => {
    const upload: Upload = vi.fn(async () => {
      throw new Error("503");
    });
    const { chunker } = makeChunker(upload);
    chunker.push(event());
    const p = chunker.flush();
    await Promise.resolve();
    expect(upload).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(upload).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(upload).toHaveBeenCalledTimes(3);
    await p;
    expect(chunker.queuedChunks()).toBe(0);
    expect(chunker.pendingBytes()).toBe(0);
  });

  it("keeps the pending bytes bounded at 2 MB by dropping the oldest queued chunks", async () => {
    let release: () => void = () => undefined;
    const upload: Upload = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
    const { chunker } = makeChunker(upload);
    const big = event(300 * 1024); // each push flushes immediately (> 256 KB)
    for (let i = 0; i < 10; i++) chunker.push(big);
    expect(chunker.pendingBytes()).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(chunker.queuedChunks()).toBeLessThan(10);
    release();
  });

  it("keepalive flush sends every queued chunk immediately with keepalive and no retry", async () => {
    const upload: Upload = vi.fn(async () => undefined);
    const { chunker } = makeChunker(upload);
    chunker.push(event());
    await chunker.flush({ keepalive: true });
    expect(upload).toHaveBeenCalledTimes(1);
    expect((upload.mock.calls[0] as unknown as [ReplayChunk, { keepalive: boolean }])[1].keepalive).toBe(true);
  });

  it("captures the session id when the buffer starts so a rotation does not relabel events", async () => {
    let session = "A";
    let seq = 0;
    const upload = vi.fn(async () => undefined);
    const chunker = new ReplayChunker({ sessionId: () => session, nextSeq: () => seq++, upload, clock });
    chunker.push(event());
    session = "B";
    await chunker.flush();
    expect((upload.mock.calls[0] as unknown as [ReplayChunk])[0].session_id).toBe("A");
    chunker.push(event());
    await chunker.flush();
    expect((upload.mock.calls[1] as unknown as [ReplayChunk])[0].session_id).toBe("B");
  });

  it("cut() on an empty buffer returns null", () => {
    const { chunker } = makeChunker();
    expect(chunker.cut()).toBeNull();
  });
});
