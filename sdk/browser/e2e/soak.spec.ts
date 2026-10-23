/**
 * Long-session soak (checklist N43): the busy SPA of e2e/pages/soak.js with replay on, for
 * OUO_SOAK_MINUTES (default 2; the nightly / manual run uses 60). Sampled every
 * OUO_SOAK_SAMPLE_S seconds (default: 20 samples per run, at least 10 s apart):
 *   - in every engine: listeners on window/document, active observers, pending timers and
 *     intervals, DOM nodes (e2e/pages/soak-probe.js);
 *   - in Chromium also: JS heap after a forced GC, and the engine's own listener and node counts
 *     (CDP Performance.getMetrics).
 * Pass: after the warm-up (the first 20 % of the samples) nothing grows: counts stay at or below
 * the warm-up maximum plus a small slack, and the heap's late median stays within 15 % (+2 MB)
 * of its early median. Results go to $OUO_SOAK_OUT (default test-results)/soak-<engine>.json.
 *
 * Run with `npm run test:soak` (soak.config.ts); never part of the per-PR suite.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test, type CDPSession, type Page } from "@playwright/test";
import { captured, COLLECTOR_PORT, open, resetCollector } from "./harness";

const MINUTES = Number(process.env.OUO_SOAK_MINUTES ?? 2);
const SAMPLE_S = Number(process.env.OUO_SOAK_SAMPLE_S ?? Math.max(10, Math.round((MINUTES * 60) / 20)));
const PROBE = new URL("./pages/soak-probe.js", import.meta.url).pathname;

interface Sample {
  t: number;
  listeners: number;
  observers: number;
  timers: number;
  intervals: number;
  nodes: number;
  heapMB?: number;
  cdpListeners?: number;
  cdpNodes?: number;
  delivered: { logs: number; spans: number; replay: number; rejected: number };
}

async function chromiumMetrics(cdp: CDPSession | null): Promise<Partial<Sample>> {
  if (!cdp) return {};
  await cdp.send("HeapProfiler.collectGarbage");
  const { usedSize } = (await cdp.send("Runtime.getHeapUsage")) as { usedSize: number };
  const { metrics } = (await cdp.send("Performance.getMetrics")) as { metrics: Array<{ name: string; value: number }> };
  const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]));
  return { heapMB: Math.round((usedSize / 1048576) * 100) / 100, cdpListeners: m["JSEventListeners"] ?? 0, cdpNodes: m["Nodes"] ?? 0 };
}

/** What a user does between samples: clicks rows and routes, types, scrolls, goes back. */
async function behave(page: Page, ms: number): Promise<void> {
  const end = Date.now() + ms;
  let i = 0;
  while (Date.now() < end) {
    i++;
    await page.locator(".row button").nth(i % 50).click({ timeout: 2000 }).catch(() => undefined);
    if (i % 3 === 0) await page.locator("#search").fill(`q${i}`);
    if (i % 4 === 0) await page.mouse.wheel(0, i % 8 === 0 ? -600 : 600);
    if (i % 7 === 0) await page.locator("#back").click();
    if (i % 5 === 0) await page.locator("#next").click();
    await page.waitForTimeout(700);
  }
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)]! : 0;
};

test(`soak: ${MINUTES} min busy SPA with replay, no growth after warm-up`, async ({ page, browserName }) => {
  test.setTimeout((MINUTES + 5) * 60_000);
  await page.addInitScript({ path: PROBE });
  const cdp = browserName === "chromium" ? await page.context().newCDPSession(page) : null;
  await cdp?.send("Performance.enable");
  await open(page, `/soak.html?collector=${COLLECTOR_PORT}${process.env.OUO_SOAK_QUERY ?? ""}`);

  const samples: Sample[] = [];
  const started = Date.now();
  const totals = { logs: 0, spans: 0, replay: 0, rejected: 0 };
  while (Date.now() - started < MINUTES * 60_000) {
    await behave(page, SAMPLE_S * 1000);
    await page.evaluate(() => (window as unknown as { rum?: { flush(): Promise<void> } }).rum?.flush());
    // Counted and cleared each sample, so the stub's memory stays flat for an hour.
    const c = await captured(page);
    await resetCollector(page);
    const delivered = { logs: c.logs.length, spans: c.spans.length, replay: c.replay.length, rejected: c.rejected };
    for (const k of Object.keys(totals) as Array<keyof typeof totals>) totals[k] += delivered[k];
    const probe = (await page.evaluate(() => (window as unknown as { __probe(): Omit<Sample, "t" | "delivered"> }).__probe())) as Omit<Sample, "t" | "delivered">;
    const sample: Sample = { t: Math.round((Date.now() - started) / 1000), ...probe, ...(await chromiumMetrics(cdp)), delivered };
    samples.push(sample);
    console.log(`[soak ${browserName}] ${JSON.stringify(sample)}`);
  }

  const dir = process.env.OUO_SOAK_OUT ?? "test-results";
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/soak-${browserName}.json`, JSON.stringify({ browserName, minutes: MINUTES, sampleSeconds: SAMPLE_S, totals, samples }, null, 2));

  expect(samples.length).toBeGreaterThanOrEqual(5);
  const warm = Math.max(1, Math.ceil(samples.length * 0.2));
  const early = samples.slice(0, warm);
  const after = samples.slice(warm);
  const maxOf = (xs: Sample[], k: keyof Sample) => Math.max(...xs.map((s) => Number(s[k] ?? 0)));
  // Slack: timers and listeners come and go with in-flight work at the moment of sampling.
  const slack: Partial<Record<keyof Sample, number>> = { listeners: 2, observers: 1, timers: 15, intervals: 0, nodes: 400 };
  for (const [k, s] of Object.entries(slack) as Array<[keyof Sample, number]>) {
    expect(maxOf(after, k), `${k} after warm-up`).toBeLessThanOrEqual(maxOf(early, k) + s);
  }
  if (cdp) {
    const heap = samples.map((s) => s.heapMB!);
    const third = Math.max(1, Math.floor(after.length / 3));
    const earlyHeap = median(heap.slice(warm, warm + third));
    const lateHeap = median(heap.slice(-third));
    expect(lateHeap, `heap: early ${earlyHeap} MB, late ${lateHeap} MB`).toBeLessThanOrEqual(earlyHeap * 1.15 + 2);
    expect(maxOf(after, "cdpListeners"), "engine listener count").toBeLessThanOrEqual(maxOf(early, "cdpListeners") * 1.1 + 50);
  }
  // Delivery kept up the whole time, and replay kept recording.
  expect(totals.rejected).toBe(0);
  expect(after.every((s) => s.delivered.logs > 0 && s.delivered.replay > 0)).toBe(true);
});
