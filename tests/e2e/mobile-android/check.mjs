// Asserts the React Native Android suite's launches (run.sh) against rum-api, with the check ids of
// docs/specs/mobile-sdk.md section 3, and prints the checks and the maturity row.
// Usage: node check.mjs <out dir>   (the env's variables set: deploy/envs/ouo-env env)
//
// `pending`: the work package whose merge makes the check pass on React Native Android; a pending
// check runs and reports without failing the run, and once it passes the run fails until `pending`
// is removed. None is pending since W9 part 2.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getJSON, GRAFANA, pollUntil, readHeaders, RUM, table, TEMPO_DS_UID } from "../lib.mjs";

const [out] = process.argv.slice(2);
const SERVICE = "mobile-store";
// `OUO_NOTE {...}` lines the conformance build logs (examples/ouo-mobile/src/rum.ts `note`).
const notes = readFileSync(join(out, "logcat.txt"), "utf8")
  .split("\n")
  .map((l) => l.match(/OUO_NOTE (\{.*\})\s*$/)?.[1])
  .filter(Boolean)
  .map((j) => JSON.parse(j));
const requests = readFileSync(join(out, "requests.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
// run.sh names every launch (`am start -e ouo_action <name>`); the early crash notes itself.
const launch = (action) => notes.find((n) => n.kind === "launch" && n.action === action);
const [main, tapRun, crash, hang, oom, offline, reject] = ["main", "taps", "crash", "hang", "oom", "offline", "reject"].map(launch);
const early = notes.find((n) => n.kind === "crash" && n.action === "crash-early");
const rotated = notes.find((n) => n.kind === "active" && n.ts > main.ts && n.ts < tapRun.ts && n.session !== main.session)?.session;
const noteAfter = (l, kind) => notes.find((n) => n.kind === kind && n.ts >= l.ts && n.session === l.session);

const detail = (id) => getJSON(`${RUM}/v1/sessions/${id}`).catch(() => null);
const named = (d, name) => (d?.timeline ?? []).filter((e) => e.name === name);
const attr = (e, key) => e?.attrs?.[key.replaceAll(".", "_")];
const lastEvents = (e) => {
  try {
    return JSON.parse(attr(e, "ouo.last_events") ?? "[]");
  } catch {
    return [];
  }
};
const hasContext = (e, screen) => attr(e, "app.screen.name") === screen && lastEvents(e).length > 0 && lastEvents(e).length <= 20;

async function traceSpans(traceId) {
  const body = await getJSON(`${GRAFANA}/api/datasources/proxy/uid/${TEMPO_DS_UID}/api/traces/${traceId}`).catch(() => null);
  return (body?.batches ?? body?.trace?.resourceSpans ?? body?.resourceSpans ?? []).flatMap((r) => {
    const service = r.resource?.attributes?.find((a) => a.key === "service.name")?.value?.stringValue;
    return (r.scopeSpans ?? []).flatMap((ss) =>
      (ss.spans ?? []).map((s) => ({
        service,
        name: s.name,
        attrs: Object.fromEntries((s.attributes ?? []).map((a) => [a.key, Object.values(a.value ?? {})[0]])),
      })),
    );
  });
}
const tracesOf = async (id) => Promise.all(((await detail(id))?.traces ?? []).map((t) => traceSpans(t.trace_id)));

let pixelReport = null;
/** Areas the app notes around a Text (examples/ouo-mobile `maskedArea`), left-aligned. */
const TEXT_AREAS = new Set(["product-price", "cart-total"]);
const CHECKS = {
  "C1.1": async () => {
    const [a, b] = await Promise.all([detail(main.session), detail(rotated)]);
    return a?.end_reason === "background" && Boolean(rotated) && attr(named(b, "session.start")[0], "session.previous_id") === main.session;
  },
  "C2.1": async () => {
    const d = await detail(main.session);
    const e = named(d, "exception").find((x) => attr(x, "exception.message") === "golden handled error");
    return d?.status === "errored" && attr(e, "ouo.exception.handled") === "true" && attr(e, "ouo.exception.fatal") === "false" && Boolean(attr(e, "exception.stacktrace")) && hasContext(e, "Cart");
  },
  "C2.2": async () => {
    const d = await detail(crash.session);
    const e = named(d, "exception").find((x) => attr(x, "ouo.exception.kind") === "native");
    const at = noteAfter(crash, "crash")?.ts;
    return (
      d?.status === "crashed" && d?.end_reason === "crash" && Math.abs(Date.parse(d.ended_at) - at) <= 1000 &&
      attr(e, "ouo.exception.fatal") === "true" && named(d, "session.start").length === 1 && hasContext(e, "Cart")
    );
  },
  // N52: nothing was exported before the crash; the session starts when it started, not at the crash.
  "C2.3": async () => {
    const d = await detail(early?.session);
    return d?.status === "crashed" && d?.end_reason === "crash" && Date.parse(d.started_at) <= early.ts && Math.abs(Date.parse(d.ended_at) - (early.ts + 200)) <= 1000;
  },
  "C3.1": async () => {
    const hs = named(await detail(hang.session), "exception").filter((x) => attr(x, "ouo.exception.kind") === "hang");
    return hs.length === 1 && Number(attr(hs[0], "ouo.hang.duration_ms")) >= 2000 && attr(hs[0], "ouo.exception.fatal") === "false" && hasContext(hs[0], "Cart");
  },
  "C3.2": async () => {
    const d = await detail(oom.session);
    const e = named(d, "exception").find((x) => attr(x, "ouo.exception.kind") === "termination");
    return d?.status === "crashed" && d?.end_reason === "crash" && attr(e, "ouo.exception.fatal") === "true" && Boolean(attr(e, "ouo.termination.cause"));
  },
  "C4.1": async () => {
    const v = await getJSON(`${RUM}/v1/sessions/${main.session}/vitals`).catch(() => null);
    const s = v?.summary ?? {};
    const screens = (v?.vitals ?? []).filter((x) => x.name === "ouo.screen.display");
    return (
      s.app_start?.type === "cold" &&
      s.app_start.duration_ms > 0 &&
      screens.map((x) => x.screen).join(",") === "Products,Product,Cart" &&
      screens.every((x) => x.values?.ttid_ms > 0) &&
      s.frames?.total > 0
    );
  },
  "C4.2": async () => {
    const v = await getJSON(`${RUM}/v1/sessions/${main.session}/vitals`).catch(() => null);
    const first = (v?.vitals ?? []).find((x) => x.name === "ouo.screen.display");
    return first?.values?.ttfd_ms > 0;
  },
  "C5.1": async () =>
    (await tracesOf(main.session)).some(
      (spans) => spans.some((s) => s.service === SERVICE && s.attrs["http.request.method"] === "GET") && spans.some((s) => s.service !== SERVICE && s.attrs["session.id"] === main.session),
    ),
  "C6.1": async () => {
    const taps = named(await detail(tapRun.session), "ui.tap");
    const want = [
      ["product-p-1002", "tap", "Products"],
      ["btn-Add to cart", "long_press", "Product"],
      ["cart-items", "swipe", "Cart"],
    ];
    let i = 0;
    for (const t of taps) {
      const [target, gesture, screen] = want[i] ?? [];
      if (attr(t, "ouo.ui.target") === target && attr(t, "ouo.ui.gesture") === gesture && attr(t, "app.screen.name") === screen && attr(t, "ouo.ui.view_type")) i++;
    }
    return i === want.length;
  },
  "C7.1": async () => {
    const nav = named(await detail(main.session), "navigation");
    const res = await fetch(`${RUM}/v1/funnels/query`, {
      method: "POST",
      headers: { ...readHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ steps: ["/Products", "/Product", "/Cart"].map((value) => ({ kind: "page", value })), from: String(main.ts - 60_000), to: "now", filters: { service: SERVICE, platform: "mobile" } }),
    });
    const counts = res.ok ? ((await res.json()).steps ?? []).map((s) => s.sessions) : [];
    return nav.map((e) => attr(e, "url.path")).slice(0, 3).join(" ") === "/Products /Product /Cart" && nav.every((e) => attr(e, "ouo.navigation.kind") === "screen") && counts[2] >= 1;
  },
  "C8.1": async () => {
    const [a, b] = await Promise.all([detail(main.session), detail(rotated)]);
    return a?.replay_kind === "frames" && b?.replay_kind === "frames";
  },
  // The chunk says masked, and the pixels agree: every area the app noted (product image and price,
  // cart total, feedback input) is black in the frame shown before the next screen.
  "C8.2": async () => {
    const meta = await getJSON(`${RUM}/v1/sessions/${main.session}/replay`).catch(() => null);
    const frames = await getJSON(`${RUM}/v1/sessions/${main.session}/replay/frames`).catch(() => null);
    const navs = named(await detail(main.session), "navigation").map((e) => Date.parse(e.ts));
    // The first note per view: the journey notes each screen's views while that screen is on top
    // (a stack keeps the screens below mounted, so later notes measure covered views).
    const areas = [...new Map(notes.filter((n) => n.kind === "area" && n.session === main.session).reverse().map((n) => [n.name, n])).values()];
    if (meta?.masked !== true || frames?.platform !== "android" || areas.length < 4) return false;
    const file = join(out, "frames.json");
    writeFileSync(file, JSON.stringify(frames));
    pixelReport = areas.map((a) => {
      const until = (navs.find((t) => t > a.ts) ?? a.ts + 5000) - 1;
      // The centre half of a block, and the first 24 dp of a text view's line: text is masked per
      // line, so the rest of a wide Text stays white; unmasked glyphs leave light pixels there.
      const rect = (TEXT_AREAS.has(a.name) ? [a.x + 2, a.y + a.h / 4, 24, a.h / 2] : [a.x + a.w / 4, a.y + a.h / 4, a.w / 2, a.h / 2]).join(",");
      const [mean] = JSON.parse(execFileSync(join(out, "pixels"), [file, String(until), rect]).toString());
      return { name: a.name, mean };
    });
    return pixelReport.every((r) => r.mean >= 0 && r.mean < 0.15);
  },
  "C8.3": async () => {
    const meta = await getJSON(`${RUM}/v1/sessions/${crash.session}/replay`).catch(() => null);
    const at = noteAfter(crash, "crash")?.ts;
    const end = Number(meta?.ended_at) || Date.parse(meta?.ended_at ?? "");
    return meta?.kind === "frames" && Math.abs(end - at) <= 1500;
  },
  "C9.1": async () => {
    const d = await detail(main.session);
    const trace = (d?.traces ?? []).find((t) => t.root_name === "golden.checkout");
    const logs = await getJSON(`${RUM}/v1/sessions/${main.session}/logs`).catch(() => null);
    return Boolean(trace && trace.span_count >= 2) && (logs?.logs ?? []).some((l) => l.body === "golden log line");
  },
  // The record, the steps before it, and the replay around it (a frame at or before it and one after).
  "C10.1": async () => {
    const note = noteAfter(main, "feedback");
    const f = named(await detail(main.session), "feedback")[0];
    const steps = lastEvents(f).map((e) => `${e.name}|${e.body}`);
    const frames = (await getJSON(`${RUM}/v1/sessions/${main.session}/replay/frames`).catch(() => null))?.frames ?? [];
    const at = Date.parse(f?.ts ?? "");
    return (
      Boolean(note?.id) &&
      attr(f, "ouo.feedback.id") === note.id &&
      attr(f, "ouo.feedback.message") === "golden feedback" &&
      attr(f, "ouo.feedback.contact") === "qa@example.invalid" &&
      String(attr(f, "ouo.feedback.screenshot")) === "true" &&
      steps.some((s) => s === "log|golden log line") &&
      steps.some((s) => s.includes("golden handled error")) &&
      frames.some((x) => Number(x.ts) <= at) &&
      frames.some((x) => Number(x.ts) > at)
    );
  },
  "C11.1": async () => named(await detail(offline.session), "offline-step").length === 1,
  "C11.2": async () => {
    const otlp = requests.filter((r) => /\/v1\/(logs|traces)$/.test(r.path));
    return otlp.length > 0 && otlp.every((r) => r.encoding === "gzip");
  },
  // The 500 is sent once and dropped, the 503 again until it arrives, and the step after them is in rum-api.
  "C11.3": async () => {
    const sends = (h) => requests.filter((r) => r.body === h);
    const poison = requests.find((r) => r.injected && r.status === 500)?.body;
    const flaky = requests.find((r) => r.injected && r.status === 503)?.body;
    return (
      Boolean(poison && flaky) && sends(poison).length === 1 && sends(flaky).length >= 2 && sends(flaky).at(-1).status === 200 &&
      named(await detail(reject.session), "reject-step").length === 1
    );
  },
};

const rows = [];
const levels = {};
let failed = false;
for (const [id, def] of Object.entries(CHECKS)) {
  const { pending, run } = typeof def === "function" ? { run: def } : def;
  let result;
  if (!run) {
    result = "not run";
  } else {
    const pass = await pollUntil(id, async () => ({ done: Boolean(await run()), value: true }), Number(process.env.OUO_CHECK_WAIT ?? (pending ? 20 : 120))).catch(() => false);
    result = pass ? "pass" : "FAIL";
    if (!pending && !pass) failed = true;
    if (pending && pass) {
      failed = true;
      result = "pass (remove pending)";
    }
  }
  rows.push({ check: id, result, pending: pending ?? "" });
  const cap = id.split(".")[0];
  (levels[cap] ??= []).push(result === "pass" ? 2 : result === "not run" ? 0 : 1);
}
// L2 when every check passes; L1 when one ran (records exist, a check fails or has no harness); L0 when none ran.
for (const [cap, ls] of Object.entries(levels)) levels[cap] = ls.every((l) => l === 2) ? "L2" : ls.some((l) => l > 0) ? "L1" : "L0";
table(rows);
if (pixelReport) console.log("C8.2 pixels (mean brightness, black < 0.15):", pixelReport);
console.log("maturity (React Native Android, manual suite):", Object.entries(levels).map(([c, l]) => `${c} ${l}`).join(", "));
console.log({ main: main?.session, rotated, taps: tapRun?.session, crash: crash?.session, early: early?.session, hang: hang?.session, oom: oom?.session, offline: offline?.session, reject: reject?.session });
process.exit(failed ? 1 : 0);
