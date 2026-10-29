// What ouo's replay bytes are made of: captures the ouo cell's replay chunks (request bodies, read
// from the browser, gunzipped here), and sums the rrweb events by type. Answers how big one full
// snapshot (type 2, re-sent at every checkout) is next to the incremental stream.
// Usage: node snapshot.mjs [--seconds 30] [--cell ouo] [--nodes 10000]
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { gunzipSync } from "node:zlib";
import { chromium } from "@playwright/test";

const arg = (name, d) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : d; };
const seconds = Number(arg("--seconds", 30));
const cell = arg("--cell", "ouo");
const nodes = arg("--nodes") ? Number(arg("--nodes")) : undefined;

const server = spawn(process.execPath, ["server.mjs"], { stdio: ["ignore", "pipe", "inherit"] });
try {
  const ports = await new Promise((r) => createInterface({ input: server.stdout }).once("line", (l) => r(JSON.parse(l))));
  const intake = `http://127.0.0.1:${ports.intake}`;
  const browser = await chromium.launch({ headless: true, args: ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.addInitScript((b) => { window.__BENCH__ = b; }, { intake, nodes });
  const bodies = [];
  page.on("request", (r) => { if (r.url().includes("/v1/replay/chunks") && r.method() === "POST") bodies.push({ t: Date.now(), buf: r.postDataBuffer(), enc: r.headers()["content-encoding"] }); });
  const t0 = Date.now();
  await page.goto(`http://127.0.0.1:${ports.page}/c/${cell}/home`);
  const routes = ["products", "cart", "account", "help", "home"];
  for (let k = 0; Date.now() - t0 < seconds * 1000; k++) {
    if (k % 2) await page.click("#load"); else await page.click(`#nav-${routes[(k / 2) % 5]}`);
    await page.waitForTimeout(2000);
  }
  await page.goto(`http://127.0.0.1:${ports.page}/blank`);
  await page.waitForTimeout(1000);
  await browser.close();

  const byType = {};
  let wire = 0, css = 0, fullSnapshots = 0;
  for (const { buf, enc } of bodies) {
    if (!buf) continue;
    wire += buf.length;
    const json = JSON.parse((enc === "gzip" ? gunzipSync(buf) : buf).toString());
    for (const e of json.events) {
      const s = JSON.stringify(e);
      (byType[e.type] ??= { count: 0, bytes: 0 });
      byType[e.type].count++;
      byType[e.type].bytes += s.length;
      if (e.type === 2) {
        fullSnapshots++;
        for (const m of s.matchAll(/"_cssText":"((?:[^"\\]|\\.)*)"/g)) css += m[1].length;
        for (const m of s.matchAll(/"isStyle":true,"textContent":"((?:[^"\\]|\\.)*)"/g)) css += m[1].length;
      }
    }
  }
  const names = { 2: "full snapshot", 3: "incremental", 4: "meta", 5: "custom" };
  const total = Object.values(byType).reduce((a, x) => a + x.bytes, 0);
  console.log(`cell ${cell}, ${seconds} s, ${bodies.length} chunks, ${(wire / 1024).toFixed(1)} KB on the wire, ${(total / 1024).toFixed(1)} KB of events (JSON)`);
  for (const [t, x] of Object.entries(byType)) console.log(`  type ${t} ${names[t] ?? ""}: ${x.count} events, ${(x.bytes / 1024).toFixed(1)} KB (${((100 * x.bytes) / total).toFixed(1)} %)`);
  console.log(`  CSS text inside full snapshots: ${(css / 1024).toFixed(1)} KB over ${fullSnapshots} full snapshot(s)`);
} finally {
  server.kill();
}
