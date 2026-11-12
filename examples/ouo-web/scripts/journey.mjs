#!/usr/bin/env node
// Scripted shopper journey through the ouo-web example in a headless browser (Playwright).
//
//   node scripts/journey.mjs [--browser chromium|firefox|webkit] [--url http://localhost:4173]
//                            [--backend http://localhost:8081] [--out journey.json]
//
// Products -> product -> add to cart -> second product -> add -> cart -> checkout (card) ->
// product -> add -> checkout (broken-card, the backend answers 500) -> Chaos page: a dead button
// (`ouo.user_action.frustration` type dead), four fast clicks on it (type rage), a 300 ms long
// task, a render error (OuoErrorBoundary). Every request the page sends to the backend is counted (preflights
// excluded) with the trace id of its traceparent; the summary written to --out is what
// scripts/verify.py checks Tempo, Loki and rum-api against:
//   {start, end, requests, traces, sessions: [session ids], url, backend, browser, vitals, loaf}
// `traces` is the number of distinct trace ids: every request is its own trace (a click never
// starts one), so it equals `requests`. `vitals` lists the Web Vitals this engine
// reports (verify expects each of them). The journey leaves the page at the end so the SDK flushes
// (pagehide, visibilitychange, keepalive), and the browser stays up until those requests are out.
import { chromium, firefox, webkit } from "playwright";
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    url: { type: "string", default: process.env.OUO_WEB_URL ?? "http://localhost:4173" },
    backend: { type: "string", default: process.env.VITE_BACKEND_URL ?? "http://localhost:8081" },
    out: { type: "string", default: "journey.json" },
    headed: { type: "boolean", default: false },
    browser: { type: "string", default: process.env.OUO_WEB_BROWSER ?? "chromium" },
  },
});

const log = (msg) => console.log(`${new Date().toISOString()} [journey] ${msg}`);
const backend = args.backend.replace(/\/$/, "");
const start = Math.floor(Date.now() / 1000) - 1;

const engines = { chromium, firefox, webkit };
if (!engines[args.browser]) throw new Error(`--browser must be one of ${Object.keys(engines).join(", ")}`);
const browser = await engines[args.browser].launch({ headless: !args.headed });
const context = await browser.newContext();
const page = await context.newPage();
let requests = 0;
const traceIds = new Set();
const failed = [];
page.on("requestfinished", async (r) => {
  if (!r.url().startsWith(backend) || r.method() === "OPTIONS") return;
  requests++;
  const tp = (await r.allHeaders())["traceparent"];
  if (tp) traceIds.add(tp.split("-")[1]);
});
page.on("requestfailed", (r) => {
  if (r.url().startsWith(backend)) failed.push(`${r.method()} ${r.url()} ${r.failure()?.errorText}`);
});
page.on("pageerror", (e) => log(`page error: ${e.message}`));

async function addProduct(index) {
  await page.getByRole("navigation").getByRole("link", { name: "Products", exact: true }).click();
  await page.getByTestId("product-grid").waitFor();
  await page.locator(".product-card").nth(index).click();
  await page.getByRole("button", { name: "Add to cart" }).click();
  await page.getByText("Added.").waitFor();
  log(`added product ${index}`);
}

async function checkout(method) {
  await page.getByRole("navigation").getByRole("link", { name: /^Cart/ }).click();
  await page.getByTestId("cart-table").waitFor();
  await page.getByRole("link", { name: /checkout/i }).click();
  const form = page.getByTestId("checkout-form");
  await form.locator('input[name="name"]').fill("Journey Shopper");
  await form.locator('input[name="email"]').fill("shopper@example.test");
  await form.locator('input[name="card"]').fill("4242424242424242");
  await form.locator('select[name="paymentMethod"]').selectOption(method);
  await form.locator('button[type="submit"]').click();
  if (method === "card") {
    await page.getByTestId("order-id").waitFor();
  } else {
    await page.locator(".alert").first().waitFor();
  }
  log(`checkout ${method}`);
}

async function chaos() {
  await page.getByRole("navigation").getByRole("link", { name: "Chaos", exact: true }).click();
  await page.getByTestId("chaos-log").waitFor();
  const button = (id) => page.locator(`[data-chaos="${id}"]`);
  await button("dead").click();
  await page.waitForTimeout(2400); // nothing happens for two seconds after the click: a dead click
  for (let i = 0; i < 4; i++) await button("dead").click({ delay: 20 });
  await page.waitForTimeout(1200);
  await button("long-task").click();
  await page.waitForTimeout(500);
  await button("render-error").click();
  await page.getByTestId("page-failed").waitFor();
  log("chaos: dead click, rage click, long task, render error");
}

log(`open ${args.url} in ${args.browser}`);
await page.goto(args.url);
await page.getByTestId("product-grid").waitFor();
const support = await page.evaluate(() => {
  const t = PerformanceObserver.supportedEntryTypes ?? [];
  const inp = t.includes("event") && typeof PerformanceEventTiming !== "undefined" && "interactionId" in PerformanceEventTiming.prototype;
  return {
    vitals: ["TTFB", "FCP", ...(t.includes("largest-contentful-paint") ? ["LCP"] : []), ...(t.includes("layout-shift") ? ["CLS"] : []), ...(inp ? ["INP"] : [])],
    loaf: t.includes("long-animation-frame"),
  };
});
await addProduct(0);
await addProduct(1);
await checkout("card");
await addProduct(2);
await checkout("broken-card");
await chaos();
// Let the last responses and spans settle, then read the session before closing.
await page.waitForTimeout(2000);
const sessions = await page.evaluate(() => {
  try {
    const s = JSON.parse(localStorage.getItem("ouo.session") ?? "null");
    return s?.id ? [s.id] : [];
  } catch {
    return [];
  }
});
// Leave the page the way a user does: a navigation unloads it with pagehide and visibilitychange in
// every engine (WebKit's close({ runBeforeUnload }) fires neither). The SDK flushes there with
// keepalive requests, which the browser sends after the page is gone, but only while the browser
// process lives: keep it up a moment.
await page.goto("about:blank");
await page.close();
await new Promise((r) => setTimeout(r, 3000));
await context.close();
await browser.close();
const end = Math.ceil(Date.now() / 1000) + 1;

const summary = {
  start, end, requests, traces: traceIds.size, sessions, url: args.url, backend, failed,
  browser: args.browser, vitals: support.vitals, loaf: support.loaf,
};
writeFileSync(args.out, JSON.stringify(summary, null, 2) + "\n");
log(`${args.browser}: ${requests} backend requests in ${traceIds.size} traces, session ${sessions.join(", ") || "unknown"}, failed ${failed.length}; wrote ${args.out}`);
if (failed.length) {
  console.error(failed.join("\n"));
  process.exit(1);
}
