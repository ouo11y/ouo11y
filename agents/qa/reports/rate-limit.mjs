const URL = "http://localhost:8090/ingest/otlp/v1/logs";
const H = { "content-type": "application/json", "x-ouo-project-token": "pt_dev_demo_0000000000000000" };
const body = JSON.stringify({ resourceLogs: [] });
const N = 400;
const t0 = Date.now();
const results = await Promise.all(Array.from({ length: N }, () => fetch(URL, { method: "POST", headers: H, body }).then(async (r) => ({ s: r.status, ra: r.headers.get("retry-after"), body: (await r.text()).slice(0, 80) }))));
const dt = Date.now() - t0;
const counts = {};
for (const r of results) counts[r.s] = (counts[r.s] || 0) + 1;
const first429 = results.find((r) => r.s === 429);
console.log(JSON.stringify({ n: N, elapsed_ms: dt, counts, first429 }));
// recovery
const seq = [];
for (let i = 0; i < 6; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  const r = await fetch(URL, { method: "POST", headers: H, body });
  seq.push({ after_s: i + 1, status: r.status, retry_after: r.headers.get("retry-after") });
}
console.log(JSON.stringify({ recovery: seq }));
