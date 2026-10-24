// A large DOM for the rrweb cost measurement (e2e/rrweb-cost.spec.ts): ?nodes=N elements in a
// table (rows of 10 cells, a text node in each), then the SDK per ?sdk / ?replay / ?block.
// window.jank collects main-thread blocking (lag of a 10 ms timer chain).
const q = new URLSearchParams(location.search);
const nodes = Number(q.get("nodes") ?? 10000);
const tbody = document.querySelector("#grid tbody");
const rows = Math.ceil(nodes / 11); // a row and its 10 cells
for (let r = 0; r < rows; r++) {
  const tr = document.createElement("tr");
  for (let c = 0; c < 10; c++) tr.appendChild(document.createElement("td")).textContent = `${r}:${c}`;
  tbody.appendChild(tr);
}

// Main-thread blocking, every engine: a 10 ms timer chain; any lag over 20 ms counts as blocked.
const jank = (window.jank = { blockedMs: 0, worstMs: 0 });
let expected = performance.now() + 10;
const tick = () => {
  const now = performance.now();
  const lag = now - expected;
  if (lag > 20) jank.blockedMs += lag;
  jank.worstMs = Math.max(jank.worstMs, lag);
  expected = now + 10;
  setTimeout(tick, 10);
};
setTimeout(tick, 10);

/** Changes the text of `count` cells, `times` times, every `everyMs`. */
window.churn = (count, times, everyMs) =>
  new Promise((done) => {
    const cells = tbody.getElementsByTagName("td");
    let i = 0;
    const tick = () => {
      for (let k = 0; k < count; k++) cells[(i * count + k) % cells.length].textContent = `${i}-${k}`;
      if (++i < times) setTimeout(tick, everyMs);
      else done();
    };
    tick();
  });

// Started by the spec once its counters run, so they cover the SDK's whole start.
window.startSDK = async () => {
  if (q.get("sdk") === "0") return 0;
  const t0 = performance.now();
  const { initRUM } = await import("/dist/index.js");
  window.rum = initRUM({
    endpoint: `http://localhost:${q.get("collector") ?? Number(location.port) + 1}`,
    projectId: "e2e",
    projectToken: "pt_e2e",
    service: { name: "e2e-big", version: "1.0.0", environment: "e2e" },
    replay: {
      enabled: q.get("replay") !== "0",
      flushIntervalMs: 1000,
      ...(q.get("block") ? { blockSelector: q.get("block") } : {}),
    },
  });
  return performance.now() - t0;
};
document.getElementById("status").textContent = "ready";
