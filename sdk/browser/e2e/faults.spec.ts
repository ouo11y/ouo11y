/**
 * The golden rule in real browsers: with the SDK failing in every way the harness can make it
 * fail, the page behaves exactly as it does without the SDK. The same journey runs with the SDK
 * off and under each fault; what the page did and saw must be identical.
 */
import { expect, test, type Page } from "@playwright/test";
import { DEAD_COLLECTOR_PORT, resetCollector, setCollectorFault } from "./harness";

interface Transcript {
  out: string;
  path: string;
  errors: string[];
  apiStatus: number;
  historyLength: number;
}

async function journey(page: Page, query: string, arm?: (page: Page) => Promise<void>): Promise<Transcript> {
  await resetCollector(page);
  await arm?.(page);
  const consoleErrors: string[] = [];
  // WebKit reports a refused connection to the collector as a console line here; it is the
  // browser's network log, not an exception on the page.
  page.on("pageerror", (e) => {
    if (!/access control checks|Failed to load resource/.test(e.message)) consoleErrors.push(e.message);
  });
  await page.goto(`/?${query}`);
  await expect(page.locator("#status")).toHaveText("ready");
  const before = await page.evaluate(() => history.length);
  await page.click("#fetch");
  await expect(page.locator("#out")).toContainText("/api/items");
  await page.click("#mutate");
  await page.click("#route");
  await page.click("#handled");
  await page.click("#throw");
  await page.waitForTimeout(800);
  const apiStatus = await page.evaluate(async () => (await fetch("/api/items")).status);
  const t: Transcript = {
    // Only what does not vary run to run: the request path, not the trace id the SDK adds.
    out: ((await page.locator("#out").textContent()) ?? "").replace(/Added at \d+/, "Added at T").replace(/"traceparent":"[^"]*"|"traceparent":null/, '"traceparent":X'),
    path: await page.evaluate(() => location.pathname + location.search),
    errors: [...(await page.evaluate(() => (window as unknown as { pageErrors: string[] }).pageErrors)), ...consoleErrors],
    apiStatus,
    historyLength: (await page.evaluate(() => history.length)) - before,
  };
  await page.goto("about:blank");
  return t;
}

const FAULTS: Array<[string, string, ((page: Page) => Promise<void>)?]> = [
  ["healthy", "replay=session"],
  ["collector down", `replay=session&collector=${DEAD_COLLECTOR_PORT}`],
  ["collector answers 500", "replay=session", (page) => setCollectorFault(page, { status: 500 })],
  ["collector answers 429 forever", "replay=session", (page) => setCollectorFault(page, { status: 429, retryAfter: 1 })],
  ["collector very slow", "replay=session", (page) => setCollectorFault(page, { delayMs: 5000 })],
  ["every SDK internal throws", "replay=session&fault=*"],
  ["replay cannot load or mask", "replay=session&fault=replay.load,replay.mask"],
  ["storage and the outbox throw", "replay=session&fault=store.open,store.put"],
];

test("the page's transcript is the same with the SDK off and under every fault", async ({ page }) => {
  test.setTimeout(180_000);
  const baseline = await journey(page, "sdk=0");
  // The page's own error is seen by the page, in each engine's wording.
  expect(baseline.errors.length).toBeGreaterThan(0);
  expect(baseline.errors.every((e) => e.includes("thrown by the page"))).toBe(true);
  for (const [name, query, arm] of FAULTS) {
    expect(await journey(page, query, arm), name).toEqual(baseline);
  }
});

test("storage blocked by the browser: the SDK runs from memory and the page sees nothing", async ({ page }) => {
  await page.addInitScript(() => {
    const deny = (): never => {
      throw new DOMException("denied", "SecurityError");
    };
    Object.defineProperty(window, "localStorage", { get: deny });
    Object.defineProperty(window, "indexedDB", { get: deny });
  });
  const t = await journey(page, "replay=session");
  expect(t.errors.filter((e) => !e.includes("thrown by the page"))).toEqual([]);
  expect(t.apiStatus).toBe(200);
});
