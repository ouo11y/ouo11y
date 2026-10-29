// Runs the benchmark: N rounds, every cell once per round, cell order rotated each round.
// One run = fresh headless Chromium, page load + 3 s settle, a fixed 60 s journey, page hide, 3 s drain.
// Usage: node run.mjs [--rounds 10] [--first-round 0] [--cells none,ouo,...] [--journey 60] [--nodes 10000] [--out results/x.json]
// --first-round numbers the rounds from there (to redo a lost round and merge it into an earlier file).
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { loadavg } from "node:os";
import { chromium } from "@playwright/test";
import { CELLS } from "./cells.mjs";

const arg = (name, d) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : d; };
const rounds = Number(arg("--rounds", 10));
const firstRound = Number(arg("--first-round", 0));
const cells = arg("--cells", Object.keys(CELLS).join(",")).split(",");
const journeyS = Number(arg("--journey", 60));
const nodes = arg("--nodes") ? Number(arg("--nodes")) : undefined;
const out = arg("--out", `results/${new Date().toISOString().replace(/[:.]/g, "-")}${nodes ? `-nodes${nodes}` : ""}.json`);
const SETTLE_MS = 3000, DRAIN_MS = 3000;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// The intake + page server: our own child process, PID kept, killed in `finally`.
const server = spawn(process.execPath, ["server.mjs"], { stdio: ["ignore", "pipe", "inherit"] });
const ports = await new Promise((resolve, reject) => {
  createInterface({ input: server.stdout }).once("line", (l) => resolve(JSON.parse(l)));
  server.once("exit", (c) => reject(new Error(`server exited ${c}`)));
});
const intake = `http://127.0.0.1:${ports.intake}`;
const pageBase = `http://127.0.0.1:${ports.page}`;
const ctl = async (p) => (await fetch(`${intake}/__bench/${p}`)).json();
console.error(`server pid ${server.pid} page :${ports.page} intake :${ports.intake}`);

// Installed in the page before any script: long tasks (buffered) and the bench config.
const initScript = ({ intake, nodes }) => {
  window.__BENCH__ = { intake, nodes };
  window.__LT = [];
  new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__LT.push([e.startTime, e.duration]); })
    .observe({ type: "longtask", buffered: true });
};

async function metrics(cdp, bcdp) {
  const { metrics } = await cdp.send("Performance.getMetrics");
  const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]));
  let rendererCpu = null;
  try {
    const { processInfo } = await bcdp.send("SystemInfo.getProcessInfo");
    rendererCpu = processInfo.filter((p) => p.type === "renderer").reduce((a, p) => a + p.cpuTime, 0);
  } catch { /* not available */ }
  return { task: m.TaskDuration, script: m.ScriptDuration, layout: m.LayoutDuration, style: m.RecalcStyleDuration, heap: m.JSHeapUsedSize, rendererCpu };
}

// The journey: one action every 2 s on a fixed schedule from journey start (30 actions in 60 s).
// Cycle: route change (pushState + fetch), "Load item" click (fetch), type 12 chars in the input.
// Action 15 is the click that throws.
async function journey(page, t0, seconds) {
  const routes = ["products", "cart", "account", "help", "home"];
  const n = Math.floor(seconds / 2);
  for (let k = 0; k < n; k++) {
    const at = t0 + 500 + k * 2000;
    const now = Date.now();
    if (at > now) await wait(at - now);
    if (k === 15) await page.click("#boom");
    else if (k % 3 === 0) await page.click(`#nav-${routes[(k / 3) % routes.length]}`);
    else if (k % 3 === 1) await page.click("#load");
    else { await page.click("#search"); await page.keyboard.type(`query ${k} abc`, { delay: 30 }); }
    if (k % 5 === 4) await page.click(`#list li:nth-child(${(k % 20) + 1}) button`);
  }
  const end = t0 + seconds * 1000;
  if (end > Date.now()) await wait(end - Date.now());
}

async function runOnce(cell, round) {
  const browser = await chromium.launch({
    headless: true,
    // No DNS outside localhost: anything aimed at a vendor endpoint fails fast and is counted.
    args: ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost"],
  });
  const external = [];
  const errors = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    context.on("request", (r) => { const h = new URL(r.url()).hostname; if (/^https?:/.test(r.url()) && h !== "127.0.0.1" && h !== "localhost") external.push(r.url().slice(0, 100)); });
    // No context.route(): Playwright's interception answers CORS preflights itself and touches every
    // request; the resolver rule above already makes every non-local request fail, and it is counted.
    await context.addInitScript(initScript, { intake, nodes });
    const page = await context.newPage();
    page.on("pageerror", (e) => { if (!/bench: thrown/.test(e.message)) errors.push(e.message.slice(0, 200)); });
    page.on("console", (m) => { if (m.type() === "error" && !/bench: thrown/.test(m.text())) errors.push(m.text().slice(0, 200)); });
    const cdp = await context.newCDPSession(page);
    const bcdp = await browser.newBrowserCDPSession();
    await page.goto(`${pageBase}/blank`);
    await cdp.send("Performance.enable");
    await ctl("reset");
    const m0 = await metrics(cdp, bcdp);
    const tNav = Date.now();
    await page.goto(`${pageBase}/c/${cell}/home`, { waitUntil: "load" });
    await page.waitForFunction(() => performance.getEntriesByName("sdk-init-done").length > 0, null, { timeout: 15000 });
    await wait(SETTLE_MS);
    const m1 = await metrics(cdp, bcdp);
    const load = await page.evaluate(() => {
      const nav = performance.getEntriesByType("navigation")[0];
      const init = performance.getEntriesByName("sdk-init-done")[0];
      const app = performance.getEntriesByName("app-ready")[0];
      return {
        sdkInitDone: init?.startTime ?? null,
        appReady: app?.startTime ?? null,
        domContentLoaded: nav.domContentLoadedEventEnd,
        loadEnd: nav.loadEventEnd,
        elements: document.getElementsByTagName("*").length,
        nodes: (() => { let n = 0; const w = document.createTreeWalker(document, NodeFilter.SHOW_ALL); while (w.nextNode()) n++; return n; })(),
        tJourney: performance.now(),
      };
    });
    const tJ = Date.now();
    await journey(page, tJ, journeyS);
    const tEnd = Date.now();
    const m2 = await metrics(cdp, bcdp);
    const lt = await page.evaluate(() => window.__LT);
    await cdp.send("HeapProfiler.collectGarbage");
    const heapAfterGc = (await metrics(cdp, bcdp)).heap;
    // Page hide: navigate away so every SDK runs its pagehide / visibilitychange flush, then drain.
    await page.goto(`${pageBase}/blank`);
    await wait(DRAIN_MS);
    const { log, served } = await ctl("stats");
    const ltSplit = (from, to) => {
      const xs = lt.filter(([s]) => s >= from && s < to).map(([, d]) => d);
      return { count: xs.length, sum: xs.reduce((a, b) => a + b, 0), tbt: xs.reduce((a, d) => a + Math.max(0, d - 50), 0), max: xs.length ? Math.max(...xs) : 0 };
    };
    const rel = (t) => t - tNav;
    return {
      cell, round, ok: true, tNav, loadavg1: loadavg()[0], journeyMs: tEnd - tJ, pageLifeMs: tEnd - tNav,
      load,
      cpu: {
        load: { task: m1.task - m0.task, script: m1.script - m0.script, layout: m1.layout - m0.layout, style: m1.style - m0.style, renderer: m1.rendererCpu - m0.rendererCpu },
        journey: { task: m2.task - m1.task, script: m2.script - m1.script, layout: m2.layout - m1.layout, style: m2.style - m1.style, renderer: m2.rendererCpu - m1.rendererCpu },
      },
      heap: { end: m2.heap, endAfterGc: heapAfterGc },
      longTasks: { load: ltSplit(0, load.tJourney), journey: ltSplit(load.tJourney, Infinity), all: lt },
      requests: log.map((r) => ({ ...r, t: rel(r.t), phase: r.t < tJ ? "load" : r.t <= tEnd ? "journey" : "hide" })),
      served,
      external, errors,
    };
  } finally {
    await browser.close();
  }
}

const results = { started: new Date().toISOString(), rounds, journeyS, nodes: nodes ?? null, cells, chromium: null, runs: [] };
try {
  { const b = await chromium.launch({ headless: true }); results.chromium = b.version(); await b.close(); }
  for (let round = firstRound; round < firstRound + rounds; round++) {
    const order = cells.map((_, i) => cells[(i + round) % cells.length]); // rotate each round
    for (const cell of order) {
      const t = Date.now();
      try {
        const r = await runOnce(cell, round);
        results.runs.push(r);
        const sdkBytes = r.requests.filter((x) => !["app", "other"].includes(x.sdk)).reduce((a, x) => a + x.wire, 0);
        console.error(`r${round} ${cell.padEnd(14)} task ${(r.cpu.journey.task * 1000).toFixed(0)} ms  renderer ${(r.cpu.journey.renderer * 1000).toFixed(0)} ms  sdk wire ${(sdkBytes / 1024).toFixed(0)} KB  reqs ${r.requests.length}  ext ${r.external.length}  err ${r.errors.length}  (${((Date.now() - t) / 1000).toFixed(0)} s)`);
      } catch (e) {
        results.runs.push({ cell, round, ok: false, error: String(e?.stack ?? e).slice(0, 500) });
        console.error(`r${round} ${cell} FAILED ${e?.message}`);
      }
      await mkdir("results", { recursive: true });
      await writeFile(out, JSON.stringify(results));
    }
  }
} finally {
  server.kill();
}
console.error(`wrote ${out}`);
