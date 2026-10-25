/**
 * Delivery under network faults (checklist N36, part A) in Chromium, Firefox and WebKit against
 * the collector stub (e2e/server.mjs, POST /__fault): offline then online, offline across a page
 * load (IndexedDB), 429 with Retry-After, 503, a slow collector, gzip, and the same-origin proxy
 * route with a relative endpoint.
 */
import { expect, test, type Page } from "@playwright/test";
import { COLLECTOR } from "./harness";


type Attr = { key: string; value: Record<string, unknown> };
interface Req {
  path: string;
  at: number;
  encoding: string | null;
  bytes: number;
  status: number;
}
interface Captured {
  logs: Array<{ resourceLogs: Array<{ scopeLogs: Array<{ logRecords: Array<{ eventName: string; attributes: Attr[] }> }> }> }>;
  requests: Req[];
}
interface Stats {
  sent: number;
  retried: number;
  queued: number;
  dropped: number;
  rawBytes: number;
  wireBytes: number;
}

async function captured(page: Page) {
  const c = (await (await page.request.get(`${COLLECTOR}/__captured`)).json()) as Captured;
  const marks = c.logs.flatMap((l) =>
    l.resourceLogs.flatMap((r) =>
      r.scopeLogs.flatMap((s) => s.logRecords.filter((lr) => lr.eventName === "e2e.delivery").map((lr) => String(lr.attributes.find((a) => a.key === "mark")?.value["stringValue"]))),
    ),
  );
  return { marks, requests: c.requests };
}

async function open(page: Page, query = "") {
  await page.request.post(`${COLLECTOR}/__reset`);
  await page.goto(`/?replay=0&${query}`);
  await expect(page.locator("#status")).toHaveText("ready");
}

const faults = (page: Page, f: Record<string, unknown>) => page.request.post(`${COLLECTOR}/__fault`, { data: f });

/** Sends what page load queued (session.start, the document load span) so a fault armed next hits the request under test. */
async function settle(page: Page) {
  await page.evaluate(() => (window as unknown as { rum: { flush(): Promise<void> } }).rum.flush());
  await page.waitForTimeout(1200);
}

/** Emits one custom event carrying `mark`, then flushes. */
const mark = (page: Page, m: string) =>
  page.evaluate(async (m) => {
    const rum = (window as unknown as { rum: { addEvent(n: string, a: Record<string, string>): void; flush(): Promise<void> } }).rum;
    rum.addEvent("e2e.delivery", { mark: m });
    await rum.flush();
  }, m);

const stats = (page: Page) => page.evaluate(() => (window as unknown as { rum: { deliveryStats(): Stats } }).rum.deliveryStats());

test.describe.configure({ mode: "serial" });

test("offline then online: events wait and are sent on the online event", async ({ page, context }) => {
  await open(page);
  await context.setOffline(true);
  await mark(page, "offline-1");
  await mark(page, "offline-2");
  await expect.poll(async () => (await stats(page)).queued, { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
  expect((await captured(page)).marks).toEqual([]);
  await context.setOffline(false);
  await expect.poll(async () => (await captured(page)).marks.sort(), { timeout: 20_000 }).toEqual(["offline-1", "offline-2"]);
  expect((await stats(page)).dropped).toBe(0);
});

test("offline at page close: the next page load of the origin sends what was kept (IndexedDB)", async ({ page, context }) => {
  await open(page);
  await context.setOffline(true);
  await mark(page, "kept-across-load");
  await expect.poll(async () => (await stats(page)).queued, { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
  // Let the IndexedDB write land, then leave while still offline.
  await page.waitForTimeout(300);
  await page.goto("about:blank");
  await context.setOffline(false);
  await page.goto("/?replay=0");
  await expect(page.locator("#status")).toHaveText("ready");
  await expect.poll(async () => (await captured(page)).marks, { timeout: 20_000 }).toContain("kept-across-load");
});

test("429 with Retry-After: the retry waits as asked", async ({ page }) => {
  await open(page);
  await settle(page);
  await faults(page, { status: 429, retryAfter: 2, count: 1, paths: ["/v1/logs"] });
  await mark(page, "after-429");
  await expect.poll(async () => (await captured(page)).marks, { timeout: 20_000 }).toContain("after-429");
  const logs = (await captured(page)).requests.filter((r) => r.path === "/v1/logs");
  const first429 = logs.findIndex((r) => r.status === 429);
  expect(first429).toBeGreaterThanOrEqual(0);
  const retry = logs.slice(first429 + 1).find((r) => r.status === 200)!;
  expect(retry.at - logs[first429]!.at).toBeGreaterThanOrEqual(1900);
  expect((await stats(page)).retried).toBeGreaterThanOrEqual(1);
});

test("503 twice: retried with backoff and delivered once", async ({ page }) => {
  await open(page);
  await settle(page);
  const armed = (await captured(page)).requests.length;
  await faults(page, { status: 503, count: 2, paths: ["/v1/logs"] });
  await mark(page, "after-503");
  await expect.poll(async () => (await captured(page)).marks, { timeout: 20_000 }).toContain("after-503");
  const statuses = (await captured(page)).requests.slice(armed).filter((r) => r.path === "/v1/logs").map((r) => r.status);
  expect(statuses.slice(0, 2)).toEqual([503, 503]);
  await page.waitForTimeout(500);
  expect((await captured(page)).marks.filter((m) => m === "after-503")).toHaveLength(1);
});

test("400 is not retried: dropped and counted", async ({ page }) => {
  await open(page);
  await settle(page);
  await faults(page, { status: 400, count: 1, paths: ["/v1/logs"] });
  await mark(page, "bad-request");
  await expect.poll(async () => (await stats(page)).dropped, { timeout: 10_000 }).toBe(1);
  await page.waitForTimeout(1500);
  expect((await captured(page)).requests.filter((r) => r.path === "/v1/logs" && r.status === 400)).toHaveLength(1);
});

test("slow collector: the page stays responsive and nothing is sent twice", async ({ page }) => {
  await open(page);
  await faults(page, { delayMs: 4000, count: 3 });
  const t0 = Date.now();
  await page.evaluate(() => (window as unknown as { rum: { addEvent(n: string, a: Record<string, string>): void; flush(): Promise<void> } }).rum.addEvent("e2e.delivery", { mark: "slow" }));
  void page.evaluate(() => (window as unknown as { rum: { flush(): Promise<void> } }).rum.flush());
  // The main thread is free while the request waits on the server.
  expect(await page.evaluate(() => 1 + 1)).toBe(2);
  expect(Date.now() - t0).toBeLessThan(2000);
  await expect.poll(async () => (await captured(page)).marks, { timeout: 20_000 }).toContain("slow");
  await page.waitForTimeout(1000);
  expect((await captured(page)).marks.filter((m) => m === "slow")).toHaveLength(1);
});

test("OTLP bodies of 1 KB or more go gzip, and the stub decodes them", async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    const rum = (window as unknown as { rum: { addEvent(n: string, a: Record<string, string>): void } }).rum;
    for (let i = 0; i < 40; i++) rum.addEvent("e2e.delivery", { mark: `bulk-${i}`, pad: "x".repeat(100) });
  });
  await page.evaluate(() => (window as unknown as { rum: { flush(): Promise<void> } }).rum.flush());
  await expect.poll(async () => (await captured(page)).marks.filter((m) => m.startsWith("bulk-")).length, { timeout: 10_000 }).toBe(40);
  const logs = (await captured(page)).requests.filter((r) => r.path === "/v1/logs" && r.bytes >= 1024);
  expect(logs.length).toBeGreaterThan(0);
  const supported = await page.evaluate(() => typeof CompressionStream === "function");
  for (const r of logs) expect(r.encoding).toBe(supported ? "gzip" : null);
  const s = await stats(page);
  if (supported) expect(s.wireBytes).toBeLessThan(s.rawBytes);
  test.info().annotations.push({ type: "gzip", description: `raw ${s.rawBytes} B, wire ${s.wireBytes} B` });
});

test("first-party route: a relative endpoint through a same-origin proxy delivers traces, logs and replay", async ({ page }) => {
  await page.request.post(`${COLLECTOR}/__reset`);
  await page.goto("/?endpoint=/otel");
  await expect(page.locator("#status")).toHaveText("ready");
  await mark(page, "via-proxy");
  await page.locator("#fetch").click();
  await page.waitForTimeout(1500);
  await page.evaluate(() => (window as unknown as { rum: { flush(): Promise<void> } }).rum.flush());
  await expect.poll(async () => (await captured(page)).marks, { timeout: 10_000 }).toContain("via-proxy");
  const paths = new Set((await captured(page)).requests.map((r) => r.path));
  expect(paths).toEqual(new Set(["/v1/logs", "/v1/traces", "/v1/replay/chunks"]));
});

test("page close over the keepalive budget: the rest is kept and sent by the next page load", async ({ page }) => {
  await open(page);
  // ~200 KB of events queued, then the tab is closed with no flush beforehand.
  await page.evaluate(() => {
    const rum = (window as unknown as { rum: { addEvent(n: string, a: Record<string, string>): void } }).rum;
    for (let i = 0; i < 60; i++) rum.addEvent("e2e.delivery", { mark: `unload-${i}`, pad: `${i}`.repeat(3000) });
  });
  await page.goto("about:blank");
  await page.goto("/?replay=0");
  await expect(page.locator("#status")).toHaveText("ready");
  await expect.poll(async () => new Set((await captured(page)).marks.filter((m) => m.startsWith("unload-"))).size, { timeout: 20_000 }).toBe(60);
});
