// End-to-end check of the plugin BFF slice (ADR-0023) against an ouo-env stack started with
// --muninn:
//
//   deploy/envs/ouo-env up <env> --muninn
//   eval "$(deploy/envs/ouo-env env <env>)"
//   (cd tests/e2e/plugin-bff && npm install && npx playwright install chromium && node run.mjs)
//
// 1. record    @ouo11y/browser (replay.mode structure/dom) records a page in Chromium, with
//              setUser, and sends telemetry and replay chunks to the collector.
// 2. admin     Grafana as admin (Clearance c5): the session is in the Session explorer list,
//              its page shows the event timeline, and the replay plays: the recorded DOM
//              (the page's marker text and the rows added) is inside the player's iframe.
// 3. viewer    Grafana as a Viewer (c1): the same pages. From the BFF's network responses, not
//              the screen: no user, no attributes, no body, replays null, no replay request
//              made, manifest and chunk answer 403, and the user id appears in no response.
// 4. pixel     Mobile-shaped sessions sent as OTLP to the collector (the RN SDK's wire): an
//              `ouo-frames/3` replay (JPEG frame, patch, touch) draws on the player's canvas, an
//              `ouo-video/1` replay (a real H.264 segment) decodes in the <video>; the session
//              page lists its traces (step 1's documentLoad span).
// 5. access    An unmasked replay (`ouo.replay.masked=false`) plays for admin (c5) and answers
//              403 "needs c5" to an Editor (c3). Clearance by team and by project: a Viewer in
//              team e2e-support gets c3, and c4 in project demo (the plugin settings are
//              changed for the test and put back after).
// 6. flows     The provisioned funnel shop-checkout (ADR-0025) counts step 1's web session
//              (product page, cart, checkout, then an exception: failed before "Pay by card"),
//              an iOS session that converts and an Android one that abandons after the cart,
//              sent as OTLP. Admin clicks the failed drop-off on the Business flows page, opens
//              the web session from the list and its replay plays. A Viewer (c1) gets the same
//              counts and the drop-off list without users.
// 7. home      The Home page's answer: session health by platform, web vitals from step 1,
//              mobile vitals from the OTLP sessions, the top error, and the backend's server
//              spans (sent as OTLP traces) read back from Mimir through Tempo's span metrics.
//
// Writes out/report.html (screenshots inlined) and out/results.json.
//
// Environment: OUO_OTLP_URL, OUO_GRAFANA_URL (ouo-env env <env>); OUO_PROJECT_ID / OUO_PROJECT_TOKEN
// (demo / pt_dev_demo_0000000000000000); OUO_GRAFANA_ADMIN_PASSWORD (testing567);
// OUO_BROWSER_SDK_SRC: a @ouo11y/browser source entry (sdk/browser/src/index.ts of a checkout) to
// bundle instead of the released package, e.g. a fix not yet released. OUO_E2E_CHANNEL: the
// Playwright browser channel, default "chrome" (Playwright's own Chromium has no H.264, step 4).
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { gzipSync } from "node:zlib";
import { chromium } from "playwright";
import { chunkRecord, hex, logsRequest } from "../muninn/otlp.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../..");
const env = process.env;
const need = (k) => (env[k] ?? (() => { throw new Error(`${k} is not set (eval "$(deploy/envs/ouo-env env <env>)")`); })()).replace(/\/$/, "");
const OTLP = need("OUO_OTLP_URL");
const GRAFANA = need("OUO_GRAFANA_URL");
const PROJECT = env.OUO_PROJECT_ID ?? "demo";
const TOKEN = env.OUO_PROJECT_TOKEN ?? "pt_dev_demo_0000000000000000";
const ADMIN = { user: "admin", password: env.OUO_GRAFANA_ADMIN_PASSWORD ?? "testing567" };
// A Viewer created by this test in the local env; its password is a throwaway test value.
const VIEWER = { user: "e2e-viewer", password: "e2e-viewer-local-only" };
const EDITOR = { user: "e2e-editor", password: "e2e-editor-local-only", role: "Editor" };
const TEAMED = { user: "e2e-teamed", password: "e2e-teamed-local-only" };
const APP = `${GRAFANA}/a/ouo11y-rum-app/explore`;
const BFF = `${GRAFANA}/api/plugins/ouo11y-rum-app/resources/v1`;
const OUT = path.join(HERE, "out");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}
async function poll(what, fn, timeoutS = 120) {
  const end = Date.now() + timeoutS * 1000;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(2000);
  }
}

// --- 1. record ------------------------------------------------------------------------
async function record(browser) {
  const marker = randomBytes(4).toString("hex");
  const user = `e2e-user-${marker}`;
  const out = path.join(HERE, "build");
  fs.mkdirSync(out, { recursive: true });
  const sdkSrc = env.OUO_BROWSER_SDK_SRC ? path.resolve(env.OUO_BROWSER_SDK_SRC) : null;
  await build({
    entryPoints: [path.join(HERE, "page/entry.js")], bundle: true, format: "iife", target: "es2022",
    outfile: path.join(out, "page.js"), logLevel: "warning",
    ...(sdkSrc ? { alias: { "@ouo11y/browser": sdkSrc }, nodePaths: [path.join(REPO, "node_modules"), path.join(REPO, "sdk/browser/node_modules")] } : {}),
  });
  const cfg = JSON.stringify({ endpoint: OTLP, projectId: PROJECT, projectToken: TOKEN, user });
  const html = fs.readFileSync(path.join(HERE, "page/index.html"), "utf8").replace("__CONFIG__", cfg).replace("__MARKER__", marker);
  const js = fs.readFileSync(path.join(out, "page.js"));
  const server = http.createServer((req, res) => {
    if (req.url === "/page.js") return res.writeHead(200, { "content-type": "text/javascript" }).end(js);
    res.writeHead(200, { "content-type": "text/html" }).end(html);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const page = await browser.newPage();
  try {
    await page.goto(`http://localhost:${server.address().port}`);
    await page.waitForFunction(() => window.ouo?.getSessionId());
    const session = await page.evaluate(() => window.ouo.getSessionId());
    for (let i = 0; i < 5; i++) {
      await page.click("#add");
      await sleep(700);
    }
    // Step 6's flow: a product page (a History API navigation), cart, checkout, then the payment
    // fails before payment.submit.
    await page.evaluate(() => history.pushState({}, "", "/products/7"));
    await sleep(300);
    await page.evaluate(() => window.ouo.recordEvent("cart.add", { "product.id": "7" }));
    await sleep(300);
    await page.evaluate(() => window.ouo.recordEvent("checkout.start"));
    await sleep(300);
    await page.evaluate(() => window.ouo.recordException(new Error("card declined by the e2e bank")));
    await sleep(500);
    await page.evaluate(() => window.ouo.shutdown()); // flushes and closes the replay stream
    await sleep(1000);
    console.log(`recorded session ${session} (marker ${marker}, SDK ${sdkSrc ?? "@ouo11y/browser 0.4.1 from npm"})`);
    return { session, marker, user, sdk: sdkSrc ?? "@ouo11y/browser 0.4.1 (npm)" };
  } finally {
    await page.close();
    server.close();
  }
}

// --- Grafana helpers -------------------------------------------------------------------
const ADMIN_AUTH = "Basic " + Buffer.from(`${ADMIN.user}:${ADMIN.password}`).toString("base64");
async function grafanaAPI(method, p, body) {
  const r = await fetch(`${GRAFANA}${p}`, {
    method,
    headers: { authorization: ADMIN_AUTH, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  return { status: r.status, json: text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : text };
}

/** A local test user (throwaway password); new users join org 1 as Viewer. Returns its id. */
async function ensureUser(u) {
  const r = await grafanaAPI("POST", "/api/admin/users", { name: u.user, login: u.user, email: `${u.user}@example.invalid`, password: u.password });
  if (r.status !== 200 && r.status !== 412) throw new Error(`create ${u.user}: ${r.status} ${JSON.stringify(r.json)}`);
  const id = (await grafanaAPI("GET", `/api/users/lookup?loginOrEmail=${u.user}`)).json.id;
  if (u.role) await grafanaAPI("PATCH", `/api/org/users/${id}`, { role: u.role });
  return id;
}
const ensureViewer = () => ensureUser(VIEWER);

/** A logged-in context that records every BFF response. */
async function grafanaContext(browser, who) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const r = await ctx.request.post(`${GRAFANA}/login`, { data: who });
  if (!r.ok()) throw new Error(`login ${who.user}: ${r.status()}`);
  const responses = [];
  ctx.on("response", async (resp) => {
    const url = resp.url();
    if (!url.includes("/api/plugins/ouo11y-rum-app/resources/")) return;
    const entry = { path: url.slice(url.indexOf("/resources/") + "/resources".length), status: resp.status() };
    try {
      const type = resp.headers()["content-type"] ?? "";
      if (type.includes("json")) entry.json = await resp.json();
      else entry.bytes = (await resp.body()).length;
    } catch {
      // body gone (navigation)
    }
    responses.push(entry);
  });
  return { ctx, responses };
}

const shot = async (page, name) => {
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  return file;
};

// --- 2. admin -------------------------------------------------------------------------
async function asAdmin(browser, rec) {
  const { ctx, responses } = await grafanaContext(browser, ADMIN);
  const page = await ctx.newPage();
  // Loki ingestion and the replay reference records take a few seconds.
  const listed = await poll("the session in the BFF list", async () => {
    const r = await ctx.request.get(`${BFF}/sessions`);
    const body = r.ok() ? await r.json() : null;
    const s = body?.sessions?.find((x) => x.id === rec.session);
    return s && s.has_replay ? s : null;
  });
  check("admin: BFF lists the session with its user and a replay hint", listed.user === rec.user && listed.has_replay, `${listed.event_count} events, user ${listed.user}`);

  await page.goto(APP);
  const link = page.locator(`a[href*="/explore/${PROJECT}/${rec.session}"]`);
  await link.waitFor({ timeout: 30000 });
  check("admin: the session is in the Session explorer list", true);
  const listShot = await shot(page, "admin-list");

  await link.click();
  await page.getByTestId("timeline-event").first().waitFor({ timeout: 30000 });
  const events = await page.getByTestId("timeline-event").count();
  const detail = responses.find((r) => r.path === `/v1/projects/${PROJECT}/sessions/${rec.session}` || r.path.startsWith(`/v1/projects/${PROJECT}/sessions/${rec.session}?`))?.json;
  const names = [...new Set((detail?.events ?? []).map((e) => e.name))];
  check("admin: the session page shows the event timeline", events >= 2 && events === detail?.events?.length, `${events} events: ${names.join(", ")}`);
  check("admin: the session answer carries attributes, the user and the replay list",
    detail?.events?.some((e) => e.attributes && Object.keys(e.attributes).length > 0) && detail?.session?.user === rec.user && detail?.replays?.length >= 1,
    `replays ${detail?.replays?.length}, redacted [${detail?.redacted}]`);

  // The replay: rrweb renders the recorded DOM into a sandboxed iframe.
  const frame = page.frameLocator('[data-testid="ouo-replay-rrweb"] iframe');
  const markerText = `plugin-bff-marker-${rec.marker}`;
  let seen = await frame.locator("#marker").textContent({ timeout: 30000 }).catch(() => null);
  if (seen !== markerText) {
    await page.locator(".rr-controller__btns button").first().click().catch(() => {});
    await sleep(3000);
    seen = await frame.locator("#marker").textContent({ timeout: 10000 }).catch(() => null);
  }
  check("admin: the replay plays the recorded DOM (marker text in the player's iframe)", seen === markerText, `iframe #marker = ${JSON.stringify(seen)}`);
  // Play to the end: the rows the test added must be there.
  await page.locator(".rr-controller__btns button").first().click().catch(() => {});
  const rows = await poll("rows replayed", async () => {
    const n = await frame.locator("#rows li").count().catch(() => 0);
    return n >= 5 ? n : null;
  }, 40).catch(() => 0);
  check("admin: the replay reaches the rows added during the session", rows >= 5, `${rows} rows in the replayed DOM`);
  const chunks = responses.filter((r) => r.path.includes("/chunks/"));
  const manifest = responses.find((r) => /\/replays\/[0-9a-f]{32}$/.test(r.path));
  check("admin: manifest and chunks came from the BFF", manifest?.status === 200 && chunks.length > 0 && chunks.every((c) => c.status === 200),
    `${chunks.length} chunks, ${chunks.reduce((n, c) => n + (c.bytes ?? 0), 0)} bytes decompressed, formats ${manifest?.json?.streams?.flatMap((s) => s.chunks?.map((c) => c.format) ?? []).filter((v, i, a) => a.indexOf(v) === i)}`);
  const sessionShot = await shot(page, "admin-session");
  await ctx.close();
  return { listShot, sessionShot, responses, manifest: manifest?.json };
}

// --- 3. viewer ------------------------------------------------------------------------
async function asViewer(browser, rec, adminManifest) {
  await ensureViewer();
  const { ctx, responses } = await grafanaContext(browser, VIEWER);
  const page = await ctx.newPage();
  await page.goto(APP);
  const link = page.locator(`a[href*="/explore/${PROJECT}/${rec.session}"]`);
  await link.waitFor({ timeout: 30000 });
  const listShot = await shot(page, "viewer-list");
  await link.click();
  await page.getByTestId("replay-hidden").waitFor({ timeout: 30000 });
  const sessionShot = await shot(page, "viewer-session");

  const me = responses.find((r) => r.path === "/v1/me")?.json;
  check("viewer: Clearance level c1", me?.level === 1 && me?.can?.replay === false, JSON.stringify(me));
  const list = responses.find((r) => r.path.startsWith("/v1/sessions"))?.json;
  const row = list?.sessions?.find((s) => s.id === rec.session);
  check("viewer: list answer has the session without its user", row && !("user" in row), `redacted [${list?.redacted}]`);
  const detail = responses.find((r) => r.path.startsWith(`/v1/projects/${PROJECT}/sessions/${rec.session}`))?.json;
  check("viewer: session answer has the timeline without attributes or body",
    detail?.events?.length > 0 && detail.events.every((e) => !("attributes" in e) && !("body" in e)), `${detail?.events?.length} events, keys ${[...new Set(detail?.events?.flatMap((e) => Object.keys(e)))]}`);
  check("viewer: session answer has no user and replays null",
    detail && !("user" in detail.session) && detail.replays === null && ["attributes", "replay", "identity"].every((g) => detail.redacted.includes(g)), `redacted [${detail?.redacted}]`);
  check("viewer: the page made no replay request", !responses.some((r) => r.path.includes("/replays/")), responses.map((r) => r.path.split("?")[0]).join(" "));
  const everything = JSON.stringify(responses);
  check("viewer: the user id appears in no BFF response", !everything.includes(rec.user));

  // Ask for the replay directly, with the ids the admin saw.
  const stream = adminManifest?.streams?.[0]?.stream_id;
  const base = `${BFF}/projects/${PROJECT}/sessions/${rec.session}/replays/${adminManifest?.replay_id}`;
  const m = await ctx.request.get(base);
  const c = await ctx.request.get(`${base}/streams/${stream}/chunks/0`);
  check("viewer: manifest and chunk answer 403", m.status() === 403 && c.status() === 403, `manifest ${m.status()}, chunk ${c.status()}: ${await c.text()}`);
  await ctx.close();
  return { listShot, sessionShot, responses: [...responses, { path: "(direct) manifest", status: m.status() }, { path: "(direct) chunk 0", status: c.status() }] };
}

// --- 4. pixel ------------------------------------------------------------------------
const OTLP_AUTH = "Basic " + Buffer.from(`${PROJECT}:${TOKEN}`).toString("base64");
async function sendOTLP(request) {
  const r = await fetch(`${OTLP}/v1/logs`, { method: "POST", headers: { "content-type": "application/x-protobuf", authorization: OTLP_AUTH }, body: request });
  if (r.status !== 200) throw new Error(`collector answered ${r.status}`);
}

/** A mobile-shaped session: two telemetry events and one replay chunk of `format`. */
async function sendPixelSession({ format, body, encoding, masked, t0 }) {
  const session = hex(16), replay = hex(16), stream = hex(16);
  const resource = { "service.name": "plugin-bff-pixel-e2e", "ouo.platform": "ios" };
  const ms = (t) => BigInt(t) * 1_000_000n;
  await sendOTLP(logsRequest({ resource, scope: "ouo.rum", records: [
    { event: "session.start", attrs: { "session.id": session }, timeNs: ms(t0) },
    { event: "app.navigation.complete", attrs: { "session.id": session, "app.screen.name": "Checkout", "app.navigation.destination.name": "Checkout" }, timeNs: ms(t0 + 100) },
  ] }));
  const chunk = chunkRecord({ session, replay, stream, seq: 0, format, body, over: {
    "ouo.replay.encoding": encoding, "ouo.replay.keyframe": true, "ouo.replay.masked": masked,
    "ouo.replay.start_time": t0, "ouo.replay.end_time": t0 + 5000,
  } });
  chunk.timeNs = ms(t0);
  await sendOTLP(logsRequest({ resource, records: [
    chunk,
    { event: "ouo.replay.ended", attrs: { "session.id": session, "ouo.replay.id": replay, "ouo.replay.stream.id": stream, "ouo.replay.end_state": "complete", "ouo.replay.end_reason": "e2e", "ouo.replay.last_sequence": 0 }, timeNs: ms(t0 + 5000) },
  ] }));
  return { session, replay, stream };
}

async function pixelSessions(browser) {
  // JPEGs of a small page with a marker, as the SDK would capture a masked screen.
  const page = await browser.newPage({ viewport: { width: 300, height: 400 } });
  await page.setContent(`<body style="margin:0;background:#2b6cb0;color:#fff;font:28px sans-serif"><p style="padding:20px">frames e2e</p></body>`);
  const full = (await page.screenshot({ type: "jpeg", quality: 50 })).toString("base64");
  await page.setContent(`<body style="margin:0;background:#c53030"></body>`);
  const patch = (await page.screenshot({ type: "jpeg", quality: 50, clip: { x: 0, y: 0, width: 64, height: 64 } })).toString("base64");
  await page.close();
  const t0 = Date.now() - 60_000;
  const ndjson = [
    { t: t0, type: "frame", w: 300, h: 400, scale: 1, reason: "timer", jpeg: full },
    { t: t0 + 300, type: "touch", x: 150, y: 200, phase: "began" },
    { t: t0 + 1000, type: "patch", reason: "change", patches: [{ x: 0, y: 0, w: 64, h: 64, jpeg: patch }] },
  ].map((e) => JSON.stringify(e)).join("\n") + "\n";
  const frames = await sendPixelSession({ format: "ouo-frames/3", body: gzipSync(Buffer.from(ndjson)), encoding: "gzip", masked: true, t0 });
  const unmasked = await sendPixelSession({ format: "ouo-frames/3", body: gzipSync(Buffer.from(ndjson)), encoding: "gzip", masked: false, t0 });

  const mp4 = fs.readFileSync(path.join(REPO, "project/kb/vendor-internals/sentry/mobile-sdks/fixtures/ios/04-replay-segment-0/replay_video.mp4"));
  const header = { t: t0, type: "video", end: t0 + 5000, w: 402, h: 874, scale: 1, fps: 1, frames: 5, mp4: mp4.length, touches: [{ t: t0 + 1000, x: 200, y: 400, phase: "began" }] };
  const video = await sendPixelSession({ format: "ouo-video/1", body: Buffer.concat([Buffer.from(JSON.stringify(header) + "\n"), mp4]), encoding: "identity", masked: true, t0 });
  return { frames, unmasked, video, t0 };
}

async function waitListed(ctx, ids) {
  await poll("the pixel sessions in the BFF list", async () => {
    const r = await ctx.request.get(`${BFF}/sessions`);
    const body = r.ok() ? await r.json() : null;
    return ids.every((id) => body?.sessions?.some((s) => s.id === id && s.has_replay));
  });
}

async function pixelPlayback(browser, px, rec) {
  const { ctx, responses } = await grafanaContext(browser, ADMIN);
  await waitListed(ctx, [px.frames.session, px.video.session, px.unmasked.session]);
  const page = await ctx.newPage();

  await page.goto(`${APP}/${PROJECT}/${px.frames.session}`);
  const canvas = page.getByTestId("ouo-replay-frames");
  await canvas.waitFor({ timeout: 30000 });
  await page.getByTestId("ouo-replay-play").click();
  const drawn = await poll("the patch drawn", async () => {
    const t = Number(await canvas.getAttribute("data-drawn-t"));
    return t >= px.t0 + 1000 ? t : null;
  }, 20).catch(() => null);
  // The patch is red over the blue frame: the top-left pixel is red, the centre still blue.
  const pixels = await canvas.evaluate((c) => {
    const d = c.getContext("2d");
    return { corner: Array.from(d.getImageData(10, 10, 1, 1).data), centre: Array.from(d.getImageData(150, 300, 1, 1).data), w: c.width, h: c.height };
  });
  const red = pixels.corner[0] > 150 && pixels.corner[2] < 100, blue = pixels.centre[2] > 120 && pixels.centre[0] < 100;
  check("pixel: ouo-frames/3 draws the full frame and then the patch on the canvas", drawn && red && blue && pixels.w === 300,
    `drawn up to +${drawn ? drawn - px.t0 : "?"} ms, corner rgb ${pixels.corner.slice(0, 3)}, centre rgb ${pixels.centre.slice(0, 3)}, canvas ${pixels.w}x${pixels.h}`);
  const framesShot = await shot(page, "pixel-frames");

  await page.goto(`${APP}/${PROJECT}/${px.video.session}`);
  const video = page.getByTestId("ouo-replay-video");
  await video.waitFor({ timeout: 30000 });
  await page.getByTestId("ouo-replay-play").click();
  const media = await poll("the video decoded", async () => {
    const m = await video.evaluate((v) => ({ w: v.videoWidth, h: v.videoHeight, ready: v.readyState, err: v.error?.code ?? 0, t: v.currentTime }));
    return m.w > 0 && m.ready >= 2 ? m : m.err ? m : null;
  }, 20).catch(() => ({ w: 0, ready: 0, err: -1 }));
  check("pixel: ouo-video/1 decodes in the <video> (H.264 segment)", media.w === 402 && media.h === 874 && !media.err, JSON.stringify(media));
  await sleep(1500);
  const touches = await page.getByTestId("ouo-replay-touch").count();
  const videoShot = await shot(page, "pixel-video");

  // Traces of step 1's browser session. Tempo answers a search once the trace is flushed from
  // its ingester's live traces (seconds to a minute after the last span).
  const detail = await poll("the session's traces in Tempo", async () => {
    const r = await ctx.request.get(`${BFF}/projects/${PROJECT}/sessions/${rec.session}`);
    const d = r.ok() ? await r.json() : null;
    return d?.traces?.length ? d : null;
  }, 120).catch(() => null);
  await page.goto(`${APP}/${PROJECT}/${rec.session}`);
  await page.getByTestId("explore-traces").waitFor({ timeout: 30000 }).catch(() => {});
  const traces = await page.getByTestId("explore-traces").locator("tr").count().catch(() => 0);
  check("traces: the session page lists the session's traces from Tempo", traces >= 1 && detail?.traces?.some((t) => t.root_name === "documentLoad"),
    `${traces} rows: ${detail?.traces?.map((t) => `${t.root_name} ${t.duration_ms} ms`).join(", ")}${detail ? "" : " (not in Tempo within 120 s)"}`);
  await ctx.close();
  return { framesShot, videoShot, touches };
}

// --- 5. access ------------------------------------------------------------------------
async function access(browser, px) {
  const replayOf = async (ctx, s) => {
    const d = await (await ctx.request.get(`${BFF}/projects/${PROJECT}/sessions/${s.session}`)).json();
    const m = await ctx.request.get(`${BFF}/projects/${PROJECT}/sessions/${s.session}/replays/${s.replay}`);
    const c = await ctx.request.get(`${BFF}/projects/${PROJECT}/sessions/${s.session}/replays/${s.replay}/streams/${s.stream}/chunks/0`);
    return { listed: d.replays?.length ?? null, manifest: m.status(), chunk: c.status(), message: m.status() === 200 ? "" : (await m.json()).error };
  };
  const admin = await grafanaContext(browser, ADMIN);
  const a = await replayOf(admin.ctx, px.unmasked);
  check("access: admin (c5) reads the unmasked replay", a.manifest === 200 && a.chunk === 200, JSON.stringify(a));
  await admin.ctx.close();

  await ensureUser(EDITOR);
  const editor = await grafanaContext(browser, EDITOR);
  const e = await replayOf(editor.ctx, px.unmasked);
  const em = await replayOf(editor.ctx, px.frames);
  check("access: an Editor (c3) gets 403 'needs c5' for the unmasked replay, 200 for a masked one",
    e.manifest === 403 && e.chunk === 403 && /without masking/.test(e.message) && em.manifest === 200 && em.chunk === 200, `unmasked ${JSON.stringify(e)}, masked ${JSON.stringify(em)}`);
  await editor.ctx.close();

  // Teams and projects: change the plugin's Clearance for the test, then put it back.
  const teamedId = await ensureUser(TEAMED);
  let team = await grafanaAPI("GET", "/api/teams/search?name=e2e-support");
  let teamId = team.json.teams?.find((t) => t.name === "e2e-support")?.id;
  if (!teamId) teamId = (await grafanaAPI("POST", "/api/teams", { name: "e2e-support" })).json.teamId;
  await grafanaAPI("POST", `/api/teams/${teamId}/members`, { userId: teamedId });
  // Grafana makes the team's creator a member; admin must keep its own level.
  const adminId = (await grafanaAPI("GET", "/api/users/lookup?loginOrEmail=admin")).json.id;
  await grafanaAPI("DELETE", `/api/teams/${teamId}/members/${adminId}`);
  // Grafana rebuilds the plugin instance only when the settings' update time changes, in whole
  // seconds: two writes within one second leave the first one in force.
  const writeSettings = async (jsonData) => {
    await sleep(1100);
    await grafanaAPI("POST", "/api/plugins/ouo11y-rum-app/settings", { enabled: true, pinned: true, jsonData });
    await sleep(1100);
  };
  const settings = (await grafanaAPI("GET", "/api/plugins/ouo11y-rum-app/settings")).json;
  const original = settings.jsonData;
  const changed = { ...original, clearance: { ...original.clearance, teams: { "e2e-support": 3 }, projects: { [PROJECT]: { teams: { "e2e-support": 4 } } } } };
  await writeSettings(changed);
  try {
    const teamed = await grafanaContext(browser, TEAMED);
    const org = await (await teamed.ctx.request.get(`${BFF}/me`)).json();
    const inDemo = await (await teamed.ctx.request.get(`${BFF}/me?project=${PROJECT}`)).json();
    const other = await (await teamed.ctx.request.get(`${BFF}/me?project=elsewhere`)).json();
    check("access: a Viewer in team e2e-support gets c3 in the org and c4 in project demo",
      org.level === 3 && org.teams?.includes("e2e-support") && inDemo.level === 4 && other.level === 3, `org ${org.level} ${JSON.stringify(org.teams)}, demo ${inDemo.level}, elsewhere ${other.level}`);
    const d = await (await teamed.ctx.request.get(`${BFF}/projects/${PROJECT}/sessions/${px.frames.session}`)).json();
    check("access: at c4 in project demo the timeline carries attributes and the replay list", Array.isArray(d.replays) && d.events.some((ev) => ev.attributes), `redacted [${d.redacted}]`);
    await teamed.ctx.close();
  } finally {
    await writeSettings(original);
  }
}

// --- 6. flows -------------------------------------------------------------------------
const FUNNEL = "shop-checkout";

/** OTLP logs of a mobile-shaped session walking the shop flow up to `upTo` events. */
async function sendMobileFlow({ platform, upTo, t0, vitals }) {
  const session = hex(16);
  const resource = { "service.name": `shop-${platform}`, "ouo.platform": platform };
  const ms = (t) => BigInt(t) * 1_000_000n;
  const flow = [
    { event: "session.start", attrs: {} },
    { event: "navigation", attrs: { "url.path": "/products/3", "ouo.navigation.kind": "screen" } },
    { event: "cart.add", attrs: { "ouo.event.custom": true } },
    { event: "checkout.start", attrs: { "ouo.event.custom": true } },
    { event: "payment.submit", attrs: { "ouo.event.custom": true, "payment.method": "card" } },
    { event: "order.placed", attrs: { "ouo.event.custom": true } },
  ].slice(0, upTo);
  if (vitals) {
    flow.push(
      { event: "ouo.app.start", attrs: { "ouo.app.start.type": "cold", "ouo.app.start.duration_ms": "812.5" } },
      { event: "ouo.screen.display", attrs: { "app.screen.name": "Products", "ouo.screen.ttid_ms": "240" } },
      { event: "app.jank", attrs: { "ouo.frames.total": 300, "ouo.frames.slow": 12, "ouo.frames.frozen": 3, "app.jank.frame_count": 15 } },
    );
  }
  await sendOTLP(logsRequest({ resource, scope: "ouo.rum", records: flow.map((r, i) => ({ ...r, attrs: { ...r.attrs, "session.id": session }, timeNs: ms(t0 + i * 1000) })) }));
  return session;
}

/** Server spans of a backend, as OTLP/JSON traces: Tempo's metrics generator turns them into span metrics in Mimir. */
async function sendServerSpans(service, n, errors) {
  const now = BigInt(Date.now()) * 1_000_000n;
  const spans = Array.from({ length: n }, (_, i) => ({
    traceId: hex(16), spanId: hex(8), name: "POST /api/pay", kind: 2,
    startTimeUnixNano: String(now - BigInt(i) * 10_000_000n - 120_000_000n), endTimeUnixNano: String(now - BigInt(i) * 10_000_000n),
    status: { code: i < errors ? 2 : 1 },
  }));
  const body = { resourceSpans: [{ resource: { attributes: [{ key: "service.name", value: { stringValue: service } }] }, scopeSpans: [{ scope: { name: "e2e" }, spans }] }] };
  const r = await fetch(`${OTLP}/v1/traces`, { method: "POST", headers: { "content-type": "application/json", authorization: OTLP_AUTH }, body: JSON.stringify(body) });
  if (r.status !== 200) throw new Error(`collector answered ${r.status} for traces`);
}

async function flows(browser, rec, since) {
  const t0 = Date.now() - 30_000;
  const ios = await sendMobileFlow({ platform: "ios", upTo: 6, t0, vitals: true });
  const android = await sendMobileFlow({ platform: "android", upTo: 3, t0 });
  const scope = `from=${since}&to=${Date.now() + 60_000}&project=${PROJECT}`;

  const { ctx, responses } = await grafanaContext(browser, ADMIN);
  const list = await (await ctx.request.get(`${BFF}/funnels`)).json();
  check("flows: the provisioned funnel is listed", list.funnels?.some((f) => f.id === FUNNEL && f.steps.length === 5), list.funnels?.map((f) => f.id).join(","));
  const report = await poll("the three sessions in the funnel", async () => {
    const r = await (await ctx.request.get(`${BFF}/funnels/${FUNNEL}?${scope}`)).json();
    return r.steps?.[0]?.sessions >= 3 && r.steps?.[2]?.sessions >= 2 ? r : null;
  }, 90).catch(() => null);
  const counts = report?.steps?.map((s) => `${s.sessions}/${s.dropped_off}/${s.failed}`).join(" ");
  const st = report?.steps ?? [];
  check("flows: web and mobile sessions in one funnel, the drop at Pay split into failed and abandoned",
    st[0]?.sessions === 3 && st[0]?.by_platform?.web === 1 && st[0]?.by_platform?.ios === 1 && st[0]?.by_platform?.android === 1 &&
    st[2]?.sessions === 2 && st[2]?.dropped_off === 1 && st[3]?.sessions === 1 && st[3]?.failed === 1 && st[4]?.sessions === 1,
    `sessions/dropped/failed per step: ${counts}`);
  const failed = await (await ctx.request.get(`${BFF}/funnels/${FUNNEL}/steps/4/sessions?outcome=failed&${scope}`)).json();
  const abandoned = await (await ctx.request.get(`${BFF}/funnels/${FUNNEL}/steps/3/sessions?outcome=abandoned&${scope}`)).json();
  check("flows: the failed drop-off is the web session, with its user for admin; the abandoned one is Android",
    failed.sessions?.length === 1 && failed.sessions[0].id === rec.session && failed.sessions[0].user === rec.user && failed.sessions[0].failed_with === "exception" &&
    abandoned.sessions?.length === 1 && abandoned.sessions[0].id === android,
    `failed ${JSON.stringify(failed.sessions?.[0])}, abandoned ${abandoned.sessions?.[0]?.platform}`);

  // The page: click the failed drop-off at Pay, open the web session, its replay plays.
  const page = await ctx.newPage();
  await page.goto(`${GRAFANA}/a/ouo11y-rum-app/flows`);
  await page.getByTestId("funnel-step").first().waitFor({ timeout: 30000 });
  const flowShot = await shot(page, "flows-funnel");
  const steps = page.getByTestId("funnel-step");
  await steps.nth(3).getByTestId("funnel-failed").click();
  const link = page.locator(`[data-testid="dropped-session-link"][href*="${rec.session}"]`);
  await link.waitFor({ timeout: 30000 });
  const dropShot = await shot(page, "flows-dropped");
  await link.click();
  const frame = page.frameLocator('[data-testid="ouo-replay-rrweb"] iframe');
  const seen = await frame.locator("#marker").textContent({ timeout: 30000 }).catch(() => null);
  check("flows: from the failed drop-off to the session page, and its replay plays", seen === `plugin-bff-marker-${rec.marker}`, `iframe #marker = ${JSON.stringify(seen)}`);
  const replayShot = await shot(page, "flows-replay");
  await ctx.close();

  const viewer = await grafanaContext(browser, VIEWER);
  const vr = await (await viewer.ctx.request.get(`${BFF}/funnels/${FUNNEL}?${scope}`)).json();
  const vd = await (await viewer.ctx.request.get(`${BFF}/funnels/${FUNNEL}/steps/4/sessions?outcome=failed&${scope}`)).json();
  check("flows: a Viewer (c1) gets the same counts and the drop-off list without users",
    vr.steps?.map((s) => s.sessions).join() === st.map((s) => s.sessions).join() && vd.sessions?.length === 1 && !("user" in vd.sessions[0]) && vd.redacted?.includes("identity") && !JSON.stringify(vd).includes(rec.user),
    `counts ${vr.steps?.map((s) => s.sessions).join()}, redacted [${vd.redacted}]`);
  await viewer.ctx.close();
  return { flowShot, dropShot, replayShot, ios, android };
}

// --- 7. home --------------------------------------------------------------------------
async function home(browser, rec, flow, since) {
  await sendServerSpans("shop-api-e2e", 20, 5);
  const scope = `from=${since}&to=${Date.now() + 60_000}&project=${PROJECT}`;
  const { ctx } = await grafanaContext(browser, ADMIN);
  const ov = await poll("the overview with the backend from Mimir", async () => {
    await sendServerSpans("shop-api-e2e", 5, 0);
    const r = await (await ctx.request.get(`${BFF}/overview?${scope}`)).json();
    return r.backend?.some((s) => s.service === "shop-api-e2e") ? r : null;
  }, 180).catch(async () => (await ctx.request.get(`${BFF}/overview?${scope}`)).json());
  const platforms = Object.fromEntries((ov.health ?? []).map((h) => [h.platform, h]));
  check("home: session health by platform (web errored, iOS and Android healthy)",
    platforms.web?.errored >= 1 && platforms.ios?.sessions >= 1 && platforms.ios?.errored === 0 && platforms.android?.sessions >= 1 && ov.totals?.health < 100,
    `totals ${JSON.stringify(ov.totals)}, platforms ${Object.keys(platforms)}`);
  check("home: the web session's exception is a top error with its message (admin)",
    ov.top_errors?.some((e) => e.message?.includes("card declined by the e2e bank") && e.session === rec.session), ov.top_errors?.map((e) => `${e.sessions}x ${e.message ?? e.fingerprint}`).join("; "));
  check("home: web vitals from the browser session", ov.web_vitals?.length > 0, ov.web_vitals?.map((v) => `${v.name} ${v.p75}`).join(", "));
  const mv = Object.fromEntries((ov.mobile_vitals ?? []).map((v) => [`${v.platform}/${v.name}`, v.p75]));
  check("home: mobile vitals from the iOS session (cold start, TTID, slow and frozen frames)",
    mv["ios/app_start_cold"] === 812.5 && mv["ios/ttid"] === 240 && mv["ios/slow_frames"] === 4 && mv["ios/frozen_frames"] === 1, JSON.stringify(mv));
  const api = ov.backend?.find((s) => s.service === "shop-api-e2e");
  check("home: the backend's server spans read back from Mimir (Tempo span metrics)", api && api.rate_per_sec > 0 && api.error_pct > 0 && api.p95_ms > 0,
    api ? JSON.stringify(api) : `backend ${JSON.stringify(ov.backend)} ${ov.backend_error ?? ""}`);
  const page = await ctx.newPage();
  await page.goto(`${GRAFANA}/a/ouo11y-rum-app/home`);
  await page.getByTestId("home-health").waitFor({ timeout: 30000 });
  await page.getByTestId("home-backend").scrollIntoViewIfNeeded();
  const homeShot = await shot(page, "home");
  await ctx.close();

  const viewer = await grafanaContext(browser, VIEWER);
  const vo = await (await viewer.ctx.request.get(`${BFF}/overview?${scope}`)).json();
  check("home: a Viewer (c1) gets the numbers but no error message or type",
    vo.totals?.sessions === ov.totals?.sessions && vo.top_errors?.length > 0 && vo.top_errors.every((e) => !("message" in e) && !("type" in e)) && vo.redacted?.includes("attributes") && !JSON.stringify(vo).includes("card declined"),
    `sessions ${vo.totals?.sessions}, redacted [${vo.redacted}]`);
  await viewer.ctx.close();
  return { homeShot };
}

// --- report ---------------------------------------------------------------------------
function report(rec, admin, viewer, pixel, flow, homeRes) {
  const img = (f) => `<img alt="${path.basename(f)}" src="data:image/png;base64,${fs.readFileSync(f).toString("base64")}">`;
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
  const rows = results.map((r) => `<tr class="${r.ok ? "ok" : "fail"}"><td>${r.ok ? "PASS" : "FAIL"}</td><td>${esc(r.name)}</td><td>${esc(r.detail)}</td></tr>`).join("");
  const viewerJSON = esc(JSON.stringify(viewer.responses.map((r) => ({ path: r.path, status: r.status, body: r.json })), null, 2));
  fs.writeFileSync(path.join(OUT, "report.html"), `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Plugin BFF e2e</title>
<style>body{font:14px system-ui,sans-serif;margin:24px;max-width:1400px;color:#222;background:#fff}td{padding:4px 8px;border-bottom:1px solid #ddd;vertical-align:top}
.ok td:first-child{color:#1a7f37;font-weight:600}.fail td:first-child{color:#cf222e;font-weight:600}img{max-width:100%;border:1px solid #ccc;margin:8px 0}
pre{background:#f6f8fa;padding:12px;overflow:auto;max-height:480px;font-size:12px}</style></head><body>
<h1>Plugin BFF: sessions, replays, Clearance, business flows and Home, end to end</h1>
<p>${new Date().toISOString()} · session <code>${rec.session}</code> · SDK ${esc(rec.sdk)} · Grafana ${esc(GRAFANA)}</p>
<table>${rows}</table>
<h2>Admin (c5): session page, replay playing the recorded DOM</h2>${img(admin.sessionShot)}
<h2>Admin: Session explorer list</h2>${img(admin.listShot)}
<h2>Viewer (c1): session page</h2>${img(viewer.sessionShot)}
<h2>Viewer: list</h2>${img(viewer.listShot)}
<h2>ouo-frames/3 replay (full frame, then a red patch top left)</h2>${img(pixel.framesShot)}
<h2>ouo-video/1 replay (a real H.264 segment from the Sentry iOS fixtures)</h2>${img(pixel.videoShot)}
${homeRes ? `<h2>Home: health, sessions over time, top errors, vitals, backend from Mimir</h2>${img(homeRes.homeShot)}` : ""}
${flow ? `<h2>Business flows: the funnel, web and mobile</h2>${img(flow.flowShot)}<h2>The failed drop-off at Pay</h2>${img(flow.dropShot)}<h2>From the drop-off to the replay</h2>${img(flow.replayShot)}` : ""}
<h2>Viewer: every BFF response</h2><pre>${viewerJSON}</pre>
</body></html>`);
  fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify({ rec, results }, null, 2));
}

fs.mkdirSync(OUT, { recursive: true });
const CHANNEL = env.OUO_E2E_CHANNEL ?? "chrome";
const browser = await chromium.launch(CHANNEL === "chromium" ? {} : { channel: CHANNEL });
console.log(`browser: ${CHANNEL} ${browser.version()}`);
try {
  const since = Date.now() - 60_000;
  const rec = await record(browser);
  const admin = await asAdmin(browser, rec);
  const viewer = await asViewer(browser, rec, admin.manifest);
  const px = await pixelSessions(browser);
  const pixel = await pixelPlayback(browser, px, rec);
  await access(browser, px);
  const flow = await flows(browser, rec, since);
  const homeRes = await home(browser, rec, flow, since);
  report(rec, admin, viewer, pixel, flow, homeRes);
} catch (err) {
  check("run", false, err.stack ?? String(err));
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed${failed ? "" : ""}; report: ${path.join(OUT, "report.html")}`);
process.exit(failed ? 1 : 0);
