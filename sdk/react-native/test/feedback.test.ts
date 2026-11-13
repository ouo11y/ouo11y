/**
 * C10 feedback (docs/specs/mobile-sdk.md): the record, the last timeline events it carries
 * (RecentEvents, shared with W4's error context) and the replay frame, end to end through initRUM.
 */
import { SeverityNumber } from "@opentelemetry/api-logs";
import { LoggerProvider } from "@opentelemetry/sdk-logs";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { feedbackRecord, MAX_FEEDBACK_BYTES } from "../src/feedback";
import { cutUtf8 } from "../src/text";
import { initRUM, RUMProvider, type RUMInternal } from "../src/index";
import { getRUM } from "../src/instance";
import { LAST_EVENT_BODY_MAX, LAST_EVENTS, RecentEvents, type RecentEvent } from "../src/telemetry/recent";
import { attr, BACKEND, baseOptions, g, installErrorUtils, installFetchStub, type Captured } from "./support/otlp";

describe("feedbackRecord", () => {
  it("message as body and attribute, contact when given, the id", () => {
    expect(feedbackRecord({ message: "  The pay button does nothing \n", contact: " ana@example.com " }, "id-1")).toEqual({
      body: "The pay button does nothing",
      attrs: { "ouo.feedback.message": "The pay button does nothing", "ouo.feedback.contact": "ana@example.com", "ouo.feedback.id": "id-1" },
    });
    expect(feedbackRecord({ message: "slow", contact: "   " }, "id-2")?.attrs).toEqual({ "ouo.feedback.message": "slow", "ouo.feedback.id": "id-2" });
  });

  it("nothing to send without a message; anything but a string is no text", () => {
    expect(feedbackRecord({ message: "   " }, "x")).toBeUndefined();
    expect(feedbackRecord(undefined, "x")).toBeUndefined();
    expect(feedbackRecord({ message: 42 } as never, "x")).toBeUndefined();
    expect(feedbackRecord({ message: "ok", contact: { email: "a" } } as never, "x")?.attrs["ouo.feedback.contact"]).toBeUndefined();
  });

  it("cuts message and contact at MAX_FEEDBACK_BYTES of UTF-8 with an ellipsis, as the bridge does", () => {
    const long = "a".repeat(MAX_FEEDBACK_BYTES + 10);
    const r = feedbackRecord({ message: long, contact: long }, "x")!;
    expect(r.body).toBe("a".repeat(MAX_FEEDBACK_BYTES) + "…");
    expect(r.attrs["ouo.feedback.contact"]).toBe(r.body);
    expect(feedbackRecord({ message: "a".repeat(MAX_FEEDBACK_BYTES) }, "x")!.body).toBe("a".repeat(MAX_FEEDBACK_BYTES));
  });

  it("cutUtf8 keeps whole code points within the byte budget (Go truncate)", () => {
    expect(cutUtf8("éé", 4)).toBe("éé"); // 2 bytes each, fits exactly
    expect(cutUtf8("éééé", 5)).toBe("éé…");
    expect(cutUtf8("ab😀cd", 5)).toBe("ab…"); // the emoji is 4 bytes: never split
    expect(cutUtf8("ab😀cd", 6)).toBe("ab😀…");
    expect(cutUtf8("日本語", 9)).toBe("日本語");
    expect(cutUtf8("", 0)).toBe("");
  });
});

describe("RecentEvents", () => {
  function emitter() {
    const recent = new RecentEvents();
    const provider = new LoggerProvider({ processors: [recent] });
    const logger = provider.getLogger("t");
    let t = 1_700_000_000_000;
    const emit = (name: string | undefined, attrs: Record<string, string | number>, body?: string, session = "s1") =>
      logger.emit({ ...(name ? { eventName: name } : {}), body: body ?? name ?? "", timestamp: t++, severityNumber: SeverityNumber.INFO, attributes: { ...(name ? { "event.name": name } : {}), "session.id": session, ...attrs } });
    return { recent, emit };
  }

  it("keeps the last LAST_EVENTS of the session, oldest first, with a readable body", () => {
    const { recent, emit } = emitter();
    for (let i = 0; i < LAST_EVENTS + 5; i++) emit("ui.tap", {}, `Tap item-${i} (button) on Products`);
    const got = recent.read("s1");
    expect(got).toHaveLength(LAST_EVENTS);
    expect(got[0]!.body).toBe("Tap item-5 (button) on Products");
    expect(got.at(-1)).toEqual({ ts: 1_700_000_000_000 + LAST_EVENTS + 4, name: "ui.tap", body: `Tap item-${LAST_EVENTS + 4} (button) on Products` });
  });

  it("oldest first by ts, stable: a vital stamped earlier than the records emitted before it", () => {
    const recent = new RecentEvents();
    const logger = new LoggerProvider({ processors: [recent] }).getLogger("t");
    const at = (name: string, ts: number) =>
      logger.emit({ eventName: name, body: name, timestamp: ts, attributes: { "event.name": name, "session.id": "s1" } });
    at("navigation", 3000);
    at("ui.tap", 4000);
    at("ouo.screen.display", 2500); // emitted after, measured before
    at("log", 4000);
    expect(recent.read("s1").map((e) => e.name)).toEqual(["ouo.screen.display", "navigation", "ui.tap", "log"]);
  });

  it("a record whose body is its name reads from its attributes", () => {
    const { recent, emit } = emitter();
    emit("navigation", { "url.path": "/Home/Cart" });
    emit("exception", { "exception.type": "TypeError", "exception.message": "x is undefined" });
    emit("http.request.failed", { "http.request.method": "POST", "url.full": "https://api.test/pay", "http.response.status_code": 503 });
    emit("ouo.app.start", { "ouo.app.start.type": "cold" });
    emit(undefined, {}, "checkout started"); // a raw log record without event.name
    expect(recent.read("s1").map((e: RecentEvent) => [e.name, e.body])).toEqual([
      ["navigation", "/Home/Cart"],
      ["exception", "TypeError: x is undefined"],
      ["http.request.failed", "POST https://api.test/pay 503"],
      ["ouo.app.start", ""],
      ["log", "checkout started"],
    ]);
  });

  it("only the asked session's entries; records without a session are not kept; bodies are cut", () => {
    const { recent, emit } = emitter();
    emit("navigation", { "url.path": "/Old" }, undefined, "s0");
    emit("ui.tap", {}, "x".repeat(LAST_EVENT_BODY_MAX + 50));
    const provider = new LoggerProvider({ processors: [recent] });
    provider.getLogger("t").emit({ body: "no session", attributes: {} });
    expect(recent.read("s1")).toHaveLength(1);
    expect(recent.read("s1")[0]!.body).toBe("x".repeat(LAST_EVENT_BODY_MAX) + "…");
    expect(recent.read("s0").map((e) => e.body)).toEqual(["/Old"]);
    expect(recent.read("nope")).toEqual([]);
  });
});

describe("rum.feedback through initRUM", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    installErrorUtils();
    delete g.__ouoSessionProcessState;
  });
  afterEach(async () => {
    await (getRUM() as RUMInternal | undefined)?._uninstall();
    globalThis.fetch = originalFetch;
    delete g.ErrorUtils;
    delete g.__ouoSessionProcessState;
    delete g.expo;
  });

  async function start(extra: Record<string, unknown> = {}): Promise<{ rum: RUMInternal; captured: Captured }> {
    const captured = installFetchStub();
    const rum = initRUM({ ...baseOptions(), ...extra }) as RUMInternal;
    await rum.ready;
    return { rum, captured };
  }

  const recordingNative = () => {
    const n = {
      start: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      isRecording: vi.fn(() => true),
      flush: vi.fn(() => Promise.resolve()),
      sessionDidRotate: vi.fn(),
      setSessionId: vi.fn(),
      screenDidChange: vi.fn(),
    };
    g.expo = { modules: { OuoReplay: n } };
    return n;
  };

  it("one feedback event on the session: message, contact, id, the last events before it", async () => {
    const { rum, captured } = await start();
    type Handlers = { onTouchStart: (e: object) => void; onTouchEnd: (e: object) => void };
    const el = RUMProvider({ rum }) as ReactElement<Handlers>;
    const fiber = { elementType: "RCTView", memoizedProps: { testID: "pay", role: "button" }, return: { elementType: { displayName: "CartScreen" }, memoizedProps: {}, return: null } };
    rum.trackNavigation("/Cart");
    el.props.onTouchStart({ _targetInst: fiber, nativeEvent: { pageX: 1, pageY: 1 } });
    el.props.onTouchEnd({ nativeEvent: { pageX: 1, pageY: 1 } });
    await fetch(`${BACKEND}/api/pay?fail=500`).catch(() => undefined);
    rum.log.warn("payment retried");
    const id = rum.feedback({ message: "Paying fails every time", contact: "ana@example.com" });
    await rum.flush();

    const [f, ...more] = captured.byName("feedback");
    expect(more).toHaveLength(0);
    const a = f!.attributes;
    expect(f!.body?.stringValue).toBe("Paying fails every time");
    expect(f!.severityText).toBe("INFO");
    expect(attr(a, "ouo.feedback.message")).toBe("Paying fails every time");
    expect(attr(a, "ouo.feedback.contact")).toBe("ana@example.com");
    expect(attr(a, "ouo.feedback.id")).toBe(id);
    expect(id).toMatch(/^[0-9a-f]{12}4[0-9a-f]{3}[89ab][0-9a-f]{15}$/);
    expect(attr(a, "session.id")).toBe(rum.session.id());
    expect(attr(a, "ouo.feedback.screenshot")).toBeUndefined();
    const last = JSON.parse(attr(a, "ouo.last_events") as string) as RecentEvent[];
    const steps = last.map((e) => `${e.name}|${e.body}`);
    // In emit order, the feedback itself not among them.
    expect(steps.indexOf("navigation|/Cart")).toBeLessThan(steps.indexOf("ui.tap|Tap pay (button) on Cart"));
    expect(steps).toContain("http.request.failed|GET http://backend.test/api/pay?fail=REDACTED 500");
    expect(steps.at(-1)).toBe("log|payment retried");
    expect(steps.some((s) => s.startsWith("feedback|"))).toBe(false);
    expect(last.every((e) => e.ts <= Number(BigInt(f!.timeUnixNano) / 1_000_000n))).toBe(true);
  });

  it("an empty message sends nothing and returns undefined", async () => {
    const { rum, captured } = await start();
    expect(rum.feedback({ message: " " })).toBeUndefined();
    await rum.flush();
    expect(captured.byName("feedback")).toHaveLength(0);
  });

  it("screenshot with replay recording: a frame is asked for after the record, and the record says so", async () => {
    const n = recordingNative();
    const { rum, captured } = await start({ replay: { enabled: true } });
    let clock = Date.now();
    const spy = vi.spyOn(Date, "now").mockImplementation(() => ++clock);
    let askedAt = 0;
    n.screenDidChange.mockImplementation(() => (askedAt = Date.now()));
    rum.feedback({ message: "look at this", screenshot: true });
    rum.feedback({ message: "no picture" });
    spy.mockRestore();
    await rum.flush();
    expect(n.screenDidChange).toHaveBeenCalledTimes(1);
    const records = captured.byName("feedback");
    expect(records.map((l) => attr(l.attributes, "ouo.feedback.screenshot"))).toEqual([true, undefined]);
    // The frame comes after the feedback in the replay (C10.1's frame after it).
    expect(Number(BigInt(records[0]!.timeUnixNano) / 1_000_000n)).toBeLessThan(askedAt);
  });

  it("screenshot without replay recording: no frame, no flag", async () => {
    const n = recordingNative();
    const { rum, captured } = await start(); // replay not enabled
    rum.feedback({ message: "look at this", screenshot: true });
    await rum.flush();
    expect(n.screenDidChange).not.toHaveBeenCalled();
    expect(attr(captured.byName("feedback")[0]!.attributes, "ouo.feedback.screenshot")).toBeUndefined();
  });

  it("after an idle timeout: the frame, the last events and the record all go to the new session", async () => {
    const n = recordingNative();
    const { rum, captured } = await start({ replay: { enabled: true }, session: { inactivityTimeoutMs: 60_000 } });
    rum.trackNavigation("/Old");
    const first = rum.session.id();
    const now = Date.now();
    const spy = vi.spyOn(Date, "now").mockReturnValue(now + 61_000);
    rum.feedback({ message: "back after lunch", screenshot: true });
    spy.mockRestore();
    await rum.flush();
    const f = captured.byName("feedback")[0]!;
    expect(attr(f.attributes, "session.id")).not.toBe(first);
    expect(attr(f.attributes, "session.id")).toBe(rum.session.id());
    // The recorder heard of the new session before the feedback's frame request (the last one;
    // the first came from the navigation).
    expect(n.screenDidChange).toHaveBeenCalledTimes(2);
    expect(n.sessionDidRotate.mock.invocationCallOrder.at(-1)!).toBeLessThan(n.screenDidChange.mock.invocationCallOrder.at(-1)!);
    expect(n.sessionDidRotate.mock.calls.at(-1)![0]).toBe(rum.session.id());
    const last = (JSON.parse(attr(f.attributes, "ouo.last_events") as string) as RecentEvent[]).map((e) => e.body);
    expect(last).not.toContain("/Old");
  });

  it("the last events are the current session's only, after a rotation", async () => {
    const { rum, captured } = await start({ session: { maxDurationMs: 60_000 } });
    rum.trackNavigation("/Old");
    const now = Date.now();
    const spy = vi.spyOn(Date, "now").mockReturnValue(now + 61_000);
    rum.trackNavigation("/New"); // past the max duration: a new session
    rum.feedback({ message: "hi" });
    spy.mockRestore();
    await rum.flush();
    const f = captured.byName("feedback")[0]!;
    const last = (JSON.parse(attr(f.attributes, "ouo.last_events") as string) as RecentEvent[]).map((e) => e.body);
    expect(attr(f.attributes, "session.id")).not.toBe(attr(captured.byName("navigation")[0]!.attributes, "session.id"));
    expect(last).toContain("/New");
    expect(last).not.toContain("/Old");
  });
});
