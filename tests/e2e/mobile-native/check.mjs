// Asserts the native iOS suite's launches (run.sh) against rum-api, with the check ids of
// docs/specs/mobile-sdk.md section 3, and prints the checks and the maturity row.
// Usage: node check.mjs <out dir>   (the env's variables set: deploy/envs/ouo-env env)
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getJSON, GRAFANA, pollUntil, readHeaders, RUM, table } from "../lib.mjs";

const [out] = process.argv.slice(2);
const SERVICE = "ouo-ios-example";
const notes = readFileSync(join(out, "journey.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const requests = readFileSync(join(out, "requests.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
const launches = notes.filter((n) => n.kind === "launch");
const [main, tapRun, ...rest] = launches;
const [hang, crash, , early, , oom, , offline] = rest;
const rotated = notes.filter((n) => n.kind === "active" && n.ts < tapRun.ts).at(-1)?.session;
const noteAfter = (l, kind) => notes.find((n) => n.kind === kind && n.ts >= l.ts && n.session === l.session);

const detail = (id) => getJSON(`${RUM}/v1/sessions/${id}`).catch(() => null);
const named = (d, name) => (d?.timeline ?? []).filter((e) => e.name === name);
const attr = (e, key) => e?.attrs?.[key.replaceAll(".", "_")];
const lastEvents = (e) => { try { return JSON.parse(attr(e, "ouo.last_events") ?? "[]"); } catch { return []; } };
const hasContext = (e, screen) => attr(e, "app.screen.name") === screen && lastEvents(e).length > 0 && lastEvents(e).length <= 20;

async function traceSpans(traceId) {
  const body = await getJSON(`${GRAFANA}/api/datasources/proxy/uid/tempo/api/traces/${traceId}`).catch(() => null);
  return (body?.batches ?? body?.resourceSpans ?? []).flatMap((r) => {
    const service = r.resource?.attributes?.find((a) => a.key === "service.name")?.value?.stringValue;
    return (r.scopeSpans ?? []).flatMap((ss) => (ss.spans ?? []).map((s) => ({
      service, name: s.name, kind: s.kind, spanId: s.spanId, parentSpanId: s.parentSpanId,
      attrs: Object.fromEntries((s.attributes ?? []).map((a) => [a.key, Object.values(a.value ?? {})[0]])),
    })));
  });
}
const tracesOf = async (id) => Promise.all(((await detail(id))?.traces ?? []).map((t) => traceSpans(t.trace_id)));

const CHECKS = {
  "C1.1": async () => {
    const [a, b] = await Promise.all([detail(main.session), detail(rotated)]);
    return a?.end_reason === "background" && rotated !== main.session && attr(named(b, "session.start")[0], "session.previous_id") === main.session;
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
    return d?.status === "crashed" && d?.end_reason === "crash" && Math.abs(Date.parse(d.ended_at) - at) <= 1000 &&
      attr(e, "ouo.exception.fatal") === "true" && named(d, "session.start").length === 1 && hasContext(e, "Home");
  },
  "C2.3": async () => {
    const d = await detail(early.session);
    const at = noteAfter(early, "crash")?.ts;
    return d?.status === "crashed" && d?.end_reason === "crash" && Date.parse(d.started_at) <= early.ts && Math.abs(Date.parse(d.ended_at) - at) <= 1000;
  },
  "C3.1": async () => {
    const hs = named(await detail(hang.session), "exception").filter((x) => attr(x, "ouo.exception.kind") === "hang");
    return hs.length === 1 && Number(attr(hs[0], "ouo.hang.duration_ms")) >= 2000 && attr(hs[0], "ouo.exception.fatal") === "false" && attr(hs[0], "app.screen.name") === "Cart";
  },
  "C3.2": async () => {
    const d = await detail(oom.session);
    const e = named(d, "exception").find((x) => attr(x, "ouo.exception.kind") === "termination");
    return d?.status === "crashed" && d?.end_reason === "crash" && Boolean(attr(e, "ouo.termination.cause"));
  },
  "C4.1": async () => {
    const d = await detail(main.session);
    const screens = named(d, "ouo.screen.display").filter((e) => attr(e, "ouo.screen.ttid_ms")).map((e) => attr(e, "app.screen.name"));
    return attr(named(d, "ouo.app.start")[0], "ouo.app.start.type") === "cold" && Number(attr(named(d, "ouo.app.start")[0], "ouo.app.start.duration_ms")) > 0 &&
      screens.join(" ") === "Home Products Cart" && named(d, "app.jank").some((e) => Number(attr(e, "ouo.frames.total")) > 0);
  },
  "C4.2": async () => Number(attr(named(await detail(main.session), "ouo.screen.display").find((e) => attr(e, "app.screen.name") === "Home"), "ouo.screen.ttfd_ms")) > 0,
  "C5.1": async () => (await tracesOf(main.session)).some((spans) =>
    spans.some((s) => s.service === SERVICE && s.attrs["http.request.method"] === "GET") && spans.some((s) => s.service !== SERVICE && s.attrs["session.id"] === main.session)),
  "C6.1": async () => {
    const ts = named(await detail(tapRun.session), "ui.tap");
    const want = [["open-products", "tap", "Home"], ["checkout", "long_press", "Cart"], ["cart-items", "swipe", "Cart"]];
    let i = 0;
    for (const t of ts) {
      const [target, gesture, screen] = want[i] ?? [];
      if (attr(t, "ouo.ui.target") === target && attr(t, "ouo.ui.gesture") === gesture && attr(t, "app.screen.name") === screen && attr(t, "ouo.ui.view_type")) i++;
    }
    return i === want.length;
  },
  "C7.1": async () => {
    const d = await detail(main.session);
    const nav = named(d, "navigation");
    const res = await fetch(`${RUM}/v1/funnels/query`, {
      method: "POST",
      headers: { ...readHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ steps: ["/Home", "/Products", "/Cart"].map((value) => ({ kind: "page", value })), from: String(main.ts - 60_000), to: "now", filters: { service: SERVICE, platform: "mobile" } }),
    });
    const counts = res.ok ? ((await res.json()).steps ?? []).map((s) => s.sessions) : [];
    return nav.map((e) => attr(e, "url.path")).slice(0, 3).join(" ") === "/Home /Products /Cart" && nav.every((e) => attr(e, "ouo.navigation.kind") === "screen") && counts[2] >= 1;
  },
  "C8.1": async () => {
    const [a, b] = await Promise.all([detail(main.session), detail(rotated)]);
    return a?.replay_kind === "frames" && b?.replay_kind === "frames";
  },
  // The chunk says masked, and the pixels agree: every area the app noted (UIKit text, an input, SwiftUI
  // text, a SwiftUI image, a SwiftUI toolbar title) is black in the frame shown before the next screen.
  "C8.2": async () => {
    const meta = await getJSON(`${RUM}/v1/sessions/${main.session}/replay`).catch(() => null);
    const frames = await getJSON(`${RUM}/v1/sessions/${main.session}/replay/frames`).catch(() => null);
    const navs = named(await detail(main.session), "navigation").map((e) => Date.parse(e.ts));
    const areas = notes.filter((n) => n.kind === "area" && n.session === main.session);
    if (meta?.masked !== true || !frames || areas.length < 5) return false;
    const file = join(out, "frames.json");
    writeFileSync(file, JSON.stringify(frames));
    const results = areas.map((a) => {
      const until = (navs.find((t) => t > a.ts) ?? a.ts + 5000) - 1;
      // The centre half of the area: unmasked content leaves white there (a label's or an image's
      // layout frame is wider than what it draws), a mask does not.
      const rect = [a.x + a.w / 4, a.y + a.h / 4, a.w / 2, a.h / 2].join(",");
      const [mean] = JSON.parse(execFileSync(join(out, "pixels"), [file, String(until), rect]).toString());
      return { name: a.name, mean };
    });
    pixelReport = results;
    return results.every((r) => r.mean >= 0 && r.mean < 0.15);
  },
  "C8.3": async () => {
    const meta = await getJSON(`${RUM}/v1/sessions/${crash.session}/replay`).catch(() => null);
    const at = noteAfter(crash, "crash")?.ts;
    const end = Number(meta?.ended_at) || Date.parse(meta?.ended_at ?? "");
    return meta?.kind === "frames" && Math.abs(end - at) <= 1500;
  },
  "C9.1": async () => {
    const spans = (await tracesOf(main.session)).find((s) => s.some((x) => x.name === "checkout")) ?? [];
    const root = spans.find((x) => x.name === "checkout");
    const logs = await getJSON(`${RUM}/v1/sessions/${main.session}/logs`).catch(() => null);
    return Boolean(root) && spans.some((x) => x.kind === 3 || x.kind === "SPAN_KIND_CLIENT" ? x.parentSpanId === root.spanId : false) &&
      (logs?.logs ?? []).some((l) => l.body === "golden log line");
  },
  // The record, the steps before it (ending with the journey's last ones), and the replay around it.
  "C10.1": async () => {
    const note = noteAfter(main, "feedback");
    const f = named(await detail(main.session), "feedback")[0];
    const steps = lastEvents(f).map((e) => `${e.name} ${e.body}`);
    const frames = (await getJSON(`${RUM}/v1/sessions/${main.session}/replay/frames`).catch(() => null))?.frames ?? [];
    const at = Date.parse(f?.ts ?? "");
    return Boolean(note?.id) && attr(f, "ouo.feedback.id") === note.id && attr(f, "ouo.feedback.message") === "golden feedback" &&
      attr(f, "ouo.feedback.contact") === "ada@example.com" && attr(f, "ouo.feedback.screenshot") === "true" &&
      // The journey's last steps before it: the error and the log line of the checkout (its request may answer after).
      steps.slice(-3).some((s) => s.startsWith("log golden log line")) && steps.some((s) => s.includes("golden handled error")) &&
      frames.some((x) => Number(x.ts) <= at) && frames.some((x) => Number(x.ts) > at);
  },
  "C11.1": async () => named(await detail(offline.session), "offline-step").length === 1,
  "C11.2": async () => {
    const otlp = requests.filter((r) => /\/v1\/(logs|traces)$/.test(r.path));
    return otlp.length > 0 && otlp.every((r) => r.encoding === "gzip");
  },
};

let pixelReport = null;
const rows = [];
const levels = {};
for (const [id, check] of Object.entries(CHECKS)) {
  const pass = await pollUntil(id, async () => ({ done: Boolean(await check()), value: true }), Number(process.env.OUO_CHECK_WAIT ?? 120)).catch(() => false);
  rows.push({ check: id, result: pass ? "pass" : "FAIL" });
  const cap = id.split(".")[0];
  levels[cap] = levels[cap] === "L1" || pass !== true ? "L1" : "L2";
}
table(rows);
if (pixelReport) console.log("C8.2 pixels (mean brightness, black < 0.15):", pixelReport);
console.log("maturity (native iOS, manual suite):", Object.entries(levels).map(([c, l]) => `${c} ${l}`).join(", "));
console.log({ main: main.session, rotated, taps: tapRun.session, hang: hang.session, crash: crash.session, early: early.session, oom: oom.session, offline: offline.session });
process.exit(rows.some((r) => r.result === "FAIL") ? 1 : 0);
