# 2026-11-13 Plugin BFF second slice: pixel players, Clearance by team and project, unmasked at c5, traces, Helm

Branch `claude/plugin-bff-full`, stacked on PR #189 (`claude/plugin-bff-player-3a00ee`). Its pull request opens once #189 is merged (one PR at a time); the founder merges.

## What was done

- **`ouo-kit` pixel players** (`src/replay/pixel.ts`, `PixelPlayers.tsx`): `ouo-frames/3` on a canvas (the latest full JPEG, then the patches after it, touches for 500 ms) and `ouo-video/1` in a `<video>` (header line + mp4 per chunk, blob URLs, the replay clock as master, the last frame held in gaps). Shared clock and controls (play, position, speed). The format table now maps both to renderers. New components on the spec wire, not ports of the MVP players.
- **Clearance by team** (Q2): `clearance.teams`; the backend reads members of the named teams through Grafana's API with the plugin's managed service account (`plugin.json` `iam`: `teams:read`, `teams.permissions:read`, `org.users:read`), cached one minute; no token or a failed lookup resolves without teams. Compose turns on `externalServiceAccounts` and managed service accounts.
- **Clearance by project** (Q9): `clearance.projects.<p>.{roles,teams,users}` replaces the org level for that project when it matches. Every read takes the session's project level; the list drops sessions of projects at 0. `/me?project=` answers for one project.
- **Unmasked replays at c5** (Q10): a replay with a chunk whose `ouo.replay.masked` is false or absent answers 403 "recorded without masking and needs c5" below c5, for the manifest and every chunk (cached per replay, five minutes).
- **Traces** from Tempo (`libs/ouo-go/tempo.go`): TraceQL `{ span.session.id = "<id>" }`, c1, a table on the session page linking to Explore. Mimir: nothing session-scoped to read (ADR section 5).
- **Helm**: `grafana.plugin.muninnUrl`, `muninnTenant`, `muninnReadTokenSecret`, `clearance`; Loki and Tempo URLs from the chart's helpers.
- **Fix** found on the way: `bff.ts` built query strings with `URLSearchParams.size`, which jsdom and browsers before 2023 lack, so `from`/`to` were dropped there; now `toString()`. (Also in PR #189's code; current Chrome was unaffected.)
- ADR-0023 updated: section 4 (c5, teams, projects, enforcement), 5 (Tempo, Mimir, projects and Muninn keys), 6 (both slices), Q2/Q9/Q10 built.

No new dependency.

## Verified, and how

| Check | Result |
|---|---|
| `libs/ouo-go`: `go vet`, `go test -race` | pass; `TestLevelsAgainstFields` gained `unmasked` and `traces` columns; `TestTeamsAndProjects`, `TestTempoQueryAndError` |
| Plugin backend: `go vet`, `go test` | pass; `TestTeamsFromGrafana` (fake Grafana: team search, members, cache, no-token fallback) |
| `ouo-kit`: Vitest, typecheck | 11/11, clean |
| Plugin: lint, typecheck, Jest | 0 errors, clean, 210/210 |
| `helm lint`, `helm template` with the kind values | clean; provisioning and env rendered as intended |
| End to end in env `pluginbff`, Google Chrome 157 (`channel: "chrome"`), SDK from PR #187's branch | 21/21, below |

```text
browser: chrome 157.0.8103.52
recorded session fbcc4924c60deb7ba4632e4fb2eac2f2 (marker 8d66a209, SDK <PR #187 build>/sdk/browser/src/index.ts)
PASS  admin: BFF lists the session with its user and a replay hint  (13 events, user e2e-user-8d66a209)
PASS  admin: the session is in the Session explorer list
PASS  admin: the session page shows the event timeline  (13 events: session.start, browser.navigation, browser.navigation_timing, browser.web_vital, browser.user_action.click, session.end, ouo.replay.ended)
PASS  admin: the session answer carries attributes, the user and the replay list  (replays 1, redacted [])
PASS  admin: the replay plays the recorded DOM (marker text in the player's iframe)  (iframe #marker = "plugin-bff-marker-8d66a209")
PASS  admin: the replay reaches the rows added during the session  (5 rows in the replayed DOM)
PASS  admin: manifest and chunks came from the BFF  (3 chunks, 5574 bytes decompressed, formats rrweb/2)
PASS  viewer: Clearance level c1  ({"login":"e2e-viewer","role":"Viewer","level":1,"can":{"timeline":true,"attributes":false,"replay":false,"identity":false,"unmasked":false}})
PASS  viewer: list answer has the session without its user  (redacted [attributes,replay,identity])
PASS  viewer: session answer has the timeline without attributes or body  (13 events, keys time,name,severity,view_id)
PASS  viewer: session answer has no user and replays null  (redacted [attributes,replay,identity])
PASS  viewer: the page made no replay request  (/v1/me /v1/sessions /v1/me /v1/projects/demo/sessions/fbcc4924c60deb7ba4632e4fb2eac2f2)
PASS  viewer: the user id appears in no BFF response
PASS  viewer: manifest and chunk answer 403  (manifest 403, chunk 403: {"error":"clearance too low"}
PASS  pixel: ouo-frames/3 draws the full frame and then the patch on the canvas  (drawn up to +1000 ms, corner rgb 196,48,48, centre rgb 43,108,176, canvas 300x400)
PASS  pixel: ouo-video/1 decodes in the <video> (H.264 segment)  ({"w":402,"h":874,"ready":4,"err":0,"t":0.0162})
PASS  traces: the session page lists the session's traces from Tempo  (1 rows: documentLoad 68 ms)
PASS  access: admin (c5) reads the unmasked replay  ({"listed":1,"manifest":200,"chunk":200,"message":""})
PASS  access: an Editor (c3) gets 403 'needs c5' for the unmasked replay, 200 for a masked one  (unmasked {"listed":1,"manifest":403,"chunk":403,"message":"clearance too low: the replay was recorded without masking and needs c5"}, masked {"listed":1,"manifest":200,"chunk":200,"message":""})
PASS  access: a Viewer in team e2e-support gets c3 in the org and c4 in project demo  (org 3 ["e2e-support"], demo 4, elsewhere 3)
PASS  access: at c4 in project demo the timeline carries attributes and the replay list  (redacted [])
21/21 passed
```

Report with screenshots (rrweb, `ouo-frames/3` with the red patch over the blue frame, `ouo-video/1` playing the Sentry iOS segment): [reports/2026-11-13-e2e-second-slice.html](../reports/2026-11-13-e2e-second-slice.html).

Live findings, now in the kb ([grafana-backend-plugin.md](../../../kb/plugin/bff/grafana-backend-plugin.md), [pixel-replay-in-the-browser.md](../../../kb/plugin/bff/pixel-replay-in-the-browser.md)): team members come back as `[]` without `org.users:read`; Grafana makes a team's creator a member; two settings writes within one second leave the first in force; Playwright's Chromium has no H.264.

## What is left

- The founder's answers to ADR-0023's questions; PR #189 merged, then this branch's PR.
- Muninn in the Helm chart (`grafana.plugin.muninnUrl` points at it once it exists).
- `ouo-wireframe/1` (not built by any SDK yet), funnels, dashboards, vendor APIs, GraphQL, retiring rum-api and the MVP pages: outside this design.

## What the next agent must know

- A project's grants **replace** the org level when they match, so they can lower an Admin too (an Admin in a team listed for a project gets that team's level there).
- The e2e changes the plugin settings for its team/project step and writes them back; Grafana restarts re-apply provisioning anyway.
- Env `pluginbff` runs this branch (`http://grafana.pluginbff.ouo.localhost`, admin / testing567; e2e users `e2e-viewer`, `e2e-editor`, `e2e-teamed`, passwords `<login>-local-only`; team `e2e-support`). Down with `deploy/envs/ouo-env down pluginbff`.
