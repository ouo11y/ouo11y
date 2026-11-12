// The e2e page: starts the SDK from the query string and wires a few buttons. An external module,
// so the same file runs under the strict Content-Security-Policy of csp.html.
import * as ouo from "/dist/index.js";

const q = new URLSearchParams(location.search);
const num = (k, d) => (q.has(k) ? Number(q.get(k)) : d);
const status = document.getElementById("status");
window.ouo = ouo;
// What the page itself sees: an SDK failure must never show up here.
window.pageErrors = [];
window.addEventListener("error", (e) => window.pageErrors.push(String(e.message)));
window.addEventListener("unhandledrejection", (e) => window.pageErrors.push(String(e.reason)));

if (q.get("traceparent")) {
  // Server-rendered page stand-in: the meta tag the backend would write.
  const m = document.createElement("meta");
  m.name = "traceparent";
  m.content = q.get("traceparent");
  document.head.appendChild(m);
}
for (const f of (q.get("fault") ?? "").split(",").filter(Boolean)) ouo._internal.injectFault(f);
if (q.get("sdk") !== "0") {
  ouo.init({
    endpoint: q.get("endpoint") ?? `http://localhost:${num("collector", Number(location.port) + 1)}`,
    projectId: "e2e",
    projectToken: "pt_e2e",
    serviceName: "e2e-page",
    serviceVersion: "1.0.0",
    environment: "e2e",
    sampling: { sessionRate: num("sample", 1) },
    replay: { mode: q.get("replay") ?? "off", sessionRate: 1, bufferRate: 1, chunkMaxMs: 500 },
    consent: { required: q.get("consent") === "1" },
    propagation: { sessionBaggage: q.get("baggage") === "1" },
    instrumentations: { resourceTiming: q.get("resources") === "1" },
    transport: { flushIntervalMs: 300, retry: { initialMs: 200, maxMs: 1000 } },
    debug: q.get("debug") === "1",
  });
}

const out = document.getElementById("out");
document.getElementById("fetch").addEventListener("click", async () => {
  const res = await fetch(`/api/items?user=jane&delay=${num("apiDelay", 0)}`);
  out.textContent = JSON.stringify(await res.json());
});
document.getElementById("slow").addEventListener("click", () => void fetch("/api/slow?delay=8000").catch(() => undefined));
document.getElementById("route").addEventListener("click", () => {
  history.pushState({}, "", "/products/7?ref=mail");
  ouo.trackNavigation("/products/:id");
  out.textContent = "product 7";
});
document.getElementById("mutate").addEventListener("click", () => {
  const p = document.createElement("p");
  p.textContent = `Added at ${Date.now()} for Jane`;
  out.appendChild(p);
});
document.getElementById("throw").addEventListener("click", () => {
  setTimeout(() => {
    throw new Error("thrown by the page");
  }, 0);
});
document.getElementById("handled").addEventListener("click", () => ouo.recordException(new Error("handled by the page"), { plan: "pro" }));
status.textContent = "ready";
