// End-to-end check of Clearance from identity-provider groups (ADR-0024) against an ouo-env
// stack started with --muninn --idp (Keycloak realm `ouo`, deploy/compose/compose.idp.yaml):
//
//   deploy/envs/ouo-env up <env> --muninn --idp
//   eval "$(deploy/envs/ouo-env env <env>)"
//   (cd tests/e2e/plugin-bff && npm install && npx playwright install chromium && node clearance-idp.mjs)
//
// Every check reads the backend's HTTP answers, never the screen. Users sign in to Grafana
// through Keycloak's login form over plain HTTP; all of them are Grafana Viewers.
//
// 1. record    a browser session with a user id and a replay (record.mjs).
// 2. omar      group rum-privacy (c4): attributes, the user, the replay list, manifest, chunk.
// 3. lena      group rum-support (c1): the timeline only; no user, no attributes, replays
//              null, manifest and chunk 403, the user id in no answer.
// 4. nora      no group: level 0, every data endpoint 403.
// 5. move      lena is moved to rum-privacy in Keycloak. Her open session keeps c1 until
//              Grafana refreshes her tokens (they live 60 s in this realm), then is c4
//              without signing in again. Moved back, a new sign-in is c1 at once.
// 6. local     Grafana users who did not come from the identity provider get level 0: a
//              local Viewer, the same after renaming its login to an IdP user's name and to a
//              group's name, with a forged X-Id-Token (unsigned, and signed by its own key),
//              and the local Admin. A forged header on lena's session does not replace her
//              real token.
//
// Writes out/clearance-idp.json. Environment: OUO_OTLP_URL, OUO_GRAFANA_URL, OUO_KEYCLOAK_URL
// (ouo-env env <env>); OUO_PROJECT_ID / OUO_PROJECT_TOKEN (demo / pt_dev_demo_0000000000000000).
// Passwords are the realm's and the stack's public development value.
import fs from "node:fs";
import path from "node:path";
import { createSign, generateKeyPairSync } from "node:crypto";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { record } from "./record.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;
const need = (k) => (env[k] ?? (() => { throw new Error(`${k} is not set (eval "$(deploy/envs/ouo-env env <env>)", env started with --idp)`); })()).replace(/\/$/, "");
const OTLP = need("OUO_OTLP_URL");
const GRAFANA = need("OUO_GRAFANA_URL");
const KEYCLOAK = need("OUO_KEYCLOAK_URL");
const PROJECT = env.OUO_PROJECT_ID ?? "demo";
const TOKEN = env.OUO_PROJECT_TOKEN ?? "pt_dev_demo_0000000000000000";
const PASSWORD = "testing567";
const BFF = `${GRAFANA}/api/datasources/uid/ouo11y/resources/v1`;
const ISSUER = `${KEYCLOAK}/realms/ouo`;
const OUT = path.join(HERE, "out");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}
async function poll(what, fn, timeoutS = 120, everyMs = 2000) {
  const end = Date.now() + timeoutS * 1000;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(everyMs);
  }
}

// --- HTTP sessions ----------------------------------------------------------------------
/** A cookie jar per host that follows redirects, enough for an OIDC code flow. */
class Session {
  cookies = new Map();
  seen = []; // every BFF answer: { path, status, body }
  async fetch(url, opts = {}) {
    for (let hop = 0; hop < 12; hop++) {
      const host = new URL(url).host;
      const cookie = [...(this.cookies.get(host) ?? new Map())].map(([k, v]) => `${k}=${v}`).join("; ");
      const r = await fetch(url, { ...opts, redirect: "manual", headers: { ...(opts.headers ?? {}), ...(cookie ? { cookie } : {}) } });
      for (const sc of r.headers.getSetCookie()) {
        const kv = sc.split(";")[0];
        const i = kv.indexOf("=");
        if (!this.cookies.has(host)) this.cookies.set(host, new Map());
        this.cookies.get(host).set(kv.slice(0, i).trim(), kv.slice(i + 1));
      }
      const to = r.headers.get("location");
      if (r.status >= 300 && r.status < 400 && to) {
        url = new URL(to, url).href;
        opts = {};
        continue;
      }
      return r;
    }
    throw new Error(`too many redirects, last ${url}`);
  }
  /** GET a BFF path; the answer is kept in `seen`. */
  async bff(p, headers) {
    const r = await this.fetch(`${BFF}${p}`, { headers });
    const type = r.headers.get("content-type") ?? "";
    const body = type.includes("json") ? await r.json() : { bytes: (await r.arrayBuffer()).byteLength };
    this.seen.push({ path: p, status: r.status, body });
    return { status: r.status, body };
  }
}

/** Signs in to Grafana through Keycloak's login form. */
async function idpLogin(user) {
  const s = new Session();
  const page = await (await s.fetch(`${GRAFANA}/login/generic_oauth`)).text();
  const action = /<form[^>]*action="([^"]+)"/.exec(page)?.[1]?.replaceAll("&amp;", "&");
  if (!action) throw new Error(`no Keycloak login form for ${user} (is the env started with --idp?)`);
  await s.fetch(action, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ username: user, password: PASSWORD }) });
  const me = await s.fetch(`${GRAFANA}/api/user`);
  if (!me.ok) throw new Error(`${user}: not signed in to Grafana after the Keycloak form (${me.status})`);
  return s;
}

/** Signs in with a Grafana password (a user the identity provider does not know). */
async function localLogin(user, password) {
  const s = new Session();
  const r = await s.fetch(`${GRAFANA}/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ user, password }) });
  if (!r.ok) throw new Error(`local login ${user}: ${r.status}`);
  return s;
}

// --- Keycloak admin ---------------------------------------------------------------------
async function keycloakAdmin() {
  const r = await fetch(`${KEYCLOAK}/realms/master/protocol/openid-connect/token`, {
    method: "POST",
    body: new URLSearchParams({ grant_type: "password", client_id: "admin-cli", username: "admin", password: PASSWORD }),
  });
  if (!r.ok) throw new Error(`keycloak admin token: ${r.status}`);
  const { access_token } = await r.json();
  const call = async (method, p) => {
    const res = await fetch(`${KEYCLOAK}/admin/realms/ouo${p}`, { method, headers: { authorization: `Bearer ${access_token}` } });
    if (!res.ok) throw new Error(`keycloak ${method} ${p}: ${res.status}`);
    return res.status === 204 ? null : res.json();
  };
  const groups = Object.fromEntries((await call("GET", "/groups")).map((g) => [g.name, g.id]));
  const userId = async (name) => (await call("GET", `/users?username=${name}&exact=true`))[0].id;
  return {
    /** Makes `group` the user's only group. */
    async setGroup(user, group) {
      const id = await userId(user);
      for (const g of await call("GET", `/users/${id}/groups`)) await call("DELETE", `/users/${id}/groups/${g.id}`);
      await call("PUT", `/users/${id}/groups/${groups[group]}`);
    },
  };
}

// --- forged tokens ----------------------------------------------------------------------
const b64 = (v) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");
const forgedClaims = () => ({ iss: ISSUER, aud: "grafana", sub: "forged", exp: Math.floor(Date.now() / 1000) + 300, groups: ["rum-privacy"] });
const unsignedToken = () => `${b64({ alg: "none", typ: "JWT" })}.${b64(forgedClaims())}.`;
/** The right issuer, audience and groups, signed with a key the identity provider does not hold. */
function selfSignedToken() {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const head = `${b64({ alg: "RS256", typ: "JWT", kid: "forged" })}.${b64(forgedClaims())}`;
  return `${head}.${createSign("RSA-SHA256").update(head).sign(privateKey).toString("base64url")}`;
}

// --- the checks -------------------------------------------------------------------------
const sessionPath = (rec) => `/projects/${PROJECT}/sessions/${rec.session}`;

async function asOmar(rec) {
  const s = await idpLogin("omar");
  const row = await poll("the session in the BFF list", async () => {
    const { body } = await s.bff("/sessions");
    const x = body?.sessions?.find((v) => v.id === rec.session);
    return x?.has_replay ? x : null;
  });
  const me = (await s.bff("/me")).body;
  check("omar (rum-privacy): level c4 from groups, as a Grafana Viewer", me.level === 4 && me.mode === "groups" && me.role === "Viewer", JSON.stringify(me));
  check("omar: the list answer carries the session's user", row.user === rec.user, `user ${row.user}`);
  const detail = (await s.bff(sessionPath(rec))).body;
  check("omar: the session answer carries attributes, the user and the replay list",
    detail.events?.some((e) => e.attributes && Object.keys(e.attributes).length) && detail.session?.user === rec.user && detail.replays?.length >= 1,
    `${detail.events?.length} events, replays ${detail.replays?.length}, redacted [${detail.redacted}]`);
  const replay = detail.replays?.[0]?.replay_id;
  const manifest = await s.bff(`${sessionPath(rec)}/replays/${replay}`);
  const stream = manifest.body?.streams?.[0]?.stream_id;
  const chunk = await s.bff(`${sessionPath(rec)}/replays/${replay}/streams/${stream}/chunks/0`);
  check("omar: manifest and chunk answer 200", manifest.status === 200 && chunk.status === 200 && chunk.body.bytes > 0, `manifest ${manifest.status}, chunk ${chunk.status} (${chunk.body.bytes} bytes)`);
  return { replay, stream };
}

async function asLena(rec, ids) {
  const s = await idpLogin("lena");
  const me = (await s.bff("/me")).body;
  check("lena (rum-support): level c1 from groups", me.level === 1 && me.mode === "groups" && me.can.replay === false && me.can.identity === false, JSON.stringify(me));
  const list = (await s.bff("/sessions")).body;
  const row = list.sessions?.find((v) => v.id === rec.session);
  check("lena: the list answer has the session without its user", row && !("user" in row), `redacted [${list.redacted}]`);
  const detail = (await s.bff(sessionPath(rec))).body;
  check("lena: the session answer has the timeline only: no attributes, no body, no user, replays null",
    detail.events?.length > 0 && detail.events.every((e) => !("attributes" in e) && !("body" in e)) && !("user" in detail.session) && detail.replays === null,
    `${detail.events?.length} events, redacted [${detail.redacted}]`);
  const manifest = await s.bff(`${sessionPath(rec)}/replays/${ids.replay}`);
  const chunk = await s.bff(`${sessionPath(rec)}/replays/${ids.replay}/streams/${ids.stream}/chunks/0`);
  check("lena: manifest and chunk answer 403", manifest.status === 403 && chunk.status === 403, `manifest ${manifest.status}, chunk ${chunk.status}`);
  check("lena: the user id appears in no answer", !JSON.stringify(s.seen).includes(rec.user));
  // Grafana sets X-Id-Token itself for a user with identity-provider tokens.
  const forged = (await s.bff("/me", { "X-Id-Token": selfSignedToken() })).body;
  check("lena: a forged X-Id-Token on her session changes nothing", forged.level === 1, `level ${forged.level}`);
  return s;
}

async function asNora(rec) {
  const s = await idpLogin("nora");
  const me = (await s.bff("/me")).body;
  const list = await s.bff("/sessions");
  const detail = await s.bff(sessionPath(rec));
  check("nora (no group): level 0, list and session answer 403", me.level === 0 && list.status === 403 && detail.status === 403, `level ${me.level}, list ${list.status}, session ${detail.status}`);
}

async function groupMove(lena) {
  const kc = await keycloakAdmin();
  await kc.setGroup("lena", "rum-privacy");
  const t0 = Date.now();
  try {
    const first = (await lena.bff("/me")).body.level;
    const level = await poll("lena's open session to reach c4", async () => {
      const l = (await lena.bff("/me")).body.level;
      return l === 4 ? l : null;
    }, 150, 5000);
    const secs = Math.round((Date.now() - t0) / 1000);
    check("moved to rum-privacy: lena's open session becomes c4 at the token refresh, without a new sign-in", level === 4,
      `level ${first} right after the move, c4 after ${secs}s (tokens live 60s in this realm)`);
    const fresh = (await (await idpLogin("lena")).bff("/me")).body;
    check("moved to rum-privacy: a new sign-in is c4", fresh.level === 4, `level ${fresh.level}`);
  } finally {
    await kc.setGroup("lena", "rum-support");
  }
  const back = (await (await idpLogin("lena")).bff("/me")).body;
  check("moved back to rum-support: a new sign-in is c1 at once", back.level === 1, `level ${back.level}`);
}

async function localUsers() {
  const admin = "Basic " + Buffer.from(`admin:${PASSWORD}`).toString("base64");
  const api = (method, p, body) => fetch(`${GRAFANA}${p}`, { method, headers: { authorization: admin, "content-type": "application/json" }, body: body && JSON.stringify(body) });
  // A local Viewer made for this run and deleted after it; the password is a throwaway.
  const login = `e2e-local-${Date.now()}`;
  const pw = "e2e-local-only-password";
  const made = await api("POST", "/api/admin/users", { name: "e2e local", login, email: `${login}@example.invalid`, password: pw });
  if (!made.ok) throw new Error(`create local user: ${made.status} ${await made.text()}`);
  const { id } = await made.json();
  try {
    const s = await localLogin(login, pw);
    const plain = (await s.bff("/me")).body;
    check("local Viewer (not from the identity provider): level 0", plain.level === 0 && plain.mode === "groups" && plain.role === "Viewer", JSON.stringify(plain));
    const levels = [];
    // The user renames itself, as Grafana lets a local user do.
    for (const name of ["omar", "rum-privacy"]) {
      const r = await s.fetch(`${GRAFANA}/api/user`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ login: name, name: "e2e local", email: `${login}@example.invalid` }) });
      const me = (await s.bff("/me")).body;
      levels.push(`${name}: rename ${r.status}, login ${me.login}, level ${me.level}`);
      if (!r.ok || me.login !== name || me.level !== 0) levels.push("UNEXPECTED");
    }
    check("local Viewer renames its login to an IdP user's name and to a group's name: still level 0", !levels.includes("UNEXPECTED"), levels.join("; "));
    const forged = [];
    for (const [kind, tok] of [["unsigned", unsignedToken()], ["signed by its own key", selfSignedToken()]]) {
      const me = (await s.bff("/me", { "X-Id-Token": tok, Authorization: `Bearer ${tok}` })).body;
      const list = await s.bff("/sessions", { "X-Id-Token": tok });
      forged.push(`${kind}: level ${me.level}, list ${list.status}`);
      if (me.level !== 0 || list.status !== 403) forged.push("UNEXPECTED");
    }
    check("local Viewer sends a forged X-Id-Token naming rum-privacy: still level 0", !forged.includes("UNEXPECTED"), forged.join("; "));
  } finally {
    await api("DELETE", `/api/admin/users/${id}`);
  }
  const root = await localLogin("admin", PASSWORD);
  const me = (await root.bff("/me")).body;
  check("local Admin: level 0 in groups mode (the org role is not read)", me.level === 0 && me.role === "Admin", JSON.stringify(me));
}

fs.mkdirSync(OUT, { recursive: true });
let rec;
try {
  const browser = await chromium.launch();
  try {
    rec = await record(browser, { otlp: OTLP, project: PROJECT, token: TOKEN });
  } finally {
    await browser.close();
  }
  const ids = await asOmar(rec);
  const lena = await asLena(rec, ids);
  await asNora(rec);
  await groupMove(lena);
  await localUsers();
} catch (err) {
  check("run", false, err.stack ?? String(err));
}
fs.writeFileSync(path.join(OUT, "clearance-idp.json"), JSON.stringify({ at: new Date().toISOString(), grafana: GRAFANA, rec, results }, null, 2));
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed; results: ${path.join(OUT, "clearance-idp.json")}`);
process.exit(failed ? 1 : 0);
