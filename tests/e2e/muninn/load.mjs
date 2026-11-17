// Replay chunk load on the collector's OTLP /v1/logs, for the back-pressure checks of
// deploy/scripts/sentry-backpressure.sh (Muninn stopped: the disk queue takes the chunks).
//
//   node load.mjs [--chunks 200] [--bytes 262144] [--concurrency 8]
//
// Sends spec-wire `ouo.replay.chunk` records (one per request, format load/1, identity
// encoding, random bodies so every chunk is new) and prints one JSON line: status codes and
// the collector's answer latency (p50/p95/p99/max, ms). Environment: OUO_OTLP_URL,
// OUO_PROJECT_ID / OUO_PROJECT_TOKEN (demo / pt_dev_demo_0000000000000000).
import { randomBytes } from "node:crypto";
import { chunkRecord, hex, logsRequest } from "./otlp.mjs";

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? Number(process.argv[i + 1]) : d; };
const N = arg("chunks", 200), BYTES = arg("bytes", 262144), C = arg("concurrency", 8);
const OTLP = (process.env.OUO_OTLP_URL ?? "http://localhost:4318").replace(/\/$/, "");
const PROJECT = process.env.OUO_PROJECT_ID ?? "demo";
const TOKEN = process.env.OUO_PROJECT_TOKEN ?? "pt_dev_demo_0000000000000000";
const BASIC = "Basic " + Buffer.from(`${PROJECT}:${TOKEN}`).toString("base64");

const session = hex(16), replay = hex(16), stream = hex(16);
const codes = {}, lat = [];
let next = 0;
async function worker() {
  while (next < N) {
    const seq = next++;
    const rec = chunkRecord({ session, replay, stream, seq, format: "load/1", body: randomBytes(BYTES),
      over: { "ouo.replay.encoding": "identity" } });
    const t0 = performance.now();
    let code;
    try {
      const r = await fetch(`${OTLP}/v1/logs`, { method: "POST", body: logsRequest({ records: [rec] }),
        headers: { "content-type": "application/x-protobuf", authorization: BASIC } });
      await r.arrayBuffer();
      code = String(r.status);
    } catch (e) { code = `error: ${e.cause?.code ?? e.message}`; }
    lat.push(performance.now() - t0);
    codes[code] = (codes[code] ?? 0) + 1;
  }
}
const t0 = performance.now();
await Promise.all(Array.from({ length: C }, worker));
lat.sort((a, b) => a - b);
const p = (q) => Math.round(lat[Math.min(lat.length - 1, Math.round((q / 100) * (lat.length - 1)))] * 10) / 10;
console.log(JSON.stringify({ chunks: N, bytes: BYTES, session, replay, seconds: Math.round(performance.now() - t0) / 1000, codes,
  latency_ms: { p50: p(50), p95: p(95), p99: p(99), max: p(100) } }));
