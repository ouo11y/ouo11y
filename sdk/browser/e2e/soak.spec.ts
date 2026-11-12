/**
 * A long session with replay on: a busy single-page app for OUO_SOAK_MINUTES (default 1). What
 * the SDK holds must not grow once it has warmed up: event listeners, observers, pending timers
 * and, in Chromium, the JavaScript heap. The page must see no error, and the SDK must contain none.
 * Samples are written to OUO_SOAK_OUT (default soak-results) as JSON.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { captured, diagnostics, open, pageErrors } from "./harness";

const MINUTES = Number(process.env.OUO_SOAK_MINUTES ?? 1);
const OUT = process.env.OUO_SOAK_OUT ?? "soak-results";

interface Sample {
  at: number;
  listeners: number;
  observers: number;
  timers: number;
  nodes: number;
  heap: number | null;
}

test("a long session does not leak", async ({ page, browserName }) => {
  await page.addInitScript(() => {
    const counts = { listeners: 0, observers: 0, timers: 0 };
    (window as unknown as { soak: typeof counts }).soak = counts;
    const add = EventTarget.prototype.addEventListener;
    const remove = EventTarget.prototype.removeEventListener;
    const seen = new WeakMap<object, Set<string>>();
    const key = (type: string, fn: unknown, o: unknown): string | null => {
      if (typeof fn !== "function" && typeof fn !== "object") return null;
      return `${type}|${typeof o === "boolean" ? o : !!(o as { capture?: boolean } | undefined)?.capture}`;
    };
    EventTarget.prototype.addEventListener = function (this: EventTarget, type: string, fn: EventListenerOrEventListenerObject | null, o?: boolean | AddEventListenerOptions) {
      const k = fn ? key(type, fn, o) : null;
      if (k && fn) {
        const set = seen.get(fn as object) ?? new Set<string>();
        if (!set.has(`${k}`)) counts.listeners++;
        set.add(k);
        seen.set(fn as object, set);
      }
      return add.call(this, type, fn, o);
    };
    EventTarget.prototype.removeEventListener = function (this: EventTarget, type: string, fn: EventListenerOrEventListenerObject | null, o?: boolean | EventListenerOptions) {
      const k = fn ? key(type, fn, o) : null;
      if (k && fn && seen.get(fn as object)?.delete(k)) counts.listeners--;
      return remove.call(this, type, fn, o);
    };
    for (const name of ["MutationObserver", "PerformanceObserver"] as const) {
      const proto = (window[name] as { prototype: { observe: (...a: unknown[]) => void; disconnect: () => void } }).prototype;
      const live = new WeakSet<object>();
      const { observe, disconnect } = proto;
      proto.observe = function (this: object, ...a: unknown[]) {
        if (!live.has(this)) counts.observers++;
        live.add(this);
        return observe.apply(this, a);
      };
      proto.disconnect = function (this: object) {
        if (live.delete(this)) counts.observers--;
        return disconnect.call(this);
      };
    }
    const pending = new Set<number>();
    const st = window.setTimeout;
    const ct = window.clearTimeout;
    window.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => {
      const id: number = st(() => {
        pending.delete(id);
        counts.timers = pending.size;
        fn(...args);
      }, ms);
      pending.add(id);
      counts.timers = pending.size;
      return id;
    }) as typeof window.setTimeout;
    window.clearTimeout = ((id?: number) => {
      if (id !== undefined) pending.delete(id);
      counts.timers = pending.size;
      return ct(id);
    }) as typeof window.clearTimeout;
  });
  await open(page, "/?replay=session");

  const sample = (): Promise<Sample> =>
    page.evaluate(() => {
      const c = (window as unknown as { soak: { listeners: number; observers: number; timers: number } }).soak;
      const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
      return { at: Date.now(), ...c, nodes: document.getElementsByTagName("*").length, heap: mem ? mem.usedJSHeapSize : null };
    });
  const samples: Sample[] = [];
  const end = Date.now() + MINUTES * 60_000;
  const every = Math.max(5000, (MINUTES * 60_000) / 40);
  let next = Date.now() + every;
  for (let i = 0; Date.now() < end; i++) {
    const step = i % 6;
    if (step === 0) await page.click("#mutate");
    else if (step === 1) await page.click("#fetch");
    else if (step === 2) await page.click("#route");
    else if (step === 3) await page.evaluate(() => history.back());
    else if (step === 4) await page.fill("#name", `typed ${i}`);
    else
      await page.evaluate(() => {
        // The app prunes its own list, like a feed that keeps the latest items.
        const out = document.getElementById("out")!;
        while (out.childElementCount > 30) out.firstElementChild!.remove();
        (window as unknown as { ouo: { recordEvent(n: string): void } }).ouo.recordEvent("soak.tick");
      });
    await page.waitForTimeout(120);
    if (Date.now() >= next) {
      samples.push(await sample());
      next += every;
    }
  }
  samples.push(await sample());
  const diag = await diagnostics(page);
  const errors = await pageErrors(page);
  const c = await captured(page);
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, `soak-${browserName}.json`), JSON.stringify({ browser: browserName, minutes: MINUTES, samples, diagnostics: diag, pageErrors: errors, chunks: c.chunks.length, logs: c.logs.length, spans: c.spans.length }, null, 2));

  expect(errors).toEqual([]);
  expect(diag.internalErrors).toBe(0);
  expect(diag.state).toBe("running");
  expect(c.chunks.length).toBeGreaterThan(2);
  // After the first quarter (warm-up) nothing the SDK holds may keep growing.
  const warm = samples.slice(0, Math.max(1, Math.floor(samples.length / 4)));
  const last = samples[samples.length - 1]!;
  const peak = (k: "listeners" | "observers" | "timers"): number => Math.max(...warm.map((s) => s[k]));
  expect(last.listeners).toBeLessThanOrEqual(peak("listeners") + 2);
  expect(last.observers).toBeLessThanOrEqual(peak("observers") + 2);
  expect(last.timers).toBeLessThanOrEqual(peak("timers") + 6);
  if (last.heap !== null && warm[warm.length - 1]!.heap !== null) {
    expect(last.heap - warm[warm.length - 1]!.heap!).toBeLessThan(12 * 1024 * 1024);
  }
});
