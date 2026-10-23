#!/usr/bin/env node
// Scripted shopper journey through the ouo-web example in headless Chromium (Playwright).
//
//   node scripts/journey.mjs [--url http://localhost:4173] [--backend http://localhost:8081] [--out journey.json]
//
// Products -> product -> add to cart -> second product -> add -> cart -> checkout (card) ->
// product -> add -> checkout (broken-card, the backend answers 500). Every request the page sends
// to the backend is counted (preflights excluded); the summary written to --out is what
// scripts/verify.py checks Tempo and rum-api against:
//   {start, end, requests, sessions: [session ids], url, backend}
// The page is closed at the end so the SDK flushes (pagehide, keepalive).
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    url: { type: "string", default: process.env.OUO_WEB_URL ?? "http://localhost:4173" },
    backend: { type: "string", default: process.env.VITE_BACKEND_URL ?? "http://localhost:8081" },
    out: { type: "string", default: "journey.json" },
    headed: { type: "boolean", default: false },
  },
});

const log = (msg) => console.log(`${new Date().toISOString()} [journey] ${msg}`);
const backend = args.backend.replace(/\/$/, "");
const start = Math.floor(Date.now() / 1000) - 1;

const browser = await chromium.launch({ headless: !args.headed });
const context = await browser.newContext();
const page = await context.newPage();
let requests = 0;
const failed = [];
page.on("requestfinished", (r) => {
  if (r.url().startsWith(backend) && r.method() !== "OPTIONS") requests++;
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

log(`open ${args.url}`);
await page.goto(args.url);
await page.getByTestId("product-grid").waitFor();
await addProduct(0);
await addProduct(1);
await checkout("card");
await addProduct(2);
await checkout("broken-card");
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
await page.close({ runBeforeUnload: true });
await context.close();
await browser.close();
// The SDK's exporters flush on pagehide; give the collector a moment.
await new Promise((r) => setTimeout(r, 3000));
const end = Math.ceil(Date.now() / 1000) + 1;

const summary = { start, end, requests, sessions, url: args.url, backend, failed };
writeFileSync(args.out, JSON.stringify(summary, null, 2) + "\n");
log(`${requests} backend requests, session ${sessions.join(", ") || "unknown"}, failed ${failed.length}; wrote ${args.out}`);
if (failed.length) {
  console.error(failed.join("\n"));
  process.exit(1);
}
