# Work checklist (single sorted list)

Consolidated on 2026-10-17 from `project/tracker/mvp.md`, `project/tracker/roadmap.md`, the 15 `project/agents/*/tracker.md` files, the latest agent summaries, `project/agents/sentry-demo/reports/bridge-vs-sdk.html` (gap report, PR #24) and `project/agents/sentry-demo/reports/sdk-overhead-ios.html` (device cost, PR #25).

**This file is the one place to pick work from.** `roadmap.md` keeps phase scope and verification notes, and agent trackers stay as run logs. Ids are kept from their source (A = bridge parity gap, B = founder backlog, C = cosmetic/plugin gap from the gap report, G = ouo SDK gap vs the bridge, Q = QA finding). Items new here have an N id.

Goal driving the order: two prospects on `@sentry/react-native`. Pitch path 3 first (keep Sentry, ingest through the bridge). Path 1 (feature-flag rollout to the ouo SDK) comes after the ouo SDK closes its gaps. Path 2-lite (ouo next to Sentry, ouo replay off) is cheap on the device (+0.6 MB, +2.5 ms start, +59 KB per 95 s on the simulator).

Blockers marked **[founder]** need an answer or an account from the founder.

## 0. In flight

- [x] PR #23 OpenFeature rollout (`ouo.rum.mode`): rebased onto main with #24's navigation wiring and #25's perf harness; merged 2026-10-17.

## 1. Before parallel work resumes (do while nothing else is running)

- [x] B5 Repo organisation: ADR, then one mechanical move (product code by component, user docs under `docs/`, agent/process material under one folder, link checker in CI). Layout approved by the founder 2026-10-17; done in batch 0 ([ADR-0010](../../docs/adr/0010-repository-layout.md)): process material under `project/`, `deploy/docker` is `deploy/compose`, one `docs/releasing.md`, CI job `links`.
- [ ] B2 Named local environments (`ouo-env`, `<service>.<env>.ouo.localhost`, `gc` on merge, login admin / testing567). Every task below starts a stack. **Built 2026-10-17** (`deploy/envs/ouo-env`, [README](../../deploy/envs/README.md), [kb](../kb/ouo-env.md)): proxy, `up/down/ls/gc/url/env`, tests, AGENTS.md rule, verified on `sbx` (smoke + e2e) and a gc run. Open: migrate the founder's `ouo` stack into `main` (needs the founder's OK to stop it), and the stopped projects whose volumes remain (`ouo-8a`, `ouo-sb`, `ouo-taps`, `ouo-cmp`, `ouo-flags`): delete their volumes only on the founder's word.
- [x] N18 Org rename to `ouo11y` ([ADR-0009](../../docs/adr/0009-org-and-product-naming.md), accepted 2026-10-18, PR #27): repo transferred to `ouo11y/ouo11y` 2026-10-18; mechanical rename (Go modules, `@ouo11y/browser`, `@ouo11y/react-native`, plugin ID `ouo11y-rum-app` 0.7.0, `ghcr.io/ouo11y/*`, links, SwiftPM package `ouo11y-ios`) in PR #31; `docs/business/` and the roadmap timeline moved with history to the private `ouo11y/company`; `ouo11y/ouo11y-ios` created private with a README on branch `about`. Summary: `project/agents/orchestrator/summaries/2026-10-18-ouo11y-rename.md`.
- [ ] N19 Image release after the rename. **[founder]** push `rum-api-v0.3.0`, `collector-v0.3.0`, `grafana-v0.3.0` after a release PR (`docs/releasing.md`, "Next image release after the rename"). Until then `compose.images.yaml`, the Helm defaults and the VM `--images` mode point at `ghcr.io/ouo11y/*:0.2.0`, which does not exist; build from source. Then bump the pins and re-grant Read on the new packages.
- [x] N1 Tracker hygiene [done 2026-10-17 in batch 0: roadmap 8a row (#14, open items named), Phase 12 bridge line points at the bridge section, bridge section PR status (#16, #17, #23), release summary and changelogs record the 0.2.0 tags, stale Xcode / review rows in the ios-replay, sdk-react-native, qa, grafana-plugin, sdk-browser and platform-infra trackers resolved with their PRs, root `CHANGELOG.md` plugin 0.6.0 and image versions]. Was: Tracker hygiene left after this consolidation: roadmap 8a row (PR #14 merged, VM / publish / upgrade items still open), the Phase 12 line duplicating S1 to S4, the Sentry bridge section's PR status (#16, #17), the release summary "no tag pushed" (0.2.0 tags exist), stale "blocked: Xcode" and "review" rows in the ios-replay, sdk-react-native, qa, grafana-plugin, sdk-browser and platform-infra trackers, and root `CHANGELOG.md` listing the plugin at 0.3.0 while it is 0.6.0. Done after #23 merges, since #23 also edits `roadmap.md`.

## 2. Sentry path: client-ready bridge (P0)

Correctness first, then context, then UI. Effort from the gap report.

- [ ] A1 `captureMessage` below error becomes `sentry.message`, not an exception (3 errors shown where Sentry shows 2) [0.5 d]
- [ ] A5 HTTP client spans named `{method}` with `server.address`, `url.path` parsed (cardinality) [0.5 d]
- [ ] A2 Release, environment, OS and device on Sentry `log` records [0.5 d]
- [ ] A3 Device and OS context per `sid` / `did` on session and timeline records [1 d]
- [ ] A9 `session.previous_id` from the previous `sid` of the same `did` [0.5 d]
- [ ] A11 Back navigation from `navigation` breadcrumbs [1 d]
- [ ] A8 Timeline for sessions without a replay (error-event breadcrumbs, successful `http.client` spans) [2 d]
- [ ] A6 Error context allowlist (locale, connection, memory, thermal, foreground, current screen, app start) [~1 d]
- [ ] A7 Native crash frames keep `instruction_addr` / `image_addr` and `debug_meta` images [1 d]
- [ ] A4 Mobile vitals: cold / warm start, TTID, slow / frozen frames, stalls as timeline records with plugin display [~2 d]
- [ ] C5 `http.request.failed` severity: WARN from the bridge vs ERROR from the SDK; align (receiver)
- [x] C1 Stack trace shown in the plugin for errors [done 2026-10-23, PR #39, plugin 0.8.0, `project/agents/grafana-plugin/reports/b1-bridge-parity.html`]
- [x] C2 Session header shows device, OS, build, environment [done 2026-10-23, PR #39, plugin 0.8.0, `project/agents/grafana-plugin/reports/b1-bridge-parity.html`]
- [x] C3 Frames replays show "Taps 0" although touches are drawn [done 2026-10-23, PR #39, plugin 0.8.0, `project/agents/grafana-plugin/reports/b1-bridge-parity.html`]
- [x] C4 First screen shown at −2.7 s, before session start [done 2026-10-23, PR #39, plugin 0.8.0, `project/agents/grafana-plugin/reports/b1-bridge-parity.html`]
- [x] C6 Traces table names every ouo trace `HTTP GET` [done 2026-10-23, PR #39, plugin 0.8.0, `project/agents/grafana-plugin/reports/b1-bridge-parity.html`]
- [x] C7 Logs panel renders the ouo exception line as `session_previous_id=…` [done 2026-10-23, PR #39, plugin 0.8.0, `project/agents/grafana-plugin/reports/b1-bridge-parity.html`]
- [x] C8 Masking note is hard-coded; rum-api should store the chunk's `masked` flag and the plugin should show it [done 2026-10-23, PR #39, plugin 0.8.0, `project/agents/grafana-plugin/reports/b1-bridge-parity.html`]
- [x] B1 Session page: activity list only, Timeline panel behind `OUO_FEATURE_TOGGLES_ENABLE=sessionTimelinePanel` [done 2026-10-23, PR #39, plugin 0.8.0, `project/agents/grafana-plugin/reports/b1-bridge-parity.html`]
- [x] N2 Real Sentry upstream run [2026-10-18: self-hosted Sentry 26.10 (`sentry-sbx`, https://sentry.ouo.localhost), real-tap journey: 49/49 envelopes byte-identical, all 200, no rate-limit / 413 / auth issues; Sentry stored everything; ouo 19/21, the 2 misses are startup console lines without a session (not upstream-related); Sentry MCP `sentry-sbx` (user-level, read-only) reads replays; `project/kb/sentry-self-hosted.md`, `project/agents/sentry-demo/reports/sentry-self-hosted-n2-f4.html`]. **Changed by the founder 2026-10-17:** not a sentry.io run; self-hosted Sentry with a Sentry MCP. Still untested: a quota-limited Sentry (real 429 / `X-Sentry-Rate-Limits`).
- [ ] N3 Supported Sentry SDK range. **Founder 2026-10-17:** the prospects' platforms are unknown for now; assume React Native on iOS, Android later. Now: test the bridge against the current major `@sentry/react-native` (8.x; 8.30 captured) with golden tests per captured version. Medium term: native `sentry-cocoa` and `sentry-java` apps. Older majors (~7.11, the Expo default with cocoa 8.58) only if a prospect turns out to run one.
- [ ] B6 Bridge on Android (sentry-java envelopes and replay never captured). **Founder 2026-10-17:** assume the prospects add Android later; medium term, after the iOS React Native path (with N3's native sentry-java work).
- [ ] N4 Receiver state is in memory, so the bridge runs as one replica only. Document it for pilots now; shared state later (Phase 11).
- [ ] N5 Client setup notes: `propagateTraceparent: true` + `tracePropagationTargets` for backend correlation (needs an app release on their side); a `beforeBreadcrumb` filter if ouo runs alongside; never demo the bridge in parallel mode (ouo owns `traceparent`). C9 (~30 s duration difference) goes in the same notes.
- [ ] B8 Pitch kit (the material itself goes to the private `ouo11y/company` repo, ADR-0009): "point your DSN at ouo" one-pager, hosted demo env, one-page comparison built from the gap report and the device-cost numbers. **[founder]** where the hosted demo lives: still open (2026-10-17).

## 3. ouo SDK: earn the path-1 upgrade (P1)

The gap report found the ouo RN SDK behind the bridge on several points. Until these close, path 1 cannot be sold as "more data".

- [ ] G1 Native crashes (today a crashed session reads "terminated, healthy")
- [ ] G2 Vitals: app start, TTID, frames
- [ ] G3 Public span API and log API
- [ ] G4 Timeline parity: tap targets with component names, app lifecycle, successful requests
- [ ] G5 Device model without app code; trace id on errors; in-app frames and stable stack paths (no per-install container paths)
- [ ] G6 Forward `Sentry.captureException` errors when both SDKs run (parallel mode)
- [ ] N6 iOS replay capture holds the main thread for ~49 ms (Sentry ~18.5 ms, both on the simulator): move scaling and encoding off the main thread in `sdk/ios`. This is the main risk before anyone runs ouo replay in production. Measure before and after on the founder's iPhone 16 Pro Max (founder 2026-10-17: prefer it over the simulator for every performance number).
- [ ] N7 Rerun parallel replays: once, Sentry's replay stopped after 41 s while ouo's ran (not reproduced)
- [ ] N8 rum-api and plugin filter sessions and health by `ouo.rum.mode` cohort (needed to compare cohorts from #23)
- [ ] N9 Rollout edge from #23: a device that moves to `ouo` never sends sentry-cocoa's cached session end or a pending native crash; document it or flush before switching
- [ ] Q1 QA rev2 findings still reproducing: second exception after `session.end`, dev symbolicated traces, resource attributes in custom-event timeline, React dev double-reports the uncaught error (`crash_count 2`)
- [ ] Q2 Demo apps: `examples/mobile` has no replay endpoint variable and the baked `expo.extra` ignores env (R2-2); `examples/web` lacks `VITE_OUO_REPLAY_ENDPOINT` (R2-1)
- [ ] N10 Browser SDK: FCP / LCP / CLS / INP never observed in a foreground browser; multi-tab replay interleaving; CI bundle-size budget

## 4. Benchmark and releases (P1)

- [ ] B3 Fair, repeatable device-cost benchmark ouo vs latest stable Sentry, per major SDK release, regression blocks the release. Builds on the PR #25 harness. Real-device run on the founder's iPhone 16 Pro Max, available since 2026-10-17 and preferred over the simulator for every performance number (xctrace Activity Monitor, LAN proxy, CADisplayLink hitch monitor; LAN-IP ingest ports from `ouo-env url <env> --lan`).
- [ ] B4 Release every artefact from CI: npm SDKs, SwiftPM, plugin, collector, rum-api, Helm chart (OCI, `chart-v*`); release-please per component; compatibility matrix; one releasing doc; CHANGELOGs for `sdk/ios`, rum-api and the chart. **[founder]** npm org, `ouo11y-ios` mirror repo, Grafana signing token, and whether SDK tarballs keep source maps.
- [ ] B7 Supply chain: Renovate, govulncheck / npm audit / Trivy, SECURITY.md, provenance
- [ ] N11 rum-api CI: use a `services: minio` block instead of pulling `pgsty/minio` in the test

## 5. Platform: pilot-ready (P2, roadmap 8a to 8d)

- [ ] 8a VM install run on a fresh VM (`deploy/vm/install.sh`, plus an `--images` mode for the released images)
- [ ] 8a Upgrade from the previous release with existing replays, plus a start-up schema-version guard in rum-api
- [ ] N12 Helm unverified paths: S3 backend on kind (in-cluster MinIO), ingress with cert-manager, `x_forwarded_for`, `lgtm.mode=external`, HA values, `existingSecret`, collector replicas > 1 (rate buckets per pod)
- [ ] 8b Retention per signal; replay chunk lifecycle in the bucket (lifecycle rules + sweeper); delete by user / project with audit log; sampling in both SDKs; masking proof and DPA
- [ ] 8c Self-observability dashboards, alert rules, backup / restore drill, runbook
- [ ] 8d Five-minute demo recording, security questionnaire answers and data-flow diagram, pilot contract templates
- [ ] N13 Collector: auth-failure counter (401s invisible in Mimir, R2-3); empty OTLP requests bypass `ouoratelimit`; an `internal` project for rum-api's own telemetry; tag component modules (now `v0.0.0` + replace)
- [ ] N14 Token rotation: basicauth 0.160 cannot overlap tokens, but ADR-0007 promises an overlap. **Deferred by the founder 2026-10-17:** keep it as is and address it later (multi-token authenticator or a cut-over-only ADR change, decided then).
- [ ] N15 QA not exercised live: per-project bucket and quota, `key_from: x_forwarded_for`, foreign-origin CORS from a real browser, a stock OTel SDK with `OTEL_EXPORTER_OTLP_HEADERS`, plugin Viewer role, `background` end reason
- [ ] N16 Docs drift: `examples/fast-tracked/00-stack.md`, `project/kb/rrweb-chunking.md`, `project/kb/ios-replay.md` may still describe rum-api as the ingest gateway or replay sink; fast-tracked guides never run end to end by a fresh reader
- [ ] 8a exit criterion: a non-founder installs from docs on fresh Kubernetes and a fresh VM, resolves a staged incident, verifies retention and deletion, restores from backup

## 6. Gate: before this repo goes public

- [x] N21 **History purge** (founder 2026-10-18: "leave no traces of such files"). Done 2026-10-18 with `git filter-repo` on a mirror clone, force-pushed with the founder's approval (`--force-with-lease`): `docs/business/`, `reports/roadmap.html` and `project/reports/roadmap.html` removed from every commit, tag and branch; a client app name became `client-app`; the "What to tell the two clients" section of `bridge-vs-sdk.html`, the retainer-template line (now in the `ouo11y/company` tracker), the product-plan contents in the orchestrator tracker and one commit subject redacted. main 411f6f5 -> 9e17ab0; tags `*-v0.2.0` cd44e19 -> 7975bc6 (the 0.2.0 images' revision label still names cd44e19); the 29 merged branches deleted. Verified on a fresh clone: no business path, string or commit message left. **Accepted by the founder 2026-10-18 (no GitHub Support ticket):** the old commits stay reachable on GitHub through `refs/pull/*/head` and cached views while the repo is private, and PR #11 and #13 keep their original descriptions. Local clones and worktrees hold the old objects until cleaned (`project/kb/org-rename.md`, "History purge").
- [ ] N20 **Gate before going public: publish with a fresh history in a new public repository.** The purge (N21) cleaned branches and tags, but GitHub's PR refs, PR descriptions (#11, #13) and caches still reach the old commits, and that cannot be undone without GitHub Support (declined). So `ouo11y/ouo11y` itself is never made public: the public repo is a new one whose first commit is a snapshot of `main` (this one stays private as the full-history archive). Before the snapshot, scrub what is still in the tree if the founder wants it gone: the business-model sections of `docs/VISION.md`, the unnamed prospect / pitch-kit lines in this checklist, `project/tracker/roadmap.md` and summaries. Also needed for public: the lookalike claims and npm / grafana.com orgs (ADR-0009 points 7 and 8).

## 7. Later (roadmap phases, unchanged)

- [ ] Plugin: deprecated `Select` to `Combobox`; Playwright e2e
- [ ] Native symbolication (A7 keeps the addresses; symbolication itself is unscheduled); JS source maps for both paths (A10)
- [ ] rum-api: Tempo paging beyond 1000, read-side project scoping, cache `meta.json` per session in `decorateReplay`
- [ ] Phase 9 release health (version comparison, regression alerts) and public benchmark site with the other competitors (Datadog, Faro, OpenReplay)
- [ ] Phase 10 Android replay, Phase 11 scale and multi-project, Phase 12 migration kit, Phase 13 native SDKs, AI investigation experiment
- [ ] N17 Platform coverage (founder 2026-10-17): compare Sentry's SDK platform list with ouo's (browser, React Native, iOS replay today) and add each missing platform as a later phase. Long term: one ouo SDK spec with a conformance suite (Phase 13.0), implemented per platform in roadmap order.

## Founder decisions

Recorded 2026-10-17:

- (a) **ADR-0008 accepted** (2026-10-17). It was implemented and merged in #16 and #17; only the status line lagged.
- (b) **Prospect platforms unknown for now.** Assume React Native on iOS, Android later. Bridge tested against the current major `@sentry/react-native` now, native `sentry-cocoa` and `sentry-java` medium term (N3, B6). Long term one ouo SDK spec with a conformance suite, implemented in roadmap order; compare Sentry's platform list with ouo's and add what is missing as later phases (N17).
- (c) **N2 changed:** self-hosted Sentry with a Sentry MCP pointing at it, not sentry.io. Done 2026-10-18 (see N2).
- (d) **Token rotation (N14) deferred:** kept as is, addressed later.
- (e) **The founder's iPhone 16 Pro Max is available:** preferred over the simulator for every performance number (B3, N6).
- (f) **Hosted demo (B8):** still open.
- (g) **F4 verdict pending:** re-run done 2026-10-18 next to Sentry's own player (`project/agents/sentry-demo/reports/sentry-self-hosted-n2-f4.html`): plays unmasked in both; ouo's taps are clearer; ouo is worse on seek (black frame), counts an info message as an error, and has startup console lines without a session. The black frame on seek and the two clocks are fixed in plugin 0.8.0 (2026-10-23, `project/agents/grafana-plugin/reports/b1-bridge-parity.html`).
- Repo layout for B5 approved (ADR-0010).

Recorded 2026-10-18 (ADR-0009, accepted):

- (h) **Names:** org and repo `ouo11y/ouo11y`; browser SDK `@ouo11y/browser` (not `@ouo11y/web`); `ouo` stays the short name in code (`ouo.` attributes, `ouo*` collector components).
- (i) **Three repos:** `ouo11y/ouo11y` product, `ouo11y/ouo11y-ios` CI-published mirror, `ouo11y/company` always private for business material. The product may be open-sourced later (gate N20).

## Decisions waiting on the founder

1. Package publishing: npm org, deploy key for the `ouo11y-ios` mirror (repo created 2026-10-18), plugin signing, source maps in tarballs (B4). GHCR stays private until stable.
2. Where the hosted demo for B8 lives.
3. Verdict on the F4 unmasked Sentry recordings (re-run 2026-10-18 side by side with Sentry's player; see the report). Trust the ouo-env proxy CA once so https://sentry.ouo.localhost opens without a warning (`deploy/envs/README.md`).
4. Old stopped compose projects' volumes (`ouo-8a`, `ouo-sb`, `ouo-taps`, `ouo-cmp`, `ouo-flags`): keep or delete (B2).
5. Push the post-rename image tags (N19).
