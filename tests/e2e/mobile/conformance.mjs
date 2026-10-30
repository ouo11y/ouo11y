#!/usr/bin/env node
// Mobile SDK conformance suite for React Native on iOS (docs/specs/mobile-sdk.md, ADR-0015).
//
// 1. Runs the golden app: launches of the built @ouo11y/react-native bundle under the native
//    stand-in (launch.cjs, standin.cjs), one "device" (storage, crash file) per journey:
//      main       Home -> Products -> Cart, a tap, a long press and a swipe, request in a custom span, log, handled error,
//                 feedback, main-thread block, background rotation
//      crash      native crash after the first export, then the next launch
//      early      native crash 200 ms after launch, then the next launch
//      terminate  a memory warning, killed in the foreground without a report, then the next launch
//      offline    a launch with the collector refused, then the next launch online
// 2. Asserts every check of the spec against rum-api (and the stand-in's request log for the
//    wire checks), polling until the required checks pass or OUO_E2E_TIMEOUT runs out.
// 3. Prints one line per check and the maturity row of React Native iOS (L0-L2; L3 also needs
//    the B3 gate, docs/benchmarks.md). Exit 1 when a required check fails, or when a pending
//    check passes (the package that made it pass removes `pending`, so the check stays required).
//
// Needs the SDK bundle (npm run -w sdk/react-native build) and an env with the demo backend.
// Env: the variables of tests/e2e/lib.mjs, OUO_BACKEND_URL (default http://localhost:8081),
// OUO_E2E_TIMEOUT (default 180 s). Flags: --out <file> writes the result as JSON.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GRAFANA, OTLP, PROJECT_ID, PROJECT_TOKEN, READ_TOKEN, REPLAY, RUM, TEMPO_DS_UID, TIMEOUT_S, getJSON, readHeaders, sleep, table } from "../lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLE = join(HERE, "../../../sdk/react-native/dist/index.js");
const BACKEND = (process.env.OUO_BACKEND_URL ?? "http://localhost:8081").replace(/\/$/, "");
const RUN_ID = Date.now().toString(36);
const SERVICE = `qa-rn-ios-${RUN_ID}`;
const T0 = Date.now();
const args = process.argv.slice(2);
const OUT_FILE = args.includes("--out") ? args[args.indexOf("--out") + 1] : undefined;

// ---------------------------------------------------------------- the golden app

const DEVICES = {
  main: ["main"],
  crash: ["crash", "relaunch"],
  early: ["early-crash", "relaunch"],
  terminate: ["terminate", "relaunch"],
  offline: ["offline", "relaunch"],
};

function launch(dir, name, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--require", "./standin.cjs", "launch.cjs"], {
      cwd: HERE,
      env: {
        ...process.env,
        OUO_OTLP_URL: OTLP,
        OUO_REPLAY_URL: REPLAY,
        OUO_PROJECT_ID: PROJECT_ID,
        OUO_PROJECT_TOKEN: PROJECT_TOKEN,
        OUO_BACKEND_URL: BACKEND,
        OUO_E2E_SERVICE: SERVICE,
        OUO_E2E_LAUNCH: name,
        OUO_E2E_DEVICE_DIR: dir,
        OUO_E2E_COLLECTOR_ORIGINS: `${OTLP},${REPLAY}`,
        OUO_STORAGE_FILE: join(dir, "async-storage.json"),
        ...extraEnv,
      },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => {
      const line = out.split("\n").find((l) => l.startsWith("GOLDEN "));
      if (code !== 0 || !line) return reject(new Error(`launch ${name} exited ${code}:\n${out.slice(-2000)}`));
      resolve(JSON.parse(line.slice("GOLDEN ".length)));
    });
  });
}

async function runGoldenApp() {
  const root = mkdtempSync(join(tmpdir(), "ouo-conformance-"));
  const golden = { root };
  for (const [device, launches] of Object.entries(DEVICES)) {
    const dir = join(root, device);
    mkdirSync(dir, { recursive: true });
    golden[device] = { dir, launches: [] };
    for (const name of launches) {
      const r = await launch(dir, name, device === "offline" && name === "offline" ? { OUO_E2E_OFFLINE: "1" } : {});
      golden[device].launches.push(r);
    }
    golden[device].log = readFileSync(join(dir, "standin.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    console.log(`golden ${device}: ${golden[device].launches.map((l) => `${l.launch}=${l.session}`).join(" ")}`);
  }
  return golden;
}

// ---------------------------------------------------------------- rum-api reads

const detail = (id) => getJSON(`${RUM}/v1/sessions/${id}`).catch(() => null);
const named = (d, name) => (d?.timeline ?? []).filter((e) => e.name === name);
const attr = (e, key) => e?.attrs?.[key.replaceAll(".", "_")];

/** service.name of every span of a trace and the attributes of the backend's spans, via Grafana's Tempo proxy. */
async function traceSpans(traceId) {
  const body = await getJSON(`${GRAFANA}/api/datasources/proxy/uid/${TEMPO_DS_UID}/api/traces/${traceId}`);
  const spans = [];
  for (const r of body.batches ?? body.trace?.resourceSpans ?? body.resourceSpans ?? []) {
    const service = r.resource?.attributes?.find((a) => a.key === "service.name")?.value?.stringValue;
    for (const ss of r.scopeSpans ?? r.instrumentationLibrarySpans ?? []) {
      for (const s of ss.spans ?? []) {
        const attrs = Object.fromEntries((s.attributes ?? []).map((a) => [a.key, Object.values(a.value ?? {})[0]]));
        spans.push({ service, name: s.name, kind: s.kind, attrs });
      }
    }
  }
  return spans;
}

const result = (ok, seen, detail) => ({ ok: Boolean(ok), seen: Boolean(seen || ok), detail });

/** Error context (spec C2): the screen of the error and the session's last events before it. */
function hasContext(e, screen) {
  let events = [];
  try {
    events = JSON.parse(attr(e, "ouo.last_events") ?? "[]");
  } catch {}
  return attr(e, "app.screen.name") === screen && events.length > 0 && events.length <= 20;
}

// ---------------------------------------------------------------- the checks (spec section 3)

// `pending`: the work package whose merge makes the check pass on React Native iOS; until then
// the check runs and reports but does not fail the run. That package deletes the field.
const CHECKS = [
  {
    id: "C1.1",
    title: "background longer than the timeout: two sessions linked by session.previous_id",
    async run(g) {
      const { session, second } = g.main.launches[0];
      const [a, b] = await Promise.all([detail(session), detail(second)]);
      const start = named(b, "session.start")[0];
      return result(
        a?.end_reason === "background" && a?.state === "ended" && attr(start, "session.previous_id") === session,
        named(a, "session.start").length > 0,
        { first: a && { end_reason: a.end_reason, state: a.state }, second_previous_id: attr(start, "session.previous_id") ?? null },
      );
    },
  },
  {
    id: "C2.1",
    title: "a handled error is an exception (handled, not fatal) with its context, and the session is errored",
    async run(g) {
      const d = await detail(g.main.launches[0].session);
      const e = named(d, "exception").find((x) => attr(x, "exception.message") === "golden handled error");
      return result(
        d?.status === "errored" &&
          attr(e, "ouo.exception.handled") === "true" &&
          attr(e, "ouo.exception.fatal") === "false" &&
          Boolean(attr(e, "exception.stacktrace")) &&
          hasContext(e, "Cart"),
        e,
        { status: d?.status ?? null, exception: e?.attrs ?? null },
      );
    },
  },
  {
    id: "C2.2",
    title: "a native crash is a fatal exception on the next launch; the session is crashed and ends at the crash time",
    async run(g) {
      const crashed = g.crash.launches[0].session;
      const at = g.crash.log.find((x) => x.kind === "os.crash")?.ts;
      const d = await detail(crashed);
      const e = named(d, "exception").find((x) => attr(x, "ouo.exception.kind") === "native");
      const endsAtCrash = d?.ended_at && Math.abs(Date.parse(d.ended_at) - at) <= 1000;
      return result(
        d?.status === "crashed" &&
          d?.end_reason === "crash" &&
          endsAtCrash &&
          attr(e, "ouo.exception.fatal") === "true" &&
          named(d, "session.start").length === 1 &&
          hasContext(e, "Home"),
        e,
        { status: d?.status ?? null, end_reason: d?.end_reason ?? null, ended_at: d?.ended_at ?? null, crash_at: at && new Date(at).toISOString() },
      );
    },
  },
  {
    id: "C2.3",
    title: "a native crash in the first second keeps the session's start and ends it at the crash",
    async run(g) {
      // N52: nothing was exported before the crash. The session must start when it started (by
      // the time the SDK started replay at the latest), not at the crash, and end with it.
      const started = g.early.log.find((x) => x.kind === "replay.start")?.ts;
      const at = g.early.log.find((x) => x.kind === "os.crash")?.ts;
      const d = await detail(g.early.launches[0].session);
      const startedAt = Date.parse(d?.started_at ?? "");
      const endsAtCrash = Math.abs(Date.parse(d?.ended_at ?? "") - at) <= 1000;
      return result(
        d?.status === "crashed" && d?.end_reason === "crash" && startedAt <= started && endsAtCrash,
        d && named(d, "exception").length > 0,
        { status: d?.status ?? null, end_reason: d?.end_reason ?? null, started_at: d?.started_at ?? null, replay_start: started && new Date(started).toISOString(), ended_at: d?.ended_at ?? null, crash_at: at && new Date(at).toISOString() },
      );
    },
  },
  {
    id: "C3.1",
    title: "a 3 s main-thread block gives one hang exception with its duration",
    async run(g) {
      const d = await detail(g.main.launches[0].session);
      const hangs = named(d, "exception").filter((x) => attr(x, "ouo.exception.kind") === "hang");
      return result(
        hangs.length === 1 && Number(attr(hangs[0], "ouo.hang.duration_ms")) >= 2000 && attr(hangs[0], "ouo.exception.fatal") === "false" && hasContext(hangs[0], "Cart"),
        hangs.length > 0,
        { hangs: hangs.map((h) => h.attrs) },
      );
    },
  },
  {
    id: "C3.2",
    title: "a foreground termination without a crash report is a fatal termination on the next launch",
    async run(g) {
      const d = await detail(g.terminate.launches[0].session);
      const e = named(d, "exception").find((x) => attr(x, "ouo.exception.kind") === "termination");
      return result(d?.status === "crashed" && d?.end_reason === "crash" && attr(e, "ouo.exception.fatal") === "true" && attr(e, "ouo.termination.cause"), e, {
        status: d?.status ?? null,
        end_reason: d?.end_reason ?? null,
        cause: attr(e, "ouo.termination.cause") ?? null,
      });
    },
  },
  {
    id: "C4.1",
    title: "cold app start, TTID of each of the three screens and frame counts",
    async run(g) {
      const v = await getJSON(`${RUM}/v1/sessions/${g.main.launches[0].session}/vitals`).catch(() => null);
      const screens = (v?.vitals ?? []).filter((x) => x.name === "ouo.screen.display");
      const s = v?.summary ?? {};
      return result(
        s.app_start?.type === "cold" &&
          s.app_start.duration_ms > 0 &&
          screens.map((x) => x.screen).join(",") === "Home,Products,Cart" &&
          screens.every((x) => x.values?.ttid_ms > 0) &&
          s.frames?.total > 0,
        (v?.vitals ?? []).length > 0,
        { summary: s, screens: screens.map((x) => `${x.screen}:${x.values?.ttid_ms}`) },
      );
    },
  },
  {
    id: "C4.2",
    title: "TTFD on the first screen",
    async run(g) {
      const v = await getJSON(`${RUM}/v1/sessions/${g.main.launches[0].session}/vitals`).catch(() => null);
      const first = (v?.vitals ?? []).find((x) => x.name === "ouo.screen.display");
      return result(first?.values?.ttfd_ms > 0, first?.values?.ttfd_ms !== undefined, { first: first ?? null });
    },
  },
  {
    id: "C5.1",
    title: "a request to the demo backend joins one trace with the backend span, which carries session.id",
    async run(g) {
      const { session } = g.main.launches[0];
      const d = await detail(session);
      for (const t of d?.traces ?? []) {
        const spans = await traceSpans(t.trace_id).catch(() => []);
        const client = spans.find((s) => s.service === SERVICE && s.attrs["http.request.method"] === "GET");
        const server = spans.find((s) => s.service !== SERVICE && s.attrs["session.id"] === session);
        if (client && server) return result(true, true, { trace_id: t.trace_id, client: client.name, server: `${server.service} ${server.name}` });
      }
      return result(false, named(d, "http.request").length > 0, { traces: (d?.traces ?? []).map((t) => t.trace_id) });
    },
  },
  {
    id: "C6.1",
    title: "a tap, a long press and a swipe appear in order with label, view type, gesture and screen",
    async run(g) {
      const d = await detail(g.main.launches[0].session);
      const taps = named(d, "ui.tap").map((e) => ["ouo.ui.target", "ouo.ui.view_type", "ouo.ui.gesture", "app.screen.name"].map((k) => attr(e, k) ?? "?").join(" "));
      const want = ["open-products button tap Home", "add-to-cart button long_press Products", "cart-items FlatList swipe Cart"];
      return result(taps.join(",") === want.join(","), taps.length > 0, { taps });
    },
  },
  {
    id: "C7.1",
    title: "the three-screen journey: one screen navigation per change, a three-step funnel",
    async run(g) {
      const res = await fetch(`${RUM}/v1/funnels/query`, {
        method: "POST",
        headers: { ...readHeaders(), "content-type": "application/json" },
        body: JSON.stringify({
          steps: ["/Home", "/Products", "/Cart"].map((value) => ({ kind: "page", value })),
          from: String(T0 - 60_000),
          to: "now",
          filters: { service: SERVICE, platform: "mobile" },
        }),
      });
      const body = res.ok ? await res.json() : null;
      const counts = (body?.steps ?? []).map((s) => s.sessions);
      // Each screen change is one navigation record of kind `screen`, like the bridge's.
      const nav = named(await detail(g.main.launches[0].session), "navigation").map((e) => `${attr(e, "url.path")}:${attr(e, "ouo.navigation.kind")}`);
      const screens = nav.join(",") === "/Home:screen,/Products:screen,/Cart:screen";
      return result(counts[2] === 1 && counts[1] === 1 && screens, counts[0] > 0, { http: res.status, sessions_per_step: counts, navigation: nav });
    },
  },
  {
    id: "C8.1",
    title: "each session of a rotation gets its own frames replay",
    async run(g) {
      const { session, second } = g.main.launches[0];
      const [a, b] = await Promise.all([detail(session), detail(second)]);
      return result(a?.replay_kind === "frames" && b?.replay_kind === "frames", a?.has_replay || b?.has_replay, {
        first: a?.replay_kind ?? null,
        second: b?.replay_kind ?? null,
      });
    },
  },
  {
    id: "C8.2",
    title: "masking is on by default (text, inputs, images, web views)",
    async run(g) {
      const start = g.main.log.find((x) => x.kind === "replay.start");
      const o = start?.options ?? {};
      return result(o.maskText && o.maskInputs && o.maskImages && o.maskWebViews, start, { options: o });
    },
  },
  {
    id: "C8.3",
    title: "a replay cut by a crash is finished on the next launch, up to the crash",
    async run(g) {
      const crashed = g.crash.launches[0].session;
      const at = g.crash.log.find((x) => x.kind === "os.crash")?.ts;
      const meta = await getJSON(`${RUM}/v1/sessions/${crashed}/replay`).catch(() => null);
      const end = meta && Date.parse(meta.ended_at ?? "") || Number(meta?.ended_at);
      return result(meta?.kind === "frames" && end >= at - 1500, meta, { meta: meta && { kind: meta.kind, chunk_count: meta.chunk_count, ended_at: meta.ended_at } });
    },
  },
  {
    id: "C9.1",
    title: "a custom span parents the request span, and a log line reaches the session's logs",
    async run(g) {
      const { session } = g.main.launches[0];
      const d = await detail(session);
      const trace = (d?.traces ?? []).find((t) => t.root_name === "golden.checkout");
      const logs = await getJSON(`${RUM}/v1/sessions/${session}/logs`).catch(() => null);
      const line = (logs?.logs ?? []).find((l) => l.body === "golden log line");
      return result(trace && trace.span_count >= 2 && line, trace || line, { trace: trace && { root: trace.root_name, spans: trace.span_count }, log: Boolean(line) });
    },
  },
  {
    id: "C10.1",
    title: "a feedback appears on the session with message, contact, id, screenshot and the steps before it",
    async run(g) {
      const { session, feedback: id } = g.main.launches[0];
      const d = await detail(session);
      const f = named(d, "feedback")[0];
      let steps = [];
      try {
        steps = JSON.parse(attr(f, "ouo.last_events") ?? "[]").map((e) => `${e.name}|${e.body}`);
      } catch {
        steps = ["unparsable"];
      }
      const at = Date.parse(f?.ts ?? "");
      const replay = f ? await getJSON(`${RUM}/v1/sessions/${session}/replay/frames`).catch(() => null) : null;
      // The replay at the feedback time shows the screen: a frame at or before it, and the recording goes on.
      const shown = (replay?.frames ?? []).filter((x) => x.ts <= at).at(-1);
      const frame = shown && (replay?.frames ?? []).some((x) => x.ts > at) ? shown : undefined;
      const want = ["ui.tap|Swipe cart-items (FlatList) on Cart", "log|golden log line", "exception|Error: golden handled error"];
      return result(
        attr(f, "ouo.feedback.message") === "golden feedback" &&
          attr(f, "ouo.feedback.contact") === "qa@example.invalid" &&
          attr(f, "ouo.feedback.id") === id &&
          String(attr(f, "ouo.feedback.screenshot")) === "true" &&
          steps.slice(-3).join(",") === want.join(",") &&
          frame,
        f,
        { feedback: f ? { message: attr(f, "ouo.feedback.message"), contact: attr(f, "ouo.feedback.contact"), screenshot: attr(f, "ouo.feedback.screenshot") } : null, last_steps: steps.slice(-3), frame_before_ms: frame ? at - frame.ts : null },
      );
    },
  },
  {
    id: "C11.1",
    title: "a run with the collector refused loses nothing after the next launch",
    async run(g) {
      const d = await detail(g.offline.launches[0].session);
      const delivered = g.main.log.some((x) => x.kind === "request" && x.status === 200);
      return result(named(d, "navigation").some((e) => attr(e, "url.path") === "/Home"), delivered, { found: Boolean(d), events: (d?.timeline ?? []).map((x) => x.name) });
    },
  },
  {
    id: "C11.2",
    title: "OTLP requests are gzip",
    async run(g) {
      const otlp = g.main.log.filter((x) => x.kind === "request" && /\/v1\/(logs|traces|metrics)$/.test(x.url));
      const encodings = [...new Set(otlp.map((x) => x.encoding))];
      return result(otlp.length > 0 && encodings.join() === "gzip", otlp.length > 0, { requests: otlp.length, encodings });
    },
  },
];

const CAPABILITIES = {
  C1: "Sessions and lifecycle",
  C2: "Errors and crashes",
  C3: "Hangs and terminations",
  C4: "Vitals",
  C5: "Network",
  C6: "Interactions",
  C7: "Screens and navigation",
  C8: "Replay",
  C9: "Span and log API",
  C10: "Feedback",
  C11: "Delivery",
  C12: "Cost",
};

// ---------------------------------------------------------------- run

async function evaluate(golden) {
  return Promise.all(
    CHECKS.map(async (c) => {
      try {
        return { ...c, ...(await c.run(golden)) };
      } catch (err) {
        return { ...c, ok: false, seen: false, detail: { error: String(err) } };
      }
    }),
  );
}

/** Spec section 4: L2 when every check of the capability passes, L1 when its records show up, else L0. */
function level(checks) {
  if (checks.length === 0) return "-";
  if (checks.every((c) => c.ok)) return "L2";
  return checks.some((c) => c.seen) ? "L1" : "L0";
}

async function main() {
  console.log(`ouo mobile conformance (React Native iOS) run_id=${RUN_ID} service=${SERVICE}`);
  console.log(`otlp ${OTLP}  replay ${REPLAY}  rum-api ${RUM}  backend ${BACKEND}  read-token=${READ_TOKEN ? "set" : "none"}`);
  if (!existsSync(BUNDLE)) throw new Error(`${BUNDLE} missing: npm run -w sdk/react-native build`);
  const ready = await getJSON(`${RUM}/readyz`).catch((e) => ({ ready: false, error: String(e) }));
  if (!ready.ready) throw new Error(`rum-api not ready: ${JSON.stringify(ready)}`);

  const golden = await runGoldenApp();

  // Poll until every required check passes; the pending ones are read in the same rounds.
  const deadline = Date.now() + TIMEOUT_S * 1000;
  let results;
  for (;;) {
    results = await evaluate(golden);
    if (results.every((r) => r.pending || r.ok) || Date.now() >= deadline) break;
    await sleep(5000);
  }
  // One more round for late pending data (Tempo, replay), so an unexpected pass is not missed.
  await sleep(10_000);
  results = await evaluate(golden);

  console.log("\nchecks (docs/specs/mobile-sdk.md section 3):");
  table(
    results.map((r) => ({
      check: r.id,
      result: r.ok ? (r.pending ? "PASS (pending: make required)" : "pass") : r.pending ? `pending ${r.pending}` : "FAIL",
      title: r.title,
    })),
  );

  console.log("\nmaturity, React Native iOS (L3 also needs the B3 gate, docs/benchmarks.md):");
  const matrix = Object.entries(CAPABILITIES).map(([cap, name]) => {
    const mine = results.filter((r) => r.id.split(".")[0] === cap);
    return {
      capability: `${cap} ${name}`,
      checks: mine.length ? `${mine.filter((r) => r.ok).length}/${mine.length}` : "B3, not e2e",
      level: mine.length ? level(mine) : "-",
      waiting: [...new Set(mine.filter((r) => r.pending && !r.ok).map((r) => r.pending))].join(", ") || "-",
    };
  });
  table(matrix);

  const failed = results.filter((r) => !r.ok && !r.pending);
  const unexpected = results.filter((r) => r.ok && r.pending);
  for (const r of [...failed, ...unexpected]) {
    console.log(`\n${r.ok ? "PASSES BUT PENDING" : "FAIL"} ${r.id} ${r.title}\n  ${JSON.stringify(r.detail)}`);
  }
  if (OUT_FILE) {
    mkdirSync(dirname(OUT_FILE), { recursive: true });
    const strip = ({ run, ...r }) => r;
    writeFileSync(OUT_FILE, JSON.stringify({ run_id: RUN_ID, service: SERVICE, golden, checks: results.map(strip), matrix }, null, 2));
    console.log(`\nwrote ${OUT_FILE}`);
  }
  if (failed.length || unexpected.length) {
    console.log(`\nCONFORMANCE FAIL: ${failed.length} required check(s) failed, ${unexpected.length} pending check(s) pass`);
    process.exit(1);
  }
  console.log(`\nCONFORMANCE OK: ${results.filter((r) => r.ok).length} required checks pass, ${results.filter((r) => r.pending).length} pending`);
}

main().catch((err) => {
  console.error(`\nCONFORMANCE ERROR: ${err?.stack ?? err}`);
  process.exit(2);
});
