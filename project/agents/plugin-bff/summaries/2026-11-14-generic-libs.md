# 2026-11-14 Generic plugin libraries (replaces PRs #189 and #191)

Branch `claude/plugin-libs-only-f7f124`, cut from `origin/main` at `c8e270fa`. Decision: [ADR-0025](../../../../docs/adr/0025-generic-libs-clients-own-plugin-and-access.md) (proposed).

## Why

Founder direction, 2026-11-14: clients build their own plugin backend and frontend and choose their own access model (their groups, a ladder, plain Grafana roles, or nothing); we ship generic libraries they may use or not. PRs #189 and #191 baked a fixed c0–c5 Clearance ladder into `libs/ouo-go` and built a BFF, a Session explorer and Keycloak wiring into our plugin. Only the libraries, the helpers and the knowledge come over.

## What was done

- **`libs/ouo-go`** (from #191's tip `ed860daa`, after both reviews' fixes): `clearance.go` and every `Clearance` argument removed. The reads are public and return raw typed data: `Loki.ListSessions`, `Loki.SessionEvents` (was `GetSession`; it no longer calls Muninn), `Loki.QueryRange`, `Loki.QueryVector`, `Muninn.ListReplays`, `Muninn.Manifest`, `Muninn.Chunk`, each validating its identifiers before LogQL or a path is built. The `Client` type is gone (the limits and clock moved onto `Loki`), and so are `Redacted`, `ReplaysError`/`ReplaysErr` and the level table. Kept: LogQL building, `truncated`, `user.id` fallback for the Sentry bridge, generic store errors (`BackendError.Public()`).
- **`libs/ouo-go/redact`** (new): `Identity` (exact `user.*` names plus `enduser.*` and `client.address`, both spellings), `Keys`, `Prefixes`, `Any`, and `Drop`, `Keep`, `Events`, `Manifest`. It maps nothing to anyone.
- **`libs/ouo-go/oidc`** (from #191's `oidc.go`): `Verifier.Verify` returns all verified claims, `Groups` the groups claim, `Strings` reads a string-or-list claim. JWKS, issuer, audience, expiry, asymmetric-only and one-fetch-a-minute checks unchanged, as are their tests (HS256 keyed with the real public key, `alg: none`, changed payload, foreign keys, provider down).
- **`libs/ouo-kit`** (`@ouo11y/kit` 0.1.0): `api.ts` (the BFF `v1` types and `bffPaths`) removed; `manifest.ts` keeps Muninn's manifest and replay-list types and `ChunkFetcher`. Publishable: not `private`, tsup build to `dist/` (ESM + `.d.ts`; React and `rrweb-player` external), `files`, `exports`, `publishConfig`, `CHANGELOG.md`. release-please component `kit` (config, manifest at 0.1.0, tag trigger), `release-npm.yml` maps `kit-v*` to `libs/ouo-kit`, `docs/releasing.md` rows. Not published.
- **CI**: `libs/ouo-go` in the Go matrix and the `go` path filter; `libs/ouo-kit` in the npm workspaces and the `node` path filter; `npm pack --dry-run -w libs/ouo-kit` in the node job.
- **kb** under `project/kb/plugin/`: `backend/grafana-backend-plugin.md` (rewritten for any client backend, with the traps the reviews found: Admin-made datasource instances, renamable logins, readable `jsonData`, leaking store errors), `backend/loki-answers.md`, `idp-tokens/idp-tokens-in-a-plugin-backend.md` (IdP tokens reach a plugin backend only through a datasource with `jsonData.oauthPassThru`; plus the attacks the verification held against and what it does not cover).
- **ADR-0025** superseding the unmerged ADR-0023 and ADR-0024, and deciding the top-level `libs/`. AGENTS.md layout line.

## Left out, on purpose

The plugin BFF (`plugins/ouo11y-rum-app/pkg`), the Session explorer pages, the nested `ouo11y-rum-datasource`, Keycloak and `compose.idp.yaml`, the `--idp`/`--muninn` changes to `ouo-env`, the Helm and Grafana image changes, `tests/e2e/plugin-bff`, the e2e HTML report, and ADR-0023/0024 as accepted decisions. **The BFF, explorer and e2e code on branches `claude/plugin-bff-player-3a00ee` (#189) and `claude/clearance-idp-groups-f56458` (#191) is reference material for the coming demo client ("client zero"), which will live in its own repository.** The plugin's MVP pages are as on `main`.

## Dependencies added

| Dependency | Where | Why |
|---|---|---|
| `github.com/go-jose/go-jose/v4` v4.1.9 | `libs/ouo-go` (`oidc` only) | JWS parsing with an algorithm allow-list and JWKS keys; the standard library has neither (carried over from #191) |
| `rrweb-player` 2.1.7 | `@ouo11y/kit` runtime | The rrweb renderer the player wraps; same version the plugin already uses |
| `tsup` ^8.5.1 | `@ouo11y/kit` dev | Builds the publishable `dist/` with types; same tool and version as `sdk/browser`, already in the lockfile |
| `@types/react` ^19, `typescript` ~5.9.3, `vitest` ^5.0.3 | `@ouo11y/kit` dev | Typecheck and tests; versions as elsewhere in the workspaces (typescript moved from the pin `5.9.2` to `~5.9.3`, as `sdk/browser`) |

## Verified, and how

- `cd libs/ouo-go && go mod verify && go vet ./... && go test -race -count=1 ./...`: ok for `ouogo`, `oidc`, `redact`. Reader table tests run against a fake Loki and a fake Muninn (gzip JSON and chunks, read token, tenant): list and event fields, `truncated` at both limits, the exact LogQL sent, validation with no store called, not-found and backend errors, `Public()` without URLs.
- `npm run typecheck -w libs/ouo-kit`: clean. `npm test -w libs/ouo-kit`: 5/5. `npm run build -w libs/ouo-kit` and `npm pack --dry-run -w libs/ouo-kit`: `dist/index.js`, `dist/index.d.ts`, map, README, LICENSE, CHANGELOG, package.json.
- Plugin unchanged: `lint` 0 errors (7 old `Select` warnings), `typecheck` clean, Jest 29 suites / 208 tests, `build` ok.
- `lychee --offline --no-progress --exclude-path node_modules --exclude-path /dist/ './**/*.md' './**/*.html'`: 0 errors.
- No stack was started; no env is left running.

## For the next agent

- `@ouo11y/kit` is first released by the founder: tag `kit-v0.1.0`, publish once by hand, then set the npm trusted publisher (docs/releasing.md section 5 and 8).
- `ouo-go` has no release line; clients import it by module path at a commit.
- A client that wants Clearance as #189/#191 had it: the level table, `Resolve` and `TestLevelsAgainstFields` are on #191's branch (`libs/ouo-go/clearance.go`, `ouogo_test.go`), written over the old API; with `redact` it is a table and a few `Drop` calls.
