import { describe, expect, it } from "vitest";
import { SamplingDecision } from "@opentelemetry/sdk-trace-base";
import { SessionManager, SESSION_STORAGE_KEY, type SessionEvent } from "../src/session/manager";
import { MemoryStorage } from "../src/session/storage";
import { SampledLogProcessor, SessionSampler } from "../src/telemetry/sampling";

function manager(storage: MemoryStorage, opts: { rate?: number; random?: () => number } = {}, events: SessionEvent[] = []) {
  const m = new SessionManager({
    storage,
    onEvent: (e) => events.push(e),
    ...(opts.rate !== undefined ? { sessionSampleRate: opts.rate } : {}),
    ...(opts.random ? { random: opts.random } : {}),
  });
  m.start();
  return m;
}

describe("session sampling (roadmap 8b)", () => {
  it("decides once per session against the rate and persists the decision", () => {
    const storage = new MemoryStorage();
    let calls = 0;
    const m = manager(storage, { rate: 0.5, random: () => (calls++, 0.7) });
    expect(m.sampled()).toBe(false);
    expect(m.sampled()).toBe(false);
    expect(calls).toBe(1);
    expect(JSON.parse(storage.get(SESSION_STORAGE_KEY)!).sampled).toBe(false);
    // A reload (new manager, same storage) keeps the decision without drawing again.
    const again = manager(storage, { rate: 0.5, random: () => 0 });
    expect(again.sampled()).toBe(false);
  });

  it("rate 1 and 0 never draw", () => {
    const random = () => {
      throw new Error("drawn");
    };
    expect(manager(new MemoryStorage(), { rate: 1, random }).sampled()).toBe(true);
    expect(manager(new MemoryStorage(), { rate: 0, random }).sampled()).toBe(false);
    expect(manager(new MemoryStorage(), { random }).sampled()).toBe(true);
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

  it("replay sampling and error-triggered replay are separate decisions", () => {
    const storage = new MemoryStorage();
    const m = manager(storage, { random: () => 0.3 });
    expect(m.replaySampled(0.2)).toBe(false);
    expect(m.replayOnError(0.5)).toBe(true);
    expect(m.replayTriggered()).toBe(false);
    m.triggerReplay();
    expect(m.replayTriggered()).toBe(true);
    expect(JSON.parse(storage.get(SESSION_STORAGE_KEY)!)).toMatchObject({ replaySampled: false, replayOnError: true, replayTriggered: true });
  });
});
