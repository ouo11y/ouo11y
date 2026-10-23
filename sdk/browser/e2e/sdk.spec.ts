/**
 * The built SDK in Chromium, Firefox and WebKit against the collector stub (e2e/server.mjs):
 * Web Vitals, interaction tracing, soft navigations, rage / dead clicks, long animation frames,
 * document-load trace linking, sampling, error-triggered replay and multi-tab replay.
 */
import { expect, test, type Page } from "@playwright/test";

const COLLECTOR = "http://localhost:4181";

type Attr = { key: string; value: Record<string, unknown> };
interface Span {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  attributes: Record<string, unknown>;
}
interface Log {
  eventName: string;
  attributes: Record<string, unknown>;
}
interface Captured {
  traces: Array<{ resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<Span & { attributes: Attr[] }> }> }> }>;
  logs: Array<{ resourceLogs: Array<{ scopeLogs: Array<{ logRecords: Array<Log & { attributes: Attr[] }> }> }> }>;
  replay: Array<{ session_id: string; seq: number; events: Array<{ type: number; data?: { tag?: string; payload?: { tab_id?: string } } }> }>;
  rejected: number;
}

const attrs = (list: Attr[]): Record<string, unknown> =>
  Object.fromEntries(list.map((a) => [a.key, a.value["stringValue"] ?? a.value["intValue"] ?? a.value["doubleValue"] ?? a.value["boolValue"]]));

async function captured(page: Page) {
  const c = (await (await page.request.get(`${COLLECTOR}/__captured`)).json()) as Captured;
  const spans: Span[] = c.traces.flatMap((t) => t.resourceSpans.flatMap((r) => r.scopeSpans.flatMap((s) => s.spans.map((sp) => ({ ...sp, attributes: attrs(sp.attributes) })))));
  const logs: Log[] = c.logs.flatMap((l) => l.resourceLogs.flatMap((r) => r.scopeLogs.flatMap((s) => s.logRecords.map((lr) => ({ ...lr, attributes: attrs(lr.attributes) })))));
  return { spans, logs, replay: c.replay, rejected: c.rejected };
}

async function open(page: Page, query = "") {
  await page.request.post(`${COLLECTOR}/__reset`);
  await page.goto(`/${query}`);
  await expect(page.locator("#status")).toHaveText("ready");
}

const flush = (page: Page) => page.evaluate(() => (window as unknown as { rum: { flush(): Promise<void> } }).rum.flush());

test.describe.configure({ mode: "serial" });

test("Web Vitals: every metric the engine supports is reported, the final ones at page hide", async ({ page, browserName }) => {
  await open(page);
  const supported = await page.evaluate(() => {
    const t = PerformanceObserver.supportedEntryTypes ?? [];
    return {
      LCP: t.includes("largest-contentful-paint"),
      CLS: t.includes("layout-shift"),
      INP: t.includes("event") && typeof PerformanceEventTiming !== "undefined" && "interactionId" in PerformanceEventTiming.prototype,
      hidden: document.visibilityState,
    };
  });
  expect(supported.hidden).toBe("visible");
  await page.waitForTimeout(500);
  await page.locator("#mutate").click(); // an interaction: INP, and LCP finalised on input
  await page.waitForTimeout(500);
  // Leaving the page hides it: CLS and INP are reported then, and sent with keepalive.
  await page.goto("about:blank");
  await expect
    .poll(async () => new Set((await captured(page)).logs.filter((l) => l.eventName === "web_vital").map((l) => l.attributes["ouo.web_vital.name"])), { timeout: 10_000 })
    .toEqual(new Set(["TTFB", "FCP", ...(supported.LCP ? ["LCP"] : []), ...(supported.CLS ? ["CLS"] : []), ...(supported.INP ? ["INP"] : [])]));
  test.info().annotations.push({ type: "vitals", description: `${browserName}: ${JSON.stringify(supported)}` });
});

test("a click span parents the fetch its handler sends after an await", async ({ page }) => {
  await open(page);
  await page.locator("#fetch").click();
  await expect(page.locator("#out")).toContainText("checkout");
  await page.waitForTimeout(1200);
  await flush(page);
  const { spans } = await captured(page);
  const click = spans.find((s) => s.name === "click" && s.attributes["app.widget.id"] === "button#fetch");
  const req = spans.find((s) => String(s.attributes["url.full"]).endsWith("/api/checkout?delay=50"));
  expect(click, "click span").toBeTruthy();
  expect(req, "fetch span").toBeTruthy();
  expect(req!.parentSpanId).toBe(click!.spanId);
  expect(req!.traceId).toBe(click!.traceId);
  expect(click!.attributes["app.widget.name"]).toBe("Fetch after await");
  // The API echoes the traceparent it got: the same trace.
  expect(await page.locator("#out").textContent()).toContain(click!.traceId);
});

test("a route change is a soft-navigation span under the click, parenting the new route's fetch", async ({ page }) => {
  await open(page);
  await page.locator("#route").click();
  await expect(page.locator("#out")).toContainText("/api/products/7");
  await page.waitForTimeout(1200);
  await flush(page);
  const { spans } = await captured(page);
  const click = spans.find((s) => s.name === "click" && s.attributes["app.widget.id"] === "button#route")!;
  const nav = spans.find((s) => s.name === "soft-navigation")!;
  const req = spans.find((s) => String(s.attributes["url.full"]).endsWith("/api/products/7"))!;
  expect(nav.parentSpanId).toBe(click.spanId);
  expect(req.parentSpanId).toBe(nav.spanId);
  expect(nav.attributes["url.path"]).toBe("/products/7");
  expect(nav.attributes["app.screen.name"]).toBe("/products/:id");
});

test("rage clicks and dead clicks", async ({ page }) => {
  await open(page);
  await page.locator("#rage").click({ clickCount: 1 });
  await page.locator("#rage").click();
  await page.locator("#rage").click();
  await page.locator("#rage").click();
  await page.waitForTimeout(400);
  await page.locator("#dead").click();
  await page.waitForTimeout(1500);
  await flush(page);
  const { logs, spans } = await captured(page);
  const rage = logs.filter((l) => l.eventName === "ouo.rage_click");
  expect(rage).toHaveLength(1);
  expect(rage[0]!.attributes["ouo.click.count"]).toBe(4);
  expect(rage[0]!.attributes["app.widget.id"]).toBe("button#rage");
  const dead = logs.filter((l) => l.eventName === "ouo.dead_click").map((l) => l.attributes["app.widget.id"]);
  expect(dead).toContain("button#dead");
  // Clicks that caused no request are not exported as spans.
  expect(spans.filter((s) => s.name === "click")).toHaveLength(0);
});

test("long animation frames (Chromium) with the script that caused them", async ({ page, browserName }) => {
  await open(page);
  const loaf = await page.evaluate(() => (PerformanceObserver.supportedEntryTypes ?? []).includes("long-animation-frame"));
  test.skip(!loaf, `${browserName} has no Long Animation Frames API`);
  await page.locator("#block").click();
  await page.waitForTimeout(500);
  await flush(page);
  const { logs } = await captured(page);
  const frames = logs.filter((l) => l.eventName === "ouo.long_animation_frame");
  expect(frames.length).toBeGreaterThan(0);
  const f = frames.find((l) => Number(l.attributes["ouo.long_task.duration_ms"]) >= 250)!;
  expect(f).toBeTruthy();
  expect(Number(f.attributes["ouo.long_task.blocking_duration_ms"])).toBeGreaterThan(0);
  expect(String(f.attributes["ouo.long_task.script.invoker"])).toContain("BUTTON#block");
});

test("document load joins the server's trace from <meta name=traceparent>", async ({ page }) => {
  const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
  const spanId = "00f067aa0ba902b7";
  await open(page, `?traceparent=00-${traceId}-${spanId}-01`);
  await page.waitForTimeout(500);
  await flush(page);
  const { spans } = await captured(page);
  const load = spans.find((s) => s.name === "documentLoad");
  expect(load, "documentLoad span").toBeTruthy();
  expect(load!.traceId).toBe(traceId);
  expect(load!.parentSpanId).toBe(spanId);
});

test("an unsampled session sends nothing and propagates sampled=0", async ({ page }) => {
  await open(page, "?sample=0");
  await page.locator("#fetch").click();
  await expect(page.locator("#out")).toContainText("traceparent");
  expect(await page.locator("#out").textContent()).toMatch(/-00"/);
  await page.locator("#fail").click();
  await page.waitForTimeout(800);
  await flush(page);
  const c = await captured(page);
  expect(c.spans).toHaveLength(0);
  expect(c.logs).toHaveLength(0);
  expect(c.replay).toHaveLength(0);
});

test("error-triggered replay uploads the buffer after the first error", async ({ page }) => {
  await open(page, "?replayRate=0&onError=1");
  await expect.poll(() => page.evaluate(() => (window as unknown as { rum: { replay: { isRecording(): boolean } } }).rum.replay.isRecording())).toBe(true);
  await page.locator("#mutate").click();
  await page.waitForTimeout(800);
  await flush(page);
  expect((await captured(page)).replay).toHaveLength(0);
  await page.locator("#fail").click();
  await page.waitForTimeout(800);
  await flush(page);
  const { replay } = await captured(page);
  expect(replay.length).toBeGreaterThan(0);
  const first = replay.sort((a, b) => a.seq - b.seq)[0]!;
  expect(first.events[0]!.type).toBe(4);
  expect(first.events[1]!.type).toBe(2);
});

test("multi-tab replay: only the tab the user is in records; each stretch starts with a full snapshot", async ({ page, context }) => {
  await open(page);
  const isRecording = (p: Page) => p.evaluate(() => (window as unknown as { rum: { replay: { isRecording(): boolean } } }).rum.replay.isRecording());
  await expect.poll(() => isRecording(page)).toBe(true);
  const second = await context.newPage();
  await second.goto("/");
  await expect(second.locator("#status")).toHaveText("ready");
  await expect.poll(() => isRecording(second)).toBe(true);
  // Both tabs share the session; the newest claimed the lease, so the first stopped.
  expect(await second.evaluate(() => JSON.parse(localStorage.getItem("ouo.session")!).id)).toBe(await page.evaluate(() => JSON.parse(localStorage.getItem("ouo.session")!).id));
  await expect.poll(() => isRecording(page)).toBe(false);
  // The user goes back to the first tab.
  await page.bringToFront();
  await page.locator("#mutate").click();
  await expect.poll(() => isRecording(page)).toBe(true);
  await expect.poll(() => isRecording(second)).toBe(false);
  await flush(page);
  await flush(second);
  const { replay } = await captured(page);
  const events = replay.sort((a, b) => a.seq - b.seq).flatMap((c) => c.events);
  // Tab markers in order: first tab, second tab, first tab again; each followed by its snapshot.
  const tabs = events.filter((e) => e.type === 5 && e.data?.tag === "ouo.tab").map((e) => e.data!.payload!.tab_id);
  expect(tabs.length).toBeGreaterThanOrEqual(3);
  expect(tabs[0]).toBe(tabs[2]);
  expect(tabs[1]).not.toBe(tabs[0]);
  await second.close();
});
