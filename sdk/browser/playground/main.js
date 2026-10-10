import { initRUM } from "../dist/index.js";

const params = new URLSearchParams(location.search);
const backend = params.get("backend") ?? "http://localhost:8082";
const rum = initRUM({
  endpoint: params.get("rum") ?? "http://localhost:8090", // rum-api (or the stub in server.mjs)
  projectToken: params.get("token") ?? "pt_dev_demo_0000000000000000",
  ...(params.get("otlp") ? { otlpEndpoint: params.get("otlp") } : {}), // escape hatch: straight to a collector
  service: { name: "web-store", version: "1.4.2", environment: "local" },
  tracing: { propagateTo: [new RegExp("^" + backend.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))] },
  replay: { enabled: params.get("noreplay") === null, maskAllInputs: true },
  debug: true,
});
window.rum = rum;

const out = document.getElementById("log");
const log = (...a) => {
  out.textContent += a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ") + "\n";
};
document.getElementById("session").textContent = `session: ${rum.session.id()} user: ${rum.session.userId()}`;

const on = (id, fn) => document.getElementById(id).addEventListener("click", fn);
on("btn-ok", () => fetch(`${backend}/api/products`).then((r) => log("products", r.status)));
on("btn-500", () => fetch(`${backend}/api/checkout?fail=500`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).then((r) => log("checkout", r.status)));
on("btn-slow", () => fetch(`${backend}/api/products?delay=1500`).then((r) => log("slow", r.status)));
on("btn-404", () => fetch(`${backend}/api/nope`).then((r) => log("404", r.status)));
on("btn-net", () => fetch("http://localhost:1/x").catch((e) => log("net", e.message)));
on("btn-throw", () => setTimeout(() => { throw new TypeError("playground uncaught"); }, 0));
on("btn-reject", () => Promise.reject(new Error("playground rejection")));
on("btn-capture", () => rum.captureError(new Error("playground handled"), { where: "playground" }));
on("btn-console", () => console.error("playground console.error", { code: 7 }));
on("btn-nav", () => history.pushState({}, "", "/cart"));
on("btn-event", () => rum.addEvent("cart.added", { sku: "sku-1", qty: 1 }));
on("btn-pause", () => { rum.replay.pause(); log("recording", rum.replay.isRecording()); });
on("btn-resume", () => { rum.replay.resume(); setTimeout(() => log("recording", rum.replay.isRecording()), 300); });
on("btn-flush", () => rum.flush().then(() => log("flushed")));

async function scenario() {
  log("scenario start", rum.session.id());
  await fetch(`${backend}/api/products`);
  await fetch(`${backend}/api/checkout?fail=500`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  await fetch(`${backend}/api/nope`);
  rum.captureError(new Error("scenario handled"), { where: "scenario" });
  console.error("scenario console.error");
  history.pushState({}, "", "/cart");
  rum.addEvent("cart.added", { sku: "sku-1", qty: 1 });
  setTimeout(() => { throw new TypeError("scenario uncaught"); }, 0);
  document.getElementById("name").value = "secret";
  document.getElementById("name").dispatchEvent(new Event("input", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 1200));
  await rum.flush();
  log("scenario done");
  document.title = "scenario-done";
}
on("btn-scenario", scenario);
if (params.get("auto") !== null) setTimeout(scenario, 500);
