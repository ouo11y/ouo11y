/**
 * Counterpart of sdk/browser/test/rotation.test.ts (QA phase 6 bug 1): exactly one
 * `session.end` and one `session.start` must be exported per rotation when the manager's
 * events go through the real log pipeline used by `initRUM()`:
 * SessionManager -> EventEmitter -> LoggerProvider [SessionLogProcessor, exporter].
 * The mobile SessionLogProcessor never calls `session.id()` for a record that already
 * names its session, so this guards against the browser bug being reintroduced here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryLogRecordExporter, LoggerProvider, SimpleLogRecordProcessor } from "@opentelemetry/sdk-logs";
import type { Clock } from "../src/session/clock";
import { SessionManager, type ProcessState, type SessionEvent } from "../src/session/manager";
import { MemoryAsyncStorage } from "../src/session/storage";
import { EventEmitter } from "../src/telemetry/events";
import { SessionLogProcessor } from "../src/telemetry/correlation";
import { createLogger } from "../src/logger";

const MIN = 60_000;
const INACTIVITY = 30 * MIN;
const MAX = 4 * 60 * MIN;
const SERVICE_VERSION = "2.3.0";

const fakeClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

interface Pipeline {
  session: SessionManager;
  exporter: InMemoryLogRecordExporter;
  provider: LoggerProvider;
  lifecycle(): Array<{ name: string; attrs: Record<string, unknown> }>;
}

function pipeline(storage: MemoryAsyncStorage, process: ProcessState): Pipeline {
  const exporter = new InMemoryLogRecordExporter();
  let events: EventEmitter;
  const session = new SessionManager({
    storage,
    serviceVersion: SERVICE_VERSION,
    clock: fakeClock,
    inactivityTimeoutMs: INACTIVITY,
    maxDurationMs: MAX,
    process,
    onEvent: (e: SessionEvent) => events.emit(e.name, e.attributes, "info", e.timestamp),
  });
  const provider = new LoggerProvider({
    processors: [new SessionLogProcessor(session, SERVICE_VERSION), new SimpleLogRecordProcessor({ exporter })],
  });
  events = new EventEmitter(provider.getLogger("test"), createLogger(false));
  return {
    session,
    exporter,
    provider,
    lifecycle: () =>
      exporter
        .getFinishedLogRecords()
        .filter((r) => r.eventName === "session.start" || r.eventName === "session.end")
        .map((r) => ({ name: r.eventName!, attrs: { ...r.attributes } })),
  };
}

const started: Pipeline[] = [];
async function startPipeline(storage: MemoryAsyncStorage, process: ProcessState): Promise<Pipeline> {
  const p = pipeline(storage, process);
  started.push(p);
  await p.session.start();
  return p;
}

describe("session rotation through the OTel log pipeline (mobile)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-08T10:00:00Z"));
  });
  afterEach(async () => {
    for (const p of started.splice(0)) {
      p.session.stop();
      await p.provider.shutdown();
    }
  });

  it("case 3 (warm re-init): exactly one session.end and one session.start", async () => {
    const storage = new MemoryAsyncStorage();
    const process: ProcessState = {};
    const first = await startPipeline(storage, process);
    const oldId = first.session.id();
    expect(first.lifecycle().map((r) => r.name)).toEqual(["session.start"]);
    first.session.stop();

    vi.advanceTimersByTime(INACTIVITY + MIN);
    const second = await startPipeline(storage, process);
    const records = second.lifecycle();
    expect(records.map((r) => r.name)).toEqual(["session.end", "session.start"]);
    expect(records[0]!.attrs["session.id"]).toBe(oldId);
    expect(records[0]!.attrs["ouo.session.end_reason"]).toBe("inactivity");
    expect(records[0]!.attrs["session.previous_id"]).toBeUndefined();
    expect(records[0]!.attrs["service.version"]).toBe(SERVICE_VERSION);
    expect(records[1]!.attrs["session.id"]).toBe(second.session.id());
    expect(records[1]!.attrs["session.previous_id"]).toBe(oldId);
    expect(second.session.id()).not.toBe(oldId);
  });

  it("case 3 (cold start): exactly one session.end and one session.start", async () => {
    const storage = new MemoryAsyncStorage();
    const first = await startPipeline(storage, {});
    const oldId = first.session.id();
    first.session.stop();

    vi.advanceTimersByTime(INACTIVITY + MIN);
    const second = await startPipeline(storage.clone(), {});
    const records = second.lifecycle();
    expect(records.map((r) => r.name)).toEqual(["session.end", "session.start"]);
    expect(records[0]!.attrs["session.id"]).toBe(oldId);
    expect(records[0]!.attrs["ouo.session.end_reason"]).toBe("inactivity");
    expect(records[1]!.attrs["session.id"]).toBe(second.session.id());
    expect(records[1]!.attrs["session.previous_id"]).toBe(oldId);
  });

  it("case 4: max-duration rotation on activity exports exactly one session.end and one session.start", async () => {
    const storage = new MemoryAsyncStorage();
    const p = await startPipeline(storage, {});
    const oldId = p.session.id();
    for (let t = 0; t < MAX; t += 10 * MIN) {
      vi.advanceTimersByTime(10 * MIN);
      p.session.touch();
    }
    const records = p.lifecycle();
    expect(records.map((r) => r.name)).toEqual(["session.start", "session.end", "session.start"]);
    expect(records[1]!.attrs["session.id"]).toBe(oldId);
    expect(records[1]!.attrs["ouo.session.end_reason"]).toBe("max_duration");
    expect(records[2]!.attrs["session.id"]).toBe(p.session.id());
    expect(records[2]!.attrs["session.previous_id"]).toBe(oldId);
    expect(p.session.id()).not.toBe(oldId);
  });
});
