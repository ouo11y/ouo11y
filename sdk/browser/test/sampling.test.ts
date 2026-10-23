import { describe, expect, it } from "vitest";
import { SamplingDecision } from "@opentelemetry/sdk-trace-base";
import { SessionManager, SESSION_STORAGE_KEY, type SessionEvent } from "../src/session/manager";
import { isSampled, samplingHash } from "../src/session/sampling";
import { MemoryStorage } from "../src/session/storage";
import { SampledLogProcessor, SessionSampler } from "../src/telemetry/sampling";

function manager(storage: MemoryStorage, opts: { rate?: number } = {}, events: SessionEvent[] = []) {
  const m = new SessionManager({
    storage,
    onEvent: (e) => events.push(e),
    ...(opts.rate !== undefined ? { sessionSampleRate: opts.rate } : {}),
  });
  m.start();
  return m;
}

/** A rate just above / below a session's hash for a salt, so the decision is known. */
const fraction = (id: string, salt: string) => samplingHash(`${salt}:${id}`) / 2 ** 32;

describe("shared sampling rule (browser, React Native, rum-api)", () => {
  it("matches the agreed test vectors: FNV-1a 32 over UTF-16 code units, then MurmurHash3 fmix32", () => {
    expect(samplingHash("")).toBe(0xab3e7c0b);
    expect(samplingHash("a")).toBe(0x1a80b1b3);
    expect(samplingHash("replay:3c63803d-6d13-4d79-944a-72c1c26f23cb")).toBe(0x1a72a21c);
    expect(samplingHash("session:é😀x")).toBe(0x30555dd9);
  });

  it("samples iff hash / 2^32 < rate; 0 and 1 are exact", () => {
    const id = "3c63803d-6d13-4d79-944a-72c1c26f23cb";
    const f = fraction(id, "replay");
    expect(f).toBeCloseTo(0x1a72a21c / 2 ** 32, 12);
    expect(isSampled(id, f + 1e-9, "replay")).toBe(true);
    expect(isSampled(id, f, "replay")).toBe(false);
    expect(isSampled(id, 1, "replay")).toBe(true);
    expect(isSampled(id, 0, "replay")).toBe(false);
  });

  it("a lower rate keeps a subset of a higher one (a server cap is consistent with the client)", () => {
    const ids = Array.from({ length: 2000 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    const at = (r: number) => new Set(ids.filter((id) => isSampled(id, r, "session")));
    const high = at(0.5);
    const low = at(0.1);
    for (const id of low) expect(high.has(id)).toBe(true);
    expect(low.size / ids.length).toBeGreaterThan(0.07);
    expect(low.size / ids.length).toBeLessThan(0.13);
  });

  it("session and replay decisions of one id are independent", () => {
    const ids = Array.from({ length: 4000 }, (_, i) => `id-${i}`);
    const both = ids.filter((id) => isSampled(id, 0.5, "session") && isSampled(id, 0.5, "replay")).length;
    expect(both / ids.length).toBeGreaterThan(0.22);
    expect(both / ids.length).toBeLessThan(0.28);
  });
});

describe("session sampling (roadmap 8b)", () => {
  it("decides from the session id once and persists the decision", () => {
    const storage = new MemoryStorage();
    const m = manager(storage, { rate: 0.5 });
    const want = isSampled(m.id(), 0.5, "session");
    expect(m.sampled()).toBe(want);
    expect(JSON.parse(storage.get(SESSION_STORAGE_KEY)!).sampled).toBe(want);
    // A reload with another rate keeps the session's first decision.
    expect(manager(storage, { rate: want ? 0 : 1 }).sampled()).toBe(want);
  });

  it("rate 1 (the default) and 0", () => {
    expect(manager(new MemoryStorage(), { rate: 1 }).sampled()).toBe(true);
    expect(manager(new MemoryStorage(), { rate: 0 }).sampled()).toBe(false);
    expect(manager(new MemoryStorage()).sampled()).toBe(true);
  });

  it("another tab's decision is adopted through the storage event", () => {
    const storage = new MemoryStorage();
    const a = manager(storage, { rate: 1 });
    const rec = { ...JSON.parse(storage.get(SESSION_STORAGE_KEY)!), sampled: false, replayTriggered: true };
    a.handleStorageEvent(JSON.stringify(rec));
    expect(a.sampled()).toBe(false);
    expect(a.replayTriggered()).toBe(true);
  });

  it("the sampler records spans of sampled sessions only", () => {
    const yes = new SessionSampler(manager(new MemoryStorage(), { rate: 1 }));
    const no = new SessionSampler(manager(new MemoryStorage(), { rate: 0 }));
    expect(yes.shouldSample().decision).toBe(SamplingDecision.RECORD_AND_SAMPLED);
    expect(no.shouldSample().decision).toBe(SamplingDecision.NOT_RECORD);
  });

  it("the log filter drops records of unsampled sessions, judging session.end by the session it ends", () => {
    const m = manager(new MemoryStorage(), { rate: 0 });
    const kept: unknown[] = [];
    const inner = { onEmit: (r: unknown) => kept.push(r), forceFlush: async () => undefined, shutdown: async () => undefined };
    const p = new SampledLogProcessor(m, inner);
    const rec = (attrs: Record<string, unknown>) => ({ attributes: attrs }) as never;
    p.onEmit(rec({ "session.id": m.id() }));
    p.onEmit(rec({ "session.id": "some-other-session" }));
    p.onEmit(rec({}));
    expect(kept).toHaveLength(2);
  });

  it("replay and error-triggered replay use their own salts", () => {
    const storage = new MemoryStorage();
    const m = manager(storage);
    const id = m.id();
    const r = fraction(id, "replay");
    const e = fraction(id, "replay_on_error");
    expect(m.replaySampled(r)).toBe(false); // rate equal to the hash: not sampled
    expect(m.replayOnError(Math.min(1, e + 1e-9))).toBe(true);
    expect(m.replayTriggered()).toBe(false);
    m.triggerReplay();
    expect(m.replayTriggered()).toBe(true);
    expect(JSON.parse(storage.get(SESSION_STORAGE_KEY)!)).toMatchObject({ replaySampled: false, replayOnError: true, replayTriggered: true });
  });
});
