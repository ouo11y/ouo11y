# plugin-demo tracker

## Plan (2026-11-13)

State at start: PR #189 (first BFF slice) and PR #191 (ADR-0024, Clearance from IdP groups) are open; `claude/plugin-bff-full` (second slice, 21/21 e2e) is pushed without a PR. One PR at a time; each is reviewed by a second session, carries `Review:` and `Author: agreed`, has green CI, and then waits for the founder.

| # | PR | Branch | Depends on | Content |
|---|---|---|---|---|
| 1 | `feat(plugin): pixel replay players, Clearance by team and project, traces (ADR-0023)` | `claude/plugin-bff-full` commits on a branch from `origin/main` | #189 merged | Step 1: the second slice as built, rerun checks and e2e; if #191 merged first, one ordered resolution rule (login, IdP group, team, role, project) with a table test, order written in ADR-0023 |
| 2 | `feat(plugin): funnels and the overview on the spec wire (ADR-0025)` | `claude/plugin-funnels-overview` (stacked) | PR 1 merged | Step 2: `ouo-go` funnels (steps, conditions, failed outcome, drop-off sessions) and overview (health, sessions over time, top errors, web and mobile vitals from Loki; backend rate, errors and latency from Mimir span metrics); BFF endpoints with Clearance; `ouo-kit` FunnelChart, SessionTable, Timeline, `useBff`; plugin pages |
| 3 | `feat(examples): one-command demo, web and mobile shop flow, three Clearance users` | stacked | PR 2 | Step 3: `ouo-web` on `@ouo11y/browser` 0.4.1, `ouo-mobile` on `@ouo11y/react-native` 0.4.0, shared browse → cart → checkout → pay flow with a failure path, replay in `structure/dom`, `pixel/frames`, `pixel/video`; demo users at c1, c3, c5; `deploy/envs/ouo-env demo`; e2e web in Chrome and mobile in the iOS Simulator |
| 4 | `feat(libs): releasable @ouo11y/kit 0.1.0 and ouo-go (ADR-0026)` | stacked | PR 3 | Step 4: kit build (ESM, types, CSS, exports, peers, size check), release-please for kit, ouo-go and the plugin; stability promise; API reference in each README; what the founder does by hand |
| 5 | `feat(examples): plugin-starter on ouo-go and @ouo11y/kit, and the walkthrough` | stacked | PR 4 | Step 5: `examples/plugin-starter` (Go backend < 200 lines, a few frontend files), CI build, ouo-env; walkthrough HTML in `project/kb/plugin/` and Markdown in `docs/` |

Step 6 (only when the founder asks), not started:

- Remove `services/rum-api`: its CI jobs, image, release-please component, compose service, Helm templates, the plugin's route proxy and `rumApiUrl`, docs that point at it; the sourcemap / symbolication path must move first (ADR-0022, PR #186).
- Remove the MVP pages (Overview, Sessions, SessionDetail, Funnels, their components and `src/api`): after PR 2's pages replace them; open PRs #162, #165, #166, #168 touch them.
- Muninn in the Helm chart: a Deployment or StatefulSet with an object store (S3/MinIO values), its OTLP ingest Service for the Collector's `otlp_http/muninn` exporter, the read token Secret wired to `grafana.plugin.muninnReadTokenSecret`, the spec-wire Collector config in the chart.

## Log

| Date | Event |
|---|---|
| 2026-11-13 | Took stock: #189 and #191 open, so step 2 starts on `claude/plugin-funnels-overview`, stacked on `claude/plugin-bff-full` with `origin/main` merged in |
