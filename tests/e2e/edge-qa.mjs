#!/usr/bin/env node
// Edge QA checks that had never run live (checklist N15, plus N13's collector changes).
// Run them through deploy/scripts/qa-edge.sh, which runs the `default` profile, recreates
// the env's collector with small buckets and `key_from: x_forwarded_for`, runs the
// `limits` profile and restores the collector.
//
// Profile `default` (the stock collector settings):
//   auth_failures   401s for a missing, malformed and wrong credential and an unknown project
//                   (OTLP and replay) show up in Mimir as ouo_auth_failures_total{reason}
//   empty_ratelimit empty OTLP exports (JSON and protobuf) are charged: client burst + 50 of
//                   them get 429 + Retry-After with an OTLP Status body; ouo_ratelimit_rejected_total
//   otel_sdk        a stock OTel JS SDK configured only with OTEL_EXPORTER_OTLP_HEADERS lands in
//                   Tempo stamped ouo.project.id=<project> (spoof overwritten); a wrong header is
//                   401; the demo backend (stock OTel Go SDK, same variables) lands as `internal`
//   cors_browser    headless Chromium (Playwright): fetch from an allowed origin works, from a
//                   foreign origin it is blocked by CORS and nothing is ingested
//   viewer          a Grafana Viewer opens the plugin pages, reads (GET, POST funnel queries)
//                   through the plugin proxy, cannot change the plugin settings or open its
//                   configuration page; a Viewer or Editor cannot DELETE a replay (403), methods
//                   without a route are 404, an Admin's DELETE works (N30)
//   background      the React Native SDK (its own code, simulated AppState) ends a session with
//                   end_reason background after backgroundTimeoutMs; rum-api reports it
// Profile `limits` (collector started with OUO_RATELIMIT_CLIENT_KEY=x_forwarded_for,
// OUO_RATELIMIT_CLIENT_RATE/BURST and OUO_RATELIMIT_PROJECT_RATE/BURST, see qa-edge.sh):
//   xff             direct to the published port, X-Forwarded-For picks the client bucket; through
//                   the env proxy (Traefik), a spoofed header does not
//   project_bucket  one project's bucket empties across many clients while another project
//                   still gets 200; rejections are key_kind=project
//
// Node 24. Configuration: the variables `deploy/envs/ouo-env env <env>` exports
// (OUO_OTLP_URL, OUO_REPLAY_URL, OUO_RUM_API_URL, OUO_GRAFANA_URL, OUO_GRAFANA_AUTH,
// OUO_TEMPO_URL, OUO_MIMIR_URL), plus OUO_PROJECT_ID / OUO_PROJECT_TOKEN (default demo),
// OUO_INTERNAL_PROJECT_ID / OUO_INTERNAL_PROJECT_TOKEN (default internal), OUO_READ_TOKEN,
// OUO_QA_PROXY_OTLP_URL (the env proxy's OTLP host, for `xff`), OUO_QA_CLIENT_BURST /
// OUO_QA_CLIENT_RATE / OUO_QA_PROJECT_BURST (what the collector runs with).
// Flags: --profile default|limits, --only a,b, --out <file> (JSON result for the report).

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const env = process.env;
const strip = (u) => u.replace(/\/$/, "");
const OTLP = strip(env.OUO_OTLP_URL ?? "http://localhost:4318");
const REPLAY = strip(env.OUO_REPLAY_URL ?? "http://localhost:4319");
const RUM = strip(env.OUO_RUM_API_URL ?? "http://localhost:8080");
const GRAFANA = strip(env.OUO_GRAFANA_URL ?? "http://localhost:3000");
const GRAFANA_AUTH = env.OUO_GRAFANA_AUTH ?? "admin:testing567";
const TEMPO = strip(env.OUO_TEMPO_URL ?? "http://localhost:3200");
const MIMIR = strip(env.OUO_MIMIR_URL ?? "http://localhost:9009");
const PROJECT_ID = env.OUO_PROJECT_ID ?? "demo";
const PROJECT_TOKEN = env.OUO_PROJECT_TOKEN ?? "pt_dev_demo_0000000000000000";
const INTERNAL_ID = env.OUO_INTERNAL_PROJECT_ID ?? "internal";
const INTERNAL_TOKEN = env.OUO_INTERNAL_PROJECT_TOKEN ?? "pt_dev_internal_00000000000000";
const READ_TOKEN = env.OUO_READ_TOKEN ?? "rt_dev_0000000000000000";
const PROXY_OTLP = env.OUO_QA_PROXY_OTLP_URL ? strip(env.OUO_QA_PROXY_OTLP_URL) : undefined;
const CLIENT_BURST = Number(env.OUO_QA_CLIENT_BURST ?? 300);
const CLIENT_RATE = Number(env.OUO_QA_CLIENT_RATE ?? 100);
const PROJECT_BURST = Number(env.OUO_QA_PROJECT_BURST ?? 5000);
const PLUGIN = "ouo11y-rum-app";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const PROFILE = flag("--profile") ?? "default";
const ONLY = flag("--only")?.split(",");
const OUT = flag("--out");
const RUN = Date.now().toString(36);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
const basic = (id, token) => `Basic ${b64(`${id}:${token}`)}`;
const EMPTY = JSON.stringify({ resourceSpans: [] });
const json = { "content-type": "application/json" };

// ---------------------------------------------------------------- result bookkeeping

const results = [];
let current;
function assert(name, ok, detail) {
  current.assertions.push({ name, ok: Boolean(ok), detail });
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail === undefined ? "" : `: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
  return Boolean(ok);
}
/** A known defect: recorded and printed, does not fail the run (flip it to assert once fixed). */
function finding(id, name, observed) {
  current.findings.push({ id, name, observed });
  console.log(`  FIND ${id} ${name}: ${typeof observed === "string" ? observed : JSON.stringify(observed)}`);
}
function note(key, value) {
  current.observed[key] = value;
}

// ---------------------------------------------------------------- HTTP helpers

async function post(url, { headers = {}, body = EMPTY } = {}) {
  const res = await fetch(url, { method: "POST", headers, body });
  const text = await res.text();
  return { status: res.status, retryAfter: res.headers.get("retry-after"), contentType: res.headers.get("content-type"), text };
}

/** Instant query; returns { labels-json: value } for every series. */
async function mimir(query) {
  const res = await fetch(`${MIMIR}/prometheus/api/v1/query?query=${encodeURIComponent(query)}`);
  if (!res.ok) throw new Error(`mimir ${query}: HTTP ${res.status}`);
  const out = {};
  for (const r of (await res.json()).data.result) out[JSON.stringify(r.metric)] = Number(r.value[1]);
  return out;
}
const total = (o) => Object.values(o).reduce((a, b) => a + b, 0);

/** Polls fn() until it returns a truthy value or the timeout passes; returns the last value. */
async function until(fn, timeoutS = 90, stepMs = 3000) {
  const end = Date.now() + timeoutS * 1000;
  let v;
  while (Date.now() < end) {
    v = await fn();
    if (v) return v;
    await sleep(stepMs);
  }
  return v;
}

/** Waits for the counter's sum (by `by`) to grow by at least `want[k]` over `before`. */
async function counterGrew(metric, by, before, want, timeoutS = 75) {
  let last = {};
  const ok = await until(async () => {
    last = {};
    for (const [k, v] of Object.entries(await mimir(`sum by (${by}) (${metric})`))) last[JSON.parse(k)[by] ?? ""] = v;
    return Object.entries(want).every(([k, n]) => (last[k] ?? 0) - (before[k] ?? 0) >= n);
  }, timeoutS, 5000);
  const delta = {};
  for (const k of new Set([...Object.keys(last), ...Object.keys(before)])) delta[k] = (last[k] ?? 0) - (before[k] ?? 0);
  return { ok, delta };
}
async function counterNow(metric, by) {
  const out = {};
  for (const [k, v] of Object.entries(await mimir(`sum by (${by}) (${metric})`))) out[JSON.parse(k)[by] ?? ""] = v;
  return out;
}

/** TraceQL search in Tempo over the last 15 minutes; resolves to the traces list. */
async function tempoSearch(q) {
  const end = Math.floor(Date.now() / 1000) + 60;
  const url = `${TEMPO}/api/search?q=${encodeURIComponent(q)}&start=${end - 900}&end=${end}&limit=20`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`tempo ${q}: HTTP ${res.status} ${await res.text()}`);
  return (await res.json()).traces ?? [];
}

/** Resource attributes of every span batch of a trace (Tempo v2 JSON). */
async function traceResources(traceId) {
  const res = await fetch(`${TEMPO}/api/v2/traces/${traceId}`);
  if (!res.ok) return [];
  const body = await res.json();
  return (body.trace?.resourceSpans ?? body.batches ?? []).map((rs) =>
    Object.fromEntries((rs.resource?.attributes ?? []).map((a) => [a.key, a.value?.stringValue])),
  );
}

/** Sends n requests with at most `parallel` in flight; returns the responses in order. */
async function burst(n, make, parallel = 25) {
  const out = new Array(n);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(parallel, n) }, async () => {
      while (next < n) {
        const i = next++;
        out[i] = await make(i);
      }
    }),
  );
  return out;
}
const countBy = (rs) => rs.reduce((m, r) => ((m[r.status] = (m[r.status] ?? 0) + 1), m), {});

const grafana = (auth = GRAFANA_AUTH) => ({ authorization: `Basic ${b64(auth)}` });

// ---------------------------------------------------------------- checks

const checks = {};

checks.auth_failures = async () => {
  const before = await counterNow("ouo_auth_failures_total", "reason");
  note("before", before);
  const traces = `${OTLP}/v1/traces`;
  const sent = {
    missing: await post(traces, { headers: json }),
    malformed: await post(traces, { headers: { ...json, authorization: "Bearer not-basic" } }),
    wrong_token: await post(traces, { headers: { ...json, authorization: basic(PROJECT_ID, "wrong") } }),
    unknown_project: await post(traces, { headers: { ...json, authorization: basic("nosuchproject", PROJECT_TOKEN) } }),
    replay_missing: await post(`${REPLAY}/v1/replay/chunks`, { headers: json, body: "{}" }),
  };
  for (const [k, r] of Object.entries(sent)) assert(`${k} -> 401`, r.status === 401, `${r.status} ${r.text.slice(0, 80)}`);
  const want = { missing: 2, malformed: 1, invalid_credentials: 2 };
  const { ok, delta } = await counterGrew("ouo_auth_failures_total", "reason", before, want);
  note("delta", delta);
  assert("ouo_auth_failures_total in Mimir grew by reason (missing >= 2, malformed >= 1, invalid_credentials >= 2)", ok, delta);
};

checks.empty_ratelimit = async () => {
  const before = await counterNow("ouo_ratelimit_rejected_total", "key_kind");
  const n = CLIENT_BURST + 50;
  const auth = { ...json, authorization: basic(PROJECT_ID, PROJECT_TOKEN) };
  const rs = await burst(n, () => post(`${OTLP}/v1/traces`, { headers: auth }));
  const counts = countBy(rs);
  note("empty_json_burst", { sent: n, statuses: counts });
  const rejected = rs.filter((r) => r.status === 429);
  assert(`${n} empty JSON exports (client burst ${CLIENT_BURST}): some answered 429`, rejected.length > 0, counts);
  assert("no other status than 200 / 429", Object.keys(counts).every((s) => s === "200" || s === "429"), counts);
  if (rejected.length) {
    const r = rejected[0];
    let body = {};
    try {
      body = JSON.parse(r.text);
    } catch {}
    assert("429 carries Retry-After >= 1", Number(r.retryAfter) >= 1, r.retryAfter);
    assert("429 body is an OTLP Status (JSON, code 8 RESOURCE_EXHAUSTED)", r.contentType?.startsWith("application/json") && body.code === 8, r.text.slice(0, 120));
  }
  // The bucket is empty now: an empty protobuf export is rejected too.
  const pb = await post(`${OTLP}/v1/traces`, { headers: { "content-type": "application/x-protobuf", authorization: basic(PROJECT_ID, PROJECT_TOKEN) }, body: new Uint8Array() });
  assert("empty protobuf export on the empty bucket -> 429 (protobuf Status)", pb.status === 429 && pb.contentType === "application/x-protobuf", `${pb.status} ${pb.contentType}`);
  await sleep(Math.ceil((CLIENT_BURST / CLIENT_RATE) * 1000) + 1000);
  const after = await post(`${OTLP}/v1/traces`, { headers: auth });
  assert("after the refill an empty export is 200 again", after.status === 200, after.status);
  const { ok, delta } = await counterGrew("ouo_ratelimit_rejected_total", "key_kind", before, { client: rejected.length + 1 });
  note("rejected_delta", delta);
  assert(`ouo_ratelimit_rejected_total{key_kind=client} grew by >= ${rejected.length + 1} in Mimir`, ok, delta);
};

function runNode(file, argv, extraEnv) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [file, ...argv], { cwd: ROOT, env: { ...process.env, ...extraEnv } });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => resolve({ code, out, err }));
  });
}

checks.otel_sdk = async () => {
  const stock = join(HERE, "otel-sdk", "stock-node.mjs");
  const runId = `stock-${RUN}`;
  const sdkEnv = (header) => ({
    OTEL_EXPORTER_OTLP_ENDPOINT: OTLP,
    OTEL_EXPORTER_OTLP_HEADERS: header,
    OTEL_SERVICE_NAME: "qa-stock-sdk",
    OTEL_RESOURCE_ATTRIBUTES: "deployment.environment.name=qa,ouo.project.id=spoofed",
  });
  const good = await runNode(stock, [runId], sdkEnv(`Authorization=Basic%20${b64(`${PROJECT_ID}:${PROJECT_TOKEN}`)}`));
  assert("stock OTel JS SDK with OTEL_EXPORTER_OTLP_HEADERS exports (exit 0)", good.code === 0, good.err.trim().split("\n").at(-1) || good.out.trim());
  const bad = await runNode(stock, [`${runId}-bad`], sdkEnv(`Authorization=Basic%20${b64(`${PROJECT_ID}:wrong`)}`));
  assert("same SDK with a wrong token fails the export (401)", bad.code !== 0 && /Unauthorized|401/.test(bad.err), bad.err.match(/OTLPExporterError: \w+/)?.[0]);
  const traces = await until(() => tempoSearch(`{ span.ouo.qa.run_id = "${runId}" }`).then((t) => t.length && t), 60);
  assert("its span is in Tempo", traces && traces.length === 1, traces && traces.length);
  if (traces?.length) {
    const res = await traceResources(traces[0].traceID);
    note("stock_sdk_resource", res[0]);
    assert(`resource ouo.project.id = ${PROJECT_ID} (the SDK's spoofed value overwritten)`, res.length > 0 && res.every((r) => r["ouo.project.id"] === PROJECT_ID), res.map((r) => r["ouo.project.id"]));
  }
  // The demo backend: stock OTel Go SDK, OTEL_EXPORTER_OTLP_HEADERS from compose, `internal` project.
  const backend = env.OUO_BACKEND_URL ? strip(env.OUO_BACKEND_URL) : GRAFANA.replace("://grafana.", "://backend.");
  const start = Math.floor(Date.now() / 1000) - 5;
  const call = await fetch(`${backend}/api/products`).then((r) => r.status, (e) => String(e));
  note("backend_call", call);
  const bt = await until(
    () => tempoSearch(`{ resource.service.name = "demo-backend" && resource.ouo.project.id = "${INTERNAL_ID}" }`).then((t) => t.filter((x) => Number(x.startTimeUnixNano) / 1e9 >= start).length > 0 && t),
    60,
  );
  assert(`demo backend (stock Go SDK, env headers) spans after the call carry ouo.project.id = ${INTERNAL_ID}`, Boolean(bt), call);
  const rumApi = await until(() => tempoSearch(`{ resource.service.name = "rum-api" }`).then((t) => t.length && t), 30);
  if (rumApi?.length) {
    const res = await traceResources(rumApi[0].traceID);
    assert(`rum-api's own spans carry ouo.project.id = ${INTERNAL_ID}`, res.some((r) => r["ouo.project.id"] === INTERNAL_ID), res.map((r) => r["ouo.project.id"]));
  } else {
    note("rum_api_spans", "none in the last 15 minutes");
  }
};

checks.cors_browser = async () => {
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    assert("playwright is installed (npm install --prefix tests/e2e)", false);
    return;
  }
  // One local page server; the same page is loaded under an allowed and a foreign origin.
  const server = createServer((_, res) => res.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><title>qa</title>"));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const origins = { allowed: `http://localhost:${port}`, foreign: `http://qa-foreign.localhost:${port}` };
  const browser = await chromium.launch();
  try {
    for (const [kind, origin] of Object.entries(origins)) {
      const page = await browser.newPage();
      // Chromium runs the preflight itself (Playwright sees no response for it) and reports
      // the CORS verdict on the console.
      const consoleErrors = [];
      page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
      await page.goto(`${origin}/`);
      const runId = `cors-${kind}-${RUN}`;
      const body = JSON.stringify({
        resourceSpans: [{ resource: { attributes: [{ key: "service.name", value: { stringValue: "qa-cors" } }] }, scopeSpans: [{ scope: { name: "qa" }, spans: [{ traceId: crypto.randomUUID().replaceAll("-", ""), spanId: crypto.randomUUID().replaceAll("-", "").slice(0, 16), name: "qa cors", kind: 1, startTimeUnixNano: String(Date.now() * 1e6), endTimeUnixNano: String(Date.now() * 1e6 + 1e6), attributes: [{ key: "ouo.qa.run_id", value: { stringValue: runId } }] }] }] }],
      });
      const outcome = await page.evaluate(
        async ({ url, auth, body }) => {
          try {
            const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: auth }, body });
            return { ok: true, status: r.status };
          } catch (e) {
            return { ok: false, error: String(e) };
          }
        },
        { url: `${OTLP}/v1/traces`, auth: basic(PROJECT_ID, PROJECT_TOKEN), body },
      );
      note(kind, { origin, outcome, console: consoleErrors, browser: browser.version() });
      if (kind === "allowed") {
        assert(`Chromium ${browser.version()} from ${origin}: POST with Authorization succeeds (200)`, outcome.ok && outcome.status === 200, outcome);
        const t = await until(() => tempoSearch(`{ span.ouo.qa.run_id = "${runId}" }`).then((x) => x.length && x), 60);
        assert("the allowed origin's span is in Tempo", Boolean(t));
      } else {
        assert(`from foreign ${origin}: fetch rejected by CORS (TypeError)`, !outcome.ok && /TypeError|Failed to fetch/.test(outcome.error), outcome);
        const cors = consoleErrors.find((t) => t.includes("blocked by CORS policy"));
        assert("Chromium blames the preflight: no Access-Control-Allow-Origin header", Boolean(cors) && /preflight/.test(cors) && /Access-Control-Allow-Origin/.test(cors), cors?.replace(/^.*?(Response to preflight)/, "$1"));
        await sleep(10000);
        const t = await tempoSearch(`{ span.ouo.qa.run_id = "${runId}" }`);
        assert("nothing from the foreign origin reached Tempo (the POST never left the browser)", t.length === 0, t.length);
      }
      await page.close();
    }
  } finally {
    await browser.close();
    server.close();
  }
};

/** Creates a Grafana user in org 1 with `role`; returns { id, headers } (basic auth as that user). */
async function grafanaUser(role) {
  const login = `qa-${role.toLowerCase()}-${RUN}`;
  const password = `${login}-pw`;
  const created = await fetch(`${GRAFANA}/api/admin/users`, {
    method: "POST",
    headers: { ...json, ...grafana() },
    body: JSON.stringify({ name: login, login, password, email: `${login}@example.invalid` }),
  });
  const { id } = await created.json();
  assert(`Grafana user ${login} created`, created.ok, created.status);
  if (id && role !== "Viewer") {
    const set = await fetch(`${GRAFANA}/api/org/users/${id}`, { method: "PATCH", headers: { ...json, ...grafana() }, body: JSON.stringify({ role }) });
    assert(`${login} gets the org role ${role}`, set.ok, set.status);
  }
  return { id, headers: grafana(`${login}:${password}`) };
}

/** Stores one replay chunk for a throwaway session through the collector; true once rum-api has it. */
async function replayFor(sid) {
  const chunk = await post(`${REPLAY}/v1/replay/chunks`, {
    headers: { ...json, authorization: basic(PROJECT_ID, PROJECT_TOKEN), "x-ouo-session-id": sid, "x-ouo-seq": "0" },
    body: JSON.stringify({ session_id: sid, seq: 0, started_at: Date.now(), ended_at: Date.now() + 1000, events: [{ type: 4, timestamp: Date.now(), data: { href: "http://qa/" } }, { type: 2, timestamp: Date.now() + 1, data: {} }] }),
  });
  const stored = await until(() => replayStatus(sid).then((s) => s === 200), 30, 1000);
  return { chunk: chunk.status, stored };
}
const replayStatus = (sid) => fetch(`${RUM}/v1/sessions/${sid}/replay`, { headers: { authorization: `Bearer ${READ_TOKEN}` } }).then((r) => r.status);

checks.viewer = async () => {
  const users = [];
  try {
    const viewer = await grafanaUser("Viewer");
    users.push(viewer.id);
    const v = viewer.headers;
    const user = await fetch(`${GRAFANA}/api/user/orgs`, { headers: v }).then((r) => r.json());
    assert("a user created through /api/admin/users has the org role Viewer", user[0]?.role === "Viewer", user[0]?.role);
    for (const p of ["overview", "sessions", "funnels"]) {
      const r = await fetch(`${GRAFANA}/a/${PLUGIN}/${p}`, { headers: v, redirect: "manual" });
      assert(`Viewer opens /a/${PLUGIN}/${p} (200)`, r.status === 200, r.status);
    }
    const proxy = `${GRAFANA}/api/plugin-proxy/${PLUGIN}/rum`;
    for (const p of ["/healthz", "/v1/stats/health?from=now-1h", "/v1/sessions?from=now-1h&limit=5", "/v1/funnels/steps?from=now-1h"]) {
      const r = await fetch(proxy + p, { headers: v });
      assert(`Viewer reads GET ${p.split("?")[0]} through the plugin proxy (200)`, r.status === 200, r.status);
    }
    const funnel = await fetch(`${proxy}/v1/funnels/query`, {
      method: "POST",
      headers: { ...json, ...v },
      body: JSON.stringify({ steps: [{ kind: "page", value: "/" }, { kind: "page", match: "prefix", value: "/products/" }], from: "now-1h", to: "now" }),
    });
    assert("Viewer runs a funnel query: POST /v1/funnels/query through the plugin proxy (200, the POST route maps back onto /v1/funnels/)", funnel.status === 200, funnel.status === 200 ? funnel.status : `${funnel.status} ${(await funnel.text()).slice(0, 160)}`);
    const settings = await fetch(`${GRAFANA}/api/plugins/${PLUGIN}/settings`, { headers: v }).then((r) => r.json());
    assert("Viewer sees the settings without the read token (secureJsonData absent)", !("secureJsonData" in settings) && settings.secureJsonFields?.readToken === true, Object.keys(settings.secureJsonFields ?? {}));
    const write = await fetch(`${GRAFANA}/api/plugins/${PLUGIN}/settings`, { method: "POST", headers: { ...json, ...v }, body: JSON.stringify({ enabled: true, jsonData: { rumApiUrl: "http://example.invalid" } }) });
    assert("Viewer cannot change the plugin settings (403)", write.status === 403, write.status);
    const cfg = await fetch(`${GRAFANA}/plugins/${PLUGIN}`, { headers: v, redirect: "manual" });
    assert("Viewer cannot open the Configuration page (302 away)", cfg.status === 302 || cfg.status === 403, cfg.status);

    // N30 (was finding V1): replay erasure through the proxy is for org Admins only.
    const sid = `qa-viewer-delete-${RUN}`;
    const target = await replayFor(sid);
    note("delete_target", { session: sid, ...target });
    assert("a throwaway replay is stored for the delete checks", target.stored, target);
    const del = (h) => fetch(`${proxy}/v1/sessions/${sid}/replay`, { method: "DELETE", headers: h });
    const vd = await del(v);
    assert("Viewer cannot DELETE a replay through the plugin proxy (403)", vd.status === 403, vd.status);
    const editor = await grafanaUser("Editor");
    users.push(editor.id);
    const ed = await del(editor.headers);
    assert("Editor cannot DELETE a replay through the plugin proxy either (403, the route needs Admin)", ed.status === 403, ed.status);
    assert("the replay is still there after both refusals (200)", (await replayStatus(sid)) === 200);
    // Methods without a route: Grafana answers 404 "plugin route match not found" and never calls rum-api.
    for (const [method, path] of [["PUT", "/v1/sourcemaps?release=qa&file=a.js"], ["PATCH", `/v1/sessions/${sid}/replay`], ["POST", "/v1/replay/chunks"], ["POST", "/v1/symbolicate"], ["DELETE", "/v1/admin/projects/demo"]]) {
      const r = await fetch(proxy + path, { method, headers: { ...json, ...v }, body: "{}" });
      assert(`Viewer ${method} ${path.split("?")[0]} through the plugin proxy is refused (404, no route)`, r.status === 404, r.status);
    }
    const ad = await del(grafana());
    assert("Admin DELETEs the replay through the plugin proxy (204)", ad.status === 204, ad.status);
    assert("the replay is gone after the Admin's DELETE (404)", (await replayStatus(sid)) === 404);
  } finally {
    for (const id of users) if (id) await fetch(`${GRAFANA}/api/admin/users/${id}`, { method: "DELETE", headers: grafana() });
  }
};

checks.background = async () => {
  const out = join(tmpdir(), `ouo-qa-background-${RUN}.json`);
  const vitest = join(ROOT, "node_modules", "vitest", "vitest.mjs");
  const r = await runNode(vitest, ["run", "--config", join(HERE, "rn-background", "vitest.config.ts")], { OUO_QA_BACKGROUND_OUT: out });
  let got = {};
  try {
    got = JSON.parse(readFileSync(out, "utf8"));
    rmSync(out);
  } catch {}
  note("session", got);
  assert("RN SDK live test passed (vitest exit 0)", r.code === 0, r.code === 0 ? undefined : (r.out + r.err).split("\n").filter((l) => /FAIL|Error|expected/.test(l)).slice(0, 4).join(" | "));
  assert("rum-api: the first session ended with end_reason background, state ended, status healthy", got.end_reason === "background" && got.state === "ended" && got.status === "healthy", got);
  assert("the SDK started a new session after the foreground", got.second && got.second !== got.first, { first: got.first, second: got.second });
};

checks.xff = async () => {
  const rate = { headers: { ...json, authorization: basic(INTERNAL_ID, INTERNAL_TOKEN) } };
  const as = (ip, url = OTLP) => post(`${url}/v1/traces`, { headers: { ...rate.headers, "x-forwarded-for": ip } });
  const a = [];
  for (let i = 0; i < CLIENT_BURST + 2; i++) a.push(await as("203.0.113.10"));
  note("client_a", countBy(a));
  const firstReject = a.find((r) => r.status === 429);
  assert(`direct: ${CLIENT_BURST + 2} requests with X-Forwarded-For 203.0.113.10 -> the last ones 429 (client bucket ${CLIENT_BURST})`, a.filter((r) => r.status === 429).length >= 1, countBy(a));
  assert("the rejection names the X-Forwarded-For client", firstReject && /client \\?"203\.0\.113\.10\\?"/.test(firstReject.text), firstReject?.text.slice(0, 120));
  const b = await as("203.0.113.11");
  assert("direct: the next request with X-Forwarded-For 203.0.113.11 is 200 (its own bucket)", b.status === 200, b.status);
  if (!PROXY_OTLP) {
    note("proxy", "OUO_QA_PROXY_OTLP_URL not set: proxy leg skipped");
    return;
  }
  const p = [];
  for (let i = 0; i < CLIENT_BURST + 2; i++) p.push(await as(`198.51.100.${i + 1}`, PROXY_OTLP));
  note("through_proxy", countBy(p));
  const rej = p.find((r) => r.status === 429);
  assert(`through the env proxy (${PROXY_OTLP}), ${CLIENT_BURST + 2} requests each spoofing a different X-Forwarded-For still share one client bucket (429)`, Boolean(rej), countBy(p));
  note("proxy_rejection", rej?.text.slice(0, 160));
  assert("the proxy's rejection names the address the proxy saw, not a spoofed one", rej && !/198\.51\.100\./.test(rej.text), rej?.text.match(/client \\?"[^"\\]+/)?.[0]);
};

checks.project_bucket = async () => {
  const before = await counterNow("ouo_ratelimit_rejected_total", "key_kind");
  const n = PROJECT_BURST + 10;
  const demo = basic(PROJECT_ID, PROJECT_TOKEN);
  // Each request from its own X-Forwarded-For client, so only the project bucket can say no.
  const rs = [];
  for (let i = 0; i < n; i++) rs.push(await post(`${OTLP}/v1/traces`, { headers: { ...json, authorization: demo, "x-forwarded-for": `192.0.2.${(i % 250) + 1}` } }));
  const counts = countBy(rs);
  note("project_burst", { sent: n, statuses: counts });
  const rej = rs.find((r) => r.status === 429);
  assert(`${n} requests of project ${PROJECT_ID} from ${n} clients (project burst ${PROJECT_BURST}): some 429`, Boolean(rej), counts);
  assert(`the rejection names the project bucket (project "${PROJECT_ID}")`, rej && /project \\?"demo\\?"/.test(rej.text.replace(PROJECT_ID, "demo")), rej?.text.slice(0, 120));
  const other = await post(`${OTLP}/v1/traces`, { headers: { ...json, authorization: basic(INTERNAL_ID, INTERNAL_TOKEN), "x-forwarded-for": "192.0.2.251" } });
  assert(`project ${INTERNAL_ID} is still 200 while ${PROJECT_ID} is limited (own bucket)`, other.status === 200, other.status);
  const again = await post(`${OTLP}/v1/traces`, { headers: { ...json, authorization: demo, "x-forwarded-for": "192.0.2.252" } });
  assert(`a fresh client of ${PROJECT_ID} is still 429 (the project bucket, not the client one)`, again.status === 429, again.status);
  const { ok, delta } = await counterGrew("ouo_ratelimit_rejected_total", "key_kind", before, { project: rs.filter((r) => r.status === 429).length + 1 });
  note("rejected_delta", delta);
  assert("ouo_ratelimit_rejected_total{key_kind=project} grew in Mimir", ok, delta);
};

const PROFILES = {
  default: ["auth_failures", "empty_ratelimit", "otel_sdk", "cors_browser", "viewer", "background"],
  limits: ["xff", "project_bucket"],
};

// ---------------------------------------------------------------- main

const names = ONLY ?? PROFILES[PROFILE];
if (!names) {
  console.error(`unknown profile ${PROFILE}`);
  process.exit(2);
}
for (const name of names) {
  if (!checks[name]) {
    console.error(`unknown check ${name}`);
    process.exit(2);
  }
  console.log(`\n== ${name}`);
  current = { check: name, profile: PROFILE, assertions: [], findings: [], observed: {}, started: new Date().toISOString() };
  const t0 = Date.now();
  try {
    await checks[name]();
  } catch (e) {
    assert("check ran without an exception", false, String(e?.stack ?? e).split("\n").slice(0, 3).join(" | "));
  }
  current.seconds = Math.round((Date.now() - t0) / 100) / 10;
  current.ok = current.assertions.every((a) => a.ok);
  results.push(current);
}

const failed = results.filter((r) => !r.ok);
const findings = results.flatMap((r) => r.findings);
console.log(`\n${results.length - failed.length}/${results.length} checks passed (profile ${PROFILE}, run ${RUN})${findings.length ? `, ${findings.length} finding(s): ${findings.map((f) => f.id).join(", ")}` : ""}`);
if (OUT) {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify({ run: RUN, profile: PROFILE, at: new Date().toISOString(), otlp: OTLP, results }, null, 2) + "\n");
}
process.exit(failed.length ? 1 : 0);
