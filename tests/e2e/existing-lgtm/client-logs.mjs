#!/usr/bin/env node
// The customer's own application logs (tests/e2e/existing-lgtm): OTLP/JSON to the customer's
// collector, with the resource a Kubernetes service carries. run.sh sends them before and after
// ouo's Loki additions and compares the stream labels Loki gives them.
// Usage: node client-logs.mjs <otlp http base> <marker>
const [base = "http://localhost:20814", marker = "m"] = process.argv.slice(2);
const now = BigInt(Date.now()) * 1_000_000n;
const kv = (key, v) => ({ key, value: { stringValue: v } });
const body = {
  resourceLogs: [{
    resource: { attributes: [
      kv("service.name", "juhi-care-api"), kv("service.namespace", "care"),
      kv("deployment.environment.name", "prod"), kv("service.instance.id", "care-api-7d9f-1"),
      kv("k8s.namespace.name", "care"), kv("k8s.pod.name", "care-api-7d9f-1"), kv("k8s.cluster.name", "juhi-eu"),
    ] },
    scopeLogs: [{ scope: { name: "care-api" }, logRecords: [1, 2, 3].map((i) => ({
      timeUnixNano: String(now + BigInt(i)), severityText: "INFO", severityNumber: 9,
      body: { stringValue: `visit scheduled ${marker} #${i}` },
      attributes: [kv("http.route", "/visits"), kv("marker", marker)],
    })) }],
  }],
};
const r = await fetch(`${base.replace(/\/$/, "")}/v1/logs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
if (!r.ok) { console.error(`client-logs: ${r.status} ${await r.text()}`); process.exit(1); }
console.log(`client-logs: 3 lines, marker ${marker}`);
