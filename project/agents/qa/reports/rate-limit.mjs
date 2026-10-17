// Phase 8a rev 2: ouoratelimit at the collector edge. 400 tiny authenticated OTLP/HTTP log posts
// fired at once from the Mac, then one post per second to watch the bucket refill.
// Usage: OUO_OTLP_URL=http://localhost:4330 node project/agents/qa/reports/rate-limit.mjs
const OTLP = (process.env.OUO_OTLP_URL ?? "http://localhost:4318").replace(/\/$/, "");
const URL = `${OTLP}/v1/logs`;
const BASIC = "Basic " + Buffer.from(`${process.env.OUO_PROJECT_ID ?? "demo"}:${process.env.OUO_PROJECT_TOKEN ?? "pt_dev_demo_0000000000000000"}`).toString("base64");
const H = { "content-type": "application/json", authorization: BASIC };
const now = () => (BigInt(Date.now()) * 1000000n).toString();
const body = () =>
  JSON.stringify({
    resourceLogs: [{
      resource: { attributes: [{ key: "service.name", value: { stringValue: "qa-ratelimit" } }] },
      scopeLogs: [{ scope: { name: "ouo.qa" }, logRecords: [{ timeUnixNano: now(), severityText: "INFO", body: { stringValue: "rl" } }] }],
    }],
  });
const N = Number(process.env.N ?? 400);
const t0 = Date.now();
const results = await Promise.all(
  Array.from({ length: N }, () =>
    fetch(URL, { method: "POST", headers: H, body: body() }).then(async (r) => ({ s: r.status, ra: r.headers.get("retry-after"), body: (await r.text()).slice(0, 200) })),
  ),
);
const dt = Date.now() - t0;
const counts = {};
for (const r of results) counts[r.s] = (counts[r.s] || 0) + 1;
const first429 = results.find((r) => r.s === 429);
const retryAfters = [...new Set(results.filter((r) => r.s === 429).map((r) => r.ra))];
console.log(JSON.stringify({ url: URL, n: N, elapsed_ms: dt, counts, retry_after_values: retryAfters, first429 }));
const seq = [];
for (let i = 0; i < 4; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  const r = await fetch(URL, { method: "POST", headers: H, body: body() });
  seq.push({ after_s: i + 1, status: r.status, retry_after: r.headers.get("retry-after") });
}
console.log(JSON.stringify({ recovery: seq }));
