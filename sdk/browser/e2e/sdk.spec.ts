/**
 * The SDK in real browsers (Chromium, Firefox, WebKit) against the collector stub: what jsdom
 * cannot show. Real page lifecycle, web vitals, the document load, Web Locks across tabs,
 * IndexedDB, keepalive at page close.
 */
import { expect, test } from "@playwright/test";
import { captured, diagnostics, flush, open, pageErrors, sessionId, setCollectorFault, PAGE_PORT, DEAD_COLLECTOR_PORT } from "./harness";

test("a page view: session, navigation, clicks, a traced request, a soft navigation, errors", async ({ page }) => {
  await open(page, "/?utm=1&token=abc");
  await page.click("#fetch");
  await expect(page.locator("#out")).toContainText("traceparent");
  await page.click("#route");
  await page.click("#handled");
  await page.click("#throw");
  await page.waitForTimeout(600);
  await flush(page);
  const c = await captured(page);
  const sid = await sessionId(page);
  expect(sid).toMatch(/^[0-9a-f]{32}$/);

  expect(c.events("session.start")).toHaveLength(1);
  const start = BigInt(c.events("session.start")[0]!.timeUnixNano);
  for (const l of c.logs) {
    expect(l.attributes["session.id"]).toBe(sid);
    expect(l.attributes["ouo.view.id"]).toBeTruthy();
    expect(l.attributes["event.name"]).toBeUndefined();
    expect(l.scope).toBe("ouo.rum");
    expect(BigInt(l.timeUnixNano)).toBeGreaterThanOrEqual(start);
    expect(String(l.attributes["browser.document.url.full"])).not.toContain("abc");
  }
  const nav = c.events("browser.navigation");
  expect(nav.map((n) => [n.attributes["url.full"], n.attributes["browser.navigation.same_document"]])).toEqual([
    [`http://localhost:${PAGE_PORT}/?utm=REDACTED&token=REDACTED`, false],
    [`http://localhost:${PAGE_PORT}/products/7?ref=REDACTED`, true],
  ]);
  expect(nav[0]!.attributes["ouo.view.id"]).not.toBe(nav[1]!.attributes["ouo.view.id"]);

  const clicks = c.events("browser.user_action.click");
  expect(clicks.map((k) => k.attributes["browser.css_selector"])).toEqual(["button#fetch", "button#route", "button#handled", "button#throw"]);
  expect(JSON.stringify(c.logs)).not.toMatch(/Jane|Open product|4111/);

  const span = c.spans.find((s) => s.name === "GET")!;
  expect(span.attributes["url.full"]).toBe(`http://localhost:${PAGE_PORT}/api/items?user=REDACTED&delay=REDACTED`);
  expect(span.attributes["session.id"]).toBe(sid);
  expect(span.parentSpanId ?? "").toBe("");
  // The backend saw this span's traceparent.
  expect(await page.locator("#out").textContent()).not.toContain("null");

  const ex = c.events("exception");
  expect(ex.map((e) => [e.attributes["exception.message"], e.attributes["ouo.exception.source"], e.attributes["ouo.exception.handled"]]).sort()).toEqual([
    ["handled by the page", "manual", true],
    ["thrown by the page", "error", false],
  ]);
  // The page's own handler saw its own error, once, and nothing from the SDK.
  expect(await pageErrors(page)).toEqual([expect.stringContaining("thrown by the page")]);
  expect((await diagnostics(page)).internalErrors).toBe(0);
});

test("document load: one span after the fact under the server's traceparent, navigation timing, web vitals at page hide", async ({ page, browserName }) => {
  const parent = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
  await open(page, `/?traceparent=${parent}`);
  await page.click("#mutate");
  await page.waitForTimeout(300);
  // Leaving the page: final vitals and the last flush go out with keepalive.
  await page.goto("about:blank");
  await page.waitForTimeout(700);
  const c = await captured(page);

  const load = c.spans.filter((s) => s.name === "documentLoad");
  expect(load).toHaveLength(1);
  expect(load[0]!.traceId).toBe("0af7651916cd43dd8448eb211c80319c");
  expect(load[0]!.parentSpanId).toBe("b7ad6b7169203331");
  expect(load[0]!.events ?? []).toEqual([]);
  // No children: nothing else is in the server's trace.
  expect(c.spans.filter((s) => s.traceId === load[0]!.traceId)).toHaveLength(1);
  expect(c.spans.some((s) => s.name === "documentFetch" || s.name === "resourceFetch")).toBe(false);

  const timing = c.events("browser.navigation_timing");
  expect(timing).toHaveLength(1);
  expect(Number(timing[0]!.attributes["browser.navigation_timing.load_event_end"])).toBeGreaterThan(0);

  const vitals = c.events("browser.web_vital");
  const names = vitals.map((v) => v.attributes["browser.web_vital.name"]);
  expect(names).toContain("ttfb");
  expect(names).toContain("fcp");
  if (browserName === "chromium") {
    expect(names).toEqual(expect.arrayContaining(["lcp", "cls", "inp"]));
    const inp = vitals.find((v) => v.attributes["browser.web_vital.name"] === "inp")!;
    expect(inp.attributes["browser.web_vital.attribution.interaction_target"]).toBe("button#mutate");
    expect(inp.attributes["browser.web_vital.attribution.interaction_type"]).toBe("pointer");
  }
  expect(new Set(names).size).toBe(names.length);
  const view = c.events("browser.navigation")[0]!.attributes["ouo.view.id"];
  for (const v of vitals) {
    expect(v.attributes["browser.web_vital.delta"]).toBe(v.attributes["browser.web_vital.value"]);
    expect(v.attributes["ouo.view.id"]).toBe(view);
  }
  expect(c.events("session.end")).toHaveLength(0);
});

test("page close: a request still in flight ends as an abandoned span, and everything leaves with keepalive", async ({ page }) => {
  await open(page);
  await page.click("#slow");
  await page.waitForTimeout(400);
  await page.goto("about:blank");
  await page.waitForTimeout(700);
  const c = await captured(page);
  const abandoned = c.spans.filter((s) => s.attributes["ouo.span.abandoned"] === true);
  expect(abandoned).toHaveLength(1);
  expect(String(abandoned[0]!.attributes["url.full"])).toContain("/api/slow");
});

test("two tabs share one session and exactly one of them emits session.start", async ({ context }) => {
  const a = await context.newPage();
  await open(a);
  const b = await context.newPage();
  await b.goto("/");
  await expect(b.locator("#status")).toHaveText("ready");
  await a.click("#mutate");
  await b.click("#mutate");
  await flush(a);
  await flush(b);
  expect(await sessionId(a)).toBe(await sessionId(b));
  const c = await captured(a);
  expect(c.events("session.start")).toHaveLength(1);
  expect(new Set(c.logs.map((l) => l.attributes["session.id"])).size).toBe(1);
  // Each tab has its own view.
  expect(new Set(c.events("browser.navigation").map((n) => n.attributes["ouo.view.id"])).size).toBe(2);
});

test("a reload continues the session; nothing is stored in cookies", async ({ page, context }) => {
  await open(page);
  const first = await sessionId(page);
  await page.reload();
  await expect(page.locator("#status")).toHaveText("ready");
  expect(await sessionId(page)).toBe(first);
  await flush(page);
  expect((await captured(page)).events("session.start")).toHaveLength(1);
  expect(await context.cookies()).toEqual([]);
  const keys = await page.evaluate(() => Object.keys(localStorage));
  expect(keys.every((k) => k.startsWith("ouo."))).toBe(true);
});

test("collector down at page close: telemetry waits in IndexedDB and a later page sends it", async ({ page, browserName }) => {
  test.setTimeout(90_000);
  await open(page, `/?collector=${DEAD_COLLECTOR_PORT}`);
  await page.click("#handled");
  // The first attempt fails while the page is alive: the SDK knows the collector is down.
  await page.waitForTimeout(900);
  // This one is created right before the page closes and never gets a normal attempt.
  await page.evaluate(() => (window as unknown as { ouo: { recordEvent(n: string): void } }).ouo.recordEvent("last.words"));
  await page.goto("about:blank");
  await page.waitForTimeout(500);
  expect((await captured(page)).logs).toHaveLength(0);
  // The outbox leaves a page's entries alone for a few seconds, then drains them.
  await page.goto("/");
  await expect(page.locator("#status")).toHaveText("ready");
  await expect
    .poll(async () => (await captured(page)).events("exception").map((e) => e.attributes["exception.message"]), { timeout: 40_000, intervals: [1000] })
    .toContain("handled by the page");
  // WebKit does not commit an IndexedDB write that starts while the page is closing: there the
  // record made in the last moment is lost (telemetry may be memory only on the web, TRN-20).
  if (browserName !== "webkit") await expect.poll(async () => (await captured(page)).events("last.words").length, { timeout: 20_000 }).toBe(1);
  expect(await pageErrors(page)).toEqual([]);
});

test("the collector answering 503 then recovering loses nothing; 400 is dropped and reported", async ({ page }) => {
  await open(page);
  await setCollectorFault(page, { status: 503, retryAfter: 1, count: 2 });
  await page.click("#handled");
  await flush(page);
  await expect.poll(async () => (await captured(page)).events("exception").length, { timeout: 15_000 }).toBe(1);
  await setCollectorFault(page, { status: 400, count: 1 });
  await page.click("#mutate");
  await flush(page);
  await page.waitForTimeout(600);
  await flush(page);
  const dropped = (await captured(page)).events("ouo.sdk.dropped");
  expect(dropped.some((d) => d.attributes["ouo.sdk.drop.reason"] === "rejected_status")).toBe(true);
  expect(await pageErrors(page)).toEqual([]);
});

test("consent pending: no request and no storage until granted", async ({ page, context }) => {
  await open(page, "/?consent=1");
  await page.click("#handled");
  await page.waitForTimeout(800);
  let c = await captured(page);
  expect(c.requests).toHaveLength(0);
  expect(await page.evaluate(() => localStorage.length)).toBe(0);
  expect(await page.evaluate(async () => (indexedDB.databases ? (await indexedDB.databases()).length : 0))).toBe(0);
  expect(await context.cookies()).toEqual([]);
  await page.evaluate(() => (window as unknown as { ouo: { setConsent(c: object): void } }).ouo.setConsent({ telemetry: true }));
  await flush(page);
  c = await captured(page);
  expect(c.events("session.start")).toHaveLength(1);
  expect(c.events("exception")).toHaveLength(1);
});

test("a strict Content-Security-Policy with Trusted Types: the SDK works and violates nothing", async ({ page }) => {
  const violations: string[] = [];
  page.on("console", (m) => {
    if (/Content Security Policy|TrustedHTML|Trusted Type/i.test(m.text())) violations.push(m.text());
  });
  await open(page, "/csp.html?replay=session");
  await page.click("#mutate");
  await page.click("#fetch");
  await page.waitForTimeout(1200);
  await flush(page);
  const c = await captured(page);
  expect(c.events("session.start")).toHaveLength(1);
  expect(c.chunks.length).toBeGreaterThan(0);
  expect(violations).toEqual([]);
  expect(await pageErrors(page)).toEqual([]);
});
