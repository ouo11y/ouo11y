/**
 * Regression for agents/qa/reports/phase-6-bugs.html bug 1: rotating an expired session
 * emitted two `session.start` records (the OTel log processor asked for the active session
 * id while `session.end` was being emitted, which lazily created a session before the
 * caller created its own). Drives the real processor chain used by `initRUM()`:
 * SessionManager -> EventEmitter -> LoggerProvider [SessionLogProcessor, exporter].
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryLogRecordExporter, LoggerProvider, SimpleLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { SessionManager, type SessionEvent } from "../src/session/manager";
import { MemoryStorage } from "../src/session/storage";
import type { Clock } from "../src/session/clock";
import { EventEmitter } from "../src/telemetry/events";
import { SessionLogProcessor } from "../src/telemetry/correlation";
import { createLogger } from "../src/logger";

const MIN = 60_000;
const INACTIVITY = 30 * MIN;
const MAX = 4 * 60 * MIN;
const SERVICE_VERSION = "1.4.2";

const fakeClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

interface Pipeline {
  session: SessionManager;
  exporter: InMemoryLogRecordExporter;
  provider: LoggerProvider;
  /** `session.start` / `session.end` records as exported, in emission order. */
  lifecycle(): Array<{ name: string; attrs: Record<string, unknown> }>;
}

/** Same wiring as initRUM(): the manager emits into a logger whose processor stamps session ids. */
function pipeline(storage: MemoryStorage): Pipeline {
  const exporter = new InMemoryLogRecordExporter();
  let events: EventEmitter;
  const session = new SessionManager({
    storage,
    clock: fakeClock,
    inactivityTimeoutMs: INACTIVITY,
    maxDurationMs: MAX,
    onEvent: (e: SessionEvent) => events.emit(e.name, e.attributes, "info"),
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
function startPipeline(storage: MemoryStorage): Pipeline {
  const p = pipeline(storage);
  started.push(p);
  p.session.start();
  return p;
}

describe("session rotation through the OTel log pipeline (QA bug 1)", () => {
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

  it("case 3: init after the inactivity window exports exactly one session.end and one session.start", () => {
    const storage = new MemoryStorage();
    const first = startPipeline(storage);
    const oldId = first.session.id();
    expect(first.lifecycle().map((r) => r.name)).toEqual(["session.start"]);
    first.session.stop();

    vi.setSystemTime(Date.now() + INACTIVITY + MIN);
    const second = startPipeline(storage);
    const newId = second.session.id();
    const records = second.lifecycle();

    expect(records.map((r) => r.name)).toEqual(["session.end", "session.start"]);
    expect(records.filter((r) => r.name === "session.start")).toHaveLength(1);
    expect(records.filter((r) => r.name === "session.end")).toHaveLength(1);

    const end = records[0]!.attrs;
    expect(end["session.id"]).toBe(oldId);
    expect(end["ouo.session.end_reason"]).toBe("inactivity");
    expect(end["session.previous_id"]).toBeUndefined();
    expect(end["user.id"]).toBe(second.session.userId());
    expect(end["service.version"]).toBe(SERVICE_VERSION);
    expect(end["ouo.platform"]).toBe("web");

    const start = records[1]!.attrs;
    expect(newId).not.toBe(oldId);
    expect(start["session.id"]).toBe(newId);
    expect(start["session.previous_id"]).toBe(oldId);

    // The first signal of the new session (any other log record) carries the new id and previous_id.
    second.provider.getLogger("test").emit({ body: "navigation", attributes: { "event.name": "navigation" } });
    const nav = second.exporter.getFinishedLogRecords().find((r) => r.attributes["event.name"] === "navigation")!;
    expect(nav.attributes["session.id"]).toBe(newId);
    expect(nav.attributes["session.previous_id"]).toBe(oldId);
    // Only the surviving id is persisted; nothing was written for a phantom session.
    expect(JSON.parse(storage.get("ouo.session")!).id).toBe(newId);
  });

  it("case 4: max-duration rotation on activity exports exactly one session.end and one session.start", () => {
    const storage = new MemoryStorage();
    const noTimerClock: Clock = { now: () => Date.now(), setTimeout: () => null, clearTimeout: () => undefined };
    const exporter = new InMemoryLogRecordExporter();
    let events: EventEmitter;
    const session = new SessionManager({
      storage,
      clock: noTimerClock,
      inactivityTimeoutMs: INACTIVITY,
      maxDurationMs: MAX,
      onEvent: (e) => events.emit(e.name, e.attributes, "info"),
    });
    const provider = new LoggerProvider({
      processors: [new SessionLogProcessor(session, SERVICE_VERSION), new SimpleLogRecordProcessor({ exporter })],
    });
    events = new EventEmitter(provider.getLogger("test"), createLogger(false));
    session.start();
    const oldId = session.id();
    for (let t = 10 * MIN; t < MAX; t += 10 * MIN) {
      vi.setSystemTime(Date.now() + 10 * MIN);
      session.touch();
    }
    vi.setSystemTime(Date.now() + 10 * MIN);
    session.touch();

    const lifecycle = exporter
      .getFinishedLogRecords()
      .filter((r) => r.eventName === "session.start" || r.eventName === "session.end")
      .map((r) => ({ name: r.eventName!, attrs: r.attributes }));
    expect(lifecycle.map((r) => r.name)).toEqual(["session.start", "session.end", "session.start"]);
    expect(lifecycle[1]!.attrs["session.id"]).toBe(oldId);
    expect(lifecycle[1]!.attrs["ouo.session.end_reason"]).toBe("max_duration");
    expect(lifecycle[2]!.attrs["session.id"]).toBe(session.id());
    expect(lifecycle[2]!.attrs["session.previous_id"]).toBe(oldId);
    expect(session.id()).not.toBe(oldId);
  });

  it("case 4 (timer path): the same-tab max-duration timer ends the session; lazy restart emits one session.start", () => {
    const storage = new MemoryStorage();
    const p = startPipeline(storage);
    const oldId = p.session.id();
    for (let t = 0; t < MAX; t += 10 * MIN) {
      vi.advanceTimersByTime(10 * MIN);
      if (t + 10 * MIN < MAX) p.session.touch();
    }
    expect(p.lifecycle().map((r) => r.name)).toEqual(["session.start", "session.end"]);
    expect(p.session.peek()).toBeNull();
    p.session.touch();
    const names = p.lifecycle().map((r) => r.name);
    expect(names).toEqual(["session.start", "session.end", "session.start"]);
    expect(p.lifecycle()[2]!.attrs["session.previous_id"]).toBe(oldId);
  });
});

describe("SessionManager re-entrancy", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-08T10:00:00Z"));
  });

  it("an event consumer calling id() during session.end sees the replacement, not a second session", () => {
    const storage = new MemoryStorage();
    const seen: Array<{ name: string; id: unknown; activeId: string }> = [];
    let m: SessionManager;
    const make = () =>
      new SessionManager({
        storage,
        clock: fakeClock,
        inactivityTimeoutMs: INACTIVITY,
        maxDurationMs: MAX,
        // Mimics the pre-fix SessionLogProcessor: asks for the active id for every event.
        onEvent: (e) => seen.push({ name: e.name, id: e.attributes["session.id"], activeId: m.id() }),
      });
    m = make();
    m.start();
    const oldId = m.id();
    m.stop();
    seen.length = 0;

    vi.setSystemTime(Date.now() + INACTIVITY + MIN);
    m = make();
    m.start();
    expect(seen.map((s) => s.name)).toEqual(["session.end", "session.start"]);
    expect(seen[0]!.id).toBe(oldId);
    expect(seen[0]!.activeId).toBe(m.id());
    expect(seen[1]!.id).toBe(m.id());
    expect(m.previousId()).toBe(oldId);
    m.stop();
  });
});
