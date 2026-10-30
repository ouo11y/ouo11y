// Reads back the runs of w8-native-sim.sh from rum-api (and the backend span from Tempo through
// Grafana) and prints one row per conformance check it mirrors. Usage: node w8-native-sim-check.mjs <w8.jsonl>
import { readFileSync } from "node:fs";
import { getJSON, GRAFANA, pollUntil, RUM, table } from "../../../../tests/e2e/lib.mjs";

const notes = readFileSync(process.argv[2], "utf8").trim().split("\n").map((l) => JSON.parse(l));
const launches = notes.filter((n) => n.kind === "launch").map((n) => n.session);
const [journey, hang, crash, , oom, , offline] = launches;
// The session after the background stay: the last "active" note before the second launch.
const secondLaunchAt = notes.find((n) => n.kind === "launch" && n.session === hang).ts;
const rotated = notes.filter((n) => n.kind === "active" && n.ts < secondLaunchAt).at(-1)?.session;

const detail = (id) => getJSON(`${RUM}/v1/sessions/${id}`).catch(() => null);
const named = (d, name) => (d?.timeline ?? []).filter((e) => e.name === name);
const attr = (e, key) => e?.attrs?.[key.replaceAll(".", "_")];
const lastEvents = (e) => { try { return JSON.parse(attr(e, "ouo.last_events") ?? "[]"); } catch { return []; } };

async function backendJoined(d, session) {
  for (const t of d?.traces ?? []) {
    const body = await getJSON(`${GRAFANA}/api/datasources/proxy/uid/tempo/api/traces/${t.trace_id}`).catch(() => null);
    const spans = (body?.batches ?? body?.resourceSpans ?? []).flatMap((r) => {
      const service = r.resource?.attributes?.find((a) => a.key === "service.name")?.value?.stringValue;
      return (r.scopeSpans ?? []).flatMap((ss) => (ss.spans ?? []).map((s) => ({ service, attrs: Object.fromEntries((s.attributes ?? []).map((a) => [a.key, Object.values(a.value ?? {})[0]])) })));
    });
    if (spans.some((s) => s.service === "w8-native-sim") && spans.some((s) => s.service !== "w8-native-sim" && s.attrs["session.id"] === session)) return true;
  }
  return false;
}

const checks = {
  "C1.1 background rotation": async () => {
    const [a, b] = await Promise.all([detail(journey), detail(rotated)]);
    return a?.end_reason === "background" && rotated !== journey && attr(named(b, "session.start")[0], "session.previous_id") === journey;
  },
  "C1 app.lifecycle": async () => {
    const [a, b] = await Promise.all([detail(journey), detail(rotated)]);
    return named(a, "app.lifecycle").some((e) => attr(e, "ouo.app.state") === "background") && named(b, "app.lifecycle").some((e) => attr(e, "ouo.app.state") === "foreground");
  },
  "C2.1 handled error with context": async () => {
    const d = await detail(journey);
    const e = named(d, "exception").find((x) => attr(x, "exception.message") === "golden handled error");
    return d?.status === "errored" && attr(e, "ouo.exception.handled") === "true" && attr(e, "app.screen.name") === "Cart" && lastEvents(e).length > 0 && Boolean(attr(e, "ouo.memory.app_bytes"));
  },
  "C2.2 native crash on the next launch": async () => {
    const d = await detail(crash);
    const e = named(d, "exception").find((x) => attr(x, "ouo.exception.kind") === "native");
    const at = notes.find((n) => n.kind === "crash")?.ts;
    return d?.status === "crashed" && d?.end_reason === "crash" && Math.abs(Date.parse(d?.ended_at) - at) <= 1000 && attr(e, "ouo.exception.fatal") === "true" && attr(e, "app.screen.name") === "Home" && lastEvents(e).length > 0;
  },
  "C3.1 one hang >= 2 s on Cart": async () => {
    const d = await detail(hang);
    const hs = named(d, "exception").filter((x) => attr(x, "ouo.exception.kind") === "hang");
    return hs.length === 1 && Number(attr(hs[0], "ouo.hang.duration_ms")) >= 2000 && attr(hs[0], "ouo.exception.fatal") === "false" && attr(hs[0], "app.screen.name") === "Cart";
  },
  "C3.2 memory termination": async () => {
    const d = await detail(oom);
    const e = named(d, "exception").find((x) => attr(x, "ouo.exception.kind") === "termination");
    return d?.status === "crashed" && d?.end_reason === "crash" && attr(e, "ouo.termination.cause") === "memory";
  },
  "C4 app start, TTID, TTFD, frames": async () => {
    const d = await detail(journey);
    const displays = named(d, "ouo.screen.display");
    const products = displays.find((e) => attr(e, "app.screen.name") === "Products");
    return attr(named(d, "ouo.app.start")[0], "ouo.app.start.type") === "cold" && displays.length >= 3 && Boolean(attr(products, "ouo.screen.ttfd_ms")) && named(d, "app.jank").length > 0;
  },
  "C5.1 backend span joins the trace": async () => backendJoined(await detail(journey), journey),
  "C7 navigation": async () => {
    const d = await detail(journey);
    return named(d, "navigation").map((e) => attr(e, "url.path")).join(" ") === "/Home /Products /Cart";
  },
  "C11.1 offline run delivered": async () => named(await detail(offline), "offline-step").length === 1,
};

const rows = [];
let ok = true;
for (const [name, check] of Object.entries(checks)) {
  const pass = await pollUntil(name, async () => ({ done: Boolean(await check()), value: true }), 90).catch(() => false);
  rows.push({ check: name, result: pass ? "pass" : "FAIL" });
  ok &&= Boolean(pass);
}
table(rows);
console.log({ journey, rotated, hang, crash, oom, offline });
process.exit(ok ? 0 : 1);
