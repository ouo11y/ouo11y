/**
 * What only a browser with Web Locks shows (found in the review of PR #182): `session.end` at
 * shutdown and at consent withdrawal, and the last-tab rule, across real tabs.
 */
import { expect, test } from "@playwright/test";
import { captured, flush, open } from "./harness";

type Ouo = { shutdown(): Promise<void>; setConsent(c: { telemetry?: boolean }): void };

test("F: shutdown in the only tab emits session.end (shutdown)", async ({ page }) => {
  await open(page);
  await flush(page);
  await page.evaluate(() => (window as unknown as { ouo: Ouo }).ouo.shutdown());
  await page.waitForTimeout(500);
  const c = await captured(page);
  expect(c.events("session.end").map((e) => e.attributes["ouo.session.end_reason"])).toEqual(["shutdown"]);
});

test("G: withdrawing telemetry consent emits session.end (consent)", async ({ page }) => {
  await open(page);
  await flush(page);
  await page.evaluate(() => (window as unknown as { ouo: Ouo }).ouo.setConsent({ telemetry: false }));
  await page.waitForTimeout(1000);
  const c = await captured(page);
  expect(c.events("session.end").map((e) => e.attributes["ouo.session.end_reason"])).toEqual(["consent"]);
});

test("two tabs: shutdown in one leaves the shared session open; shutdown in the last one ends it", async ({ context }) => {
  const a = await context.newPage();
  await open(a);
  const b = await context.newPage();
  await b.goto("/");
  await expect(b.locator("#status")).toHaveText("ready");
  await flush(a);
  await a.evaluate(() => (window as unknown as { ouo: Ouo }).ouo.shutdown());
  await a.waitForTimeout(400);
  expect((await captured(b)).events("session.end")).toHaveLength(0);
  await a.close();
  await b.waitForTimeout(300);
  await b.evaluate(() => (window as unknown as { ouo: Ouo }).ouo.shutdown());
  await b.waitForTimeout(500);
  expect((await captured(b)).events("session.end").map((e) => e.attributes["ouo.session.end_reason"])).toEqual(["shutdown"]);
});

test("consent denied: nothing is sent after the session's end, in any tab", async ({ context }) => {
  const a = await context.newPage();
  await open(a);
  const b = await context.newPage();
  await b.goto("/");
  await expect(b.locator("#status")).toHaveText("ready");
  await flush(a);
  await flush(b);
  await a.evaluate(() => (window as unknown as { ouo: Ouo }).ouo.setConsent({ telemetry: false }));
  await a.waitForTimeout(800);
  const before = (await captured(a)).requests.length;
  expect((await captured(a)).events("session.end")).toHaveLength(1);
  await a.click("#handled");
  await a.click("#fetch");
  await a.waitForTimeout(1200);
  expect((await captured(a)).requests.length).toBe(before);
  expect(await a.evaluate(() => localStorage.getItem("ouo.session"))).toBeNull();
});
