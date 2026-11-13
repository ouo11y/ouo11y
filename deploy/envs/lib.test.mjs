// node --test deploy/envs/   (no dependencies; run in CI by the node job)
import assert from "node:assert/strict";
import { test } from "node:test";
import * as lib from "./lib.mjs";

test("slugify turns branch names into DNS labels", () => {
  assert.equal(lib.slugify("claude/batch0-ouo-env"), "batch0-ouo-env");
  assert.equal(lib.slugify("feat/Sentry_Bridge.v2"), "sentry-bridge-v2");
  assert.equal(lib.slugify("main"), "main");
  assert.equal(lib.slugify("claude/a-very-long-branch-name-that-goes-on-and-on-forever"), "a-very-long-branch-name-that-goe");
  assert.equal(lib.slugify("///"), "env");
  assert.ok(lib.validName(lib.slugify("claude/x--y-")));
});

test("validName rejects what is not a DNS label and the reserved proxy name", () => {
  for (const ok of ["main", "sbx", "pr-28", "a"]) assert.ok(lib.validName(ok), ok);
  for (const bad of ["", "-a", "a-", "A", "a.b", "a_b", "proxy", "x".repeat(33)]) assert.ok(!lib.validName(bad), bad);
});

test("hosts: main has no env label, the others do", () => {
  assert.equal(lib.urlOf("main", "grafana"), "http://grafana.ouo.localhost");
  assert.equal(lib.urlOf("sbx", "grafana"), "http://grafana.sbx.ouo.localhost");
  assert.equal(lib.urlOf("pr-28", "otlp"), "http://otlp.pr-28.ouo.localhost");
  assert.equal(lib.project("main"), "ouo-main");
});

test("port blocks: main keeps the SDK defaults, others never collide", () => {
  assert.deepEqual(lib.portsOf(0), { otlp: 4318, replay: 4319, sentry: 4320, backend: 8082 });
  assert.deepEqual(lib.portsOf(1), { otlp: 20010, replay: 20011, sentry: 20012, backend: 20013 });
  const seen = new Set();
  for (let b = 0; b < 100; b++) for (const p of Object.values(lib.portsOf(b))) { assert.ok(!seen.has(p)); seen.add(p); }
  assert.equal(lib.allocateBlock("main", [5]), 0);
  assert.equal(lib.allocateBlock("sbx", []), 1);
  assert.equal(lib.allocateBlock("pr-1", [0, 1]), 2);
  assert.equal(lib.allocateBlock("pr-2", [0, 1, 2, 4]), 3);
  assert.throws(() => lib.allocateBlock("x", Array.from({ length: 100 }, (_, i) => i)));
});

test("gc removes ephemeral envs whose PR merged or closed or whose branch is gone", () => {
  const d = (o) => lib.gcDecision({ pr: null, prUnknown: false, branchExists: true, ...o });
  assert.deepEqual(d({ env: "main", pr: { number: 1, state: "MERGED" }, branchExists: false }), { remove: false, reason: "protected" });
  assert.equal(d({ env: "sbx", branchExists: false }).remove, false);
  assert.deepEqual(d({ env: "x", pr: { number: 28, state: "MERGED" } }), { remove: true, reason: "PR #28 merged" });
  assert.deepEqual(d({ env: "x", pr: { number: 29, state: "CLOSED" } }), { remove: true, reason: "PR #29 closed" });
  assert.deepEqual(d({ env: "x", pr: { number: 30, state: "OPEN" } }), { remove: false, reason: "PR #30 open" });
  assert.deepEqual(d({ env: "x", branchExists: false }), { remove: true, reason: "branch gone" });
  assert.deepEqual(d({ env: "x" }), { remove: false, reason: "branch exists, no PR yet" });
  // gh offline or not logged in: never delete on a guess, even if the branch looks gone.
  assert.equal(d({ env: "x", prUnknown: true, branchExists: false }).remove, false);
  // An open PR keeps the env even if the local branch was deleted (worktree cleaned up).
  assert.equal(d({ env: "x", pr: { number: 31, state: "OPEN" }, branchExists: false }).remove, false);
});

test("formatAge", () => {
  assert.equal(lib.formatAge(5 * 60e3), "5m");
  assert.equal(lib.formatAge(3 * 3600e3), "3h");
  assert.equal(lib.formatAge(72 * 3600e3), "3d");
  assert.equal(lib.formatAge(NaN), "-");
});

test("ls merges state files with running projects", () => {
  const now = Date.parse("2026-10-17T12:00:00Z");
  const rows = lib.lsRows({
    now,
    states: [
      { env: "pr-28", kind: "ephemeral", branch: "claude/x", created: "2026-10-17T10:00:00Z", block: 2 },
      { env: "main", kind: "main", branch: "main", created: "2026-10-15T12:00:00Z", block: 0 },
      { env: "sbx", kind: "sbx", branch: "claude/y", created: "2026-10-17T11:30:00Z", block: 1 },
    ],
    running: { main: { up: 7, total: 7 }, "pr-28": { up: 5, total: 7 }, stray: { up: 1, total: 1 } },
    prs: { "pr-28": { pr: { number: 28, state: "OPEN" } } },
  });
  assert.deepEqual(rows.map((r) => r.env), ["main", "sbx", "pr-28", "stray"]);
  assert.equal(rows[0].status, "up");
  assert.equal(rows[0].age, "2d");
  assert.equal(rows[0].ingest, ":4318");
  assert.equal(rows[1].status, "down");
  assert.equal(rows[2].status, "5/7 up");
  assert.equal(rows[2].pr, "#28 open");
  assert.equal(rows[2].ingest, ":20020");
  assert.equal(rows[3].branch, "?"); // running but no state file: shown, not hidden
  const t = lib.table(rows, ["env", "status"]);
  assert.match(t.split("\n")[0], /^ENV\s+STATUS$/);
});

test("overlay: labels, routes, published ingest ports, no other host ports", () => {
  const y = lib.renderOverlay({ env: "sbx", kind: "sbx", branch: "b", pr: "", session: "s1", created: "2026-10-17T00:00:00Z", block: 1, src: "/src" });
  assert.match(y, /"ouo\.env=sbx"/);
  assert.match(y, /"ouo\.session=s1"/);
  assert.match(y, /traefik\.http\.routers\.ouo-sbx-grafana\.rule=Host\(`grafana\.sbx\.ouo\.localhost`\)/);
  assert.match(y, /loadbalancer\.server\.port=4319/);
  assert.match(y, /"20010:4318"/);
  assert.match(y, /"20013:8081"/);
  for (const svc of lib.UNPUBLISHED) assert.match(y, new RegExp(`  ${svc}:[\\s\\S]*?ports: !reset \\[\\]`));
  assert.match(y, /"\/src\/deploy\/compose\/rum-api\/config\.yaml:\/etc\/rum-api\/config\.yaml:ro"/);
  assert.match(y, /- rum-api-data:\/data/);
  assert.match(y, /GF_SECURITY_ADMIN_PASSWORD: "testing567"/);
  assert.match(y, /GF_SERVER_ROOT_URL: "http:\/\/grafana\.sbx\.ouo\.localhost\/"/);
  // every service block appears once (duplicate YAML keys would silently drop config)
  for (const svc of ["grafana", "rum-api", "otel-collector", "backend"]) assert.equal(y.split(`\n  ${svc}:\n`).length, 2, svc);
});

test("overlay with --muninn: Muninn routed, its and MinIO's loopback ports dropped; without it, no Muninn service", () => {
  const base = { env: "x1", kind: "ephemeral", branch: "b", pr: "", session: "", created: "2026-11-13T00:00:00Z", block: 2, src: "/src" };
  const y = lib.renderOverlay({ ...base, muninn: true });
  assert.match(y, /traefik\.http\.routers\.ouo-x1-muninn\.rule=Host\(`muninn\.x1\.ouo\.localhost`\)/);
  assert.match(y, /loadbalancer\.server\.port=3400/);
  for (const svc of lib.MUNINN_UNPUBLISHED) assert.match(y, new RegExp(`\\n  ${svc}:\\n[\\s\\S]*?ports: !reset \\[\\]`));
  for (const svc of ["muninn", "minio", "muninn-init"]) assert.equal(y.split(`\n  ${svc}:\n`).length, 2, svc);
  const plain = lib.renderOverlay(base);
  assert.doesNotMatch(plain, /muninn|minio/);
  assert.match(lib.exportsOf("x1", 2, true), /export OUO_MUNINN_URL=http:\/\/muninn\.x1\.ouo\.localhost/);
  assert.doesNotMatch(lib.exportsOf("x1", 2), /MUNINN/);
});

test("env exports point the scripts at the env", () => {
  const e = lib.exportsOf("main", 0);
  assert.match(e, /export OUO_GRAFANA_URL=http:\/\/grafana\.ouo\.localhost/);
  assert.match(e, /export OUO_OTLP_URL=http:\/\/localhost:4318/);
  assert.match(e, /export OUO_GRAFANA_AUTH=admin:testing567/);
});

test("parseArgs", () => {
  assert.deepEqual(lib.parseArgs(["up", "main", "--ref", "origin/x", "--purge", "--src=/a"]), { _: ["up", "main"], flags: { ref: "origin/x", purge: true, src: "/a" } });
});

test("the collector's Sentry bridge is sentry-bridge; sentry is the external self-hosted Sentry", () => {
  const y = lib.renderOverlay({ env: "main", kind: "main", branch: "main", pr: "", session: "", created: "2026-10-18T00:00:00Z", block: 0, src: "/src" });
  assert.match(y, /Host\(`sentry-bridge\.ouo\.localhost`\)/);
  assert.doesNotMatch(y, /Host\(`sentry\.ouo\.localhost`\)/);
  const d = lib.renderProxyDynamic();
  assert.match(d, /rule: Host\(`sentry\.ouo\.localhost`\)/);
  assert.match(d, /entryPoints: \[websecure\]\n {6}service: ext-sentry\n {6}tls: \{\}/);
  assert.match(d, /url: "http:\/\/host\.docker\.internal:9000"/);
  assert.match(d, /certFile: \/etc\/ouo-proxy\/tls\/server\.pem/);
});

test("the proxy certificate covers ouo.localhost and one label below it", () => {
  const e = lib.tlsExtFile();
  assert.match(e, /^subjectAltName=DNS:ouo\.localhost,DNS:\*\.ouo\.localhost,DNS:localhost,IP:127\.0\.0\.1$/m);
  assert.match(e, /extendedKeyUsage=serverAuth/);
  assert.match(e, /CA:FALSE/);
});

test("every env route is also served on https by the websecure router", () => {
  const y = lib.renderOverlay({ env: "sbx", kind: "sbx", branch: "x", pr: "", session: "", created: "2026-10-23T00:00:00Z", block: 1, src: "/src" });
  assert.match(y, /traefik\.http\.routers\.ouo-sbx-grafana-tls\.rule=Host\(`grafana\.sbx\.ouo\.localhost`\)/);
  assert.match(y, /ouo-sbx-grafana-tls\.entrypoints=websecure/);
  assert.match(y, /ouo-sbx-grafana-tls\.tls=true/);
  assert.match(y, /ouo-sbx-grafana-tls\.service=ouo-sbx-grafana"/);
  assert.match(y, /https:\/\/\*\.ouo\.localhost/);
});

test("the certificate names cover every env one label below ouo.localhost", () => {
  assert.deepEqual(lib.tlsNames(["main", "sbx", "pr-28", "sbx"]), ["ouo.localhost", "*.ouo.localhost", "*.pr-28.ouo.localhost", "*.sbx.ouo.localhost", "localhost"]);
  assert.deepEqual(lib.tlsNames(), lib.TLS_NAMES);
  assert.match(lib.renderProxyDynamic(lib.EXTERNAL, lib.tlsNames(["sbx"])), /^# certificate names: .*\*\.sbx\.ouo\.localhost/m);
});

test("env services stay off the shared proxy network, so service names never cross envs", () => {
  const y = lib.renderOverlay({ env: "sbx", kind: "sbx", branch: "x", pr: "", session: "", created: "2026-10-24T00:00:00Z", block: 1, src: "/src" });
  assert.doesNotMatch(y, /ouo-proxy/);
  assert.doesNotMatch(y, /^\s+networks:/m);
  assert.match(y, /traefik\.docker\.network=ouo-sbx_default/);
  assert.equal(lib.envNetwork("sbx"), "ouo-sbx_default");
});
