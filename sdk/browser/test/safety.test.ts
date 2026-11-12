/**
 * The golden rule: the app must not pay for the SDK's failures (SDK spec section 12, the
 * golden-rule checklist). Faults are injected into SDK internals with the test hook
 * (`_internal.injectFault`, GR-CRASH-7); the page must see nothing: no exception out of a public
 * call, a listener or a patched function, no `error` or `unhandledrejection` event, and its own
 * requests, history calls and handlers behave exactly as without the SDK.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as ouo from "../src/index";
import { FakeCollector, wait } from "./helpers/collector";

const BASE = "http://collector.test:4318";
const collector = new FakeCollector(BASE);
const TOKEN = "pt_canary_77ab31";
const base: ouo.OuoConfig = { endpoint: BASE, projectId: "web-store", projectToken: TOKEN, serviceName: "web-store", transport: { flushIntervalMs: 100 } };

/** Everything the page's own handlers would see. */
function pageErrors(): { errors: unknown[]; stop(): void } {
  const errors: unknown[] = [];
  const onError = (e: Event): void => void errors.push((e as ErrorEvent).error ?? (e as ErrorEvent).message);
  const onRejection = (e: Event): void => void errors.push((e as PromiseRejectionEvent).reason);
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  const onNode = (reason: unknown): void => void errors.push(reason);
  process.on("unhandledRejection", onNode);
  return {
    errors,
    stop() {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
      process.off("unhandledRejection", onNode);
    },
  };
}

const POINTS = ["emit", "session.activity", "span.end", "http.post", "store.open", "store.put", "replay.load", "replay.mask", "replay.data", "replay.record"];

beforeEach(() => {
  localStorage.clear();
  collector.reset();
  collector.install();
  document.body.innerHTML = `<button id="b">b</button>`;
  history.replaceState(null, "", "/");
});

afterEach(async () => {
  for (const p of [...POINTS, "*"]) ouo._internal.injectFault(p, false);
  await ouo.shutdown();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const WEIRD: unknown[] = [undefined, null, 0, NaN, -1, "", "x".repeat(100_000), {}, [], () => undefined, Symbol("s"), new Error("e"), { toString: () => { throw new Error("hostile"); } }, Object.create(null)];

function callEverything(arg: unknown): void {
  const a = arg as never;
  ouo.init(a);
  ouo.setUser(a);
  ouo.setConsent(a);
  ouo.setGlobalAttributes(a);
  ouo.recordEvent(a, a, a);
  ouo.recordEvent("ok.event", a, a);
  ouo.recordException(a, a);
  ouo.trackNavigation(a, a);
  ouo.trackNavigation("route", a);
  ouo.restartSession();
  ouo.getSessionId();
  ouo.replay.start();
  ouo.replay.stop();
  ouo.replay.capture();
  ouo.getTracerProvider().getTracer("t").startSpan("s").end();
  ouo.getLoggerProvider().getLogger("l").emit({ body: "b" });
  ouo.diagnostics();
  void ouo.flush();
}

describe("public API (API-1, GR-CRASH-1)", () => {
  it("every function is a no-op that does not throw before init", async () => {
    const page = pageErrors();
    for (const arg of WEIRD.slice(0, 6)) expect(() => callEverything(arg)).not.toThrow();
    expect(ouo.getSessionId()).toBeUndefined();
    expect(ouo.diagnostics().state).toBe("off");
    await expect(ouo.flush()).resolves.toBeUndefined();
    await expect(ouo.shutdown()).resolves.toBeUndefined();
    await wait(50);
    expect(collector.requests).toHaveLength(0);
    expect(localStorage.length).toBe(0);
    page.stop();
    expect(page.errors).toEqual([]);
  });

  it("every function survives any argument while running, and after shutdown", async () => {
    const page = pageErrors();
    ouo.init(base);
    for (const arg of WEIRD) expect(() => callEverything(arg)).not.toThrow();
    await ouo.flush();
    await ouo.shutdown();
    for (const arg of WEIRD.slice(0, 5)) expect(() => callEverything(arg)).not.toThrow();
    await ouo.shutdown();
    await wait(50);
    page.stop();
    expect(page.errors).toEqual([]);
  });

  it("a second init is ignored with a diagnostic (LIF-1); init does not wait for the network (LIF-2)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    collector.setAlways({ fail: true });
    const t0 = performance.now();
    ouo.init({ ...base, debug: true });
    expect(performance.now() - t0).toBeLessThan(200);
    const first = ouo.getSessionId();
    ouo.init({ ...base, debug: true, serviceName: "other" });
    expect(ouo.getSessionId()).toBe(first);
    expect(warn.mock.calls.some((c) => String(c[1]).includes("init called twice"))).toBe(true);
  });

  it("`enabled: false` does no work at all (GR-KILL-4)", async () => {
    const before = { push: history.pushState, fetch: globalThis.fetch, set: XMLHttpRequest.prototype.setRequestHeader };
    const add = vi.spyOn(globalThis, "addEventListener");
    ouo.init({ ...base, enabled: false });
    expect(add).not.toHaveBeenCalled();
    expect(history.pushState).toBe(before.push);
    expect(globalThis.fetch).toBe(before.fetch);
    expect(XMLHttpRequest.prototype.setRequestHeader).toBe(before.set);
    expect(localStorage.length).toBe(0);
    expect(ouo.diagnostics().state).toBe("off");
  });
});

describe("fault injection in every internal (ERR-1, GR-CRASH-2, GR-CRASH-4, GR-CRASH-6)", () => {
  it.each(POINTS)("a throw at `%s` never reaches the page, and the app's own calls are unchanged", async (name) => {
    const page = pageErrors();
    ouo._internal.injectFault(name);
    ouo.init({ ...base, replay: { sessionRate: 1 } });
    const appHandler = vi.fn();
    document.getElementById("b")!.addEventListener("click", appHandler);
    expect(() => {
      document.getElementById("b")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      window.dispatchEvent(new Event("pointerdown"));
      history.pushState({ s: 1 }, "", "/next");
      ouo.recordEvent("cart.add");
      ouo.recordException(new Error("x"));
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("pagehide"));
      window.dispatchEvent(new Event("pageshow"));
    }).not.toThrow();
    const res = await fetch("http://localhost:3000/api/items");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
    expect(appHandler).toHaveBeenCalledTimes(1);
    expect(history.state).toEqual({ s: 1 });
    expect(location.pathname).toBe("/next");
    await ouo.flush();
    await wait(120);
    await expect(ouo.shutdown()).resolves.toBeUndefined();
    page.stop();
    expect(page.errors).toEqual([]);
  });

  it("a fault in one feature leaves the others working: errors still export when replay cannot load", async () => {
    ouo._internal.injectFault("replay.load");
    ouo.init({ ...base, replay: { sessionRate: 1 } });
    window.dispatchEvent(new ErrorEvent("error", { error: new Error("still reported"), message: "still reported" }));
    await ouo.flush();
    await collector.settled();
    expect(collector.events("exception")).toHaveLength(1);
    expect(ouo.diagnostics().replayRecording).toBe(false);
    expect(ouo.diagnostics().state).toBe("running");
  });

  it("the app's own error handlers still run and the SDK does not swallow the error (ERR-3, GR-HAND-2)", () => {
    const onerror = vi.fn();
    window.onerror = onerror;
    const listener = vi.fn();
    window.addEventListener("error", listener);
    ouo.init(base);
    const ev = new ErrorEvent("error", { error: new Error("app bug"), message: "app bug", cancelable: true });
    window.dispatchEvent(ev);
    expect(onerror).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(ev.defaultPrevented).toBe(false);
    window.onerror = null;
    window.removeEventListener("error", listener);
  });

  it("a throwing beforeSend, sanitizeUrl hook or hostile attribute getter is contained", async () => {
    const page = pageErrors();
    ouo.init({
      ...base,
      beforeSend: () => {
        throw new Error("hook");
      },
      sanitizeUrl: () => {
        throw new Error("hook");
      },
    });
    const hostile = Object.defineProperty({}, "x", { enumerable: true, get: () => { throw new Error("getter"); } });
    expect(() => ouo.recordEvent("cart.add", hostile as never)).not.toThrow();
    expect(() => ouo.recordEvent("cart.add", { ok: 1 } as never)).not.toThrow();
    await ouo.flush();
    await collector.settled();
    expect(collector.events("cart.add").length).toBeGreaterThanOrEqual(1);
    page.stop();
    expect(page.errors).toEqual([]);
  });
});

describe("self-disable (ERR-6, GR-KILL-1)", () => {
  it("after the threshold of internal errors the SDK says so once, removes its hooks and does nothing more", async () => {
    const push = history.pushState;
    ouo.init({ ...base, diagnostics: { selfDisableThreshold: 5 } });
    expect(history.pushState).not.toBe(push);
    await ouo.flush();
    await collector.settled();
    ouo._internal.injectFault("session.activity");
    for (let i = 0; i < 8; i++) window.dispatchEvent(new Event("pointerdown"));
    ouo._internal.injectFault("session.activity", false);
    expect(ouo.diagnostics().state).toBe("disabled");
    expect(ouo.diagnostics().internalErrors).toBe(5);
    expect(history.pushState).toBe(push);
    await wait(150);
    await collector.settled();
    const disabled = collector.events("ouo.sdk.disabled");
    expect(disabled).toHaveLength(1);
    expect(disabled[0]!.attributes["ouo.sdk.internal_errors"]).toBe(5);
    const before = collector.requests.length;
    ouo.recordEvent("cart.add");
    ouo.recordException(new Error("later"));
    await ouo.flush();
    await wait(150);
    expect(collector.requests.length).toBe(before);
    expect(ouo.getSessionId()).toBeUndefined();
  });
});

describe("shutdown removes every hook (LIF-4, GR-MEM-2, GR-HDR-4)", () => {
  it("listeners, patches and timers are gone, and a foreign wrapper installed later is left in place", async () => {
    const added: string[] = [];
    const removed: string[] = [];
    const realAdd = EventTarget.prototype.addEventListener;
    const realRemove = EventTarget.prototype.removeEventListener;
    vi.spyOn(EventTarget.prototype, "addEventListener").mockImplementation(function (this: EventTarget, type: string, ...rest: unknown[]) {
      added.push(type);
      return (realAdd as (...a: unknown[]) => void).call(this, type, ...rest);
    });
    vi.spyOn(EventTarget.prototype, "removeEventListener").mockImplementation(function (this: EventTarget, type: string, ...rest: unknown[]) {
      removed.push(type);
      return (realRemove as (...a: unknown[]) => void).call(this, type, ...rest);
    });
    const pristine = { push: history.pushState, replace: history.replaceState, fetch: globalThis.fetch, xhr: XMLHttpRequest.prototype.setRequestHeader };
    ouo.init(base);
    expect(history.pushState).not.toBe(pristine.push);
    // Another tool wraps history after the SDK.
    const ours = history.pushState;
    const foreign = function (this: History, ...args: Parameters<History["pushState"]>): void {
      return ours.apply(this, args);
    };
    history.pushState = foreign;
    await ouo.shutdown();
    expect(history.pushState).toBe(foreign);
    history.pushState(null, "", "/after");
    expect(location.pathname).toBe("/after");
    history.pushState = pristine.push;
    expect(history.replaceState).toBe(pristine.replace);
    expect(globalThis.fetch).toBe(pristine.fetch);
    expect(XMLHttpRequest.prototype.setRequestHeader).toBe(pristine.xhr);
    expect(added.length).toBeGreaterThan(3);
    expect([...removed].sort()).toEqual([...added].sort());
  });

  it("init and shutdown fifty times leave no listener behind", async () => {
    let live = 0;
    const realAdd = EventTarget.prototype.addEventListener;
    const realRemove = EventTarget.prototype.removeEventListener;
    vi.spyOn(EventTarget.prototype, "addEventListener").mockImplementation(function (this: EventTarget, ...a: unknown[]) {
      live++;
      return (realAdd as (...x: unknown[]) => void).apply(this, a);
    });
    vi.spyOn(EventTarget.prototype, "removeEventListener").mockImplementation(function (this: EventTarget, ...a: unknown[]) {
      live--;
      return (realRemove as (...x: unknown[]) => void).apply(this, a);
    });
    for (let i = 0; i < 50; i++) {
      ouo.init({ ...base, transport: { shutdownDeadlineMs: 50 } });
      await ouo.shutdown();
    }
    expect(live).toBe(0);
  }, 20_000);
});

describe("secrets and diagnostics (CFG-3, ERR-8, GR-PRIV-1)", () => {
  it("with debug on, no part of the credential and no payload reaches the console", async () => {
    const out: string[] = [];
    for (const level of ["log", "warn", "info", "debug", "error"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void out.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")));
    }
    ouo.init({ ...base, debug: true, sampling: { sessionRate: 7 } as never });
    ouo.setUser("user-secret-id");
    ouo.recordEvent("cart.add", { email: "jane@example.com" } as never);
    ouo.recordException(new Error("card 4111111111111111"));
    collector.next({ status: 400 });
    await ouo.flush();
    await ouo.shutdown();
    const all = out.join("\n");
    expect(all).toContain("[ouo]");
    for (const secret of [TOKEN, TOKEN.slice(3, 9), btoa(`web-store:${TOKEN}`), "jane@example.com", "4111111111111111", "user-secret-id"]) expect(all).not.toContain(secret);
    expect(out.every((line) => !line.includes("console.error"))).toBe(true);
  });

  it("with debug off the SDK prints nothing, whatever happens", async () => {
    const spies = (["log", "warn", "info", "debug", "error"] as const).map((l) => vi.spyOn(console, l).mockImplementation(() => undefined));
    ouo.init({ ...base, sampling: { sessionRate: 7 } as never, beforeSend: "x" as never });
    ouo.init(base);
    ouo._internal.injectFault("emit");
    ouo.recordEvent("cart.add");
    ouo._internal.injectFault("emit", false);
    collector.next({ status: 500 });
    await ouo.flush();
    await ouo.shutdown();
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });
});

describe("storage failures (GR-STO-2, GR-STO-3, SES-12)", () => {
  it("blocked or full localStorage: the SDK runs from memory and the page sees nothing", async () => {
    const page = pageErrors();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });
    ouo.init(base);
    expect(ouo.getSessionId()).toMatch(/^[0-9a-f]{32}$/);
    ouo.recordEvent("cart.add");
    await ouo.flush();
    await collector.settled();
    expect(collector.events("cart.add")).toHaveLength(1);
    expect(document.cookie).toBe("");
    page.stop();
    expect(page.errors).toEqual([]);
  });

  it("only namespaced keys are written and the app's keys are never touched", async () => {
    localStorage.setItem("app.cart", "3");
    const clear = vi.spyOn(Storage.prototype, "clear");
    ouo.init(base);
    ouo.setConsent({ telemetry: false });
    await ouo.shutdown();
    expect(clear).not.toHaveBeenCalled();
    expect(localStorage.getItem("app.cart")).toBe("3");
    for (let i = 0; i < localStorage.length; i++) expect(localStorage.key(i) === "app.cart" || localStorage.key(i)!.startsWith("ouo.")).toBe(true);
  });
});
