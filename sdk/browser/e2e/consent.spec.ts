/**
 * Consent in real browsers (README, "Consent"): with `consent: "pending"` the page's storage,
 * IndexedDB, cookies, BroadcastChannel and the collector see nothing from the SDK until the grant;
 * a revocation stops export and removes the SDK's ids and its IndexedDB outbox.
 */
import { expect, test, type Page } from "@playwright/test";
import { captured, COLLECTOR, flush, open } from "./harness";

test.describe.configure({ mode: "serial" });

/** Counts every storage, IndexedDB, cookie, BroadcastChannel and beacon call, before any page script runs. */
async function probe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const calls: string[] = [];
    (window as unknown as { __probe: string[] }).__probe = calls;
    for (const m of ["setItem", "getItem", "removeItem", "clear", "key"] as const) {
      const orig = Storage.prototype[m] as (...a: unknown[]) => unknown;
      Storage.prototype[m] = function (this: Storage, ...a: unknown[]) {
        calls.push(`storage.${m} ${String(a[0] ?? "")}`);
        return orig.apply(this, a);
      } as never;
    }
    const open = IDBFactory.prototype.open;
    IDBFactory.prototype.open = function (this: IDBFactory, ...a: Parameters<IDBFactory["open"]>) {
      calls.push(`indexedDB.open ${a[0]}`);
      return open.apply(this, a);
    };
    const del = IDBFactory.prototype.deleteDatabase;
    IDBFactory.prototype.deleteDatabase = function (this: IDBFactory, name: string) {
      calls.push(`indexedDB.deleteDatabase ${name}`);
      return del.call(this, name);
    };
    const cookie = Object.getOwnPropertyDescriptor(Document.prototype, "cookie")!;
    Object.defineProperty(Document.prototype, "cookie", {
      configurable: true,
      get() {
        calls.push("cookie.get");
        return cookie.get!.call(this);
      },
      set(v: string) {
        calls.push("cookie.set");
        cookie.set!.call(this, v);
      },
    });
    const BC = window.BroadcastChannel;
    if (BC) {
      window.BroadcastChannel = class extends BC {
        constructor(name: string) {
          calls.push(`BroadcastChannel ${name}`);
          super(name);
        }
      };
    }
    if (navigator.sendBeacon) {
      const beacon = navigator.sendBeacon.bind(navigator);
      navigator.sendBeacon = (url, data) => {
        calls.push(`sendBeacon ${String(url)}`);
        return beacon(url, data);
      };
    }
  });
}

const calls = (page: Page) => page.evaluate(() => (window as unknown as { __probe: string[] }).__probe.slice());
const ouoKeys = (page: Page) => page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("ouo.")));
const databases = (page: Page) => page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name));
const setConsent = (page: Page, telemetry: boolean, replay: boolean) =>
  page.evaluate(([t, r]) => (window as unknown as { rum: { setConsent(c: object): Promise<void> } }).rum.setConsent({ telemetry: t, replay: r }), [telemetry, replay] as const);

test("pending: nothing stored, opened or sent until the grant; the grant sends the queued error", async ({ page }) => {
  await probe(page);
  const toCollector: string[] = [];
  page.on("request", (r) => {
    if (r.url().startsWith(COLLECTOR)) toCollector.push(r.url());
  });
  await open(page, "/?consent=pending&beacon=1");
  await page.click("#fail"); // captureError, queued
  await page.click("#mutate");
  await page.click("#fetch"); // the app's request: not traced
  await expect(page.locator("#out")).toContainText("traceparent");
  expect(await page.locator("#out").textContent()).toContain('"traceparent":null');
  // A tab switch: what would flush and send at page hide.
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await page.waitForTimeout(1500);

  expect(await calls(page)).toEqual([]);
  expect(await ouoKeys(page)).toEqual([]);
  expect(await databases(page)).not.toContain("ouo-delivery");
  expect(toCollector).toEqual([]);
  expect(await page.evaluate(() => (window as unknown as { rum: { session: { id(): string } } }).rum.session.id())).toBe("");

  await setConsent(page, true, true);
  expect((await ouoKeys(page)).sort()).toEqual(["ouo.device", "ouo.session", "ouo.user"]);
  await expect.poll(async () => (await calls(page)).some((c) => c.startsWith("BroadcastChannel"))).toBe(true);
  await flush(page);
  await expect
    .poll(async () => (await captured(page)).logs.map((l) => l.eventName))
    .toEqual(expect.arrayContaining(["session.start", "exception"]));
  const { logs } = await captured(page);
  expect(logs.find((l) => l.eventName === "exception")!.attributes["exception.message"]).toBe("e2e failure");
  // Replay consent given: the recorder starts and uploads.
  await page.click("#mutate");
  await expect
    .poll(async () => {
      await flush(page);
      return (await captured(page)).replay.length;
    })
    .toBeGreaterThan(0);
});

test("revoked: export stops, the ids and the IndexedDB outbox are removed", async ({ page }) => {
  await open(page, "/");
  await expect.poll(() => page.evaluate(() => (window as unknown as { rum: { replay: { isRecording(): boolean } } }).rum.replay.isRecording())).toBe(true);
  await flush(page);
  await expect.poll(() => databases(page)).toContain("ouo-delivery");
  expect((await ouoKeys(page)).length).toBeGreaterThan(0);

  const toCollector: string[] = [];
  page.on("request", (r) => {
    if (r.url().startsWith(COLLECTOR)) toCollector.push(r.url());
  });
  await page.click("#fail"); // buffered at the revocation: dropped, not sent
  await page.click("#mutate");
  await setConsent(page, false, false);

  expect(await ouoKeys(page)).toEqual([]);
  expect(await databases(page)).not.toContain("ouo-delivery");
  expect(await page.evaluate(() => (window as unknown as { rum: { replay: { isRecording(): boolean } } }).rum.replay.isRecording())).toBe(false);
  await page.click("#mutate");
  await page.click("#fetch");
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await page.waitForTimeout(1500);
  expect(toCollector).toEqual([]);
  expect(await ouoKeys(page)).toEqual([]);
  expect(await databases(page)).not.toContain("ouo-delivery");
});
