# Roadmap tracker (post-MVP)

> rum-api, the MVP Grafana plugin (`ouo11y-rum-app`) and the MVP replay path (`ouoreplay` receiver/exporter, :4319) were removed on 2026-11-15 (refactor!: remove rum-api, the MVP plugin and the MVP replay path). Text below that names them is the record of that time.

Phases from the post-MVP roadmap of 2026-10-10 (moved with the rest of the business material to the private `ouo11y/company` repo on 2026-10-18, ADR-0009); this tracker is the engineering copy of the phase scope. One stacked pull request per phase, as for the MVP. Week numbers assume one full-time engineer with agents, counted from the start of Phase 8. Sequencing decisions were taken in the 2026-10-10 founder interview recorded in the roadmap document; do not reorder without a new decision there.

| Phase | Proposed branch | PR | Weeks | Status | Owner agents (proposed) |
|---|---|---|---|---|---|
| 8a Install and secure | `phase-8a-install-secure` | #14 (merged 2026-10-16) | 1 to 3 | in-progress: edge, tokens, Helm and S3 store merged; VM install run, upgrade test and N12 Helm paths verified 2026-10-23 (PR #46); package publishing open | rum-api, sdk-browser, sdk-react-native, platform-infra, helm, grafana-plugin, release, qa |
| 8b Data lifecycle | `phase-8b-data-lifecycle` | | 4 to 5 | in review | rum-api, sdk-browser, sdk-react-native, platform-infra |
| 8c Operate | `phase-8c-operate` | | 6 to 7 | todo | platform-infra, rum-api |
| 8d Pilot kit | `phase-8d-pilot-kit` | | 8 | todo | orchestrator |
| 9 Release health + public benchmarks | `phase-9-release-health` | | 9 to 13 | todo | rum-api, grafana-plugin, new: benchmarks |
| 10 Android replay (Expo) | `phase-10-android-replay` | | 14 to 16 | todo | new: android-replay, sdk-react-native |
| 11 Scale foundation + multi-project | `phase-11-scale` | | 17 to 24 | todo | rum-api, platform-infra, qa |
| 12 Parallel-stack migration kit | `phase-12-migration-kit` | | 25 to 28 or pulled forward | todo | platform-infra |
| 13 Native SDKs (conformance suite, Swift, Kotlin, Flutter) | `phase-13-native-sdks` | | 29 onward | todo | first hire, qa |
| 14 Standalone UI | | | year two | todo | decision after tenth customer |

## Phase 8 Pilot-ready platform

Phase 8 ships as four stacked PRs (8a to 8d). 8a design: ADR-0007.

### 8a Install and secure

- [x] Helm chart: rum-api, collector, Grafana with plugin provisioned; values for existing LGTM versus bundled LGTM [helm agent 2026-10-10: `deploy/helm/ouo` lint and template clean; installed on kind `ouo-8a` in bundled mode with images from the tree, 6 pods Ready, 3 `helm upgrade`s, readyz, plugin 0.3.0 enabled with read token through the proxy, ingest 401/403/200 with `ouo.project.id=demo` in Tempo, replay chunk 202; external and HA values rendered only, not installed; `project/agents/helm/summaries/2026-10-10-phase-8a.md`]
- [x] One-command VM install: TLS via reverse proxy, systemd units, documented `.env` [platform-infra 2026-10-10: `deploy/vm/` written; compose override, Caddyfile (`caddy validate` in internal, ACME and unset modes) and a throwaway Caddy with fake upstreams served both hosts over TLS from the internal CA; platform-infra 2026-10-23: `install.sh` run end to end on fresh Ubuntu 24.04 VMs (Lima), build and `--images` modes, `tls internal`, systemd across a restart, smoke from the host through Caddy; six install bugs fixed (data dir ownership, plugin hidden by the Grafana volume, unit vs install mode, Sentry route, CORS option, re-run ref); ACME and amd64 not run; `project/agents/platform-infra/summaries/2026-10-23-8a-vm-upgrade-n12.md`]
- [x] Project token for SDK ingest at the collector edge (ADR-0007 rev 2): `ouo-collector` (ocb distribution) is the only public ingest, OTLP 4318 and replay 4319 with HTTP Basic `project id:project token` (basicauth htpasswd), `ouo.project.id` stamped from the credential, `ouoratelimit` per project and client with 429 + `Retry-After`, body limits, CORS on both ports; rum-api internal (replay sink behind the ingest token, reads behind the read token) [qa 2026-10-13: `deploy/scripts/e2e.sh` run `mv6swsxe` 40 sessions 0 mismatches with 14 edge/sink/read checks (OTLP and replay 401 without or with a wrong credential, sink 401 without the ingest token, reads 401/200), `ouo.project.id=demo` over a spoofed value in Tempo, replay chunk via the collector stored with `project_id demo`; real web session (OTLP and replay only to the collector with `Authorization: Basic`, nothing to rum-api, keepalive unload chunk with the credential) and iOS session (frames uploads accepted, crashed with 8 traces); 400-request burst 93 x 429 `Retry-After: 1` and `ouo_ratelimit_rejected_total` 93 in Mimir; OTLP 5 MiB 400, rrweb 5 MiB 413; per-project bucket and quota not exercised live; demo apps lack a replay endpoint option on remapped ports (findings R2-1/R2-2); `project/reports/phase-8a-verification.html`]
- [x] Read token for plugin reads (ADR-0007 section 6; replaces the planned Grafana service account) [qa 2026-10-10: `secureJsonData.readToken` provisioned, proxy injects the Bearer server-side, browser carries no token, direct reads 401, wrong token shows the banner on all three pages and fails Test connection, restore recovers; re-checked 2026-10-13 after rum-api became internal: proxy 200, wrong token 401 with the banner, restore 200]
- [ ] Publish `@ouo11y/browser` and `@ouo11y/react-native` to npm, `OuoReplay` via SwiftPM, plugin signed for private distribution or documented unsigned allowlist; changelog and semantic versioning [release agent 2026-10-10: packages publishable (`npm pack --dry-run` lists LICENSE and CHANGELOG), workflows written and actionlint clean, versioning policy in `docs/releasing.md`, unsigned allowlist documented; nothing published: needs the npm org, GHCR visibility, optional Grafana signing token and the `ouo11y-ios` mirror repo, listed in `project/agents/release/summaries/2026-10-10-phase-8a.md`; release agent 2026-10-16: image pipeline audited and extended (collector + ouosentry, PR image builds, dry run, GitHub releases, SBOM/provenance), docs/releasing.md checklist and rc rules, examples pull pinned `ghcr.io/ouo11y/*:0.2.0` via `deploy/compose/compose.images.yaml`; `project/agents/release/summaries/2026-10-16-image-releases.md`; 2026-10-17: the founder pushed `rum-api-v0.2.0`, `collector-v0.2.0`, `grafana-v0.2.0` (grafana carries plugin 0.6.0), the three `release-images` runs are green and created GitHub releases, packages private until stable; npm, SwiftPM and plugin publishing still open (checklist B4)]
- [x] Upgrade procedure tested from the previous release, replay schema-version check [release agent 2026-10-10: `docs/operations/upgrade.md` written, `helm upgrade` exercised three times on kind; platform-infra 2026-10-23: VM 0.2.0 -> 0.3.0 and chart 0.1.0 -> 0.1.1 on kind with rrweb, frames and Sentry video replays, all byte-identical after, sessions and health unchanged; rum-api start-up guard (`replays/schema.json`, filesystem and S3) refuses a newer-schema store, Helm rolls back; `docs/operations/upgrade.md` section 8]

### 8b Data lifecycle

- [x] Retention per signal from one values entry (Loki, Tempo, Mimir TTLs) [rum-api 2026-10-23: Helm `retention` (logs, traces, metrics, replays, per-project logs / replays), compose and VM `OUO_RETENTION_*` (`install.sh --retention`), Loki compactor retention + deletes, Tempo 3.0 `block_retention` (scheduler and worker), Mimir `compactor_blocks_retention_period`, `ouo_project_id` stream label; live on `ouo-env 8b-retention-deletion`, Helm rendered + lint only; `docs/operations/data-lifecycle.md`, `project/agents/rum-api/summaries/2026-10-23-8b-data-lifecycle.md`]
- [x] rum-api replay store on object storage and a YAML config file like Loki / Tempo [rum-api 2026-10-16: `storage.backend: s3` (AWS S3 / MinIO, conditional meta writes for replicas, ranged mp4 reads), `-config.file` / `-config.expand-env` / `-config.verify`, compose MinIO opt-in, Helm `rumApi.storage`; verified with real MinIO and in the plugin, `project/agents/rum-api/summaries/2026-10-16-config-file-s3.md`]
- [x] Replay chunk lifecycle in object storage (lifecycle rules plus rum-api sweeper) matching retention [rum-api 2026-10-23: sweeper on both backends (expired + orphan, idempotent, `ouo.retention.*` metrics, `POST /v1/admin/retention/sweep`), `ouo-retention` object tags and rum-api-managed `ouo-replays-*` lifecycle rules (`storage.s3.lifecycle_rules`), verified on real MinIO in tests; live: a 1m `ttltest` replay retention expired its replays and kept `demo`. S3 rule expiry itself not observed (daily evaluation)]
- [x] Delete-by-user and delete-by-project, propagated to replay storage, recorded in an audit log [rum-api 2026-10-23: `DELETE /v1/admin/users/{user}` / `projects/{project}` behind `OUO_ADMIN_TOKEN`: replays at once, Loki delete request, Tempo trace ids for `tempo-cli redact`; append-only audit (JSONL with SHA-256 chain, or create-only S3 objects), no audit entry means no deletion; live: user deleted, replays 404, Loki lines gone after compaction (other user kept), Tempo traces redacted to empty, 6 audit entries with an intact chain]
- [ ] Sampling in both SDKs: session rate, replay rate, error-triggered replay, server-side per-project override [rum-api + sdk-react-native 2026-10-23: `@ouo11y/react-native` `session.sampleRate`, `replay.sampleRate`, `replay.onErrorSampleRate` (deterministic hash shared with rum-api, unit + integration tests, not run on a device), rum-api `projects.<id>.sampling` cap at the replay sink; browser SDK in the browser-sampling session; server-side cap on OTLP (collector) open]
- [x] Masking proof document with screenshots for web and iOS; DPA template [rum-api 2026-10-23: `docs/operations/masking-proof.md`, web (Chromium) and iOS 27 Simulator with SDK defaults and with `maskText: false`, live screen next to the stored replay, stored events / frames checked for the typed values; DPA template is legal material and lives outside this repo]

### 8c Operate

- [ ] Self-observability dashboards: ingest rate, rejected payloads, replay bytes per session, storage per project, rum-api latency
- [ ] Alert rules: ingest stall, storage growth, rejected-chunk rate
- [ ] Backup and restore drill for object storage and LGTM volumes, rehearsed on a fresh cluster, timed
- [ ] Runbook: on-call checklist, common failures, capacity table

### 8d Pilot kit

- [ ] Recorded five-minute demo of the broken shop
- [ ] Security questionnaire answers, architecture and data-flow diagram, default-collection list

### Exit criterion

- [ ] A non-founder engineer, following docs only, installs on a fresh Kubernetes cluster and a fresh VM, instruments the demo apps, resolves a staged incident from the plugin, verifies retention and deletion, restores from backup. Timed and recorded as an HTML report.

## Phase 9 Release health + public benchmarks

- [ ] Version-to-version crash-free and error-free comparison in the plugin, adoption curve per version
- [ ] Regression alert rule template when a new version drops below the previous one
- [ ] Benchmark harness: web (bundle size, main-thread blocking, memory, replay bytes per minute, requests per session) and iOS (CPU, battery, memory, frame drops) on a scripted journey
- [ ] Competitors in the harness: Sentry, Datadog RUM, Grafana Faro, OpenReplay, default configurations, scripts linked from every result
- [ ] Public benchmark site generated per release with methodology and raw data
- [ ] Exit: two demo versions compared in the plugin; site live with web results for all five products and iOS results for ouo plus two competitors

## Phase 10 Android replay (Expo)

- [ ] `sdk/android` Kotlin capture module on the frames contract (screenshot, view-hierarchy redaction, touches, chunking)
- [ ] `sdk/react-native/android` Expo bridge replacing the no-op stub
- [ ] Emulator verification of the crash flow; health by version includes Android
- [ ] Benchmarks extended to Android

## Phase 11 Scale foundation + multi-project

- [ ] ClickHouse session store behind existing rum-api contracts; sessionizer; migration path from Loki folding documented
- [ ] Projects and tokens in Postgres; per-project retention and sampling; Grafana organisation or folder mapping
- [ ] Audit log of configuration changes and deletions
- [ ] Load test at one million sessions per day, published with cluster size and cost per million sessions
- [ ] rum-api API versioning and OpenAPI document
- [ ] Exit: isolation verified between two projects; p95 rum-api latency under one second at tested volume

## Phase 12 Parallel-stack migration kit

- [ ] Collector fan-out configs: LGTM plus Elasticsearch, Datadog, New Relic exporters
- [ ] Comparison dashboards and coverage report
- [ ] Cost model from real ingest volumes
- [ ] Cutover runbook with rollback
- [x] Sentry SDK bridge: pulled forward on 2026-10-14 and tracked in its own section below (S1 to S4 done and merged in #16 and #17, S5 Android deferred, parity gaps A1 to A11). Not repeated here.
- [ ] Exit: demo backend reporting to both stacks with matching trace counts and a generated cost comparison

## Sentry bridge (ADR-0008), pulled forward on 2026-10-14

Founder ask: Sentry SDKs point at the collector; the collector forwards everything to Sentry as if it were not there; replay goes to rum-api; traces and logs go to LGTM. Branch `claude/sentry-bridge-design`, PR #16 (merged 2026-10-16); taps follow-up PR #17 (merged 2026-10-16); rollout switch PR #23 (merged 2026-10-17). ADR-0008 accepted 2026-10-17. Each sub-phase closes only when its verification is recorded here.

**MVP scope (founder, 2026-10-14):** S1 (forward to Sentry as if the collector were not there) and S3 (session replay to rum-api) are the MVP and get the strong verification. S2 (traces and logs to LGTM) was first marked "can be implemented later", then put back in scope the same day because the plugin's session list is built from the session events in Loki: S2 gets the full verification gate. Android (S5) is deferred.

| Sub-phase | Delivers | Verification gate |
|---|---|---|
| S1 Transparent forward | `ouosentry` receiver: auth table, raw-byte forward, verbatim response, `upstream: none`; `sentrytap` record/forward tool | Go tests against a fake upstream (body, headers, query byte-identical incl. gzip; 200, 429 + `X-Sentry-Rate-Limits` + `Retry-After`, 413 passthrough; upstream down 502; unknown key 403 not forwarded; body limit). Live: real Sentry iOS SDK through tap A, collector, tap B: every request in A appears in B byte-identical, responses identical; latency overhead measured |
| S2 Telemetry to LGTM | envelope parser, session, error, transaction mapping, session resolution, OTLP out | Golden tests on envelopes captured in S1. Live: simulator journey yields healthy, errored and crashed sessions in rum-api with the same counts as the Sentry session updates; exceptions in Loki; transactions in Tempo with `session.id` |
| S3 Replay to rum-api | `replay_video` decode, `kind: "video"` chunks via routing connector and `ouoreplay` exporter; rum-api video kind, manifest, mp4 range serving | Unit tests both sides. Live: replay segments of a simulator session stored, every mp4 has `ftyp` and plays (AVFoundation probe), range request 206, touches present |
| S4 Plugin player + report | video player in the plugin, HTML verification report | Grafana shows the bridged session with timeline, traces and playing video; report in `project/reports/` |
| S5 Android (deferred) | same as S1 to S3 on Android | Deferred by the founder; also no Android SDK, emulator or JDK on the build Mac |

- [x] S1 Transparent forward [2026-10-14: Go tests against a fake upstream; live in `ouo-sb` with real sentry-cocoa 9.30.1 traffic: `sentrytap compare` 39/39 requests byte-identical with identical responses, bridge overhead p50 2.8 ms p95 4.4 ms; 429 + `X-Sentry-Rate-Limits` + `Retry-After` passed through the container; unreachable upstream aborts the connection; outage run: SDK retried, flushed on recovery, ouo recorded each event once; `project/reports/sentry-bridge-verification.html`]
- [x] S2 Telemetry to LGTM [2026-10-14: golden tests on 54 captured requests; `verify-bridge.py` on two live runs: 6 sessions with status and end reason matching the SDK's updates, 8/8 errors in Loki (fatal ones fatal), 11/11 transactions in Tempo with `session.id` on every span; real-traffic fixes: stale replay id window, platform detection, crash end time, touch moves]
- [x] S3 Replay to rum-api [2026-10-14: 26/26 segments of 6 replays stored under the session they were recorded in, sha256 equal to the SDK's mp4, all decoded by AVFoundation at 402x874; rum-api tests incl. Range 206 and cross-kind 409]
- [x] S4 Plugin player + report [2026-10-14: plugin 0.4.0 video player, 97 Jest tests; live in Grafana 13.2.1 on real bridged sessions, Range/206 through the plugin proxy, timeline seek lands in the right segment; `project/reports/sentry-bridge-verification.html`, `project/agents/grafana-plugin/reports/s4-video-player.html`]
- [ ] S5 Android (deferred)

### Sentry bridge follow-ups (founder, 2026-10-14)

- [x] F1 Sentry `log` items to Loki [2026-10-14: `event.name = log` (console capture: `console`), typed attributes, session by `sentry.replay_id`, trace id (new rule 4) or `user.id`, held up to `log_hold` 1 min; live 30/30 logger entries in Loki, 51/51 log and console records with a session; golden `ios-rn-8.30.0/shop` (`TestGoldenShop`); spec section 7a]
- [x] F2 Richer timeline [2026-10-14: replay breadcrumbs become `http.request` (answered requests; failures stay `http.request.failed` from spans), `console`, `app.lifecycle`, `ui.tap`, `breadcrumb`; console lines de-duplicated against console log entries; plugin titles for them; live 45/45 requests, 21 console lines from 38 copies, 127 timeline events in the main session (20 of the previous types); spec section 9a. Successful `http.client` spans are not turned into events: the breadcrumbs cover them without duplicates]
- [x] F3 [2026-10-14: `propagateTraceparent: true`, app built with `BACKEND_URL=http://localhost:8084`, four manually instrumented flows each in its own trace (`startNewTrace`); live 27/27 backend-calling transactions are one Tempo trace with the backend server span under the app's `http.client` span; "Open in Explore" opens it (screenshot in the report)] Traces into the backend, "Open in Explore" end to end: the app must call the `ouo-sb` demo backend (localhost:8084, not 8082) with `tracePropagationTargets` for it and W3C `traceparent` propagation enabled in the Sentry SDK (`propagateTraceparent: true`, present in the bundled @sentry/core 10.76.0; `enableLogs` and the three mask options also exist in @sentry/react-native 8.30.0). More screens and actions with manual `Sentry.startSpan` around each so many traces reach the backend. Verify that the Tempo trace holds mobile and backend spans and that the plugin's Explore links open it.
- [x] F4 [2026-10-14: masking off in the demo, chunks carry `masked: false` from the recording's `options` event; 25/25 segments byte-identical and decoded; ready for the founder's review in Grafana http://localhost:3003; 2026-10-17: verdict pending, the demo is being re-run] Unmasked recordings for review: `mobileReplayIntegration({ maskAllText: false, maskAllImages: false, maskAllVectors: false })` in the demo app (demo only), rebuild, rerun the journey; the founder reviews the recordings in Grafana.

- [x] Founder review 2026-10-14 [taps: real touches recorded (24 in a tapped session) and `ui.tap` events named by component; marker made visible (white + halo, 1.5 s on video); timeline list fills its panel; Logs section (rum-api `GET /v1/sessions/{id}/logs`: session lines + lines sharing its traces, 119 on the main session incl. 68 backend lines); plugin 0.5.0]

- [x] Taps in Sentry replays (founder, 2026-10-16) [root cause: SDK and receiver were fine (real taps give rrweb touches and `ui.tap` breadcrumbs, golden `ios-rn-8.30.0/realtap`, `TestGoldenRealTap`), the scripted journey makes no touches, and the plugin had no `ui.tap` scrubber markers, no list beside the player and a weak indicator. Plugin 0.6.0: touches and breadcrumbs merged into taps, tap indicator with ripple and label (1 s full, gone by 1.5 s), `tap` markers, activity list beside the player with filters and click-to-seek; 119 Jest tests; live on a real-tap simulator session in the isolated stack `ouo-taps`: 6/6 taps paired with position and component, indicator at the tapped point; `project/kb-archive/sentry-replay-taps.md`, `project/agents/grafana-plugin/reports/sentry-taps.html`]

- [x] ouo RN SDK next to Sentry (founder, 2026-10-14) [XHR instrumentation (axios), fetch-over-XHR de-duplication, `errors.onUnhandledRejection` for Hermes' single rejection tracker; verified in `examples/sentry-mobile` with `OUO_SDK=1`: 1 rejection in each SDK, 27/27 backend spans parented to ouo, both replays stored, 42/42 forwarded byte-identical; `project/kb-archive/ouo-next-to-sentry.md`]

- [x] Runtime rollout Sentry → ouo per device (2026-10-17) [OpenFeature flag `ouo.rum.mode` (`sentry` via the bridge, `parallel` Sentry direct + ouo replay off, `ouo` only), decided per cold start, sticky device bucket, resource attribute `ouo.rum.mode` (SDK `resource` option, bridge stamps `sentry`); flagd over OFREP; three cohorts verified on the simulator (`examples/sentry-mobile/ROLLOUT.md`, `project/kb-archive/openfeature-rum-mode.md`). Open: rum-api filter by cohort]

### Bridge parity gaps (sentry-demo, 2026-10-17)

From the bridge vs ouo SDK comparison (`project/agents/sentry-demo/reports/bridge-vs-sdk.html`, `project/kb-archive/sentry-bridge-vs-ouo-sdk.md`): each item is data Sentry already sends that the bridge drops or misreads. Not started. Effort in engineer-days including tests and a golden capture.

- [ ] A1 `captureMessage` (level below error, only a synthetic exception value) becomes `sentry.message`, not an `exception` (today 3 errors where Sentry counts 2) [0.5 d]
- [ ] A2 Sentry `log` records get `service.version`, `deployment.environment.name`, `os.*`, device model from the entry attributes (`sentry.release`, `sentry.environment`, `os.*`, `device.model`) [0.5 d]
- [ ] A3 Device and OS context kept per `sid` / `did` and applied to `session.start`, `ui.tap`, `app.lifecycle`, `breadcrumb`, `console` records [1 d]
- [ ] A4 Mobile vitals: cold / warm app start, TTID per screen, slow / frozen frames, stalls from transaction `measurements` as timeline records, a rum-api type and plugin display (today only `ouo.sentry.measurement.*` span attributes) [3 d: bridge 1, rum-api 0.5, plugin 1.5]
- [ ] A5 HTTP client spans named `{method}` instead of the full URL (spanmetrics cardinality), with `server.address`, `server.port`, `url.path`, `url.scheme` parsed from `url.full` [0.5 d]
- [ ] A6 Error context allowlist: device locale, connection type, free memory, low power, thermal state, in foreground, current screen (`view_names`), app start time; app tags behind a per-project option; spec section 12 updated [1 d]
- [ ] A7 Native crash frames keep `instruction_addr` / `image_addr` (`image+offset`) and the `debug_meta` image names and UUIDs, so stacks can be symbolicated later [1 d; symbolication itself is separate]
- [ ] A8 Timeline for sessions without a replay: translate error-event breadcrumbs (de-duplicated) and successful `http.client` spans as `http.request` [2 d]
- [ ] A9 `session.previous_id` on `session.start` from the previous `sid` of the same `did` [0.5 d]
- [ ] A10 JS source maps (Sentry sends `dist` and `debug_meta`): upload and storage shared with the ouo SDK [L, roadmap]
- [ ] A11 Back navigation from `navigation` breadcrumbs (`{from, to}`) for screen changes no transaction covered [1 d]

State to resume from: isolated stack `ouo-sb` (Grafana 3003, rum-api 8091, Loki 3103, Tempo 3203, collector OTLP 4338, Sentry bridge 4340, backend 8084; env file and override in the session scratchpad `sb/`), collector upstream `http://host.docker.internal:4411`; taps: `sentrytap -listen 127.0.0.1:4411 -dir B -sink` and `-listen 127.0.0.1:4400 -dir A -forward http://127.0.0.1:4340`; app DSN `http://publickey0000000000000000000000@localhost:4400/1`, build `examples/sentry-mobile/scripts/build-ios.sh`, journey `scripts/journey.sh`, checks `sentrytap compare` and `scripts/verify-bridge.py`. ocb must be v0.160.0.

## Backlog (founder, 2026-10-17)

Not scheduled into a phase yet. Each item gets its own PR to main. The ordered work list is `project/tracker/checklist.md`.

**Founder decisions, 2026-10-17 (recorded in batch 0):**

- ADR-0008 (Sentry bridge) accepted; it was already implemented and merged (#16, #17).
- Prospect platforms are unknown for now: assume React Native on iOS, Android later. Test the bridge against the current major `@sentry/react-native` now, native `sentry-cocoa` and `sentry-java` in the medium term. Long term: one ouo SDK spec with a conformance suite (Phase 13.0), implemented in roadmap order. Later-phase item: compare Sentry's platform list with ouo's and add what is missing as later phases (checklist N17).
- The real-upstream bridge run (checklist N2) uses a self-hosted Sentry in its own named environment with a Sentry MCP pointing at it, not sentry.io; another session is doing it.
- Token rotation (checklist N14) is deferred: kept as is, addressed later.
- The founder's iPhone 16 Pro Max is available: prefer it over the simulator for every performance number (B3, checklist N6).
- The hosted demo for B8 is still open. The F4 verdict is pending while the demo is re-run.
- B5 repo layout approved (ADR-0010) and B2 `ouo-env` built in batch 0.

- [ ] B1 Session page shows only the activity list beside the player (plugin 0.6.0, right side). The `Timeline` panel on the left is hidden by default and comes back only behind a feature toggle, the way Grafana does it (`GF_FEATURE_TOGGLES_ENABLE`). Proposed shape: an env var `OUO_FEATURE_TOGGLES_ENABLE=sessionTimelinePanel` (comma-separated, more toggles later), mapped into the app plugin's `jsonData.featureToggles` by the provisioning file (Grafana expands `${ENV}` in provisioning) and by the Helm values. The plugin reads it from `jsonData`, since a frontend cannot read env vars. Keep the toggle list documented in one place (README of the plugin). Done: toggle off by default, on brings back today's layout, Jest tests for both, screenshot of both in the PR.
- [ ] B2 Named local environments instead of ad-hoc stacks on numbered ports. On 2026-10-17, 8 compose projects were running (`ouo`, `ouo-8a`, `ouo-sb`, `ouo-taps`, `ouo-cmp`, `ouo-perf`, `ouo-flags`, `ouo-flags-flagd`), some days after their PRs merged, each on its own set of ports. Target:
  - One shared reverse proxy (Traefik, reading Docker labels) on port 80. Stacks publish no host ports for UIs and APIs; only the SDK ingest ports a simulator needs stay published, from a per-env block.
  - Hostnames `<service>.<env>.ouo.localhost` (`*.localhost` resolves to 127.0.0.1 in browsers and curl with no `/etc/hosts` edits; `.local` is mDNS on macOS and resolves slowly). Envs: `main` (`grafana.ouo.localhost`, always the latest `main`), `sbx` (long-lived sandbox), and one ephemeral env per branch or PR (`grafana.<slug>.ouo.localhost`).
  - One script, `deploy/envs/ouo-env up|down|ls|gc|url <env>`: compose project `ouo-<env>`, Docker labels `ouo.env`, `ouo.branch`, `ouo.pr`, `ouo.session`, `ouo.created`. `ls` prints env, branch, PR state, age and URLs. `gc` takes down every ephemeral env whose PR is merged or closed or whose branch is gone (volumes kept unless `--purge`).
  - `main` is refreshed by `ouo-env up main` after each merge: pull the released images or build from `origin/main`.
  - AGENTS.md rule: agents use `ouo-env` only, give the founder the URL, and run `ouo-env down <env>` when their PR merges; never leave a stack running without saying so in the summary.
  - Every env's Grafana login is admin / testing567 (founder, 2026-10-17; PR #22).
  Done: script plus tests of `ls`/`gc` logic, kb entry, AGENTS.md and deploy/README.md updated, the existing stacks migrated or removed.
  Status 2026-10-17 (batch 0): script, tests, kb (`project/kb-archive/ouo-env.md`), AGENTS.md and deploy/README.md done; verified on `sbx` and with a gc run. Left: the founder's `ouo` stack into `main`, and old stopped projects' volumes (founder decides).
- [ ] B3 Device-cost benchmark, ouo SDK vs Sentry SDK, repeatable and fair. This pulls forward the iOS part of Phase 9's benchmark harness; the one-off measurement in session "Measure device cost of ouo SDK next to Sentry" (2026-10-17) is its starting point, not its replacement.
  - **What is measured, on the end device:** network (bytes up compressed and uncompressed, request count, bytes per minute of replay), CPU (average and p95 during the journey, idle overhead), memory (peak and steady, growth over a 30 min soak), disk (app binary and JS bundle size added, on-disk queue/cache size, max offline buffer), startup time added, frame drops / JS thread stalls, energy impact (Xcode energy gauge or `xctrace` power profile on a real device).
  - **Fairness rules, written down before the first run:** same app, same scripted journey with real taps, release builds, same sampling (100% sessions in the benchmark), feature parity tiers compared separately (T1 errors only; T2 + tracing/network; T3 + session replay at each SDK's default settings; T4 + replay with matched quality), a baseline with no SDK, N ≥ 10 runs per cell with medians and IQR, the same device model and OS on a cold boot, and pinned versions recorded in the result. Sentry is configured per its own docs, and the config files are published with the results. Report losses as plainly as wins.
  - **Platforms:** iOS real device first (the founder's iPhone 16 Pro Max, available 2026-10-17; preferred over the simulator for every number), simulator as a secondary check (React Native, Expo), web (bundle size, main-thread blocking, memory, bytes), Android once Phase 10 lands.
  - **Cadence:** a workflow runs it for every major (and opt-in minor) release of `@ouo11y/react-native` / `@ouo11y/browser` against the **latest stable** Sentry SDK, resolved at run time and recorded. Results are stored as JSON with an HTML report per run in `project/reports/benchmarks/<date>-<ouo version>-vs-sentry-<version>/`, and a trend page across runs. A regression above an agreed threshold blocks the release.
  - Done: harness, method doc (kb), first published run, release checklist step in docs/releasing.md.
- [ ] B4 Release every ouo artefact, not only the images. Today: images (`rum-api`, `collector`, `grafana`) are tagged and released by CI (0.2.0 on 2026-10-17, GHCR private until 2026-10-31, the images public since). The 8a item "Publish `@ouo11y/browser` and `@ouo11y/react-native` to npm, `OuoReplay` via SwiftPM, plugin signed..." is still open, and so are its blockers (npm org, `ouo11y-ios` mirror repo, signing token). Scope:
  - Components and channels: `@ouo11y/browser` and `@ouo11y/react-native` (npm, with provenance), `OuoReplay` (SwiftPM via mirror repo), `ouo11y-rum-app` plugin (zip on GitHub releases, then signed private/community), `ouo-collector` and `rum-api` (GHCR), Helm chart (OCI on GHCR).
  - One versioning policy: independent semver per component with tag prefixes, managed by release-please (manifest mode) from conventional commits, which opens a release PR per component with its CHANGELOG. Merging it tags and publishes. A "Release" `workflow_dispatch` button is kept for manual cuts. The founder approves every release PR or tag.
  - A compatibility matrix in docs (which SDK versions work with which collector / rum-api / plugin, and the replay `schema_version`), checked by the e2e suite on every release.
  - Done: one release of each component published from CI with nothing built locally, one releasing doc (done: root `RELEASING.md` merged into `docs/releasing.md` by B5, 2026-10-17).
- [x] B5 Repo organisation (ADR first, then one mechanical PR, done when no session is running) [done 2026-10-17, [ADR-0010](../../docs/adr-archive/0010-repository-layout.md), batch 0 PR: `agents/`, `kb/`, `tracker/`, `reports/` moved under `project/`, `deploy/docker` renamed `deploy/compose`, root `RELEASING.md` merged into `docs/releasing.md`, lychee link check in CI]. Before: the repo mixed product code with process material at the top level: `agents/` (173 files), `kb/`, `tracker/`, `reports/` sat next to `sdk/`, `services/`, `collector/`, `plugins/`. Release docs were split across root `RELEASING.md`, `docs/releasing.md` and `kb/release-packaging.md`, and verification reports lived in both `reports/` and `agents/*/reports/`. Proposal for the ADR:
  - Product code by component, each with its own README, CHANGELOG and owner: `sdk/{browser,react-native,ios}`, `collector/`, `services/rum-api/`, `plugins/ouo11y-rum-app/`, `deploy/{compose,helm,vm,envs}`, `examples/`, `tests/`.
  - All user-facing docs under `docs/` (getting started, guides, operations, specs, ADRs, releasing, compatibility matrix), and a short README map at the root.
  - All agent and process material under one folder (for example `project/` holding `project/agents/`, `project/kb-archive/`, `project/tracker/`, `project/reports/`), so the root shows the product.
  - Update every path in AGENTS.md, indexes, CI path filters, Dockerfiles, workflows and links in one PR, with a link checker in CI so nothing breaks.
- [ ] B6 Sentry bridge on Android (S5, deferred on 2026-10-14). Pull forward before a client demo if either prospect ships Android: neither sentry-java envelopes nor its replay have ever been captured.
- [ ] B7 Supply chain and security basics that client security questionnaires (8d) ask for: Renovate for dependencies, `govulncheck` / `npm audit` / Trivy image scan in CI, SECURITY.md with a disclosure address, signed tags or provenance on every release.
- [ ] B8 Pitch kit for the Sentry path: a one-page "point your DSN at ouo" guide per platform, a hosted demo env with the broken-shop app (admin login kept private), and the results of the gap report (session "Gap report: Sentry bridge vs ouo SDK") and B3 turned into a one-page comparison for clients.

## Phase 13 Native SDKs

- [ ] 13.0 Conformance suite driving any SDK through session spec cases, error classification, baggage, replay contract; browser and React Native SDKs pass it
- [ ] 13a Swift SDK: session manager, URLSession instrumentation, crash reporting, OTLP export, existing replay capture
- [ ] 13b Kotlin SDK reusing the Phase 10 capture module
- [ ] 13c Flutter SDK wrapping both native modules
- [ ] Per SDK: suite green, demo app instrumented, benchmark page extended

## Continuous: AI investigation experiment

- [ ] rum-api exposed as MCP tools
- [ ] Precision measured on twenty historical incidents before any customer sees it
- [ ] Fix suggestions behind a flag with human review only
