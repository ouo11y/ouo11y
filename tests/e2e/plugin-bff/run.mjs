// End-to-end check of the plugin BFF slice (ADR-0023) against an ouo-env stack started with
// --muninn and without --idp (Clearance in roles mode; clearance-idp.mjs checks groups mode):
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
//
// Writes out/report.html (screenshots inlined) and out/results.json.
//
// Environment: OUO_OTLP_URL, OUO_GRAFANA_URL (ouo-env env <env>); OUO_PROJECT_ID / OUO_PROJECT_TOKEN
// (demo / pt_dev_demo_0000000000000000); OUO_GRAFANA_ADMIN_PASSWORD (testing567);
// OUO_BROWSER_SDK_SRC: a @ouo11y/browser source entry (sdk/browser/src/index.ts of a checkout) to
// bundle instead of the released package, e.g. a fix not yet released.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { record } from "./record.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;
const need = (k) => (env[k] ?? (() => { throw new Error(`${k} is not set (eval "$(deploy/envs/ouo-env env <env>)")`); })()).replace(/\/$/, "");
const OTLP = need("OUO_OTLP_URL");
const GRAFANA = need("OUO_GRAFANA_URL");
const PROJECT = env.OUO_PROJECT_ID ?? "demo";
const TOKEN = env.OUO_PROJECT_TOKEN ?? "pt_dev_demo_0000000000000000";
const ADMIN = { user: "admin", password: env.OUO_GRAFANA_ADMIN_PASSWORD ?? "testing567" };
// A Viewer created by this test in the local env; its password is a throwaway test value.
const VIEWER = { user: "e2e-viewer", password: "e2e-viewer-local-only" };
const APP = `${GRAFANA}/a/ouo11y-rum-app/explore`;
const BFF = `${GRAFANA}/api/datasources/uid/ouo11y/resources/v1`;
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

// --- Grafana helpers -------------------------------------------------------------------
async function ensureViewer() {
  const auth = "Basic " + Buffer.from(`${ADMIN.user}:${ADMIN.password}`).toString("base64");
  const r = await fetch(`${GRAFANA}/api/admin/users`, {
    method: "POST",
    headers: { authorization: auth, "content-type": "application/json" },
    body: JSON.stringify({ name: "e2e viewer", login: VIEWER.user, email: "e2e-viewer@example.invalid", password: VIEWER.password }),
  });
  // 412: the user exists from an earlier run. New users join org 1 as Viewer.
  if (r.status !== 200 && r.status !== 412) throw new Error(`create viewer: ${r.status} ${await r.text()}`);
}

/** A logged-in context that records every BFF response. */
async function grafanaContext(browser, who) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const r = await ctx.request.post(`${GRAFANA}/login`, { data: who });
  if (!r.ok()) throw new Error(`login ${who.user}: ${r.status()}`);
  const responses = [];
  ctx.on("response", async (resp) => {
    const url = resp.url();
    if (!url.includes("/api/datasources/uid/ouo11y/resources/")) return;
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

// --- report ---------------------------------------------------------------------------
function report(rec, admin, viewer) {
  const img = (f) => `<img alt="${path.basename(f)}" src="data:image/png;base64,${fs.readFileSync(f).toString("base64")}">`;
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
  const rows = results.map((r) => `<tr class="${r.ok ? "ok" : "fail"}"><td>${r.ok ? "PASS" : "FAIL"}</td><td>${esc(r.name)}</td><td>${esc(r.detail)}</td></tr>`).join("");
  const viewerJSON = esc(JSON.stringify(viewer.responses.map((r) => ({ path: r.path, status: r.status, body: r.json })), null, 2));
  fs.writeFileSync(path.join(OUT, "report.html"), `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Plugin BFF e2e</title>
<style>body{font:14px system-ui,sans-serif;margin:24px;max-width:1400px;color:#222;background:#fff}td{padding:4px 8px;border-bottom:1px solid #ddd;vertical-align:top}
.ok td:first-child{color:#1a7f37;font-weight:600}.fail td:first-child{color:#cf222e;font-weight:600}img{max-width:100%;border:1px solid #ccc;margin:8px 0}
pre{background:#f6f8fa;padding:12px;overflow:auto;max-height:480px;font-size:12px}</style></head><body>
<h1>Plugin BFF slice, end to end</h1>
<p>${new Date().toISOString()} · session <code>${rec.session}</code> · SDK ${esc(rec.sdk)} · Grafana ${esc(GRAFANA)}</p>
<table>${rows}</table>
<h2>Admin (c5): session page, replay playing the recorded DOM</h2>${img(admin.sessionShot)}
<h2>Admin: Session explorer list</h2>${img(admin.listShot)}
<h2>Viewer (c1): session page</h2>${img(viewer.sessionShot)}
<h2>Viewer: list</h2>${img(viewer.listShot)}
<h2>Viewer: every BFF response</h2><pre>${viewerJSON}</pre>
</body></html>`);
  fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify({ rec, results }, null, 2));
}

fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
try {
  const rec = await record(browser, { otlp: OTLP, project: PROJECT, token: TOKEN });
  const admin = await asAdmin(browser, rec);
  const viewer = await asViewer(browser, rec, admin.manifest);
  report(rec, admin, viewer);
} catch (err) {
  check("run", false, err.stack ?? String(err));
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed${failed ? "" : ""}; report: ${path.join(OUT, "report.html")}`);
process.exit(failed ? 1 : 0);
