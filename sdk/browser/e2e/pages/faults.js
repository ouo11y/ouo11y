// A page whose own code fails in every way a page can (e2e/faults.spec.ts). Everything the page
// observes goes to window.transcript; the spec runs the same steps with and without the SDK and
// expects the same transcript. ?sdk=0 skips the SDK, ?collector=<port> points it elsewhere.
const q = new URLSearchParams(location.search);
const transcript = (window.transcript = []);
const out = document.getElementById("out");
const log = (line) => {
  transcript.push(line);
  const li = document.createElement("li");
  li.textContent = line;
  out.appendChild(li);
};
const msg = (e) => (e && e.message) || String(e);

// The page's own error handlers, installed before the SDK as most apps do.
window.onerror = (message, _src, _line, _col, err) => {
  log(`onerror: ${msg(err ?? message)}`);
  return true; // handled: the browser does not log it
};
window.onunhandledrejection = (e) => {
  log(`onunhandledrejection: ${msg(e.reason)}`);
  e.preventDefault();
};
window.addEventListener("error", (e) => {
  if (e.target === window) log(`error listener: ${msg(e.error ?? e.message)}`);
});

if (q.get("sdk") !== "0") {
  const { initRUM } = await import("/dist/index.js");
  window.rum = initRUM({
    endpoint: `http://localhost:${q.get("collector") ?? 4181}`,
    projectId: "e2e",
    projectToken: "pt_e2e",
    service: { name: "e2e-faults", version: "1.0.0", environment: "e2e" },
    tracing: { idleTimeoutMs: 200 },
    replay: { enabled: true, flushIntervalMs: 500 },
  });
}

const on = (id, fn) => document.getElementById(id).addEventListener("click", fn);

on("throw-handler", () => {
  log("first listener");
  throw new Error("handler boom");
});
on("throw-handler", () => log("second listener ran"));

on("fetch-then-throw", () => {
  fetch("/api/ok?n=1").then((res) => {
    log(`fetch status ${res.status}`);
    throw new Error("fetch callback boom");
  });
});

on("fetch-read", async () => {
  const res = await fetch("/api/read?x=1", { headers: { "x-page": "1" } });
  const body = await res.json();
  log(`read ${res.ok} ${res.status} ${res.headers.get("content-type")} ${body.path} bodyUsed=${res.bodyUsed}`);
  const clone = (await fetch("/api/read?x=2")).clone();
  log(`clone ${(await clone.json()).path}`);
});

on("fetch-fail", () => {
  fetch("http://localhost:9/nowhere").then(
    () => log("fetch to nowhere resolved"),
    (e) => log(`fetch rejected ${e.name}`),
  );
});

on("xhr-throw", () => {
  const xhr = new XMLHttpRequest();
  xhr.open("GET", "/api/xhr");
  xhr.onload = () => {
    log(`xhr ${xhr.status} ${JSON.parse(xhr.responseText).path}`);
    throw new Error("xhr onload boom");
  };
  xhr.send();
});

on("push", () => {
  const r = history.pushState({ n: 1 }, "", "/faults/1");
  log(`push returned ${r} ${location.pathname} state=${history.state.n}`);
  history.replaceState({ n: 2 }, "", "/faults/2");
  log(`replace ${location.pathname} state=${history.state.n}`);
});

on("push-bad", () => {
  try {
    history.pushState({}, "", "https://elsewhere.example/x");
    log("cross-origin push did not throw");
  } catch (e) {
    log(`push threw ${e.name}`);
  }
});

on("reject", () => {
  Promise.reject(new Error("unhandled boom"));
});

on("timer-throw", () => {
  setTimeout(() => {
    throw new Error("timer boom");
  }, 0);
});

document.getElementById("link").addEventListener("click", (e) => {
  e.preventDefault();
  log(`link prevented ${e.defaultPrevented}`);
});

on("console", () => {
  log(`console.error returned ${console.error("page console error", 1)}`);
});

on("storage", () => {
  try {
    localStorage.setItem("app.key", "v");
    log(`storage ok ${localStorage.getItem("app.key")}`);
  } catch (e) {
    log(`storage threw ${e.name}`);
  }
});

window.addEventListener("popstate", () => log(`popstate ${location.pathname}`));
document.getElementById("status").textContent = "ready";
