/**
 * Fault injection in Chromium, Firefox and WebKit (checklist N42): a page whose own code throws
 * in its listeners, fetch and XHR callbacks, timers and promises behaves exactly the same with
 * and without the SDK, also when Web Storage is blocked or full and when the collector is down.
 * "The same" is the page's transcript (e2e/pages/faults.js): what its own handlers saw, in order.
 *
 * Network faults of the collector (429, 503, slow, offline) are delivery's specs; they share the
 * stub's fault switch (`setCollectorFault`, e2e/harness.ts).
 */
import { expect, test, type Browser, type Page } from "@playwright/test";
import { captured, DEAD_COLLECTOR_PORT, flush, open } from "./harness";

const STEPS = ["throw-handler", "fetch-then-throw", "fetch-read", "fetch-fail", "xhr-throw", "push", "push-bad", "reject", "timer-throw", "link", "console", "storage", "back"];

const BLOCKED_STORAGE = () => {
  for (const name of ["localStorage", "sessionStorage"]) {
    Object.defineProperty(window, name, {
      configurable: true,
      get() {
        throw new DOMException("The operation is insecure.", "SecurityError");
      },
    });
  }
};
const FULL_STORAGE = () => {
  Storage.prototype.setItem = function () {
    throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
  };
};

interface Variant {
  name: string;
  init?: () => void;
  query?: string;
}
const VARIANTS: Variant[] = [
  { name: "healthy collector" },
  { name: "storage blocked (sandboxed / third-party iframe)", init: BLOCKED_STORAGE },
  { name: "storage full (quota exceeded)", init: FULL_STORAGE },
  { name: "collector down", query: `collector=${DEAD_COLLECTOR_PORT}` },
];

const transcript = (page: Page) => page.evaluate(() => [...(window as unknown as { transcript: string[] }).transcript]);

/** Runs every step in a fresh context and returns the page's transcript. */
async function run(browser: Browser, variant: Variant, sdk: boolean): Promise<{ lines: string[]; page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  if (variant.init) await page.addInitScript(variant.init);
  await open(page, `/faults.html?sdk=${sdk ? 1 : 0}&${variant.query ?? ""}`);
  for (const step of STEPS) {
    if (step === "back") await page.evaluate(() => history.back());
    else await page.locator(`#${step}`).click();
    await page.waitForTimeout(250);
  }
  // Settled: nothing more arrives.
  let last = -1;
  await expect.poll(async () => {
    const n = (await transcript(page)).length;
    const stable = n === last;
    last = n;
    return stable;
  }, { intervals: [300], timeout: 10_000 }).toBe(true);
  return { lines: await transcript(page), page, close: () => context.close() };
}

test.describe.configure({ mode: "serial" });

for (const variant of VARIANTS) {
  test(`the page behaves the same with and without the SDK: ${variant.name}`, async ({ browser }) => {
    const without = await run(browser, variant, false);
    await without.close();
    const withSdk = await run(browser, variant, true);
    try {
      expect(withSdk.lines).toEqual(without.lines);
      // The page did fail: the transcript is not trivially empty.
      expect(without.lines).toEqual(expect.arrayContaining(["first listener", "second listener ran", "onerror: handler boom", "onunhandledrejection: fetch callback boom", "onerror: xhr onload boom", "onunhandledrejection: unhandled boom", "onerror: timer boom"]));
      // The SDK is alive on that page: it never said it could not start.
      const sdkUp = await withSdk.page.evaluate(() => typeof (window as unknown as { rum?: { session: { id(): string } } }).rum?.session.id() === "string" && (window as unknown as { rum: { session: { id(): string } } }).rum.session.id() !== "");
      expect(sdkUp).toBe(true);

      if (variant.query?.includes("collector=")) return;
      const BOOMS = ["handler boom", "fetch callback boom", "xhr onload boom", "unhandled boom", "timer boom"];
      // Each page error is reported once.
      await expect
        .poll(async () => {
          await flush(withSdk.page);
          const { logs } = await captured(withSdk.page);
          return logs.filter((l) => l.eventName === "exception").map((l) => String(l.attributes["exception.message"])).filter((m) => BOOMS.includes(m)).sort();
        }, { timeout: 15_000 })
        .toEqual([...BOOMS].sort());
      const { logs, replay } = await captured(withSdk.page);
      expect(logs.some((l) => l.eventName === "http.request.failed")).toBe(true);
      // One session for the page, also when it can only live in memory.
      expect(new Set(logs.map((l) => l.attributes["session.id"])).size).toBe(1);
      expect(replay.length, "replay chunks").toBeGreaterThan(0);
    } finally {
      await withSdk.close();
    }
  });
}
