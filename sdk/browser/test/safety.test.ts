/**
 * The SDK never breaks the host page (checklist N42): its hooks contain their own exceptions,
 * patched globals behave like the originals, `initRUM` twice is a no-op, `shutdown` restores
 * everything and a later `initRUM` works, and a failed start leaves nothing installed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getRUM, initRUM, type RUM, type RUMOptions } from "../src/index";
import { guardedFailures } from "../src/guard";
import { EventEmitter } from "../src/telemetry/events";
import { stubFetch, wait } from "./helpers/otlp";

const BASE = "http://localhost:8095";
const { logRecords } = stubFetch(BASE);
const options: RUMOptions = {
  endpoint: BASE,
  projectId: "web-store",
  projectToken: "pt_test_safety",
  service: { name: "web-store", version: "1.0.0", environment: "test" },
  tracing: { documentLoad: false, idleTimeoutMs: 50 },
  replay: { enabled: false },
};

let rum: RUM | undefined;
const pristine = {
  push: history.pushState,
  replace: history.replaceState,
  consoleError: console.error,
  addEventListener: globalThis.addEventListener,
};

beforeEach(() => {
  localStorage.clear();
});

afterEach(async () => {
  await rum?.shutdown();
  rum = undefined;
});

/** Records what reaches the page: its own error and rejection listeners. */
function pageErrors(): { errors: unknown[]; stop: () => void } {
  const errors: unknown[] = [];
  const onError = (e: ErrorEvent): void => void errors.push(e.error ?? e.message);
  const onRejection = (e: PromiseRejectionEvent): void => void errors.push(e.reason);
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  return {
    errors,
    stop: () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    },
  };
}

describe("lifecycle", () => {
  it("initRUM twice warns and returns the running instance", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    rum = initRUM(options);
    const again = initRUM({ ...options, projectToken: "other" });
    expect(again).toBe(rum);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("initRUM called twice"));
  });

  it("shutdown restores the patched globals, and initRUM works again afterwards", async () => {
    rum = initRUM(options);
    expect(history.pushState).not.toBe(pristine.push);
    expect(console.error).not.toBe(pristine.consoleError);
    await rum.shutdown();
    expect(getRUM()).toBeUndefined();
    expect(history.pushState).toBe(pristine.push);
    expect(history.replaceState).toBe(pristine.replace);
    expect(console.error).toBe(pristine.consoleError);
    // shutdown twice is fine
    await rum.shutdown();

    rum = initRUM(options);
    expect(getRUM()).toBe(rum);
    const before = logRecords().length;
    rum.addEvent("after.reinit");
    await rum.flush();
    expect(logRecords().slice(before).map((r) => r.eventName)).toContain("after.reinit");
  });

  it("a wrapper installed on top of the SDK's survives shutdown", async () => {
    rum = initRUM(options);
    const calls: string[] = [];
    const sdkPush = history.pushState;
    const routerPush = function (this: History, ...args: Parameters<History["pushState"]>): void {
      calls.push("router");
      sdkPush.apply(this, args);
    };
    history.pushState = routerPush;
    await rum.shutdown();
    rum = undefined;
    expect(history.pushState).toBe(routerPush);
    history.pushState({}, "", "/after-shutdown");
    expect(calls).toEqual(["router"]);
    expect(location.pathname).toBe("/after-shutdown");
    history.pushState = pristine.push;
  });

  it("a start that fails part way warns, removes what it installed and returns an inert instance", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // pagehide is the last listener installed: everything before it must be undone.
    vi.spyOn(globalThis, "addEventListener").mockImplementation(function (this: unknown, type: string, ...rest: unknown[]) {
      if (type === "pagehide") throw new Error("no pagehide here");
      return (pristine.addEventListener as (...a: unknown[]) => void).call(this, type, ...rest);
    } as typeof globalThis.addEventListener);
    const inert = initRUM(options);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not start"), expect.any(Error));
    expect(getRUM()).toBeUndefined();
    expect(history.pushState).toBe(pristine.push);
    expect(console.error).toBe(pristine.consoleError);
    expect(() => inert.captureError(new Error("x"))).not.toThrow();
    expect(inert.session.id()).toBe("");
  });

  it("a configuration error still throws, so a misconfigured app fails at its first run", () => {
    expect(() => initRUM({ ...options, projectToken: "" })).toThrow(/projectToken/);
    expect(getRUM()).toBeUndefined();
  });
});

describe("hooks contain SDK exceptions", () => {
  it("nothing the SDK throws reaches the page, and the page's own code behaves the same", async () => {
    const pageConsoleError = vi.fn();
    console.error = pageConsoleError;
    rum = initRUM(options);
    const page = pageErrors();
    const failuresBefore = guardedFailures();
    // Every event the SDK emits now throws inside the SDK.
    vi.spyOn(EventEmitter.prototype, "emit").mockImplementation(() => {
      throw new Error("sdk bug");
    });

    // history: the original runs and its return value comes back.
    expect(history.pushState({ a: 1 }, "", "/sdk-bug")).toBeUndefined();
    expect(location.pathname).toBe("/sdk-bug");
    expect(history.state).toEqual({ a: 1 });
    history.replaceState(null, "", "/sdk-bug-2");
    window.dispatchEvent(new PopStateEvent("popstate"));

    // listeners: click, keydown, storage, visibility.
    const b = document.createElement("button");
    let clicked = 0;
    b.addEventListener("click", () => clicked++);
    document.body.appendChild(b);
    b.click();
    document.dispatchEvent(new KeyboardEvent("keydown"));
    window.dispatchEvent(new StorageEvent("storage", { key: "ouo.session", newValue: "{" }));
    document.dispatchEvent(new Event("visibilitychange"));

    // console.error: the page's function is called with the same arguments.
    expect(() => console.error("page says", 42)).not.toThrow();
    expect(pageConsoleError).toHaveBeenCalledWith("page says", 42);

    // public API
    expect(() => rum!.captureError(new Error("app"))).not.toThrow();
    expect(() => rum!.addEvent("x")).not.toThrow();
    expect(() => rum!.setRoute("/r")).not.toThrow();
    await expect(rum.flush()).resolves.toBeUndefined();

    await wait(100);
    page.stop();
    expect(clicked).toBe(1);
    expect(page.errors).toEqual([]);
    expect(guardedFailures()).toBeGreaterThan(failuresBefore);
    await rum.shutdown();
    expect(console.error).toBe(pageConsoleError);
    console.error = pristine.consoleError;
  });

  it("history errors the browser throws reach the caller unchanged", () => {
    rum = initRUM(options);
    expect(() => history.pushState({}, "", "https://elsewhere.example/x")).toThrow();
  });

  it("an error thrown by the page's own listener is still the page's, reported once", async () => {
    rum = initRUM(options);
    const before = logRecords().length;
    const page = pageErrors();
    const b = document.createElement("button");
    b.addEventListener("click", () => {
      throw new Error("page handler failed");
    });
    document.body.appendChild(b);
    b.click(); // jsdom reports listener errors to window "error"
    await rum.flush();
    page.stop();
    expect(page.errors.map(String)).toEqual(["Error: page handler failed"]);
    const exceptions = logRecords()
      .slice(before)
      .filter((r) => r.eventName === "exception" && r.attributes["exception.message"] === "page handler failed");
    expect(exceptions).toHaveLength(1);
  });
});

describe("feature detection", () => {
  it("starts and reports without the optional platform APIs", async () => {
    const optional = [
      "PerformanceObserver",
      "CompressionStream",
      "BroadcastChannel",
      "MutationObserver",
      "requestIdleCallback",
      "scheduler",
    ] as const;
    for (const name of optional) vi.stubGlobal(name, undefined);
    const randomUUID = crypto.randomUUID;
    Object.defineProperty(crypto, "randomUUID", { value: undefined, configurable: true });
    try {
      const warn = vi.spyOn(console, "warn");
      rum = initRUM({ ...options, replay: { enabled: true } });
      expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("could not start"), expect.anything());
      expect(rum.session.id()).toMatch(/^[0-9a-f-]{36}$/);
      const before = logRecords().length;
      rum.addEvent("no.optional.apis");
      await rum.flush();
      expect(logRecords().slice(before).map((r) => r.eventName)).toContain("no.optional.apis");
    } finally {
      Object.defineProperty(crypto, "randomUUID", { value: randomUUID, configurable: true });
      vi.unstubAllGlobals();
    }
  });
});
