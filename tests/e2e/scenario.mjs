#!/usr/bin/env node
// End-to-end scenario for the ouo MVP (Phase 6 QA).
//
// 1. Generates a known matrix of synthetic sessions (web + mobile, two versions,
//    5 healthy / 3 errored / 2 crashed per version) by posting OTLP/JSON logs and
//    traces straight to the OpenTelemetry Collector, exactly as the SDKs would.
// 2. Waits for Loki / Tempo ingestion, then asserts rum-api:
//      GET /v1/stats/health            buckets equal the matrix (counts and percentages)
//      GET /v1/sessions?status=crashed exactly the crashed ids, with service_version
//      GET /v1/sessions/{id}           trace_count, ordered timeline, Grafana trace links (HTTP 200)
// 3. Prints a summary table and exits non-zero with a diff on any mismatch.
//
// Node 24, no dependencies. Configuration (env, see deploy/scripts/e2e.sh):
//   OUO_OTLP_URL      default http://localhost:${OUO_OTLP_HTTP_PORT:-4318}
//   OUO_RUM_API_URL   default http://localhost:${OUO_RUM_API_PORT:-8080}
//   OUO_GRAFANA_URL   default http://localhost:${OUO_GRAFANA_PORT:-3000}
//   OUO_GRAFANA_AUTH  default admin:admin
//   OUO_E2E_TIMEOUT   seconds to wait for ingestion (default 120)
// Flags: --out <file> writes the full result as JSON (used by reports/mvp-verification.html).

import { randomBytes } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// ---------------------------------------------------------------- configuration

const env = process.env;
const OTLP = (env.OUO_OTLP_URL ?? `http://localhost:${env.OUO_OTLP_HTTP_PORT ?? 4318}`).replace(/\/$/, "");
const RUM = (env.OUO_RUM_API_URL ?? `http://localhost:${env.OUO_RUM_API_PORT ?? 8080}`).replace(/\/$/, "");
const GRAFANA = (env.OUO_GRAFANA_URL ?? `http://localhost:${env.OUO_GRAFANA_PORT ?? 3000}`).replace(/\/$/, "");
const GRAFANA_AUTH = env.OUO_GRAFANA_AUTH ?? "admin:admin";
const TIMEOUT_S = Number(env.OUO_E2E_TIMEOUT ?? 120);
// Range: absolute run start so that two runs inside 15 minutes never count each other.
// (`from=now-15m` works too but is not idempotent.) rum-api accepts epoch ms.
const T0 = Date.now();
const RANGE = String(T0 - 60_000);

const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const OUT_FILE = outIdx >= 0 ? args[outIdx + 1] : undefined;

// The matrix. Each service gets both versions; each version gets these counts.
const RUN_ID = Date.now().toString(36);
const SERVICES = [
  { platform: "web", service: "qa-web", code: "w" },
  { platform: "mobile", service: "qa-mobile", code: "m" },
];
const VERSIONS = ["1.0.0", "1.1.0"];
const COUNTS = { healthy: 5, errored: 3, crashed: 2 };

// ---------------------------------------------------------------- helpers

const hex = (n) => randomBytes(n).toString("hex");
const ns = (ms) => (BigInt(Math.round(ms)) * 1000000n).toString();
const str = (v) => ({ stringValue: String(v) });
const bool = (v) => ({ boolValue: Boolean(v) });
const int = (v) => ({ intValue: String(v) });
const kv = (obj) => Object.entries(obj).map(([key, value]) => ({ key, value }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (n, total) => (total === 0 ? 0 : Math.round((n / total) * 10000) / 100);

const failures = [];
function check(name, expected, actual, detail) {
  const ok = JSON.stringify(expected) === JSON.stringify(actual);
  if (!ok) failures.push({ name, expected, actual, detail });
  return ok;
}

async function getJSON(url) {
  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

async function postOTLP(path, body) {
  const res = await fetch(`${OTLP}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path} -> HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

async function pollUntil(label, fn, timeoutS = TIMEOUT_S, everyMs = 3000) {
  const deadline = Date.now() + timeoutS * 1000;
  let last;
  for (;;) {
    try {
      last = await fn();
      if (last.done) return last.value;
    } catch (err) {
      last = { error: String(err) };
    }
    if (Date.now() >= deadline) {
      throw new Error(`${label}: timeout after ${timeoutS}s; last: ${JSON.stringify(last).slice(0, 500)}`);
    }
    await sleep(everyMs);
  }
}

// ---------------------------------------------------------------- session generation

/** Builds the events, spans and expectations of one synthetic session. */
function buildSession({ platform, service, code }, version, status, index, baseMs) {
  const id = `qa-${RUN_ID}-${code}-${version.replaceAll(".", "")}-${status[0]}${index}`;
  const userId = `qa-user-${code}-${index}`;
  const startedAt = baseMs; // epoch ms
  let t = startedAt;
  const tick = () => (t += 250);

  const ids = {
    "session.id": str(id),
    "user.id": str(userId),
    "ouo.platform": str(platform),
    "service.version": str(version),
  };
  const events = [];
  const event = (name, extra = {}, severity = ["INFO", 9]) => {
    events.push({
      timeUnixNano: ns(t),
      observedTimeUnixNano: ns(t),
      severityText: severity[0],
      severityNumber: severity[1],
      eventName: name,
      body: str(name),
      attributes: kv({ "event.name": str(name), ...ids, ...extra }),
    });
  };

  event("session.start", { "ouo.session.started_at": int(startedAt) });
  tick();
  event("navigation", { "url.path": str("/"), "ouo.navigation.kind": str("load") });
  tick();

  // traces: 1..3 per session, each = client span (service) -> server span (qa-backend)
  const traceCount = (index % 3) + 1;
  const traces = [];
  let failedTraceId = null;
  for (let k = 0; k < traceCount; k++) {
    const traceId = hex(16);
    const clientSpan = hex(8);
    const serverSpan = hex(8);
    const start = t;
    const failed = status === "errored" && index === 2 && k === 0; // one 500 trace in session e2
    const route = ["/api/products", "/api/cart", "/api/checkout"][k];
    const method = k === 0 ? "GET" : "POST";
    const statusCode = failed ? 500 : 200;
    traces.push({
      traceId,
      spans: [
        {
          resource: { service, version, platform },
          span: {
            traceId,
            spanId: clientSpan,
            name: `HTTP ${method}`,
            kind: 3,
            startTimeUnixNano: ns(start),
            endTimeUnixNano: ns(start + 120),
            attributes: kv({
              ...ids,
              "http.request.method": str(method),
              "url.full": str(`http://qa-backend${route}`),
              "http.response.status_code": int(statusCode),
            }),
            status: { code: failed ? 2 : 0 },
          },
        },
        {
          resource: { service: "qa-backend", version: "0.1.0", platform: null },
          span: {
            traceId,
            spanId: serverSpan,
            parentSpanId: clientSpan,
            name: `${method} ${route}`,
            kind: 2,
            startTimeUnixNano: ns(start + 10),
            endTimeUnixNano: ns(start + 100),
            attributes: kv({
              "session.id": str(id),
              "user.id": str(userId),
              "ouo.platform": str(platform),
              "http.request.method": str(method),
              "http.route": str(route),
              "http.response.status_code": int(statusCode),
            }),
            status: { code: failed ? 2 : 0 },
          },
        },
      ],
    });
    if (failed) failedTraceId = traceId;
    t += 150;
  }

  if (status === "errored") {
    // e0: handled exception, e1: failed request, e2: both (plus the errored trace above)
    if (index !== 1) {
      event(
        "exception",
        {
          "exception.type": str("Error"),
          "exception.message": str("qa handled error"),
          "exception.stacktrace": str("Error: qa handled error\n    at qa (scenario.mjs:1:1)"),
          "ouo.exception.fatal": bool(false),
          "ouo.exception.handled": bool(true),
        },
        ["WARN", 13],
      );
      tick();
    }
    if (index !== 0) {
      event("http.request.failed", {
        "http.request.method": str("POST"),
        "url.full": str("http://qa-backend/api/checkout?fail=500"),
        "http.response.status_code": int(500),
      });
      tick();
    }
  }

  let expectEnd = null;
  if (status === "crashed") {
    // web: uncaught error / unhandled rejection, fatal, the page keeps running (no session.end)
    // mobile c0: fatal exception + session.end crash (SDK flushed in time)
    // mobile c1: session.end crash only (crash marker found on the next launch, ADR-0004 / rum-api)
    const mobileMarkerOnly = platform === "mobile" && index === 1;
    if (!mobileMarkerOnly) {
      event(
        "exception",
        {
          "exception.type": str(index === 0 ? "TypeError" : "UnhandledRejection"),
          "exception.message": str("qa fatal error"),
          "exception.stacktrace": str("TypeError: qa fatal error\n    at qa (scenario.mjs:2:2)"),
          "ouo.exception.fatal": bool(true),
          "ouo.exception.handled": bool(false),
          "ouo.exception.kind": str(index === 0 ? "uncaught" : "unhandledrejection"),
        },
        ["ERROR", 17],
      );
      tick();
    }
    if (platform === "mobile") {
      event("session.end", {
        "ouo.session.end_reason": str("crash"),
        "ouo.session.duration_ms": int(t - startedAt),
        "ouo.session.started_at": int(startedAt),
      });
      expectEnd = "crash";
      tick();
    }
  }

  return {
    id,
    userId,
    platform,
    service,
    version,
    status,
    startedAt,
    lastSignalMs: t,
    events,
    traces,
    expect: {
      traceCount,
      failedTraceId,
      endReason: expectEnd,
      eventNames: events.map((e) => e.eventName),
    },
    // resource for the log records (what the SDK resource would be)
    resource: { service, version, platform },
  };
}

function resourceAttrs({ service, version, platform }) {
  const attrs = {
    "service.name": str(service),
    "service.version": str(version),
    "deployment.environment.name": str("qa"),
    "ouo.sdk.name": str("qa-scenario"),
  };
  if (platform) attrs["ouo.platform"] = str(platform);
  return { attributes: kv(attrs) };
}

function generateMatrix() {
  const sessions = [];
  const now = Date.now();
  let base = T0 - 30_000; // sessions start 30 s before the run and are spread 250 ms apart
  for (const svc of SERVICES) {
    for (const version of VERSIONS) {
      for (const [status, n] of Object.entries(COUNTS)) {
        for (let i = 0; i < n; i++) {
          sessions.push(buildSession(svc, version, status, i, base));
          base += 250;
        }
      }
    }
  }
  return sessions;
}

async function sendMatrix(sessions) {
  // one resourceLogs entry per session (its own resource), one request per service
  for (const svc of SERVICES) {
    const mine = sessions.filter((s) => s.service === svc.service);
    const resourceLogs = mine.map((s) => ({
      resource: resourceAttrs(s.resource),
      scopeLogs: [{ scope: { name: "ouo.qa" }, logRecords: s.events }],
    }));
    const resourceSpans = [];
    for (const s of mine) {
      for (const tr of s.traces) {
        for (const sp of tr.spans) {
          resourceSpans.push({
            resource: resourceAttrs(sp.resource),
            scopeSpans: [{ scope: { name: "ouo.qa" }, spans: [sp.span] }],
          });
        }
      }
    }
    const logsRes = await postOTLP("/v1/logs", { resourceLogs });
    const tracesRes = await postOTLP("/v1/traces", { resourceSpans });
    const rejectedLogs = logsRes?.partialSuccess?.rejectedLogRecords ?? 0;
    const rejectedSpans = tracesRes?.partialSuccess?.rejectedSpans ?? 0;
    if (rejectedLogs || rejectedSpans) {
      throw new Error(`collector rejected logs=${rejectedLogs} spans=${rejectedSpans}: ${JSON.stringify(logsRes)} ${JSON.stringify(tracesRes)}`);
    }
    console.log(`sent ${svc.service}: ${mine.length} sessions, ${mine.reduce((a, s) => a + s.events.length, 0)} log records, ${resourceSpans.length} spans`);
  }
}

// ---------------------------------------------------------------- assertions

function expectedBuckets(svc) {
  const total = Object.values(COUNTS).reduce((a, b) => a + b, 0);
  return VERSIONS.map((version) => ({
    platform: svc.platform,
    service_name: svc.service,
    service_version: version,
    total,
    healthy: COUNTS.healthy,
    errored: COUNTS.errored,
    crashed: COUNTS.crashed,
    healthy_pct: pct(COUNTS.healthy, total),
    errored_pct: pct(COUNTS.errored, total),
    crashed_pct: pct(COUNTS.crashed, total),
  }));
}

function expectedTotals(svc) {
  const b = expectedBuckets(svc);
  const total = b.reduce((a, x) => a + x.total, 0);
  const healthy = b.reduce((a, x) => a + x.healthy, 0);
  const errored = b.reduce((a, x) => a + x.errored, 0);
  const crashed = b.reduce((a, x) => a + x.crashed, 0);
  return {
    total,
    healthy,
    errored,
    crashed,
    healthy_pct: pct(healthy, total),
    errored_pct: pct(errored, total),
    crashed_pct: pct(crashed, total),
  };
}

const pickTotals = (t) => ({
  total: t.total,
  healthy: t.healthy,
  errored: t.errored,
  crashed: t.crashed,
  healthy_pct: t.healthy_pct,
  errored_pct: t.errored_pct,
  crashed_pct: t.crashed_pct,
});

async function assertHealth(svc, sessions) {
  const url = `${RUM}/v1/stats/health?from=${RANGE}&service=${svc.service}`;
  const expectedTotal = sessions.filter((s) => s.service === svc.service).length;
  const body = await pollUntil(
    `health ${svc.service} total=${expectedTotal}`,
    async () => {
      const b = await getJSON(url);
      return { done: b.totals?.total === expectedTotal, value: b, seen: b.totals?.total };
    },
  );
  const actualBuckets = body.buckets.map((b) => ({ ...b }));
  check(`health buckets ${svc.service}`, expectedBuckets(svc), actualBuckets, url);
  check(`health rows sum ${svc.service}`, true, actualBuckets.every((b) => b.healthy + b.errored + b.crashed === b.total), url);
  check(`health totals ${svc.service}`, expectedTotals(svc), pickTotals(body.totals), url);
  return { url, body };
}

async function assertCrashedList(svc, sessions) {
  const url = `${RUM}/v1/sessions?from=${RANGE}&service=${svc.service}&status=crashed&limit=1000`;
  const expected = sessions
    .filter((s) => s.service === svc.service && s.status === "crashed")
    .map((s) => ({ session_id: s.id, service_version: s.version, platform: s.platform, status: "crashed", user_id: s.userId }))
    .sort((a, b) => a.session_id.localeCompare(b.session_id));
  const body = await getJSON(url);
  const actual = (body.sessions ?? [])
    .map((s) => ({ session_id: s.session_id, service_version: s.service_version, platform: s.platform, status: s.status, user_id: s.user_id }))
    .sort((a, b) => a.session_id.localeCompare(b.session_id));
  check(`crashed sessions ${svc.service}`, expected, actual, url);
  // end reason: mobile crashed sessions carry session.end crash, web ones stay active
  for (const s of sessions.filter((x) => x.service === svc.service && x.status === "crashed")) {
    const rec = (body.sessions ?? []).find((r) => r.session_id === s.id);
    if (rec) check(`end_reason ${s.id}`, s.expect.endReason, rec.end_reason ?? null, url);
  }
  return { url, count: body.count, ids: actual.map((a) => a.session_id) };
}

async function assertDetail(session) {
  const url = `${RUM}/v1/sessions/${session.id}`;
  // Tempo indexing lag + rum-api's 60 s Tempo cache: poll up to 90 s for the trace count
  const body = await pollUntil(
    `detail ${session.id} trace_count=${session.expect.traceCount}`,
    async () => {
      const b = await getJSON(url);
      return { done: b.trace_count === session.expect.traceCount, value: b, seen: b.trace_count };
    },
    90,
  );
  const rec = body; // the record fields are top-level, next to `timeline` and `traces`
  check(`detail record ${session.id}`, {
    session_id: session.id,
    user_id: session.userId,
    platform: session.platform,
    service_name: session.service,
    service_version: session.version,
    status: session.status,
    trace_count: session.expect.traceCount,
    has_replay: false,
    end_reason: session.expect.endReason,
    state: session.expect.endReason ? "ended" : "active",
  }, {
    session_id: rec.session_id,
    user_id: rec.user_id,
    platform: rec.platform,
    service_name: rec.service_name,
    service_version: rec.service_version,
    status: rec.status,
    trace_count: rec.trace_count,
    has_replay: rec.has_replay,
    end_reason: rec.end_reason ?? null,
    state: rec.state,
  }, url);

  // timeline: ordered by ts, same event names in the same order as sent
  const timeline = body.timeline ?? [];
  const ts = timeline.map((e) => Date.parse(e.ts));
  const ordered = ts.every((v, i) => i === 0 || v >= ts[i - 1]);
  check(`timeline ordered ${session.id}`, true, ordered, timeline.map((e) => `${e.ts} ${e.name}`));
  check(`timeline events ${session.id}`, session.expect.eventNames, timeline.map((e) => e.name), url);

  // traces: ids, has_error on the 500 trace, grafana_url opens in Grafana (HTTP 200)
  const traces = body.traces ?? [];
  // Tempo's search API returns trace ids without leading zeros (a 32-hex id starting with
  // "0" comes back as 31 chars); Tempo and Grafana accept both forms, so compare normalised.
  const norm = (id) => String(id).replace(/^0+/, "");
  check(
    `trace ids ${session.id}`,
    session.traces.map((t) => norm(t.traceId)).sort(),
    traces.map((t) => norm(t.trace_id)).sort(),
    url,
  );
  const shortIds = traces.filter((t) => String(t.trace_id).length !== 32).map((t) => t.trace_id);
  if (session.expect.failedTraceId) {
    const failed = traces.find((t) => t.trace_id === session.expect.failedTraceId);
    check(`has_error ${session.expect.failedTraceId}`, true, failed?.has_error ?? null, url);
  }
  const links = [];
  for (const t of traces) {
    if (!t.grafana_url) {
      check(`grafana_url present ${t.trace_id}`, "string", typeof t.grafana_url, url);
      continue;
    }
    if (!t.grafana_url.startsWith(GRAFANA + "/")) {
      check(`grafana_url base ${t.trace_id}`, GRAFANA + "/explore?...", t.grafana_url, "OUO_GRAFANA_URL vs rum-api GRAFANA_URL");
    }
    const res = await fetch(t.grafana_url, {
      redirect: "follow",
      headers: { authorization: "Basic " + Buffer.from(GRAFANA_AUTH).toString("base64") },
    });
    await res.arrayBuffer();
    check(`grafana_url HTTP 200 ${t.trace_id}`, 200, res.status, t.grafana_url);
    // Stronger than the page status: the same trace id resolves through Grafana's Tempo
    // datasource (what Explore does when the TraceQL box holds a bare trace id).
    const spans = await grafanaTraceSpans(t.trace_id, t.grafana_url);
    check(`grafana datasource trace ${t.trace_id} spans`, 2, spans, "POST /api/ds/query queryType=traceId");
    links.push({ trace_id: t.trace_id, status: res.status, grafana_spans: spans, has_error: t.has_error, root: `${t.root_service} ${t.root_name}`, span_count: t.span_count });
  }
  return { url, record: rec, timeline: timeline.map((e) => ({ ts: e.ts, type: e.type, name: e.name })), traces: links, short_trace_ids: shortIds };
}

/** Number of spans Grafana's Tempo datasource returns for a trace id (0 when not found). */
async function grafanaTraceSpans(traceId, grafanaUrl) {
  const panes = new URL(grafanaUrl).searchParams.get("panes");
  const range = panes ? JSON.parse(panes)?.ouo?.range : undefined;
  const res = await fetch(`${GRAFANA}/api/ds/query`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Basic " + Buffer.from(GRAFANA_AUTH).toString("base64"),
    },
    body: JSON.stringify({
      queries: [{ refId: "A", datasource: { type: "tempo", uid: "tempo" }, queryType: "traceId", query: traceId }],
      from: range?.from ?? String(Date.now() - 3600_000),
      to: range?.to ?? String(Date.now()),
    }),
  });
  const body = await res.json().catch(() => ({}));
  const frame = body?.results?.A?.frames?.[0];
  return frame?.data?.values?.[0]?.length ?? 0;
}

// ---------------------------------------------------------------- output

function table(rows) {
  const cols = Object.keys(rows[0]);
  const width = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c]).length)));
  const line = (r) => cols.map((c, i) => String(r[c]).padEnd(width[i])).join("  ");
  console.log(line(Object.fromEntries(cols.map((c) => [c, c]))));
  console.log(width.map((w) => "-".repeat(w)).join("  "));
  for (const r of rows) console.log(line(r));
}

function printDiff(f) {
  console.log(`\nFAIL ${f.name}`);
  if (f.detail) console.log(`  where: ${typeof f.detail === "string" ? f.detail : JSON.stringify(f.detail)}`);
  console.log(`  expected: ${JSON.stringify(f.expected)}`);
  console.log(`  actual:   ${JSON.stringify(f.actual)}`);
  if (Array.isArray(f.expected) && Array.isArray(f.actual)) {
    const e = new Set(f.expected.map((x) => JSON.stringify(x)));
    const a = new Set(f.actual.map((x) => JSON.stringify(x)));
    for (const x of e) if (!a.has(x)) console.log(`  - ${x}`);
    for (const x of a) if (!e.has(x)) console.log(`  + ${x}`);
  }
}

// ---------------------------------------------------------------- main

async function main() {
  console.log(`ouo e2e scenario run_id=${RUN_ID}`);
  console.log(`collector ${OTLP}  rum-api ${RUM}  grafana ${GRAFANA}  from=${RANGE} (${new Date(Number(RANGE)).toISOString()})`);

  const ready = await getJSON(`${RUM}/readyz`).catch((e) => ({ ready: false, error: String(e) }));
  if (!ready.ready) throw new Error(`rum-api not ready: ${JSON.stringify(ready)}`);

  const sessions = generateMatrix();
  const t0 = T0;
  await sendMatrix(sessions);

  const result = { run_id: RUN_ID, started_at: new Date(t0).toISOString(), range: RANGE, matrix: COUNTS, versions: VERSIONS, services: SERVICES, health: {}, crashed: {}, details: {}, failures: [] };

  for (const svc of SERVICES) {
    result.health[svc.service] = await assertHealth(svc, sessions);
    result.crashed[svc.service] = await assertCrashedList(svc, sessions);
  }

  // one detail check per service: the errored session with 3 traces (index 2, one of them a 500)
  for (const svc of SERVICES) {
    const s = sessions.find((x) => x.service === svc.service && x.status === "errored" && x.version === VERSIONS[0] && x.traces.length === 3);
    result.details[s.id] = await assertDetail(s);
    // and a crashed one with session.end (mobile) / fatal only (web)
    const c = sessions.find((x) => x.service === svc.service && x.status === "crashed" && x.version === VERSIONS[1]);
    result.details[c.id] = await assertDetail(c);
  }

  result.ingest_wait_ms = Date.now() - t0;
  result.failures = failures;

  // summary table
  console.log("\nmatrix vs rum-api (GET /v1/stats/health):");
  const rows = [];
  for (const svc of SERVICES) {
    const buckets = result.health[svc.service].body.buckets;
    for (const version of VERSIONS) {
      const b = buckets.find((x) => x.service_version === version) ?? {};
      rows.push({
        platform: svc.platform,
        service: svc.service,
        version,
        "sent h/e/c": `${COUNTS.healthy}/${COUNTS.errored}/${COUNTS.crashed}`,
        "api h/e/c": `${b.healthy ?? "-"}/${b.errored ?? "-"}/${b.crashed ?? "-"}`,
        "api %": `${b.healthy_pct ?? "-"}/${b.errored_pct ?? "-"}/${b.crashed_pct ?? "-"}`,
        total: b.total ?? "-",
      });
    }
  }
  table(rows);

  console.log("\nsession detail checks:");
  table(
    Object.entries(result.details).map(([id, d]) => ({
      session: id,
      status: d.record.status,
      end_reason: d.record.end_reason ?? "-",
      events: d.timeline.length,
      traces: d.record.trace_count,
      "grafana links 200": `${d.traces.filter((t) => t.status === 200).length}/${d.traces.length}`,
      "grafana ds spans": d.traces.map((t) => t.grafana_spans).join(","),
    })),
  );

  if (OUT_FILE) {
    mkdirSync(dirname(OUT_FILE), { recursive: true });
    writeFileSync(OUT_FILE, JSON.stringify(result, null, 2));
    console.log(`\nwrote ${OUT_FILE}`);
  }

  if (failures.length) {
    for (const f of failures) printDiff(f);
    console.log(`\nE2E FAIL: ${failures.length} mismatch(es), run_id=${RUN_ID}`);
    process.exit(1);
  }
  console.log(`\nE2E OK: ${sessions.length} sessions, run_id=${RUN_ID}, ingestion wait ${Math.round(result.ingest_wait_ms / 1000)} s`);
}

main().catch((err) => {
  console.error(`\nE2E ERROR: ${err?.stack ?? err}`);
  if (failures.length) for (const f of failures) printDiff(f);
  process.exit(2);
});
