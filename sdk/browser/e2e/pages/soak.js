// A busy single-page app for the soak (e2e/soak.spec.ts): a route change every 2 s that
// replaces a 300-row view, a ticker mutating 50 cells 4 times a second, fetch and XHR traffic,
// console errors and captured errors. The page itself holds nothing across routes, so any
// growth over time is the SDK's. ?sdk=0 runs it without the SDK, ?replay=0 without replay.
const q = new URLSearchParams(location.search);
if (q.get("sdk") !== "0") {
  const { initRUM } = await import("/dist/index.js");
  window.rum = initRUM({
    endpoint: `http://localhost:${q.get("collector") ?? 4181}`,
    projectId: "e2e",
    projectToken: "pt_e2e",
    service: { name: "e2e-soak", version: "1.0.0", environment: "e2e" },
    tracing: { idleTimeoutMs: 300 },
    replay: { enabled: q.get("replay") !== "0", flushIntervalMs: 2000 },
  });
}

const view = document.getElementById("view");
const ticker = document.getElementById("ticker");
const routeEl = document.getElementById("route");
let n = 0;

function render(route, items) {
  const frag = document.createDocumentFragment();
  for (let i = 0; i < 300; i++) {
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `<span class="cell">${route}</span><span class="cell">#${i}</span><span class="cell">${items[i % items.length]}</span><button>pick</button>`;
    row.querySelector("button").addEventListener("click", () => row.classList.toggle("sel"));
    frag.appendChild(row);
  }
  view.replaceChildren(frag);
}

async function go(kind) {
  n += 1;
  const route = `/soak/r${n % 20}`;
  if (kind === "push") history.pushState({ n }, "", route);
  routeEl.textContent = route;
  window.rum?.setRoute("/soak/:id");
  const res = await fetch(`/api/items?route=${n % 20}`);
  const body = await res.json();
  render(route, [body.path, String(n), "x".repeat(n % 30)]);
}

for (let i = 0; i < 50; i++) ticker.appendChild(document.createElement("span")).className = "cell";
setInterval(() => {
  for (const c of ticker.children) c.textContent = String(Math.random()).slice(2, 7);
}, 250);
setInterval(() => void go("push"), 2000);
setInterval(() => {
  const xhr = new XMLHttpRequest();
  xhr.open("GET", `/api/xhr?n=${n}`);
  xhr.send();
}, 5000);
let ticks = 0;
setInterval(() => {
  ticks += 1;
  if (ticks % 2 === 0) console.error("soak console error", ticks);
  if (ticks % 3 === 0) window.rum?.captureError(new Error(`soak captured ${ticks}`));
  if (ticks % 5 === 0) fetch("/api/fail?status=503");
}, 5000);

document.getElementById("next").addEventListener("click", () => void go("push"));
document.getElementById("back").addEventListener("click", () => history.back());
window.addEventListener("popstate", () => void go("pop"));
document.getElementById("search").addEventListener("input", (e) => (routeEl.dataset.q = e.target.value));
await go("push");
document.getElementById("status").textContent = "ready";
