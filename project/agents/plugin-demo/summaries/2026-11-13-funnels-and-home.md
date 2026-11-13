# 2026-11-13 Funnels and the Home page on the spec wire (step 2)

Branch `claude/plugin-funnels-overview`, stacked on `claude/plugin-bff-full` (the second BFF slice, itself on PR #189) with `origin/main` merged in. No pull request yet: #189 is open, and the second slice's PR comes first (one PR at a time). The founder merges.

## What was done

- **[ADR-0025](../../../../docs/adr/0025-funnels-and-home-in-the-bff.md)** (proposed): the funnel engine and the landing page move into `ouo-go` on the spec wire; definitions provisioned in plugin settings; Clearance per view; Home reads Loki and Mimir; reusable frontend pieces in `ouo-kit`. Four founder questions.
- **`ouo-go`**: `funnel.go` (steps, conditions `=` `!=` `=~`, failure event, `WalkFunnel`, `FunnelPaths`, `FunnelReportOf`, `RunFunnel`, `FunnelDropped`, `PlatformOf`), `overview.go` (`GetOverview`, a `Mimir` client over Tempo's span metrics). The MVP engine's rules (`services/rum-api/internal/funnel`) plus PR #168's conditions and failed outcome; page steps match web `browser.navigation` (path of `url.full`) and mobile `navigation` (`url.path`).
- **BFF**: `/v1/overview`, `/v1/funnels`, `/v1/funnels/{id}`, `/v1/funnels/{id}/steps/{n}/sessions`; `mimirUrl` and `funnels` settings; invalid definitions are skipped and named to Admins.
- **`ouo-kit`**: `createBffClient` + `BffError.forbidden`, `useBff` (Clearance-aware), `SessionTable`, `Timeline`, `FunnelChart`, format helpers, a CSS-custom-property theme (`themeStyle`).
- **Plugin**: Home (`/a/ouo11y-rum-app/home`, now the landing page) and Business flows (`/flows`); the Session explorer uses the kit's table and timeline (`explore/format.ts` removed); MVP pages suffixed "(MVP)" in the nav; `KitTheme` maps Grafana's theme onto the kit.
- **Provisioning**: the `shop-checkout` funnel (product page, add to cart, checkout, pay by card, order placed) in compose; Helm `grafana.plugin.funnels` and `mimirUrl` from the chart's Mimir.
- **e2e** `tests/e2e/plugin-bff`: steps 6 (flows) and 7 (home); the page now also navigates to `/products/7`, records `cart.add`, `checkout.start` and an exception; mobile-shaped sessions (iOS converts, Android abandons) and server spans are sent as OTLP; `@ouo11y/browser` pinned to the released 0.4.1.
- **Found on the way**: the browser SDK 0.4.1 sets no `ouo.platform` (ADR-0025 Q4; `PlatformOf` derives `web`); after `ouo-env up` rebuilt the backend, Grafana kept the old process until restarted (kb).

Dependencies: `libs/ouo-kit` declares `react-dom` (`>=18`) and `@types/react-dom` as dev dependencies, for `renderToStaticMarkup` in the chart test (already in the tree through the plugin). Nothing else.

## Verified, and how

| Check | Command | Result |
|---|---|---|
| `ouo-go` | `cd libs/ouo-go && go vet ./... && go test -race ./...` | pass (new: `TestWalkFunnel` 11 cases, `TestFunnelReport`, `TestFunnelValidate`, `TestRunFunnelClearance`, `TestOverview`, `TestPlatformOf`) |
| Plugin backend | `cd plugins/ouo11y-rum-app && go vet ./... && go test ./...` | pass (new: `TestFunnelEndpoints`) |
| `ouo-kit` | `npm test -w libs/ouo-kit`, `npm run typecheck -w libs/ouo-kit` | 16/16, clean |
| Plugin frontend | `npm run -w plugins/ouo11y-rum-app typecheck`, `lint`, `test` | clean; 0 errors (8 old warnings); 31 suites, 212 tests |
| Helm | `helm lint`, `helm template -f values-kind.yaml` with and without funnels | clean; `mimirUrl` and `funnels` rendered |
| End to end | `tests/e2e/plugin-bff/run.mjs` in env `pdemo` (`ouo-env up pdemo --muninn`), Google Chrome 157, `@ouo11y/browser` 0.4.1 | 32/32, below |

```text
PASS  admin: BFF lists the session with its user and a replay hint  (17 events, user e2e-user-fe3dde48)
PASS  admin: the session is in the Session explorer list
PASS  admin: the session page shows the event timeline  (17 events: session.start, browser.navigation, browser.navigation_timing, browser.web_vital, browser.user_action.click, session.end, cart.add, checkout.start, exception, ouo.replay.ended)
PASS  admin: the session answer carries attributes, the user and the replay list  (replays 1, redacted [])
PASS  admin: the replay plays the recorded DOM (marker text in the player's iframe)  (iframe #marker = "plugin-bff-marker-fe3dde48")
PASS  admin: the replay reaches the rows added during the session  (5 rows in the replayed DOM)
PASS  admin: manifest and chunks came from the BFF  (3 chunks, 5574 bytes decompressed, formats rrweb/2)
PASS  viewer: Clearance level c1  ({"login":"e2e-viewer","role":"Viewer","level":1,"can":{"timeline":true,"attributes":false,"replay":false,"identity":false,"unmasked":false}})
PASS  viewer: list answer has the session without its user  (redacted [attributes,replay,identity])
PASS  viewer: session answer has the timeline without attributes or body  (17 events, keys time,name,severity,view_id)
PASS  viewer: session answer has no user and replays null  (redacted [attributes,replay,identity])
PASS  viewer: the page made no replay request  (/v1/me /v1/sessions /v1/me /v1/projects/demo/sessions/7d8866c12a575bd6ed431f636065bc46)
PASS  viewer: the user id appears in no BFF response
PASS  viewer: manifest and chunk answer 403  (manifest 403, chunk 403: {"error":"clearance too low"}
PASS  pixel: ouo-frames/3 draws the full frame and then the patch on the canvas  (drawn up to +1000 ms, corner rgb 196,48,48, centre rgb 43,108,176, canvas 300x400)
PASS  pixel: ouo-video/1 decodes in the <video> (H.264 segment)  ({"w":402,"h":874,"ready":4,"err":0,"t":0.0009})
PASS  traces: the session page lists the session's traces from Tempo  (1 rows: documentLoad 72 ms)
PASS  access: admin (c5) reads the unmasked replay  ({"listed":1,"manifest":200,"chunk":200,"message":""})
PASS  access: an Editor (c3) gets 403 'needs c5' for the unmasked replay, 200 for a masked one  (unmasked {"listed":1,"manifest":403,"chunk":403,"message":"clearance too low: the replay was recorded without masking and needs c5"}, masked {"listed":1,"manifest":200,"chunk":200,"message":""})
PASS  access: a Viewer in team e2e-support gets c3 in the org and c4 in project demo  (org 3 ["e2e-support"], demo 4, elsewhere 3)
PASS  access: at c4 in project demo the timeline carries attributes and the replay list  (redacted [])
PASS  flows: the provisioned funnel is listed  (shop-checkout)
PASS  flows: web and mobile sessions in one funnel, the drop at Pay split into failed and abandoned  (sessions/dropped/failed per step: 3/0/0 3/0/0 2/1/0 1/1/1 1/0/0)
PASS  flows: the failed drop-off is the web session, with its user for admin; the abandoned one is Android  (failed {"project":"demo","id":"7d8866c12a575bd6ed431f636065bc46","platform":"web","last_step_at":1794581166419,"outcome":"failed","failed_with":"exception","user":"e2e-user-fe3dde48"}, abandoned android)
PASS  flows: from the failed drop-off to the session page, and its replay plays  (iframe #marker = "plugin-bff-marker-fe3dde48")
PASS  flows: a Viewer (c1) gets the same counts and the drop-off list without users  (counts 3,3,2,1,1, redacted [identity])
PASS  home: session health by platform (web errored, iOS and Android healthy)  (totals {"sessions":6,"errored":1,"crashed":0,"health":83.33,"crash_free":100}, platforms android,ios,web)
PASS  home: the web session's exception is a top error with its message (admin)  (1x card declined by the e2e bank)
PASS  home: web vitals from the browser session  (fcp 68, lcp 68, ttfb 6)
PASS  home: mobile vitals from the iOS session (cold start, TTID, slow and frozen frames)  ({"ios/app_start_cold":812.5,"ios/frozen_frames":1,"ios/slow_frames":4,"ios/ttid":240})
PASS  home: the backend's server spans read back from Mimir (Tempo span metrics)  ({"service":"shop-api-e2e","rate_per_sec":0.4,"error_pct":9.09,"p95_ms":124.8})
PASS  home: a Viewer (c1) gets the numbers but no error message or type  (sessions 6, redacted [attributes])
32/32 passed; report: /Users/ziadhassanin/Desktop/personal/ouo/.claude/worktrees/plugin-full-demo-1cd58c/tests/e2e/plugin-bff/out/report.html
```

Report with screenshots (Business flows with the failed drop-off list, the replay opened from it, Home): [reports/2026-11-13-e2e-funnels-home.html](../reports/2026-11-13-e2e-funnels-home.html).

## What is left

- PR #189 merged, then the second slice's PR (step 1), then this branch's PR (rebased on the merged slice).
- If #191 merges first: one ordered Clearance resolution rule (login, IdP group, team, role, project) with a table test, written in ADR-0023 (step 1).
- Steps 3 to 5 (demo apps and one-command demo, releasable libraries, starter plugin and walkthrough); step 6 on the founder's word.
- The e2e is not in CI (it needs a `--muninn` stack and Chrome), as before.

## What the next agent must know

- After a backend change, `docker restart ouo-<env>-grafana-1` before testing, or the old binary answers.
- Funnel counts in the e2e are read over the test's own window (`from` = test start), so earlier runs in the same env do not disturb them; the UI's 24 h view does include them.
- Env `pdemo` is left **running**: `http://grafana.pdemo.ouo.localhost` (admin / testing567; e2e users `e2e-viewer`, `e2e-editor`, `e2e-teamed`, passwords `<login>-local-only`). Down with `deploy/envs/ouo-env down pdemo`.
