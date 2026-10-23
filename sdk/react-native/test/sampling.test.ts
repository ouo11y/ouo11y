import { describe, expect, it, vi } from "vitest";
import type { LogRecordProcessor, SdkLogRecord } from "@opentelemetry/sdk-logs";
import type { ReadableSpan, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { createLogger } from "../src/logger";
import { createReplayController, type NativeReplayModule } from "../src/replay";
import { SAMPLING_SALT, SampledLogProcessor, SampledSpanProcessor, sampled, sampleRate, samplingHash } from "../src/sampling";

// Shared with services/rum-api/internal/sampling/sampling_test.go: the server-side cap and the
// SDK must agree on every session id.
const VECTORS: Array<[string, number]> = [
  ["", 0xab3e7c0b],
  ["a", 0x1a80b1b3],
  ["replay:3c63803d-6d13-4d79-944a-72c1c26f23cb", 0x1a72a21c],
  ["session:é😀x", 0x30555dd9],
];

/** First id `prefix-N` for which `pred` holds. */
function findId(prefix: string, pred: (id: string) => boolean): string {
  for (let i = 0; i < 10000; i++) {
    const id = `${prefix}-${i}`;
    if (pred(id)) return id;
  }
  throw new Error("no id found");
}

describe("sampling rule", () => {
  it("matches the Go reference vectors", () => {
    for (const [s, h] of VECTORS) expect(samplingHash(s)).toBe(h);
  });

  it("keeps everything at 1, nothing at 0, about the rate in between, nested samples", () => {
    let half = 0;
    let fifth = 0;
    for (let i = 0; i < 20000; i++) {
      const id = `s-${i}`;
      expect(sampled(id, 1, SAMPLING_SALT.session)).toBe(true);
      expect(sampled(id, 0, SAMPLING_SALT.session)).toBe(false);
      const a = sampled(id, 0.5, SAMPLING_SALT.session);
      const b = sampled(id, 0.2, SAMPLING_SALT.session);
      if (b) expect(a).toBe(true);
      half += a ? 1 : 0;
      fifth += b ? 1 : 0;
    }
    expect(half / 20000).toBeGreaterThan(0.47);
    expect(half / 20000).toBeLessThan(0.53);
    expect(fifth / 20000).toBeGreaterThan(0.18);
    expect(fifth / 20000).toBeLessThan(0.22);
  });

  it("clamps rates", () => {
    expect(sampleRate(undefined, 1)).toBe(1);
    expect(sampleRate(Number.NaN, 0)).toBe(0);
    expect(sampleRate(2, 0)).toBe(1);
    expect(sampleRate(-1, 1)).toBe(0);
    expect(sampleRate(0.25, 1)).toBe(0.25);
  });
});

describe("sampled processors", () => {
  const inId = findId("in", (id) => sampled(id, 0.5, SAMPLING_SALT.session));
  const outId = findId("out", (id) => !sampled(id, 0.5, SAMPLING_SALT.session));

  it("forward only records and spans of sampled sessions", async () => {
    const innerLog = { onEmit: vi.fn(), forceFlush: vi.fn(() => Promise.resolve()), shutdown: vi.fn(() => Promise.resolve()) } satisfies LogRecordProcessor;
    const logs = new SampledLogProcessor(innerLog, 0.5);
    logs.onEmit({ attributes: { "session.id": inId } } as unknown as SdkLogRecord);
    logs.onEmit({ attributes: { "session.id": outId } } as unknown as SdkLogRecord);
    logs.onEmit({ attributes: {} } as unknown as SdkLogRecord);
    expect(innerLog.onEmit).toHaveBeenCalledTimes(2);
    await logs.forceFlush();
    expect(innerLog.forceFlush).toHaveBeenCalled();

    const innerSpan = { onStart: vi.fn(), onEnd: vi.fn(), forceFlush: vi.fn(() => Promise.resolve()), shutdown: vi.fn(() => Promise.resolve()) } satisfies SpanProcessor;
    const spans = new SampledSpanProcessor(innerSpan, 0.5);
    spans.onEnd({ attributes: { "session.id": inId } } as unknown as ReadableSpan);
    spans.onEnd({ attributes: { "session.id": outId } } as unknown as ReadableSpan);
    expect(innerSpan.onEnd).toHaveBeenCalledTimes(1);
  });
});

function fakeNative() {
  const state = { recording: false };
  return {
    start: vi.fn(() => {
      state.recording = true;
    }),
    pause: vi.fn(() => {
      state.recording = false;
    }),
    resume: vi.fn(() => {
      state.recording = true;
    }),
    isRecording: vi.fn(() => state.recording),
    flush: vi.fn(() => Promise.resolve()),
    sessionDidRotate: vi.fn(),
    setSessionId: vi.fn(),
    stop: vi.fn(),
  } satisfies NativeReplayModule;
}

describe("replay sampling", () => {
  const logger = createLogger(false);
  const base = { endpoint: "http://otel.test:4319", projectId: "demo", projectToken: "pt_x", logger };
  const rec = (id: string): boolean => sampled(id, 0.5, SAMPLING_SALT.replay);
  const recorded = findId("rec", rec);
  const skipped = findId("skip", (id) => !rec(id));
  const skippedOnError = findId("skip-err", (id) => !rec(id) && sampled(id, 1, SAMPLING_SALT.replayOnError));

  it("does not start the recorder for a session outside the replay sample, starts it on rotation into one", () => {
    const native = fakeNative();
    const c = createReplayController({ ...base, options: { enabled: true, sampleRate: 0.5 }, native });
    c.start(skipped);
    expect(native.start).not.toHaveBeenCalled();
    expect(c.active).toBe(false);
    c.sessionDidRotate(recorded);
    expect(native.start).toHaveBeenCalledTimes(1);
    expect(native.setSessionId).toHaveBeenCalledWith(recorded);
    expect(c.isRecording()).toBe(true);
  });

  it("pauses for unrecorded sessions and resumes for recorded ones, respecting a host pause", () => {
    const native = fakeNative();
    const c = createReplayController({ ...base, options: { enabled: true, sampleRate: 0.5 }, native });
    c.start(recorded);
    c.sessionDidRotate(skipped);
    expect(native.sessionDidRotate).toHaveBeenCalledWith(skipped);
    expect(native.pause).toHaveBeenCalledTimes(1);
    expect(c.isRecording()).toBe(false);
    const next = findId("rec2", rec);
    c.sessionDidRotate(next);
    expect(native.resume).toHaveBeenCalledTimes(1);
    expect(c.isRecording()).toBe(true);

    // Host pause survives a rotation through an unrecorded session and back.
    c.pause();
    c.sessionDidRotate(findId("skip2", (id) => !rec(id)));
    c.sessionDidRotate(findId("rec3", rec));
    expect(c.isRecording()).toBe(false);
    c.resume();
    expect(c.isRecording()).toBe(true);
  });

  it("starts recording at the first error of a session in the on-error sample", () => {
    const native = fakeNative();
    const c = createReplayController({ ...base, options: { enabled: true, sampleRate: 0.5, onErrorSampleRate: 1 }, native });
    c.start(skippedOnError);
    expect(native.start).not.toHaveBeenCalled();
    c.onError();
    expect(native.start).toHaveBeenCalledTimes(1);
    c.onError();
    expect(native.start).toHaveBeenCalledTimes(1);
    // The next unrecorded session pauses again; its own error resumes.
    const nextSkipped = findId("skip3", (id) => !rec(id));
    c.sessionDidRotate(nextSkipped);
    expect(c.isRecording()).toBe(false);
    c.onError();
    expect(c.isRecording()).toBe(true);
  });

  it("never records with onErrorSampleRate 0 (default) or outside the session sample", () => {
    const native = fakeNative();
    const c = createReplayController({ ...base, options: { enabled: true, sampleRate: 0.5 }, native });
    c.start(skipped);
    c.onError();
    expect(native.start).not.toHaveBeenCalled();

    const native2 = fakeNative();
    const outOfSession = findId("nosess", (id) => !sampled(id, 0.5, SAMPLING_SALT.session));
    const c2 = createReplayController({ ...base, options: { enabled: true, onErrorSampleRate: 1 }, sessionSampleRate: 0.5, native: native2 });
    c2.start(outOfSession);
    c2.onError();
    expect(native2.start).not.toHaveBeenCalled();
  });
});
