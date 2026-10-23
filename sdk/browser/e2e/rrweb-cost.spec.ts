/**
 * rrweb's cost on a large DOM (checklist N43), run with the soak (soak.config.ts), not per PR.
 * For each mode on e2e/pages/big.html (OUO_RRWEB_NODES, default 10000 elements):
 *   none        no SDK (baseline)
 *   sdk         SDK, replay off
 *   replay      SDK, replay on (full snapshot at start, mutations recorded)
 *   blocked     SDK, replay on, the table under `replay.blockSelector`
 * it measures, at start and during a churn of 1000 cell texts every 100 ms for 10 s:
 *   - main-thread blocking, every engine: the lag of a 10 ms timer chain, summed over lags > 20 ms;
 *   - in Chromium: script and task time (CDP Performance.getMetrics deltas) and JS heap after GC;
 *   - replay bytes delivered (uncompressed JSON) and the first full snapshot's size.
 * Results print and go to $OUO_SOAK_OUT (default test-results)/rrweb-cost-<engine>.json.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test, type CDPSession, type Page } from "@playwright/test";
import { captured, COLLECTOR_PORT, open } from "./harness";

const NODES = Number(process.env.OUO_RRWEB_NODES ?? 10000);
const MODES = [
  { name: "none", query: "sdk=0" },
  { name: "sdk", query: "replay=0" },
  { name: "replay", query: "" },
  { name: "blocked", query: "block=%23grid" },
] as const;

async function metrics(cdp: CDPSession | null): Promise<Record<string, number>> {
  if (!cdp) return {};
  const { metrics } = (await cdp.send("Performance.getMetrics")) as { metrics: Array<{ name: string; value: number }> };
  return Object.fromEntries(metrics.map((m) => [m.name, m.value]));
}
async function heapMB(cdp: CDPSession | null): Promise<number | undefined> {
  if (!cdp) return undefined;
  await cdp.send("HeapProfiler.collectGarbage");
  const { usedSize } = (await cdp.send("Runtime.getHeapUsage")) as { usedSize: number };
  return Math.round((usedSize / 1048576) * 10) / 10;
}
const jank = (page: Page) => page.evaluate(() => ({ ...(window as unknown as { jank: { blockedMs: number; worstMs: number } }).jank }));
const ms = (s: number | undefined) => (s === undefined ? undefined : Math.round(s * 1000));

test(`rrweb cost on a ${NODES}-element DOM`, async ({ page, browserName }) => {
  test.setTimeout(5 * 60_000);
  const results: Array<Record<string, unknown>> = [];
  for (const mode of MODES) {
    await open(page, `/big.html?nodes=${NODES}&collector=${COLLECTOR_PORT}&${mode.query}`);
    // Counters start after the page built its table: what follows is the SDK's start.
    const cdp = browserName === "chromium" ? await page.context().newCDPSession(page) : null;
    await cdp?.send("Performance.enable");
    const before = await metrics(cdp);
    const initMs = await page.evaluate(() => (window as unknown as { startSDK(): Promise<number> }).startSDK());
    // Start: rrweb loads and takes its full snapshot.
    if (mode.name === "replay" || mode.name === "blocked") {
      await expect.poll(() => page.evaluate(() => (window as unknown as { rum: { replay: { isRecording(): boolean } } }).rum.replay.isRecording())).toBe(true);
    }
    await page.waitForTimeout(2000);
    const start = await jank(page);
    const afterStart = await metrics(cdp);
    await page.evaluate(() => (window as unknown as { churn(c: number, t: number, e: number): Promise<void> }).churn(1000, 100, 100));
    await page.waitForTimeout(1500);
    const churn = await jank(page);
    const afterChurn = await metrics(cdp);
    await page.evaluate(() => (window as unknown as { rum?: { flush(): Promise<void> } }).rum?.flush());
    const { replay } = await captured(page);
    const events = replay.sort((a, b) => a.seq - b.seq).flatMap((c) => c.events);
    const snapshot = events.find((e) => e.type === 2);
    const r = {
      mode: mode.name,
      nodes: await page.evaluate(() => document.getElementsByTagName("*").length),
      initMs: Math.round(initMs),
      startBlockedMs: Math.round(start.blockedMs),
      startWorstLagMs: Math.round(start.worstMs),
      churnBlockedMs: Math.round(churn.blockedMs - start.blockedMs),
      churnWorstLagMs: Math.round(churn.worstMs),
      startScriptMs: ms(afterStart["ScriptDuration"]! - (before["ScriptDuration"] ?? 0)),
      startTaskMs: ms(afterStart["TaskDuration"]! - (before["TaskDuration"] ?? 0)),
      churnScriptMs: ms(afterChurn["ScriptDuration"]! - afterStart["ScriptDuration"]!),
      churnTaskMs: ms(afterChurn["TaskDuration"]! - afterStart["TaskDuration"]!),
      heapMB: await heapMB(cdp),
      replayKB: Math.round(JSON.stringify(events).length / 1024),
      snapshotKB: snapshot ? Math.round(JSON.stringify(snapshot).length / 1024) : 0,
      replayEvents: events.length,
    };
    results.push(r);
    console.log(`[rrweb-cost ${browserName}] ${JSON.stringify(r)}`);
    await cdp?.detach();
  }
  const dir = process.env.OUO_SOAK_OUT ?? "test-results";
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/rrweb-cost-${browserName}.json`, JSON.stringify({ browserName, nodes: NODES, results }, null, 2));
  const by = Object.fromEntries(results.map((r) => [r.mode, r]));
  // Replay records; blocking the table keeps it out of the snapshot and the stream.
  expect(Number(by["replay"]!["snapshotKB"])).toBeGreaterThan(Number(by["blocked"]!["snapshotKB"]) * 5);
  expect(Number(by["blocked"]!["replayKB"])).toBeLessThan(Number(by["replay"]!["replayKB"]) / 5);
});
