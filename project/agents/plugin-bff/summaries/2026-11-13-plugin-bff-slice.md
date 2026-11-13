# 2026-11-13 Plugin BFF slice: ouo-go, Clearance, backend, ouo-kit player, Session explorer

Branch `claude/plugin-bff-player-3a00ee`, cut from `origin/main` at `e39a938d` (#185). One pull request; the founder merges.

## What was done

- **[ADR-0023](../../../../docs/adr/0023-plugin-bff-and-clearance.md)** (proposed): the plugin's own Go backend is the BFF; `ouo-go` and `ouo-kit` live in a new top-level `libs/`; the existing plugin is extended in place and its MVP pages are left to die with rum-api; the five `v1` resources; Clearance levels 0 to 5; direct Loki and Muninn URLs; ten founder questions (section 7), built on the recommendations.
- **`libs/ouo-go`** (Go module, standard library only): `ListSessions`, `GetSession` (Loki), `GetManifest`, `GetChunk` (Muninn, gzip read as stored then decompressed), each taking a `Clearance`; the level table in `clearance.go`; `Resolve` (login, then org role, else 0); redaction by building up from empty. Tests include `TestLevelsAgainstFields`, a table of the six levels against nine fields of the answers.
- **Plugin backend** (`plugins/ouo11y-rum-app/pkg`, `grafana-plugin-sdk-go` v0.299.0): resource handlers over `ouo-go`; 400, 403, 404, 502 mapping; a test that drives `CallResource` with Viewer, Admin, level-0 and no user. `scripts/build-backend.mjs` builds `gpx_ouo11y-rum-app_linux_{amd64,arm64}` into `dist/` after webpack, with local Go or the `golang` image.
- **`libs/ouo-kit`** (`@ouo11y/kit`, private workspace package, imported from source): the BFF's types and paths; `ReplayPlayer` (manifest + chunk fetcher; stream picker; runs from a keyframe to the first gap, RDR-3; concatenates a run before parsing NDJSON); `RrwebPlayer` (the MVP wrapper without Grafana styling); a format registry: `rrweb/2` plays, `ouo-frames/3` and `ouo-video/1` are the named seam, anything else is "stored, not playable". Vitest.
- **Frontend**: "Session explorer" (`/a/ouo11y-rum-app/explore`) with a range picker and a clearance badge and note; the session page with the event timeline (click for attributes) and the replay beside it. `src/explore/bff.ts` is the only client. Jest test for both pages at c1.
- **ouo-env**: the provisioning file sets `lokiUrl`, `muninnUrl`, `muninnTenant`, `clearance` and `muninnReadToken` (from `compose.muninn.yaml`); `ouo-env` rebuilds the plugin when `libs/` changes. CI: `libs/ouo-go` and the plugin in the Go matrix; `libs/` in the node and grafana-image path filters.

Dependencies added: `github.com/grafana/grafana-plugin-sdk-go` v0.299.0 (Grafana's SDK for backend plugins; the only way Grafana runs a backend and passes the user). `@ouo11y/kit` uses the plugin's existing `rrweb-player` 2.1.7 and the repo's `vitest`. `tests/e2e/plugin-bff` pins `@ouo11y/browser` 0.4.0, `esbuild` 0.27.7 and `playwright` 1.64.1, as `tests/e2e/muninn` does.

## Verified, and how

| Check | Command | Result |
|---|---|---|
| `ouo-go` | `cd libs/ouo-go && go vet ./... && go test ./...` | pass |
| Plugin backend | `cd plugins/ouo11y-rum-app && go vet ./... && go test ./...` | pass |
| `ouo-kit` | `npm test -w libs/ouo-kit`, `npm run typecheck -w libs/ouo-kit` | 5/5, clean |
| Plugin frontend | `npm run -w plugins/ouo11y-rum-app lint`, `typecheck`, `test` | 0 errors (only the MVP pages' old deprecation warnings), clean, 30 suites / 210 tests |
| Plugin build | `npm run -w plugins/ouo11y-rum-app build` | webpack + both binaries; the Docker fallback checked with Go off the `PATH` (`file`: ELF aarch64, static) |
| End to end | `tests/e2e/plugin-bff/run.mjs` in env `pluginbff` (`ouo-env up pluginbff --muninn`) | 14/14, below |

The e2e ran twice: with `@ouo11y/browser` built from PR #187's branch (`00b8a19c`, the first-keyframe fix, not released yet; `OUO_BROWSER_SDK_SRC`), and with the released 0.4.0 from npm. Both 14/14: this page starts its replay late enough that 0.4.0's first chunk already is a keyframe. Output of the PR #187 run:

```text
recorded session 231dc65957616bfe6b5c1a833c6cce68 (marker 6b2e89c0, SDK .../sdk187/sdk/browser/src/index.ts)
PASS  admin: BFF lists the session with its user and a replay hint  (13 events, user e2e-user-6b2e89c0)
PASS  admin: the session is in the Session explorer list
PASS  admin: the session page shows the event timeline  (13 events: session.start, browser.navigation, browser.web_vital, browser.navigation_timing, browser.user_action.click, session.end, ouo.replay.ended)
PASS  admin: the session answer carries attributes, the user and the replay list  (replays 1, redacted [])
PASS  admin: the replay plays the recorded DOM (marker text in the player's iframe)  (iframe #marker = "plugin-bff-marker-6b2e89c0")
PASS  admin: the replay reaches the rows added during the session  (5 rows in the replayed DOM)
PASS  admin: manifest and chunks came from the BFF  (3 chunks, 5574 bytes decompressed, formats rrweb/2)
PASS  viewer: Clearance level c1  ({"login":"e2e-viewer","role":"Viewer","level":1,"can":{"timeline":true,"attributes":false,"replay":false,"identity":false}})
PASS  viewer: list answer has the session without its user  (redacted [attributes,replay,identity])
PASS  viewer: session answer has the timeline without attributes or body  (13 events, keys time,name,severity,view_id)
PASS  viewer: session answer has no user and replays null  (redacted [attributes,replay,identity])
PASS  viewer: the page made no replay request  (/v1/me /v1/sessions /v1/me /v1/projects/demo/sessions/231dc65957616bfe6b5c1a833c6cce68)
PASS  viewer: the user id appears in no BFF response
PASS  viewer: manifest and chunk answer 403  (manifest 403, chunk 403: {"error":"clearance too low"})

14/14 passed
```

Screenshots (admin session page with the replay at its end, the five rows replayed; Viewer page with "Replays are hidden by your clearance") and every BFF response the Viewer received are in [reports/2026-11-13-e2e.html](../reports/2026-11-13-e2e.html). The MVP route proxy still answers 200 with the backend in place.

## Review round

A fresh-context review subagent reviewed PR #189 (the app refused to start a second session from this turn) and answered `Review: changes needed` with 17 findings. Fixed: chunk attributes in the manifest are stripped of identity below c4 (it was a leak at c3), the session user falls back to `user.id` (Sentry bridge), `GetSession` says `truncated` at its event limit, logins compare without case, backend failures answer "<store> could not be read" with the detail in Grafana's log, answers are `no-store`, plus the simplifications (Level is an integer only, `queryVector` and `sessionAgg` slimmer, no `Dispose`, runs computed once, URL defaults only in code, a Refresh button, a stream picker that follows a new manifest, Go caches kept by the Docker build). The ADR documents that a login override can be claimed by renaming a login. Kept: one lockfile per e2e folder, as every `tests/e2e/*` folder has. After the fixes: Go, Vitest, Jest (210), lint, typecheck, lychee and the e2e (14/14, PR #187 SDK) pass again.

## What is left

- The founder's answers to ADR-0023 Q1 to Q10.
- Pixel players: `ouo-frames/3` and `ouo-video/1` are named in the kit's format table and say "not wired yet". The MVP `FramePlayer` and `VideoPlayer` read the MVP wire and data types; porting them is the next slice, with an RN session in Muninn to test against.
- Teams in Clearance (needs a plugin service account), per-project Clearance, the c5 rule for unmasked recordings (Q10).
- Session list scaling (Q8): one bounded Loki read, `truncated` when hit.
- Tempo and Mimir: the session page shows trace ids only.
- Helm values for the new settings; the Grafana image carries the binaries already (they are in `dist/`).
- The e2e is not in CI: it needs a `--muninn` stack, as `tests/e2e/muninn` does.

## What the next agent must know

- `npm run build -w plugins/ouo11y-rum-app` now needs Go or Docker. CI jobs that build the plugin (node, examples, images, release) have Docker; on the rootless runners the script runs the container as root on purpose ([kb](../../../kb/plugin/bff/grafana-backend-plugin.md)).
- Attribute names reach the BFF with `_` for `.` ([kb](../../../kb/plugin/bff/loki-answers.md)); identity is matched by exact names plus `enduser_`, never `user_` (it would catch `user_agent_original`).
- Grafana gives every user the plugin's `jsonData`: keep secrets in `secureJsonData`.
- Env `pluginbff` (`http://grafana.pluginbff.ouo.localhost`, admin / testing567, user `e2e-viewer` added by the e2e) state is given in the PR's final comment.
