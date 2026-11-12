/**
 * Session rules (spec SES-5, SES-6, SES-9, SES-10, LIF-13) and the sampling bypass set (SMP-1,
 * SMP-3 to SMP-7, PRP-4), through `initRUM` against a stubbed collector and on the manager.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DROP_REPORT_INTERVAL_MS } from "../src/drops";
import { initRUM, type RUMInternal } from "../src/index";
import { getRUM } from "../src/instance";
import { SESSION_STORAGE_KEY, SessionManager, type SessionEvent, type SessionRecord } from "../src/session/manager";
import { MemoryAsyncStorage } from "../src/session/storage";
import type { RUMOptions } from "../src/types";
import { nativeReplay, resetNative } from "./mocks/expo-modules-core";
import { AppState } from "./mocks/react-native";
import { attr, BACKEND, baseOptions, g, installErrorUtils, installFetchStub, sleep, type Captured } from "./support/otlp";

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  installErrorUtils();
  resetNative();
  AppState.currentState = "active";
  delete g.__ouoSessionProcessState;
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await (getRUM() as RUMInternal | undefined)?._uninstall();
  globalThis.fetch = originalFetch;
  AppState.currentState = "active";
  delete g.ErrorUtils;
  delete g.__ouoSessionProcessState;
  delete g.expo;
});

async function start(extra: Partial<RUMOptions> = {}, storage = new MemoryAsyncStorage()): Promise<{ rum: RUMInternal; captured: Captured; storage: MemoryAsyncStorage }> {
  const captured = installFetchStub();
  const rum = initRUM({ ...baseOptions(storage), ...extra } as RUMOptions) as RUMInternal;
  await rum.ready;
  return { rum, captured, storage };
}

/** Moves the wall clock without waiting. */
function at(ms: number): void {
  vi.spyOn(Date, "now").mockImplementation(() => ms);
}

const names = (c: Captured): string[] => c.logs.map((l) => String(attr(l.attributes, "event.name")));
const dropped = (c: Captured): string[] =>
  c.byName("ouo.sdk.dropped").map((l) => `${attr(l.attributes, "ouo.sdk.drop.signal")}/${attr(l.attributes, "ouo.sdk.drop.reason")}=${attr(l.attributes, "ouo.sdk.drop.count")}`);
const unhandled = (message: string): void => g.ErrorUtils!.getGlobalHandler()(new Error(message), false);

describe("session rules", () => {
  it("SES-5, SES-10: requests and telemetry neither extend nor start a session; without one, records are dropped (no_session) and the bypass set goes out marked expired", async () => {
    const { rum, captured } = await start();
    const t0 = Date.now();
    const first = rum.session.id();
    // 29 minutes of requests and events, no touch: none of it is activity.
    for (const minute of [10, 20, 29]) {
      at(t0 + minute * 60_000);
      await fetch(`${BACKEND}/api/poll`);
      rum.recordEvent("poll.done");
    }
    expect(rum.getSessionId()).toBe(first);
    // Past the inactivity timeout: the session is over, and nothing but activity starts another.
    at(t0 + 31 * 60_000);
    expect(rum.getSessionId()).toBeUndefined();
    expect(rum.session.id()).toBe(first); // the last one, for display; reading it starts nothing
    await fetch(`${BACKEND}/api/poll`);
    rum.recordEvent("poll.after.expiry");
    rum.log.info("a log line");
    rum.recordException(new Error("handled, not in the bypass set"));
    unhandled("unhandled after expiry");
    expect(rum.getSessionId()).toBeUndefined();
    await rum.flush();

    expect(captured.byName("poll.done")).toHaveLength(3);
    expect(captured.byName("poll.after.expiry")).toHaveLength(0);
    expect(captured.byName("log")).toHaveLength(0);
    const end = captured.byName("session.end")[0]!;
    expect(attr(end.attributes, "ouo.session.end_reason")).toBe("inactivity");
    const errors = captured.byName("exception");
    expect(errors).toHaveLength(1);
    expect(attr(errors[0]!.attributes, "exception.message")).toBe("unhandled after expiry");
    expect(attr(errors[0]!.attributes, "session.id")).toBe(first);
    expect(attr(errors[0]!.attributes, "ouo.session.expired")).toBe(true);
    expect(captured.byName("session.start")).toHaveLength(1);
    // Spans of the expired period are dropped too.
    expect(captured.spans).toHaveLength(3);

    // Activity (a touch) starts the next session, linked to the last.
    rum.recordActivity();
    const second = rum.getSessionId()!;
    expect(second).not.toBe(first);
    rum.recordEvent("back");
    vi.restoreAllMocks();
    await sleep(DROP_REPORT_INTERVAL_MS + 100);
    await rum.flush();
    const back = captured.byName("back")[0]!;
    expect(attr(back.attributes, "session.id")).toBe(second);
    expect(attr(back.attributes, "ouo.session.expired")).toBeUndefined();
    expect(attr(captured.byName("session.start")[1]!.attributes, "session.previous_id")).toBe(first);
    // The event, the log line, the handled exception and the request's timeline event; and the request's span.
    expect(dropped(captured).sort()).toEqual(["log/no_session=4", "span/no_session=1"]);
  });

  it("SES-9: at the maximum duration with the user present the next session starts at once, linked", async () => {
    vi.useFakeTimers();
    const events: SessionEvent[] = [];
    const manager = new SessionManager({ storage: new MemoryAsyncStorage(), process: {}, maxDurationMs: 60 * 60_000, onEvent: (e) => events.push(e) });
    await manager.start();
    const first = manager.peek()!.id;
    // The user stays active: a touch every 10 minutes.
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      manager.touch();
    }
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    // No activity was needed: the timer rolled the session.
    const second = manager.peek()!;
    expect(second.id).not.toBe(first);
    expect(second.previousId).toBe(first);
    expect(events.map((e) => [e.name, e.attributes["ouo.session.end_reason"]])).toEqual([
      ["session.start", undefined],
      ["session.end", "max_duration"],
      ["session.start", undefined],
    ]);
    expect(events[2]!.timestamp).toBe(events[1]!.timestamp);

    // In the background the user is not present: the session ends and nothing starts.
    manager.onBackground();
    await vi.advanceTimersByTimeAsync(61 * 60_000);
    expect(manager.peek()).toBeNull();
    expect(manager.active()).toBeUndefined();
    expect(events).toHaveLength(4);
    manager.stop();
  });

  it("LIF-13: a background launch starts no session and no replay; the first foreground does", async () => {
    g.expo = { modules: { OuoReplay: nativeReplay } };
    AppState.currentState = "background";
    const storage = new MemoryAsyncStorage();
    // What the previous run left: a session that was never ended.
    const previous: SessionRecord = { id: "11111111-1111-4111-8111-111111111111", startedAt: Date.now() - 5000, lastActivity: Date.now() - 4000, userId: "" };
    await storage.setItem(SESSION_STORAGE_KEY, JSON.stringify(previous));
    const { rum, captured } = await start({ replay: { enabled: true } }, storage);
    expect(rum.getSessionId()).toBeUndefined();
    expect(nativeReplay.start).not.toHaveBeenCalled();
    // Background work (a push handler) makes requests and logs: no session comes of it.
    await fetch(`${BACKEND}/api/sync`);
    rum.recordEvent("push.received");
    await rum.flush();
    expect(rum.getSessionId()).toBeUndefined();
    // The previous run's session is still closed.
    expect(names(captured)).toEqual(["session.end"]);
    expect(attr(captured.logs[0]!.attributes, "session.id")).toBe(previous.id);
    expect(captured.spans).toHaveLength(0);
    expect(JSON.parse(storage.peek(SESSION_STORAGE_KEY)!).id).toBe(previous.id);

    AppState.__emit("active");
    const id = rum.getSessionId()!;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(nativeReplay.start).toHaveBeenCalledTimes(1);
    expect((nativeReplay.start.mock.calls[0]![1] as { sessionId: string }).sessionId).toBe(id);
    rum.recordEvent("opened");
    await rum.flush();
    const startRecord = captured.byName("session.start")[0]!;
    expect(attr(startRecord.attributes, "session.id")).toBe(id);
    expect(attr(startRecord.attributes, "session.previous_id")).toBe(previous.id);
    expect(captured.byName("opened")).toHaveLength(1);
  });
});

describe("sampling: decided once, bypass set, sampled flag", () => {
  it("SMP-1: the decision is made at session start and persisted with the session", async () => {
    const storage = new MemoryAsyncStorage();
    const events: SessionEvent[] = [];
    const manager = new SessionManager({ storage, process: {}, sampleRate: 0, onEvent: (e) => events.push(e) });
    await manager.start();
    const rec = manager.peek()!;
    expect(rec.sampled).toBe(false);
    expect(JSON.parse(storage.peek(SESSION_STORAGE_KEY)!).sampled).toBe(false);
    expect(manager.sampledFor(rec.id)).toBe(false);
    expect(manager.sampledFor("someone else")).toBeUndefined();
    expect(events[0]!.attributes["ouo.session.sample_rate"]).toBe(0);
    manager.restart();
    expect(manager.sampledFor(rec.id)).toBe(false); // the ended one is still known
    manager.stop();
    const all = new SessionManager({ storage: new MemoryAsyncStorage(), process: {}, onEvent: () => undefined });
    await all.start();
    expect(all.peek()!.sampled).toBe(true);
    all.stop();
  });

  it("SMP-3..7: an unsampled session sends only its bypass set, marked, capped; crashes are not capped", async () => {
    const { rum, captured, storage } = await start({ sampling: { sessionRate: 0, bypass: { perSessionCap: 2 } } });
    const id = rum.getSessionId()!;
    rum.recordEvent("not.sent");
    rum.recordException(new Error("handled: not in the bypass set"));
    rum.log.error("not sent");
    await fetch(`${BACKEND}/api/x`);
    unhandled("unhandled 1");
    unhandled("unhandled 2");
    unhandled("unhandled 3: over the cap");
    g.ErrorUtils!.getGlobalHandler()(new Error("fatal: never capped"), true);
    await sleep(20);
    await rum.flush();
    expect(JSON.parse(storage.peek(SESSION_STORAGE_KEY)!).sampled).toBe(false);
    // No session.start, no spans, no ordinary events.
    expect([...new Set(names(captured))]).toEqual(["exception"]);
    expect(captured.spans).toHaveLength(0);
    expect(captured.logs.map((l) => attr(l.attributes, "exception.message"))).toEqual(["unhandled 1", "unhandled 2", "fatal: never capped"]);
    for (const l of captured.logs) {
      expect(attr(l.attributes, "ouo.sampling.bypass")).toBe(true);
      expect(attr(l.attributes, "session.id")).toBe(id);
      expect(attr(l.attributes, "ouo.exception.handled")).toBe(false);
    }
  });

  it("a sampled session: session.start carries the sample rate and nothing is marked bypass", async () => {
    const { rum, captured } = await start({ session: { sampleRate: 1 } });
    unhandled("unhandled in a sampled session");
    await rum.flush();
    expect(attr(captured.byName("session.start")[0]!.attributes, "ouo.session.sample_rate")).toBe(1);
    expect(attr(captured.byName("exception")[0]!.attributes, "ouo.sampling.bypass")).toBeUndefined();
  });

  it("PRP-4, SMP-4: traceparent is still propagated in an unsampled session, with the sampled flag clear; set in a sampled one", async () => {
    const off = await start({ sampling: { sessionRate: 0 } });
    await fetch(`${BACKEND}/api/a`);
    expect(off.captured.requests[0]!.headers["traceparent"]).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-00$/);
    await off.rum._uninstall();
    delete g.__ouoSessionProcessState;
    const on = await start({ sampling: { sessionRate: 1 } });
    await fetch(`${BACKEND}/api/a`);
    expect(on.captured.requests[0]!.headers["traceparent"]).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  });
});
