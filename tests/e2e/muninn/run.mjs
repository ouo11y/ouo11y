// End-to-end check of the spec-wire replay path (ADR-0019, docs/specs/muninn.md) against
// an ouo-env stack started with --muninn:
//
//   deploy/envs/ouo-env up <env> --muninn
//   eval "$(deploy/envs/ouo-env env <env>)"
//   (cd tests/e2e/muninn && npm install && npx playwright install chromium && node run.mjs)
//
// 1. browser   the released @ouo11y/browser 0.4.0 records a page in Chromium (replay.mode
//              structure/dom) and sends its chunks to the collector's /v1/logs; every
//              request is captured on the way out.
// 2. readback  Muninn's list, manifest and chunk calls return those chunks: every body is
//              byte-for-byte inside a request the SDK sent, decompresses to rrweb events, in
//              order, sequences 0..n with no gap, stream complete.
// 3. loki      Loki holds one reference record per chunk, empty body, ouo.replay.ref set.
// 4. queue     a chunk sent while Muninn is stopped gets its 2xx from the collector and is
//              in Muninn after Muninn starts again (the collector's disk queue).
// 5. invalid   Muninn rejects a chunk with a wrong hash through OTLP partial success
//              (hash_mismatch), and the same chunk through the collector is never stored.
// 6. delete    DELETE answers 204, reads answer 404, a late chunk stays invisible.
//
// Environment (ouo-env env <env> exports the URLs; the rest default to compose's dev values):
//   OUO_OTLP_URL, OUO_MUNINN_URL, OUO_LOKI_URL, OUO_COMPOSE_PROJECT (docker compose -p, for 4)
//   OUO_PROJECT_ID / OUO_PROJECT_TOKEN  (demo / pt_dev_demo_0000000000000000)
//   OUO_MUNINN_READ_TOKEN / OUO_MUNINN_INGEST_TOKEN  (compose.muninn.yaml's dev tokens)
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { build } from "esbuild";
import { chromium } from "playwright";
import { chunkRecord, decodeResponse, hex, logsRequest, sha256 } from "./otlp.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;
const need = (k) => (env[k] ?? (() => { throw new Error(`${k} is not set (eval "$(deploy/envs/ouo-env env <env>)")`); })()).replace(/\/$/, "");
const OTLP = need("OUO_OTLP_URL");
const MUNINN = need("OUO_MUNINN_URL");
const LOKI = need("OUO_LOKI_URL");
const COMPOSE_PROJECT = need("OUO_COMPOSE_PROJECT");
const PROJECT = env.OUO_PROJECT_ID ?? "demo";
const TOKEN = env.OUO_PROJECT_TOKEN ?? "pt_dev_demo_0000000000000000";
const BASIC = "Basic " + Buffer.from(`${PROJECT}:${TOKEN}`).toString("base64");
const READ = { authorization: `Bearer ${env.OUO_MUNINN_READ_TOKEN ?? "mrt_dev_0000000000000000"}` };
const INGEST_TOKEN = env.OUO_MUNINN_INGEST_TOKEN ?? "mit_dev_0000000000000000";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}
async function poll(what, fn, timeoutS = 90) {
  const end = Date.now() + timeoutS * 1000;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(1000);
  }
}
const api = (p) => `${MUNINN}/api/v1/projects/${PROJECT}${p}`;
async function getJSON(url) {
  const r = await fetch(url, { headers: READ });
  return { status: r.status, body: r.status === 200 ? await r.json() : null };
}
async function sendToCollector(records) {
  const r = await fetch(`${OTLP}/v1/logs`, {
    method: "POST",
    headers: { "content-type": "application/x-protobuf", authorization: BASIC },
    body: logsRequest({ resource: { "service.name": "muninn-e2e-synthetic" }, records }),
  });
  return r.status;
}
// Raw GET with Accept-Encoding: gzip. fetch() would undo Content-Encoding: gzip, and so would
// the proxy (Traefik's Go transport adds Accept-Encoding: gzip to a request that has none and
// then gunzips the answer itself); the point is the stored bytes.
function rawGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, { headers: { ...READ, "accept-encoding": "gzip" } }, (res) => {
      const parts = [];
      res.on("data", (d) => parts.push(d));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts) }));
    }).on("error", reject);
  });
}
const compose = (...args) => execFileSync("docker", ["compose", "-p", COMPOSE_PROJECT, ...args], { stdio: "inherit" });

// --- 1. browser -----------------------------------------------------------------------
async function browserSession() {
  const marker = hex(4);
  const out = path.join(HERE, "build");
  fs.mkdirSync(out, { recursive: true });
  await build({ entryPoints: [path.join(HERE, "page/entry.js")], bundle: true, format: "iife", target: "es2022", outfile: path.join(out, "page.js"), logLevel: "warning" });
  const cfg = JSON.stringify({ endpoint: OTLP, projectId: PROJECT, projectToken: TOKEN });
  const html = fs.readFileSync(path.join(HERE, "page/index.html"), "utf8").replace("__CONFIG__", cfg).replace("__MARKER__", marker);
  const js = fs.readFileSync(path.join(out, "page.js"));
  const server = http.createServer((req, res) => {
    if (req.url === "/page.js") return res.writeHead(200, { "content-type": "text/javascript" }).end(js);
    res.writeHead(200, { "content-type": "text/html" }).end(html);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://localhost:${server.address().port}`;

  const sent = []; // every /v1/logs body the SDK sent, decompressed
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route("**/v1/logs", async (route) => {
      const req = route.request();
      let body = req.postDataBuffer() ?? Buffer.alloc(0);
      if ((await req.headerValue("content-encoding")) === "gzip") body = gunzipSync(body);
      sent.push(body);
      await route.continue();
    });
    await page.goto(origin);
    await page.waitForFunction(() => window.ouo?.getSessionId());
    const session = await page.evaluate(() => window.ouo.getSessionId());
    for (let i = 0; i < 6; i++) {
      await page.click("#add");
      await sleep(700);
    }
    await page.evaluate(() => window.ouo.shutdown()); // closes the stream: ouo.replay.ended
    await sleep(1000);
    return { session, marker, sent };
  } finally {
    await browser.close();
    server.close();
  }
}

// --- 2. readback ----------------------------------------------------------------------
async function readBack({ session, marker, sent }) {
  const sentChunks = sent.filter((b) => b.includes("ouo.replay.chunk")).length;
  check("browser sent replay chunks to /v1/logs", sentChunks >= 3, `${sentChunks} chunk requests`);

  const list = await poll("a complete replay in Muninn", async () => {
    const { body } = await getJSON(api(`/sessions/${session}/replays`));
    return body?.replays?.length === 1 && body.replays[0].state === "complete" ? body : null;
  });
  const summary = list.replays[0];
  check("list: one replay for the session, complete, rrweb/2", summary.formats.join() === "rrweb/2", JSON.stringify(summary));

  const { status, body: m } = await getJSON(api(`/sessions/${session}/replays/${summary.replay_id}`));
  check("manifest: 200, one stream, no missing sequence", status === 200 && m.streams.length === 1 && m.streams[0].missing.length === 0, `state ${m?.state}`);
  const st = m.streams[0];
  check("manifest: every chunk the browser sent is held", st.chunks.length === sentChunks, `${st.chunks.length} held, ${sentChunks} sent`);
  check("manifest: sequences 0..n in order", st.chunks.every((c, i) => c.sequence === i));
  check("manifest: end record complete, last_sequence = n", st.end?.end_state === "complete" && st.end.last_sequence === st.chunks.length - 1);

  const events = [];
  let allInRequests = true, hashesOk = true, encOk = true;
  for (const c of st.chunks) {
    const r = await rawGet(`${MUNINN}${c.path}`);
    const body = r.body;
    encOk &&= r.status === 200 && r.headers["content-encoding"] === "gzip" && r.headers["x-ouo-replay-format"] === "rrweb/2";
    hashesOk &&= sha256(body) === c.sha256 && r.headers.etag === `"${c.sha256}"`;
    allInRequests &&= sent.some((s) => s.includes(body)); // the bytes the SDK sent, untouched
    for (const line of gunzipSync(body).toString("utf8").split("\n")) if (line) events.push({ seq: c.sequence, e: JSON.parse(line) });
  }
  check("chunks: 200, Content-Encoding gzip, format header", encOk);
  check("chunks: sha256 of every body matches manifest and ETag", hashesOk);
  check("chunks: every body is byte-for-byte the body the SDK sent", allInRequests);
  // The first chunk flagged keyframe opens with Meta (4) then FullSnapshot (2). (/browser
  // 0.4.0 sends DomContentLoaded/Load in a non-keyframe chunk 0 before it; see the summary.)
  const kf = st.chunks.find((c) => c.keyframe);
  const first = events.filter((x) => x.seq === kf?.sequence).map((x) => x.e.type);
  const zero = events.filter((x) => x.seq === 0).map((x) => x.e.type);
  check("rrweb: the first keyframe chunk opens with Meta (4), FullSnapshot (2)", first[0] === 4 && first[1] === 2, `keyframe chunk ${kf?.sequence}: ${first.slice(0, 3).join(",")}...; chunk 0: ${zero.join(",")} keyframe=${st.chunks[0].keyframe}`);
  check("rrweb: timestamps never go backwards across chunks", events.every((x, i) => i === 0 || x.e.timestamp >= events[i - 1].e.timestamp), `${events.length} events`);
  check("rrweb: the recording holds the page's marker text", JSON.stringify(events).includes(`muninn-marker-${marker}`));
  check("rrweb: the clicks' DOM mutations are recorded", events.some((x) => x.e.type === 3 && JSON.stringify(x.e.data).includes("row 6")));
  return { session, replay: summary.replay_id, stream: st.stream_id, chunks: st.chunks };
}

// --- 3. loki --------------------------------------------------------------------------
async function lokiRefs({ session, replay, stream, chunks }) {
  const q = `{service_name="muninn-e2e"} | ouo_replay_id="${replay}" | ouo_replay_ref!=""`;
  const start = BigInt(Date.now() - 30 * 60_000) * 1_000_000n;
  const lines = await poll("reference records in Loki", async () => {
    const r = await fetch(`${LOKI}/loki/api/v1/query_range?${new URLSearchParams({ query: q, start: String(start), limit: "1000", direction: "forward" })}`);
    if (r.status !== 200) return null;
    const vals = (await r.json()).data.result.flatMap((s) => s.values.map((v) => ({ line: v[1], meta: { ...s.stream, ...(v[2] ?? {}) } })));
    return vals.length >= chunks.length ? vals : null;
  });
  const refs = new Set(lines.map((l) => l.meta.ouo_replay_ref));
  const want = chunks.map((c) => `muninn:/${PROJECT}/${session}/${replay}/${stream}/${c.sequence}`);
  check("loki: one reference record per chunk with ouo.replay.ref", want.every((w) => refs.has(w)), `${lines.length} records, e.g. ${want[0]}`);
  check("loki: reference records carry no chunk bytes (empty body)", lines.every((l) => l.line === ""));
}

// --- 4. queue -------------------------------------------------------------------------
async function diskQueue() {
  const ids = { session: hex(16), replay: hex(16), stream: hex(16) };
  const rec = chunkRecord({ ...ids, seq: 0 });
  compose("stop", "muninn");
  try {
    const down = await fetch(`${MUNINN}/ready`).then((r) => r.status).catch(() => 0);
    check("queue: Muninn is down", down !== 200, `GET /ready -> ${down}`);
    const code = await sendToCollector([rec]);
    check("queue: the collector answers 2xx while Muninn is down", code >= 200 && code < 300, `HTTP ${code}`);
    await sleep(5000);
  } finally {
    compose("start", "muninn");
  }
  const url = api(`/sessions/${ids.session}/replays/${ids.replay}/streams/${ids.stream}/chunks/0`);
  const t0 = Date.now();
  const body = await poll("the queued chunk in Muninn", async () => {
    const r = await rawGet(url).catch(() => null);
    return r?.status === 200 ? r.body : null;
  }, 180);
  check("queue: the chunk reaches Muninn after it comes back, bytes unchanged", body.equals(rec.body), `${((Date.now() - t0) / 1000).toFixed(1)} s after start`);
}

// --- 5. invalid -----------------------------------------------------------------------
async function invalid() {
  const ids = { session: hex(16), replay: hex(16), stream: hex(16) };
  const bad = chunkRecord({ ...ids, seq: 0, over: { "ouo.replay.sha256": "0".repeat(64) } });
  const good = chunkRecord({ ...ids, seq: 1 });
  const r = await fetch(`${MUNINN}/otlp/v1/logs`, {
    method: "POST",
    headers: { "content-type": "application/x-protobuf", authorization: `Bearer ${INGEST_TOKEN}` },
    body: logsRequest({ resource: { "ouo.project.id": PROJECT }, records: [bad, good] }),
  });
  const ps = decodeResponse(Buffer.from(await r.arrayBuffer()));
  check("invalid: Muninn answers 200 with partial_success rejected=1, reason hash_mismatch", r.status === 200 && ps.rejected === 1 && ps.message.startsWith("hash_mismatch"), `${r.status} ${JSON.stringify(ps)}`);
  const chunk = (seq) => fetch(api(`/sessions/${ids.session}/replays/${ids.replay}/streams/${ids.stream}/chunks/${seq}`), { headers: READ }).then((x) => x.status);
  check("invalid: the valid neighbour is stored, the bad chunk is not", (await chunk(1)) === 200 && (await chunk(0)) === 404);

  const via = { session: hex(16), replay: hex(16), stream: hex(16) };
  const code = await sendToCollector([chunkRecord({ ...via, seq: 0, over: { "ouo.replay.sha256": "0".repeat(64) } })]);
  await sleep(5000);
  const m = await getJSON(api(`/sessions/${via.session}/replays/${via.replay}`));
  check("invalid: through the collector, 2xx to the SDK and never stored", code === 200 && m.status === 404, `collector ${code}, manifest ${m.status}`);
  const st = await fetch(`${MUNINN}/otlp/v1/logs`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${INGEST_TOKEN}` }, body: "{}" });
  check("invalid: OTLP/JSON answers 415", st.status === 415);
}

// --- 6. delete ------------------------------------------------------------------------
async function del({ session, replay, stream, chunks }) {
  const r = await fetch(api(`/sessions/${session}/replays/${replay}`), { method: "DELETE", headers: READ });
  check("delete: 204", r.status === 204);
  const m = await getJSON(api(`/sessions/${session}/replays/${replay}`));
  const l = await getJSON(api(`/sessions/${session}/replays`));
  const c = await fetch(`${MUNINN}${chunks[0].path}`, { headers: READ });
  check("delete: manifest 404, chunk 404, session list empty", m.status === 404 && c.status === 404 && l.body.replays.length === 0);
  const code = await sendToCollector([chunkRecord({ session, replay, stream, seq: chunks.length + 5 })]);
  await sleep(5000);
  const after = await getJSON(api(`/sessions/${session}/replays/${replay}`));
  check("delete: a late chunk is accepted and stays invisible (tombstone)", code === 200 && after.status === 404);
}

const t0 = Date.now();
try {
  const rec = await browserSession();
  const held = await readBack(rec);
  await lokiRefs(held);
  await diskQueue();
  await invalid();
  await del(held);
} catch (e) {
  check("run", false, e.stack ?? String(e));
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
process.exit(failed.length ? 1 : 0);
