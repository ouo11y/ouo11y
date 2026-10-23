// Served with `script-src 'self'` (no unsafe-eval, no unsafe-inline), `style-src 'self'` and
// `require-trusted-types-for 'script'; trusted-types 'none'` (e2e/server.mjs): any eval, inline
// script or style, or string-to-HTML sink the SDK or rrweb used would be a violation.
window.violations = [];
document.addEventListener("securitypolicyviolation", (e) => {
  window.violations.push(`${e.violatedDirective} ${e.blockedURI} ${e.sourceFile}:${e.lineNumber}`);
});
const { initRUM } = await import("/dist/index.js");
window.rum = initRUM({
  endpoint: "http://localhost:4181",
  projectId: "e2e",
  projectToken: "pt_e2e",
  service: { name: "e2e-csp", version: "1.0.0", environment: "e2e" },
  tracing: { idleTimeoutMs: 200 },
  replay: { enabled: true, flushIntervalMs: 500 },
});
const out = document.getElementById("out");
document.getElementById("mutate").addEventListener("click", () => {
  for (let i = 0; i < 20; i++) {
    const p = document.createElement("p");
    p.textContent = `row ${i}`;
    p.style.color = i % 2 ? "red" : "blue"; // CSSOM, allowed by style-src 'self'
    out.appendChild(p);
  }
});
document.getElementById("fetch").addEventListener("click", async () => {
  const res = await fetch("/api/csp");
  out.dataset.fetched = String(res.status);
});
document.getElementById("status").textContent = "ready";
