import { afterEach, describe, expect, it } from "vitest";
import { initRUM, type RUMInternal } from "../src/index";
import { getRUM } from "../src/instance";
import type { EventEmitter } from "../src/telemetry/events";
import { createVitals, TTFD_TIMEOUT_MS, type NativeFrameStats, type NativeVitalsModule } from "../src/vitals";
import { attr, baseOptions, g, installErrorUtils, installFetchStub, waitFor } from "./support/otlp";

/** Manual clock, animation frames and timers. */
function harness(native?: NativeVitalsModule, launchedInForeground = true, stalls = true) {
  let t = 1_000_000;
  const frames: Array<() => void> = [];
  const timers: Array<{ fn: () => void; at: number; id: number }> = [];
  let ids = 0;
  const emitted: Array<{ name: string; attrs: Record<string, unknown>; at: number; body?: string }> = [];
  const events = {
    emit: (name: string, attrs: Record<string, unknown>, _sev: string, at: number, o?: { body?: string }) => emitted.push({ name, attrs, at, ...(o?.body !== undefined ? { body: o.body } : {}) }),
  } as unknown as EventEmitter;
  const vitals = createVitals({
    events,
    logger: { enabled: false, log: () => {}, warn: () => {} },
    native,
    options: { stalls },
    launchedInForeground,
    now: () => t,
    requestFrame: (cb) => frames.push(cb),
    setTimer: (fn, ms) => {
      timers.push({ fn, at: t + ms, id: ++ids });
      return ids;
    },
    clearTimer: (h) => {
      const i = timers.findIndex((x) => x.id === h);
      if (i >= 0) timers.splice(i, 1);
    },
  });
  return {
    vitals,
    emitted,
    advance(ms: number) {
      t += ms;
    },
    /** Runs the pending animation frames `n` times, `frameMs` apart. */
    frame(n = 1, frameMs = 16) {
      for (let i = 0; i < n; i++) {
        t += frameMs;
        for (const cb of frames.splice(0)) cb();
      }
    },
    /** The JS thread is busy for `busyMs`, then the due timers run. */
    block(busyMs: number) {
      t += busyMs;
      for (const timer of timers.splice(0)) if (timer.at <= t) timer.fn();
    },
    /** Runs the stall loop on time for `ms`. */
    idle(ms: number) {
      const end = t + ms;
      while (t < end) {
        t += 50;
        for (const timer of timers.splice(0)) timer.fn();
      }
    },
    now: () => t,
    timers,
  };
}

/** The process started when the clock did: the first screen's TTID counts from there. */
const measured = () => harness({ getAppStartInfo: () => ({ processStartMs: 1_000_000 }) });

describe("G2 vitals (docs/specs/mobile-vitals.md)", () => {
  it("ouo.app.start: process start to the frame after the root mounted, once the session exists", () => {
    const h = harness({ getAppStartInfo: () => ({ processStartMs: 1_000_000 - 1500 }) });
    h.vitals.navigated("Products");
    h.frame(2);
    expect(h.emitted.filter((e) => e.name === "ouo.app.start")).toHaveLength(0); // session not ready
    h.vitals.sessionReady();
    const start = h.emitted.find((e) => e.name === "ouo.app.start")!;
    expect(start.attrs).toEqual({ "ouo.app.start.type": "cold", "ouo.app.start.duration_ms": 1532, "app.screen.name": "Products", "ouo.vital.source": "ouo" });
    expect(start.at).toBe(h.now());
    expect(start.body).toBe("");
    // First screen TTID from the process start too (the record waits for TTFD until the deadline).
    expect(h.emitted.filter((e) => e.name === "ouo.screen.display")).toHaveLength(0);
    h.block(TTFD_TIMEOUT_MS);
    expect(h.emitted.find((e) => e.name === "ouo.screen.display")!.attrs).toMatchObject({ "app.screen.name": "Products", "ouo.screen.ttid_ms": 1532 });
    // At most one per run.
    h.vitals.rootMounted();
    h.frame(2);
    h.vitals.sessionReady();
    expect(h.emitted.filter((e) => e.name === "ouo.app.start")).toHaveLength(1);
  });

  it("warm start from the native type; no app start without the native process start or after a background launch", () => {
    const warm = harness({ getAppStartInfo: () => ({ processStartMs: 1_000_000 - 300, type: "warm" }) });
    warm.vitals.sessionReady();
    warm.vitals.rootMounted();
    warm.frame(2);
    expect(warm.emitted.find((e) => e.name === "ouo.app.start")!.attrs["ouo.app.start.type"]).toBe("warm");

    const none = harness(undefined);
    none.vitals.sessionReady();
    none.vitals.rootMounted();
    none.frame(2);
    none.vitals.navigated("Home");
    none.frame(2);
    expect(none.emitted.map((e) => e.name)).toEqual([]); // first screen: no app start to measure from

    const prewarmed = harness({ getAppStartInfo: () => ({ processStartMs: 1 }) }, false);
    prewarmed.vitals.sessionReady();
    prewarmed.vitals.rootMounted();
    prewarmed.frame(2);
    expect(prewarmed.emitted.filter((e) => e.name === "ouo.app.start")).toHaveLength(0);
  });

  it("ouo.screen.display: TTID from the navigation to the second frame, one per navigation", () => {
    const h = harness();
    h.vitals.navigated("Products");
    h.frame(2);
    h.vitals.navigated("Product");
    h.vitals.navigated("Product"); // same screen: no second record
    h.frame(1, 120); // slow render
    h.frame(1, 16);
    h.vitals.background(); // emits the held record of the current screen
    const displays = h.emitted.filter((e) => e.name === "ouo.screen.display");
    expect(displays).toHaveLength(1); // the first screen has no start without the native process start
    expect(displays[0]!.attrs).toEqual({ "app.screen.name": "Product", "ouo.screen.ttid_ms": 136, "ouo.vital.source": "ouo" });
  });

  it("TTFD: reportFullyDisplayed gives ttfd_ms on the screen's one display record, stamped at TTID", () => {
    const h = measured();
    h.vitals.navigated("Home");
    const navAt = h.now();
    h.frame(2); // TTID 32
    const ttidAt = h.now();
    h.advance(500); // the data loads
    h.vitals.fullyDisplayed();
    expect(h.emitted.filter((e) => e.name === "ouo.screen.display")).toHaveLength(0); // waits for the frame
    h.frame(2);
    const d = h.emitted.filter((e) => e.name === "ouo.screen.display");
    expect(d).toHaveLength(1);
    expect(d[0]!.attrs).toEqual({ "app.screen.name": "Home", "ouo.screen.ttid_ms": 32, "ouo.screen.ttfd_ms": h.now() - navAt, "ouo.vital.source": "ouo" });
    expect(d[0]!.at).toBe(ttidAt);
    // Once per visit: a second report and leaving the screen emit nothing more for Home.
    h.vitals.fullyDisplayed();
    h.frame(2);
    h.vitals.navigated("Cart");
    expect(h.emitted.filter((e) => e.name === "ouo.screen.display")).toHaveLength(1);
    expect(h.timers.filter((t) => t.at >= h.now() + TTFD_TIMEOUT_MS - 100)).toHaveLength(0); // no deadline left behind
  });

  it("TTFD reported before the first frame equals TTID", () => {
    const h = measured();
    h.vitals.navigated("Home");
    h.vitals.fullyDisplayed(); // content was ready with the first render
    h.frame(2);
    const d = h.emitted.find((e) => e.name === "ouo.screen.display")!;
    expect(d.attrs["ouo.screen.ttfd_ms"]).toBe(d.attrs["ouo.screen.ttid_ms"]);
  });

  it("without a report: TTID only, at the deadline, when the screen is left or the app goes to the background", () => {
    const deadline = measured();
    deadline.vitals.navigated("Home");
    deadline.frame(2);
    deadline.advance(TTFD_TIMEOUT_MS - 100);
    expect(deadline.emitted.filter((e) => e.name === "ouo.screen.display")).toHaveLength(0);
    deadline.block(100);
    expect(deadline.emitted.find((e) => e.name === "ouo.screen.display")!.attrs).not.toHaveProperty("ouo.screen.ttfd_ms");
    deadline.vitals.fullyDisplayed(); // too late: the record is out
    deadline.frame(2);
    expect(deadline.emitted.filter((e) => e.name === "ouo.screen.display")).toHaveLength(1);

    const left = measured();
    left.vitals.navigated("Home");
    left.frame(2);
    left.vitals.navigated("Cart");
    left.vitals.fullyDisplayed(); // belongs to Cart
    left.frame(2);
    const [home, cart] = left.emitted.filter((e) => e.name === "ouo.screen.display");
    expect(home!.attrs).not.toHaveProperty("ouo.screen.ttfd_ms");
    expect(cart!.attrs["app.screen.name"]).toBe("Cart");
    expect(cart!.attrs).toHaveProperty("ouo.screen.ttfd_ms");

    const bg = measured();
    bg.vitals.navigated("Home");
    bg.frame(2);
    bg.vitals.background();
    expect(bg.emitted.find((e) => e.name === "ouo.screen.display")!.attrs).not.toHaveProperty("ouo.screen.ttfd_ms");
  });

  it("reportFullyDisplayed before any screen does nothing", () => {
    const h = measured();
    h.vitals.fullyDisplayed();
    h.frame(2);
    h.vitals.navigated("Home");
    h.frame(2);
    h.vitals.background();
    expect(h.emitted.find((e) => e.name === "ouo.screen.display")!.attrs).not.toHaveProperty("ouo.screen.ttfd_ms");
  });

  it("ouo.stall: iterations of 100 ms or more, excess over 50 ms, per screen window", () => {
    const h = measured();
    h.vitals.navigated("Cart");
    h.idle(500);
    h.block(300); // one stall of 250 ms
    h.idle(200);
    h.block(120); // one stall of 70 ms
    h.block(90); // 90 ms: not a stall
    h.idle(100);
    h.advance(10);
    h.vitals.navigated("Checkout"); // closes the Cart window
    const stall = h.emitted.find((e) => e.name === "ouo.stall")!;
    expect(stall.attrs).toMatchObject({
      "ouo.stall.count": 2,
      "ouo.stall.total_ms": 320,
      "ouo.stall.longest_ms": 250,
      "app.screen.name": "Cart",
      "ouo.vital.window": "screen",
      "ouo.vital.source": "ouo",
    });
    expect(stall.attrs["ouo.stall.period_ms"]).toBeGreaterThan(1000);
    // A window without stalls emits none; background stops the loop and closes the window.
    h.idle(300);
    h.vitals.background();
    expect(h.emitted.filter((e) => e.name === "ouo.stall")).toHaveLength(1);
    expect(h.timers).toHaveLength(0);
    h.advance(60_000); // a long background stay is not a stall
    h.vitals.foreground();
    h.idle(100);
    h.vitals.background();
    expect(h.emitted.filter((e) => e.name === "ouo.stall")).toHaveLength(1);
  });

  it("app.jank from native frame counters per window; nothing without them", () => {
    let stats: NativeFrameStats = { total: 100, slow: 2, frozen: 0, delayMs: 40, expectedFrameMs: 1000 / 120 };
    const h = harness({ getFrameStats: () => stats });
    h.vitals.navigated("Home");
    h.advance(2000);
    stats = { total: 340, slow: 9, frozen: 1, delayMs: 940, expectedFrameMs: 1000 / 120 };
    h.vitals.navigated("Cart");
    const jank = h.emitted.filter((e) => e.name === "app.jank");
    expect(jank).toHaveLength(1); // the app_start window drew no frame: none for it
    expect(jank[0]!.attrs).toEqual({
      "app.screen.name": "Home",
      "ouo.vital.window": "screen",
      "app.jank.frame_count": 8,
      "app.jank.period": 2,
      "app.jank.threshold": 1 / 120,
      "ouo.frames.total": 240,
      "ouo.frames.slow": 7,
      "ouo.frames.frozen": 1,
      "ouo.frames.delay_ms": 900,
      "ouo.vital.source": "ouo",
    });
    // A window that drew no frame emits nothing.
    h.advance(100);
    h.vitals.background();
    expect(h.emitted.filter((e) => e.name === "app.jank")).toHaveLength(1);

    const none = harness(undefined, true, false);
    none.vitals.navigated("Home");
    none.advance(1000);
    none.vitals.background();
    expect(none.emitted).toEqual([]);
  });
});

describe("vitals through initRUM", () => {
  afterEach(async () => {
    await (getRUM() as RUMInternal | undefined)?._uninstall();
    delete g.expo;
    delete g.ErrorUtils;
    delete g.__ouoSessionProcessState;
  });

  it("reads the native module's start info and emits session events in the session", async () => {
    installErrorUtils();
    const native = {
      start: () => {},
      getAppStartInfo: () => ({ processStartMs: Date.now() - 2000 }),
    };
    g.expo = { modules: { OuoReplay: native } };
    const originalFetch = globalThis.fetch;
    const captured = installFetchStub();
    try {
      const rum = initRUM(baseOptions()) as RUMInternal;
      await rum.ready;
      rum.trackNavigation("/Products");
      await waitFor(() => captured.byName("ouo.app.start").length > 0 || false, 300);
      rum.reportFullyDisplayed();
      await new Promise((r) => setTimeout(r, 100));
      await rum.flush();
      const start = captured.byName("ouo.app.start")[0]!;
      expect(attr(start.attributes, "ouo.app.start.type")).toBe("cold");
      expect(attr(start.attributes, "ouo.app.start.duration_ms") as number).toBeGreaterThanOrEqual(2000);
      expect(attr(start.attributes, "session.id")).toBe(rum.session.id());
      expect(start.severityText).toBe("INFO");
      const display = captured.byName("ouo.screen.display")[0]!;
      expect(attr(display.attributes, "app.screen.name")).toBe("Products");
      expect(attr(display.attributes, "ouo.screen.ttfd_ms") as number).toBeGreaterThanOrEqual(attr(display.attributes, "ouo.screen.ttid_ms") as number);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
