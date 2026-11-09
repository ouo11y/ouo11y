/**
 * User and session attributes and the OTA bundle (docs/specs/attributes.md), end to end through
 * initRUM: validation, the `ouo.attr.*` stamp, the user set persisted with the user, the bundle on
 * the resource and on every signal, previous-run records left alone.
 */
import { trace } from "@opentelemetry/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bundleAttributes, mergeAttributes, signalAttributes } from "../src/attributes";
import { initRUM, type RUMInternal } from "../src/index";
import { getRUM } from "../src/instance";
import { USER_STORAGE_KEY } from "../src/session/manager";
import { MemoryAsyncStorage } from "../src/session/storage";
import { attr, baseOptions, g, installErrorUtils, installFetchStub, type Captured } from "./support/otlp";

describe("mergeAttributes / bundleAttributes", () => {
  it("same rules as the browser SDK", () => {
    const warn = vi.fn();
    const out = mergeAttributes({}, { tenant: "acme", n: 1, ok: true, long: "y".repeat(200), "a.b": 1, _x: 1, bad: null, o: {}, nan: Number.NaN }, {}, warn);
    expect(out).toEqual({ tenant: "acme", n: 1, ok: true, long: "y".repeat(128) });
    expect(warn).toHaveBeenCalledTimes(5);
    const other: Record<string, number> = {};
    for (let i = 0; i < 20; i++) other[`k${i}`] = i;
    expect(mergeAttributes({}, { extra: 1, k3: 9 }, other, () => undefined)).toEqual({ k3: 9 });
    expect(signalAttributes({ plan: "free", tenant: "u" }, { tenant: "a" })).toEqual({ "ouo.attr.plan": "free", "ouo.attr.tenant": "a" });
  });

  it("bundle id 1 to 128 characters, channel 1 to 64, trimmed", () => {
    expect(bundleAttributes({ id: " 0193-abc ", channel: "production" })).toEqual({ "ouo.app.bundle.id": "0193-abc", "ouo.app.bundle.channel": "production" });
    expect(bundleAttributes({ id: "v12", channel: "c".repeat(65) })).toEqual({ "ouo.app.bundle.id": "v12" });
    expect(bundleAttributes({ id: "" })).toBeUndefined();
    expect(bundleAttributes({ id: "x".repeat(129) })).toBeUndefined();
    expect(bundleAttributes({ id: 42 } as never)).toBeUndefined();
    expect(bundleAttributes(undefined)).toBeUndefined();
    expect(bundleAttributes(null)).toBeUndefined();
  });
});

describe("rum attributes and bundle end to end", () => {
  let captured: Captured;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    captured = installFetchStub();
    installErrorUtils();
    delete g.__ouoSessionProcessState;
  });

  afterEach(async () => {
    await (getRUM() as RUMInternal | undefined)?._uninstall();
    globalThis.fetch = originalFetch;
    delete g.ErrorUtils;
    delete g.__ouoSessionProcessState;
  });

  const logOf = (name: string) => captured.logs.find((l) => l.eventName === name || attr(l.attributes, "event.name") === name)!;

  it("init user attributes and bundle reach session.start, every event and span, and the resource", async () => {
    const rum = initRUM({
      ...baseOptions(),
      user: { id: "u-1", attributes: { tenant: "acme", plan: "pro" } },
      bundle: { id: "0193f1c2-bundle", channel: "production" },
    }) as RUMInternal;
    await rum.ready;
    rum.addEvent("first");
    rum.setAttributes({ cohort: "b", plan: "trial" }); // the app set wins over the user's plan
    rum.addEvent("second");
    trace.getTracer("t").startSpan("work").end();
    await rum.flush();

    const start = logOf("session.start");
    expect(attr(start.attributes, "ouo.attr.tenant")).toBe("acme");
    expect(attr(start.attributes, "ouo.app.bundle.id")).toBe("0193f1c2-bundle");
    expect(attr(logOf("first").attributes, "ouo.attr.cohort")).toBeUndefined();
    const second = logOf("second").attributes;
    expect(attr(second, "ouo.attr.plan")).toBe("trial");
    expect(attr(second, "ouo.attr.cohort")).toBe("b");
    expect(attr(second, "ouo.app.bundle.channel")).toBe("production");
    const span = captured.spans.find((s) => s.name === "work")!;
    expect(attr(span.attributes, "ouo.attr.tenant")).toBe("acme");
    expect(attr(span.attributes, "ouo.app.bundle.id")).toBe("0193f1c2-bundle");
    expect(attr(captured.resource, "ouo.app.bundle.id")).toBe("0193f1c2-bundle");
    expect(attr(captured.resource, "service.version")).toBe("2.3.0");
  });

  it("setBundle stamps later signals only; an invalid id is ignored; undefined clears", async () => {
    const rum = initRUM(baseOptions()) as RUMInternal;
    await rum.ready;
    rum.addEvent("before");
    rum.setBundle({ id: "codepush-v7" });
    rum.addEvent("after");
    rum.setBundle({ id: "" });
    rum.addEvent("after.invalid");
    rum.setBundle(undefined);
    rum.addEvent("after.clear");
    await rum.flush();
    expect(attr(logOf("before").attributes, "ouo.app.bundle.id")).toBeUndefined();
    expect(attr(logOf("after").attributes, "ouo.app.bundle.id")).toBe("codepush-v7");
    expect(attr(logOf("after.invalid").attributes, "ouo.app.bundle.id")).toBe("codepush-v7");
    expect(attr(logOf("after.clear").attributes, "ouo.app.bundle.id")).toBeUndefined();
    expect(attr(captured.resource, "ouo.app.bundle.id")).toBeUndefined();
  });

  it("the user set is persisted with the user and kept on the next launch; removeAttribute empties both sets", async () => {
    const storage = new MemoryAsyncStorage();
    let rum = initRUM(baseOptions(storage)) as RUMInternal;
    await rum.ready;
    rum.setUser({ id: "u-2", attributes: { tenant: "beta" } });
    rum.setUser({ id: "u-2" }); // same user without attributes keeps them
    rum.setAttributes({ flag: true });
    rum.removeAttribute("flag");
    rum.addEvent("as.u2");
    await rum.flush();
    expect(attr(logOf("as.u2").attributes, "ouo.attr.tenant")).toBe("beta");
    expect(attr(logOf("as.u2").attributes, "ouo.attr.flag")).toBeUndefined();
    expect(JSON.parse(storage.peek(USER_STORAGE_KEY)!)).toEqual({ id: "u-2", anonymous: false, attrs: { tenant: "beta" } });
    await rum._uninstall();

    // Cold start with the same user given at init, without attributes: the persisted set stays.
    delete g.__ouoSessionProcessState;
    captured.logs.length = 0;
    rum = initRUM({ ...baseOptions(storage), user: { id: "u-2" } }) as RUMInternal;
    await rum.ready;
    rum.addEvent("relaunch");
    rum.removeAttribute("tenant");
    rum.addEvent("removed");
    rum.setUser({ id: "u-3" }); // another user starts empty
    rum.addEvent("as.u3");
    await rum.flush();
    expect(attr(logOf("relaunch").attributes, "ouo.attr.tenant")).toBe("beta");
    expect(attr(logOf("removed").attributes, "ouo.attr.tenant")).toBeUndefined();
    expect(attr(logOf("as.u3").attributes, "user.id")).toBe("u-3");
    expect(JSON.parse(storage.peek(USER_STORAGE_KEY)!)).toEqual({ id: "u-3", anonymous: false });
  });

  it("a previous run's crash and session.end are not stamped with this run's attributes or bundle", async () => {
    const storage = new MemoryAsyncStorage();
    let rum = initRUM({ ...baseOptions(storage), bundle: { id: "bundle-A" } }) as RUMInternal;
    const crashed = rum.session.id();
    await rum.ready;
    // Fatal JS error: the crash marker is written, the next launch ends the session as crash.
    g.ErrorUtils!.getGlobalHandler()(new TypeError("boom"), true);
    await rum.flush();
    await rum._uninstall();

    delete g.__ouoSessionProcessState;
    captured.logs.length = 0;
    rum = initRUM({ ...baseOptions(storage), bundle: { id: "bundle-B" } }) as RUMInternal;
    rum.setAttributes({ tenant: "acme" });
    await rum.ready;
    await rum.flush();
    const end = captured.logs.find((l) => attr(l.attributes, "event.name") === "session.end" && attr(l.attributes, "session.id") === crashed)!;
    expect(end).toBeDefined();
    expect(attr(end.attributes, "ouo.session.end_reason")).toBe("crash");
    expect(attr(end.attributes, "ouo.app.bundle.id")).toBeUndefined();
    expect(attr(end.attributes, "ouo.attr.tenant")).toBeUndefined();
    const start = captured.logs.find((l) => attr(l.attributes, "event.name") === "session.start")!;
    expect(attr(start.attributes, "ouo.app.bundle.id")).toBe("bundle-B");
    expect(attr(start.attributes, "ouo.attr.tenant")).toBe("acme");
  });

  it("calls with bad input never throw", async () => {
    const rum = initRUM({ ...baseOptions(), bundle: { id: "" } }) as RUMInternal;
    await rum.ready;
    expect(() => rum.setAttributes(null as never)).not.toThrow();
    expect(() => rum.setAttributes({ "bad key": 1 } as never)).not.toThrow();
    expect(() => rum.removeAttribute(undefined as never)).not.toThrow();
    expect(() => rum.setUser({ id: "u", attributes: "nope" as never })).not.toThrow();
    expect(() => rum.setBundle({} as never)).not.toThrow();
    rum.addEvent("ok");
    await rum.flush();
    expect(attr(logOf("ok").attributes, "user.id")).toBe("u");
  });
});
