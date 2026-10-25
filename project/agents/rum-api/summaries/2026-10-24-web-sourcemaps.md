# 2026-10-24 Web source maps and symbolication (N36 part C, A10 web)

Session `web-c-sourcemaps`, branch `claude/web-sourcemaps-fa863c`, one of three parallel N36 sessions (A delivery, B page safety, C this one). Design: [ADR-0011](../../../../docs/adr/0011-source-maps-and-symbolication.md) (proposed). User guide: [docs/sourcemaps.md](../../../../docs/sourcemaps.md). Knowledge: [kb/sourcemaps-symbolication.md](../../../kb/sourcemaps-symbolication.md).

## Done

- **ADR-0011:**
  - A frame finds its map by debug id (TC39 `//# debugId=`, plus a runtime registration snippet), with release + URL path as the fallback.
  - Maps live in the rum-api bucket per project.
  - Uploads use a per-project secret upload token.
  - Symbolication happens on read in rum-api, with a cache. The raw stack in Loki is untouched.
  - Retention follows 8b.
  - React Native / Hermes reuse the same store.
- **SDK** (`sdk/browser/src/errors/classify.ts` only, plus a new `test/debug-ids.test.ts`): `exceptionAttributes` adds `ouo.exception.debug_ids`, a JSON map from script URL to debug id for the scripts the stack names. It reads `globalThis.__ouoDebugIds`, which the inject snippet keys by the bundle's own URL, so the SDK needs no regex. It never throws. That design was rebased on 2026-10-25 so that `index.js` fits its budget: 45,036 of 45,056 bytes.
- **Upload tool:** a new workspace package `sdk/sourcemaps` (`@ouo11y/sourcemaps`, bin `ouo-sourcemaps`, no runtime dependencies), with `inject`, `upload` and `inject-and-upload`.
  - It handles Vite `hidden` sibling maps, `sourceMappingURL` comments, Rollup's native debug ids and bundles that contain the SDK.
  - Options: gzip PUT, `--release`, `--url-prefix`, `--delete-after`, `--dry-run`, and environment variables.
- **rum-api:**
  - New `internal/sourcemap` package:
    - `FSObjects`, and S3 through the new `replay.Objects`;
    - `Store` with debug-id and release indexes, list, count, delete-project and sweep;
    - a V8 / SpiderMonkey / JSC / Hermes frame parser;
    - `Symbolicator` with an LRU and TTL cache, a miss cache, caller-name and enclosing-function names, and source context.
  - Endpoints: `PUT /v1/sourcemaps` (upload token), `GET /v1/sourcemaps` (read token) and `POST /v1/symbolicate` (read token). Exceptions in the session timeline and logs get a `symbolicated` field.
  - Config:
    - `projects.<id>.upload_token` / `OUO_UPLOAD_TOKENS`;
    - `retention.sourcemaps` (default 2160h), plus a per-project override;
    - `limits.max_sourcemap_bytes`;
    - `sourcemaps.cache_entries` and `sourcemaps.cache_ttl`;
    - a warning when map retention is shorter than log retention.
  - Delete-by-project removes the maps (`sourcemaps.deleted` in the audit entry). The sweeper expires them.
  - New dependency: `github.com/go-sourcemap/sourcemap` v2.1.4. It is the maintained v3 consumer Grafana Alloy's Faro receiver uses, BSD-2, with no transitive dependencies.
- **Plugin:** `StackTrace` opens on the original frames with a `source mapped` badge, three lines of source context around the first mapped frame, and an Original / Raw toggle. It is used in the Timeline, the activity list and the Logs panel. Types `Symbolicated` / `SymbolicatedFrame`.
- **Example `examples/ouo-web`:**
  - `vite build` with `sourcemap: "hidden"`;
  - `run.sh` injects, uploads with the demo upload token (release = app version) and deletes the maps before serving;
  - `verify.py` gets `check_symbolication`.
- **Stack:** `deploy/compose/compose.yaml` and `.env.example` set `OUO_UPLOAD_TOKENS=demo:ut_dev_demo_0000000000000000` (env only; the released rum-api ignores it).
- Docs: rum-api README (variables, section Source maps), `config.example.yaml`, rum-api and plugin CHANGELOG Unreleased, `docs/index.md`, ADR index, kb entry, checklist N41 and the A10 note.

## Verified

- `go test ./...` and `go vet ./...` in `services/rum-api` pass. New tests: the sourcemap package (real esbuild fixture, `testdata/gen.sh`), httpapi upload auth (401 for none / read / ingest / wrong token, 403 for another project), symbolicate, timeline and logs enrichment, config, and delete-by-project.
- Vitest passes: `sdk/browser` 111 tests (17 files), plus `size:check` (index.js 43.3 KB gzip, budget 44) and `tsc`; `sdk/sourcemaps` 9 tests, plus `tsc` and the tsup build.
- Plugin: `jest` 168 tests, `typecheck`, `lint` (no new warnings), prettier and `build` pass.
- **End to end on `ouo-env web-sourcemaps-fa863c`:** `examples/ouo-web/scripts/run.sh --env web-sourcemaps-fa863c --port 4273`. Port 4173 was held by another session's preview, and the journey hit that app first. The run uploaded 2/2 maps, and all four source-map checks passed:
  - the render error carries `ouo_exception_debug_ids`;
  - rum-api's session detail maps the top frame to `src/components/ChaosPanel.tsx:18:20`, function `RenderBomb`, with all 10 frames mapped and status `ok`;
  - the context line is the original `throw new Error`;
  - the raw minified stack is kept (`at $k (http://localhost:4273/assets/index-n7peY1ff.js:8:223609)`).
- Cost, measured on the M-series Mac: parsing ouo-web's 1.07 MB map takes 7.9 ms, and a lookup takes 12 ns.
- **Re-run with the ouo-env network fix (PR #65,** `envfix/deploy/envs/ouo-env up web-sourcemaps-fa863c --src <this worktree>`**):** `run.sh --env web-sourcemaps-fa863c --port 4273` passed **28/28** checks (Web Vitals, dead / rage clicks, boundary error, screen names, LoAF, the four source-map checks, interaction tracing, trace continuity). The first run's 10 failures came from the env collision that #65 fixes.
  - The env had two ephemeral envs up (`web-sdk-delivery-3e2993` too), and every service joined the shared `ouo-proxy` network under its compose name. The first run therefore had Loki and Tempo split between the envs.
- **Plugin in the browser** (env Grafana, session `439de7ee-a23f-48fb-91d6-b27dde5e388d`):
  - the exception in the activity list shows `source mapped`, and Original opens on `at RenderBomb (src/components/ChaosPanel.tsx:18:20)` with source lines 15 to 21;
  - React frames map to `node_modules/react-dom/cjs/react-dom.production.min.js`;
  - Raw shows `at $k (http://localhost:4273/assets/index-n7peY1ff.js:8:223609)`.
- **Session B's terser build** (`claude/web-sdk-safety-209ff7` at 5b6ef99, merged with this branch in a scratch worktree, nothing pushed):
  - terser keeps the `globalThis.__ouoDebugIds` read, and the merged SDK suite passes (131 tests);
  - terser writes `//# sourceMappingURL=` on the code's last line, which `inject` mishandled. Fixed with a trailing-comment parser, plus tests;
  - **B's `dist/*.map` were stale.** tsup 8.5.1 only chains terser's map when `terserOptions.sourceMap` is set, so the shipped map was esbuild's pre-terser map (9,228 lines against a 1-line file) and mapped nothing. With `sourceMap: true` (reported to the orchestrator for B), rum-api maps a terser frame to `src/errors/classify.ts:60:16` `debugIdsByUrl`, by debug id and by release.
  - The full ouo-web run built from that merged tree (B's terser SDK, `sourceMap: true`, this branch) against the env also passed **28/28**, with the render error at `ChaosPanel.tsx:18` `RenderBomb` and 10 of 10 frames mapped.
- Not verified: the S3 path of the map store (`replay.Objects`) is covered by build and review only. No MinIO run was done, so run `go test` with `OUO_TEST_S3_ENDPOINT` before a release.

## Left (checklist N41)

- A public upload path through `ouo-collector`. I asked the orchestrator whether I could touch `collector/` and got no answer, so this ships the rum-api-only version.
- npm publishing of `@ouo11y/sourcemaps`: the release-please component, the `release-npm.yml` tag, the trusted publisher, and a first publish by the founder.
- Helm values for the upload tokens and map retention.
- React Native / Hermes debug ids, and the Sentry bridge's `debug_meta` `sourcemap` images.
- A bundler plugin.

## Next agent must know

- In this worktree, `npm` and `npx` fail with "Exit prior to config file resolving" because the main checkout's `package.json` has merge-conflict markers (not touched). Use `npm --prefix <worktree>` or shims (kb entry).
- Env `web-sourcemaps-fa863c` (`http://grafana.web-sourcemaps-fa863c.ouo.localhost`, admin / testing567) was re-upped with #65's CLI for the re-run and torn down again after it (`ouo-env down`, volumes kept).
