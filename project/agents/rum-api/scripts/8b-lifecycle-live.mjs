#!/usr/bin/env node
// Live check of roadmap 8b on an ouo-env (docs/operations/data-lifecycle.md section 7).
//
//   node project/agents/rum-api/scripts/8b-lifecycle-live.mjs ingest <env> <run id>
//   node project/agents/rum-api/scripts/8b-lifecycle-live.mjs status <env> <run id>
//
// ingest: project demo through the collector (OTLP 4318 and replay 4319 with the demo Basic
// credential): user u-del-<run> with two sessions, user u-keep-<run> with one; each session
// has events, one span and one rrweb replay chunk. Project ttltest (no collector credential
// in the development registry) straight into Loki's OTLP endpoint and rum-api's replay sink,
// with timestamps 30 h old, the way the collector would stamp it.
// status: per session, Loki line count, Tempo trace count and replay presence.
const [cmd, env, run] = process.argv.slice(2);
if (!cmd || !env || !run) {
  console.error("usage: 8b-lifecycle-live.mjs ingest|status <env> <run id>");
  process.exit(2);
}
const host = (svc) => `http://${svc}.${env}.ouo.localhost`;
const BASIC = "Basic " + Buffer.from("demo:pt_dev_demo_0000000000000000").toString("base64");
const READ = "Bearer rt_dev_0000000000000000";
const INGEST = "Bearer it_dev_0000000000000000";

const str = (v) => ({ stringValue: String(v) });
const kv = (o) => Object.entries(o).map(([key, value]) => ({ key, value }));
const ns = (ms) => String(BigInt(Math.round(ms)) * 1000000n);
const hex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join("");

const sessions = [
  { id: `del-${run}-1`, user: `u-del-${run}`, project: "demo" },
  { id: `del-${run}-2`, user: `u-del-${run}`, project: "demo" },
  { id: `keep-${run}-1`, user: `u-keep-${run}`, project: "demo" },
  { id: `ttl-${run}-1`, user: `u-ttl-${run}`, project: "ttltest", agoMs: 30 * 3600 * 1000 },
];

async function post(url, body, headers) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const text = await res.text();
  if (res.status >= 300) throw new Error(`${url}: ${res.status} ${text.slice(0, 300)}`);
  return { status: res.status, text };
}

function otlp(s) {
  const t0 = Date.now() - (s.agoMs ?? 0);
  const ids = { "session.id": str(s.id), "user.id": str(s.user), "ouo.platform": str("web"), "service.version": str("1.0.0") };
  const resource = {
    attributes: kv({
      "service.name": str("lifecycle-check"),
      "service.version": str("1.0.0"),
      "deployment.environment.name": str("8b"),
      "ouo.platform": str("web"),
      ...(s.project !== "demo" ? { "ouo.project.id": str(s.project) } : {}),
    }),
  };
  const rec = (name, dt) => ({
    timeUnixNano: ns(t0 + dt),
    observedTimeUnixNano: ns(t0 + dt),
    severityText: "INFO",
    severityNumber: 9,
    eventName: name,
    body: str(`${name} for ${s.user}`),
    attributes: kv({ "event.name": str(name), ...ids }),
  });
  const logs = { resourceLogs: [{ resource, scopeLogs: [{ scope: { name: "ouo.8b" }, logRecords: [rec("session.start", 0), rec("navigation", 500), rec("cart.added", 900)] }] }] };
  const traceId = hex(16);
  const spans = {
    resourceSpans: [
      {
        resource,
        scopeSpans: [
          {
            scope: { name: "ouo.8b" },
            spans: [{ traceId, spanId: hex(8), name: "HTTP GET", kind: 3, startTimeUnixNano: ns(t0 + 100), endTimeUnixNano: ns(t0 + 300), attributes: kv(ids) }],
          },
        ],
      },
    ],
  };
  const chunk = {
    session_id: s.id,
    seq: 0,
    started_at: t0,
    ended_at: t0 + 1000,
    events: [
      { type: 4, data: { href: "http://localhost:5173/", width: 1280, height: 800 }, timestamp: t0 },
      { type: 2, data: {}, timestamp: t0 + 1 },
    ],
  };
  return { logs, spans, chunk, traceId };
}

async function ingest() {
  for (const s of sessions) {
    const { logs, spans, chunk, traceId } = otlp(s);
    if (s.project === "demo") {
      await post(`${host("otlp")}/v1/logs`, logs, { authorization: BASIC });
      await post(`${host("otlp")}/v1/traces`, spans, { authorization: BASIC });
      await post(`${host("replay")}/v1/replay/chunks`, chunk, { authorization: BASIC });
    } else {
      await post(`${host("loki")}/otlp/v1/logs`, logs, {});
      await post(`${host("rum-api")}/v1/replay/chunks`, chunk, { authorization: INGEST, "x-ouo-project-id": s.project });
    }
    console.log(`ingested ${s.project}/${s.user}/${s.id} trace ${traceId}`);
  }
}

async function lokiCount(sessionId) {
  const q = `{service_name="lifecycle-check"} | session_id="${sessionId}"`;
  const u = new URL(`${host("loki")}/loki/api/v1/query_range`);
  u.searchParams.set("query", q);
  u.searchParams.set("start", String((Date.now() - 7 * 86400e3) * 1e6));
  u.searchParams.set("end", String(Date.now() * 1e6));
  u.searchParams.set("limit", "1000");
  const r = await (await fetch(u)).json();
  return (r.data?.result ?? []).reduce((n, s) => n + s.values.length, 0);
}

async function tempoCount(sessionId) {
  const u = new URL(`${host("tempo")}/api/search`);
  u.searchParams.set("q", `{ span.session.id = "${sessionId}" }`);
  u.searchParams.set("start", String(Math.floor(Date.now() / 1000) - 7 * 86400));
  u.searchParams.set("end", String(Math.floor(Date.now() / 1000) + 60));
  const r = await (await fetch(u)).json();
  return (r.traces ?? []).length;
}

async function replay(sessionId) {
  const r = await fetch(`${host("rum-api")}/v1/sessions/${sessionId}/replay`, { headers: { authorization: READ } });
  if (r.status === 404) return "absent";
  const m = await r.json();
  return `present (${m.project_id}, ${m.chunk_count} chunk, ${m.bytes} B)`;
}

async function status() {
  for (const s of sessions) {
    const [l, t, r] = await Promise.all([lokiCount(s.id), tempoCount(s.id), replay(s.id)]);
    console.log(`${s.project.padEnd(8)} ${s.user.padEnd(22)} ${s.id.padEnd(22)} loki=${l} tempo=${t} replay=${r}`);
  }
}

await (cmd === "ingest" ? ingest() : status());
