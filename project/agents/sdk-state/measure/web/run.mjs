// Web overhead harness: one 60 s scripted journey per variant in headless Chromium, interleaved
// rounds. Records init time, main-thread task time, renderer CPU, JS heap, per-input main-thread
// time, and ingest bytes per minute as received by the fake collector.
import { chromium } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { loadavg } from "node:os";
import { startServer } from "./server.mjs";
const VARIANTS = (process.env.VARIANTS || "none,ouo-core,ouo-replay,sentry-core,sentry-replay").split(",");
const ROUNDS = Number(process.env.ROUNDS || 5);
const JOURNEY_MS = Number(process.env.JOURNEY_MS || 60000);
const THROTTLE = Number(process.env.CPU_THROTTLE || 1);
const { srv, log, port } = await startServer();
const origin = `http://127.0.0.1:${port}`;
const browser = await chromium.launch();
const bcdp = await browser.newBrowserCDPSession();
const rendererCpu = async () => { const { processInfo } = await bcdp.send("SystemInfo.getProcessInfo"); return processInfo.filter((p) => p.type === "renderer").reduce((s, p) => s + p.cpuTime, 0); };
const metric = async (cdp) => Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));
const results = [];
const pct = (a, p) => (a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))] : null);
function mainThread(trace) {
  const ev = trace.traceEvents || trace;
  const names = ev.filter((e) => e.name === "thread_name" && e.args?.name === "CrRendererMain");
  return { ev, mains: new Set(names.map((e) => `${e.pid}:${e.tid}`)) };
}
// Duration (ms) of every main-thread task that dispatched a user input event: app handler plus
// every SDK listener, observer callback and microtask in that task.
function interactionTasks(trace) {
  const { ev, mains } = mainThread(trace);
  const onMain = (e) => mains.has(`${e.pid}:${e.tid}`);
  const tasks = ev.filter((e) => (e.name === "RunTask" || e.name === "ThreadControllerImpl::RunTask") && e.ph === "X" && onMain(e)).sort((a, b) => a.ts - b.ts);
  const disp = ev.filter((e) => e.name === "EventDispatch" && onMain(e) && ["click", "keydown", "pointerdown", "mousedown", "wheel"].includes(e.args?.data?.type)).sort((a, b) => a.ts - b.ts);
  const hit = new Set(); let i = 0;
  for (const d of disp) {
    while (i < tasks.length && tasks[i].ts + tasks[i].dur < d.ts) i++;
    for (let j = i; j < tasks.length && tasks[j].ts <= d.ts; j++) if (d.ts <= tasks[j].ts + tasks[j].dur && tasks[j].pid === d.pid && tasks[j].tid === d.tid) { hit.add(tasks[j]); break; }
  }
  return [...hit].map((t) => t.dur / 1000).sort((a, b) => a - b);
}
function longTasks(trace) {
  const { ev, mains } = mainThread(trace);
  const lt = ev.filter((e) => (e.name === "RunTask" || e.name === "ThreadControllerImpl::RunTask") && e.ph === "X" && mains.has(`${e.pid}:${e.tid}`) && e.dur >= 50000);
  return { count: lt.length, totalBlockingMs: lt.reduce((s, e) => s + (e.dur / 1000 - 50), 0) };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function journey(page, ms) {
  const steps = [
    () => page.click("#nav-products"), () => page.fill("#q", "running shoes"), () => page.click("#load"),
    () => page.mouse.wheel(0, 1500), () => page.click("#nav-cart"), () => page.click("#checkout"),
    () => page.click("#nav-home"), () => page.click("#promo"),
  ];
  const end = Date.now() + ms; let i = 0; let boomed = false; let n = 0;
  while (Date.now() < end) {
    if (!boomed && Date.now() > end - ms / 2) { await page.click("#nav-cart"); await page.click("#boom"); boomed = true; }
    await steps[i++ % steps.length]().catch(() => {}); n++;
    await sleep(2300);
  }
  return n;
}
for (let r = 0; r < ROUNDS; r++) {
  const order = r % 2 ? [...VARIANTS].reverse() : VARIANTS;
  for (const v of order) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    const errors = []; page.on("pageerror", (e) => { if (!String(e).includes("bench:")) errors.push(String(e)); });
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("Performance.enable");
    if (THROTTLE > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: THROTTLE });
    log.length = 0;
    const cpu0 = await rendererCpu();
    await page.goto(`${origin}/?v=${v}`);
    await page.waitForFunction(() => window.__ready === true);
    await sleep(3000);
    const startup = await metric(cdp);
    const cpuStartup = await rendererCpu();
    await browser.startTracing(page, { categories: ["devtools.timeline", "toplevel", "__metadata"] });
    const tJ = Date.now();
    const actions = await journey(page, JOURNEY_MS);
    const jMs = Date.now() - tJ;
    await sleep(1000);
    const trace = JSON.parse((await browser.stopTracing()).toString());
    if (process.env.SAVE_TRACE) writeFileSync("results/trace.json", JSON.stringify(trace));
    const ixTasks = interactionTasks(trace);
    await cdp.send("HeapProfiler.collectGarbage");
    const endM = await metric(cdp);
    const cpuEnd = await rendererCpu();
    const pageVals = await page.evaluate(() => ({ initMs: window.__initMs, importMs: window.__importMs, ix: window.__ix }));
    await page.close({ runBeforeUnload: true });
    await sleep(2500);
    await ctx.close();
    const ingest = log.slice();
    const by = (pred) => ingest.filter(pred).reduce((s, x) => s + x.bytes, 0);
    const isReplay = (x) => x.path.includes("replay") || false;
    const ix = pageVals.ix.sort((a, b) => a - b);
    const q = (p) => ix.length ? ix[Math.min(ix.length - 1, Math.floor(p * ix.length))] : null;
    const row = {
      variant: v, round: r, journeyMs: jMs, loadavg1: loadavg()[0], actions, pageErrors: errors,
      initMs: pageVals.initMs, importMs: pageVals.importMs,
      startupTaskMs: startup.TaskDuration * 1000, startupScriptMs: startup.ScriptDuration * 1000, startupRendererCpuMs: cpuStartup - cpu0,
      journeyTaskMs: (endM.TaskDuration - startup.TaskDuration) * 1000, journeyScriptMs: (endM.ScriptDuration - startup.ScriptDuration) * 1000,
      journeyRendererCpuMs: (cpuEnd - cpuStartup) * 1000 / 1000 * 1000,
      heapUsedMB: endM.JSHeapUsedSize / 1048576, heapTotalMB: endM.JSHeapTotalSize / 1048576, nodes: endM.Nodes,
      ixCount: ix.length, ixP50: q(0.5), ixP90: q(0.9), ixMax: ix.at(-1) ?? null,
      ixTaskCount: ixTasks.length, ixTaskP50: pct(ixTasks, 0.5), ixTaskP90: pct(ixTasks, 0.9), ixTaskMax: ixTasks.at(-1) ?? null, ixTaskSum: ixTasks.reduce((s, x) => s + x, 0),
      longTasks: longTasks(trace),
      requests: ingest.length, ingestBytes: by(() => true), replayBytes: by((x) => x.replay), headerBytes: ingest.reduce((s, x) => s + x.headerBytes, 0),
      paths: [...new Set(ingest.map((x) => `${x.path} ${x.enc} ${x.ct}`))],
    };
    // Sentry sends replay inside envelopes to the same path: split by envelope item type later if needed.
    results.push(row);
    console.log(JSON.stringify({ v, r, init: row.initMs.toFixed(2), task: row.journeyTaskMs.toFixed(0), cpu: row.journeyRendererCpuMs.toFixed(0), heap: row.heapUsedMB.toFixed(1), ixTaskP50: row.ixTaskP50?.toFixed(2), ixTaskP90: row.ixTaskP90?.toFixed(2), req: row.requests, kB: (row.ingestBytes / 1024).toFixed(1), errs: errors.length }));
    writeFileSync(process.env.OUT || "results/runtime.json", JSON.stringify({ chromium: browser.version(), journeyMs: JOURNEY_MS, cpuThrottle: THROTTLE, results }, null, 1));
  }
}
await browser.close(); srv.close();
