# Roadmap tracker (post-MVP)

Phases from [docs/business/roadmap.md](../docs/business/roadmap.md). One stacked pull request per phase, as for the MVP. Week numbers assume one full-time engineer with agents, counted from the start of Phase 8. Sequencing decisions were taken in the 2026-10-10 founder interview recorded in the roadmap document; do not reorder without a new decision there.

| Phase | Proposed branch | PR | Weeks | Status | Owner agents (proposed) |
|---|---|---|---|---|---|
| 8a Install and secure | `phase-8a-install-secure` | | 1 to 3 | in-progress | rum-api, sdk-browser, sdk-react-native, platform-infra, helm, grafana-plugin, release, qa |
| 8b Data lifecycle | `phase-8b-data-lifecycle` | | 4 to 5 | todo | rum-api, sdk-browser, sdk-react-native, platform-infra |
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

- [x] Helm chart: rum-api, collector, Grafana with plugin provisioned; values for existing LGTM versus bundled LGTM [helm agent 2026-10-10: `deploy/helm/ouo` lint and template clean; installed on kind `ouo-8a` in bundled mode with images from the tree, 6 pods Ready, 3 `helm upgrade`s, readyz, plugin 0.3.0 enabled with read token through the proxy, ingest 401/403/200 with `ouo.project.id=demo` in Tempo, replay chunk 202; external and HA values rendered only, not installed; `agents/helm/summaries/2026-10-10-phase-8a.md`]
- [ ] One-command VM install: TLS via reverse proxy, systemd units, documented `.env` [platform-infra 2026-10-10: `deploy/vm/` written; compose override, Caddyfile (`caddy validate` in internal, ACME and unset modes) and a throwaway Caddy with fake upstreams served both hosts over TLS from the internal CA; `install.sh` not yet run on a fresh VM, owed to the Phase 8 exit criterion run]
- [x] Project token for SDK ingest at the collector edge (ADR-0007 rev 2): `ouo-collector` (ocb distribution) is the only public ingest, OTLP 4318 and replay 4319 with HTTP Basic `project id:project token` (basicauth htpasswd), `ouo.project.id` stamped from the credential, `ouoratelimit` per project and client with 429 + `Retry-After`, body limits, CORS on both ports; rum-api internal (replay sink behind the ingest token, reads behind the read token) [qa 2026-10-13: `deploy/scripts/e2e.sh` run `mv6swsxe` 40 sessions 0 mismatches with 14 edge/sink/read checks (OTLP and replay 401 without or with a wrong credential, sink 401 without the ingest token, reads 401/200), `ouo.project.id=demo` over a spoofed value in Tempo, replay chunk via the collector stored with `project_id demo`; real web session (OTLP and replay only to the collector with `Authorization: Basic`, nothing to rum-api, keepalive unload chunk with the credential) and iOS session (frames uploads accepted, crashed with 8 traces); 400-request burst 93 x 429 `Retry-After: 1` and `ouo_ratelimit_rejected_total` 93 in Mimir; OTLP 5 MiB 400, rrweb 5 MiB 413; per-project bucket and quota not exercised live; demo apps lack a replay endpoint option on remapped ports (findings R2-1/R2-2); `reports/phase-8a-verification.html`]
- [x] Read token for plugin reads (ADR-0007 section 6; replaces the planned Grafana service account) [qa 2026-10-10: `secureJsonData.readToken` provisioned, proxy injects the Bearer server-side, browser carries no token, direct reads 401, wrong token shows the banner on all three pages and fails Test connection, restore recovers; re-checked 2026-10-13 after rum-api became internal: proxy 200, wrong token 401 with the banner, restore 200]
- [ ] Publish `@ouo/browser` and `@ouo/react-native` to npm, `OuoReplay` via SwiftPM, plugin signed for private distribution or documented unsigned allowlist; changelog and semantic versioning [release agent 2026-10-10: packages publishable (`npm pack --dry-run` lists LICENSE and CHANGELOG), workflows written and actionlint clean, versioning policy in `docs/releasing.md`, unsigned allowlist documented; nothing published: needs the npm org, GHCR visibility, optional Grafana signing token and the `ouo-ios` mirror repo, listed in `agents/release/summaries/2026-10-10-phase-8a.md`; release agent 2026-10-16: image pipeline audited and extended (collector + ouosentry, PR image builds, dry run, GitHub releases, SBOM/provenance), RELEASING.md checklist and rc rules, examples pull pinned `ghcr.io/ziadmansourm/ouo/*:0.2.0` via `deploy/docker/compose.images.yaml`; no tag pushed, awaiting founder approval, `agents/release/summaries/2026-10-16-image-releases.md`]
- [ ] Upgrade procedure tested from the previous release, replay schema-version check [release agent 2026-10-10: `docs/operations/upgrade.md` written, `helm upgrade` exercised three times on kind; an upgrade from the Phase 7b release on a data directory with existing replays and the schema-version refusal are owed to Phase 8b]

### 8b Data lifecycle

- [ ] Retention per signal from one values entry (Loki, Tempo, Mimir TTLs)
- [x] rum-api replay store on object storage and a YAML config file like Loki / Tempo [rum-api 2026-10-16: `storage.backend: s3` (AWS S3 / MinIO, conditional meta writes for replicas, ranged mp4 reads), `-config.file` / `-config.expand-env` / `-config.verify`, compose MinIO opt-in, Helm `rumApi.storage`; verified with real MinIO and in the plugin, `agents/rum-api/summaries/2026-10-16-config-file-s3.md`]
- [ ] Replay chunk lifecycle in object storage (lifecycle rules plus rum-api sweeper) matching retention
- [ ] Delete-by-user and delete-by-project, propagated to replay storage, recorded in an audit log
- [ ] Sampling in both SDKs: session rate, replay rate, error-triggered replay, server-side per-project override
- [ ] Masking proof document with screenshots for web and iOS; DPA template

### 8c Operate

- [ ] Self-observability dashboards: ingest rate, rejected payloads, replay bytes per session, storage per project, rum-api latency
- [ ] Alert rules: ingest stall, storage growth, rejected-chunk rate
- [ ] Backup and restore drill for object storage and LGTM volumes, rehearsed on a fresh cluster, timed
- [ ] Runbook: on-call checklist, common failures, capacity table

### 8d Pilot kit

- [ ] Recorded five-minute demo of the broken shop
- [ ] Security questionnaire answers, architecture and data-flow diagram, default-collection list
- [ ] Pilot contract and retainer templates with milestone acceptance criteria

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
- [ ] Sentry SDK bridge (ADR-0008 proposed 2026-10-13, spec `docs/specs/sentry-bridge.md`). Order of work: (1) capture golden envelopes from both apps and answer the spec's verify items [collector]; (2) `ouosentry` receiver: forward, parse, translate, resolve sessions [collector]; (3) `video` replay kind [rum-api]; (4) video player [grafana-plugin]; (5) Sentry vs ouo comparison report [qa]. Placement ahead of Phase 10 is a founder decision (roadmap section 6 trigger)
- [ ] Exit: demo backend reporting to both stacks with matching trace counts and a generated cost comparison

## Sentry bridge (ADR-0008), pulled forward on 2026-10-14

Founder ask: Sentry SDKs point at the collector; the collector forwards everything to Sentry as if it were not there; replay goes to rum-api; traces and logs go to LGTM. Branch `claude/sentry-bridge-design`, PR #16. Each sub-phase closes only when its verification is recorded here.

**MVP scope (founder, 2026-10-14):** S1 (forward to Sentry as if the collector were not there) and S3 (session replay to rum-api) are the MVP and get the strong verification. S2 (traces and logs to LGTM) was first marked "can be implemented later", then put back in scope the same day because the plugin's session list is built from the session events in Loki: S2 gets the full verification gate. Android (S5) is deferred.

| Sub-phase | Delivers | Verification gate |
|---|---|---|
| S1 Transparent forward | `ouosentry` receiver: auth table, raw-byte forward, verbatim response, `upstream: none`; `sentrytap` record/forward tool | Go tests against a fake upstream (body, headers, query byte-identical incl. gzip; 200, 429 + `X-Sentry-Rate-Limits` + `Retry-After`, 413 passthrough; upstream down 502; unknown key 403 not forwarded; body limit). Live: real Sentry iOS SDK through tap A, collector, tap B: every request in A appears in B byte-identical, responses identical; latency overhead measured |
| S2 Telemetry to LGTM | envelope parser, session, error, transaction mapping, session resolution, OTLP out | Golden tests on envelopes captured in S1. Live: simulator journey yields healthy, errored and crashed sessions in rum-api with the same counts as the Sentry session updates; exceptions in Loki; transactions in Tempo with `session.id` |
| S3 Replay to rum-api | `replay_video` decode, `kind: "video"` chunks via routing connector and `ouoreplay` exporter; rum-api video kind, manifest, mp4 range serving | Unit tests both sides. Live: replay segments of a simulator session stored, every mp4 has `ftyp` and plays (AVFoundation probe), range request 206, touches present |
| S4 Plugin player + report | video player in the plugin, HTML verification report | Grafana shows the bridged session with timeline, traces and playing video; report in `reports/` |
| S5 Android (deferred) | same as S1 to S3 on Android | Deferred by the founder; also no Android SDK, emulator or JDK on the build Mac |

- [x] S1 Transparent forward [2026-10-14: Go tests against a fake upstream; live in `ouo-sb` with real sentry-cocoa 9.30.1 traffic: `sentrytap compare` 39/39 requests byte-identical with identical responses, bridge overhead p50 2.8 ms p95 4.4 ms; 429 + `X-Sentry-Rate-Limits` + `Retry-After` passed through the container; unreachable upstream aborts the connection; outage run: SDK retried, flushed on recovery, ouo recorded each event once; `reports/sentry-bridge-verification.html`]
- [x] S2 Telemetry to LGTM [2026-10-14: golden tests on 54 captured requests; `verify-bridge.py` on two live runs: 6 sessions with status and end reason matching the SDK's updates, 8/8 errors in Loki (fatal ones fatal), 11/11 transactions in Tempo with `session.id` on every span; real-traffic fixes: stale replay id window, platform detection, crash end time, touch moves]
- [x] S3 Replay to rum-api [2026-10-14: 26/26 segments of 6 replays stored under the session they were recorded in, sha256 equal to the SDK's mp4, all decoded by AVFoundation at 402x874; rum-api tests incl. Range 206 and cross-kind 409]
- [x] S4 Plugin player + report [2026-10-14: plugin 0.4.0 video player, 97 Jest tests; live in Grafana 13.2.1 on real bridged sessions, Range/206 through the plugin proxy, timeline seek lands in the right segment; `reports/sentry-bridge-verification.html`, `agents/grafana-plugin/reports/s4-video-player.html`]
- [ ] S5 Android (deferred)

### Sentry bridge follow-ups (founder, 2026-10-14)

- [x] F1 Sentry `log` items to Loki [2026-10-14: `event.name = log` (console capture: `console`), typed attributes, session by `sentry.replay_id`, trace id (new rule 4) or `user.id`, held up to `log_hold` 1 min; live 30/30 logger entries in Loki, 51/51 log and console records with a session; golden `ios-rn-8.30.0/shop` (`TestGoldenShop`); spec section 7a]
- [x] F2 Richer timeline [2026-10-14: replay breadcrumbs become `http.request` (answered requests; failures stay `http.request.failed` from spans), `console`, `app.lifecycle`, `ui.tap`, `breadcrumb`; console lines de-duplicated against console log entries; plugin titles for them; live 45/45 requests, 21 console lines from 38 copies, 127 timeline events in the main session (20 of the previous types); spec section 9a. Successful `http.client` spans are not turned into events: the breadcrumbs cover them without duplicates]
- [x] F3 [2026-10-14: `propagateTraceparent: true`, app built with `BACKEND_URL=http://localhost:8084`, four manually instrumented flows each in its own trace (`startNewTrace`); live 27/27 backend-calling transactions are one Tempo trace with the backend server span under the app's `http.client` span; "Open in Explore" opens it (screenshot in the report)] Traces into the backend, "Open in Explore" end to end: the app must call the `ouo-sb` demo backend (localhost:8084, not 8082) with `tracePropagationTargets` for it and W3C `traceparent` propagation enabled in the Sentry SDK (`propagateTraceparent: true`, present in the bundled @sentry/core 10.76.0; `enableLogs` and the three mask options also exist in @sentry/react-native 8.30.0). More screens and actions with manual `Sentry.startSpan` around each so many traces reach the backend. Verify that the Tempo trace holds mobile and backend spans and that the plugin's Explore links open it.
- [x] F4 [2026-10-14: masking off in the demo, chunks carry `masked: false` from the recording's `options` event; 25/25 segments byte-identical and decoded; ready for the founder's review in Grafana http://localhost:3003] Unmasked recordings for review: `mobileReplayIntegration({ maskAllText: false, maskAllImages: false, maskAllVectors: false })` in the demo app (demo only), rebuild, rerun the journey; the founder reviews the recordings in Grafana.

- [x] Founder review 2026-10-14 [taps: real touches recorded (24 in a tapped session) and `ui.tap` events named by component; marker made visible (white + halo, 1.5 s on video); timeline list fills its panel; Logs section (rum-api `GET /v1/sessions/{id}/logs`: session lines + lines sharing its traces, 119 on the main session incl. 68 backend lines); plugin 0.5.0]

- [x] Taps in Sentry replays (founder, 2026-10-16) [root cause: SDK and receiver were fine (real taps give rrweb touches and `ui.tap` breadcrumbs, golden `ios-rn-8.30.0/realtap`, `TestGoldenRealTap`), the scripted journey makes no touches, and the plugin had no `ui.tap` scrubber markers, no list beside the player and a weak indicator. Plugin 0.6.0: touches and breadcrumbs merged into taps, tap indicator with ripple and label (1 s full, gone by 1.5 s), `tap` markers, activity list beside the player with filters and click-to-seek; 119 Jest tests; live on a real-tap simulator session in the isolated stack `ouo-taps`: 6/6 taps paired with position and component, indicator at the tapped point; `kb/sentry-replay-taps.md`, `agents/grafana-plugin/reports/sentry-taps.html`]

- [x] ouo RN SDK next to Sentry (founder, 2026-10-14) [XHR instrumentation (axios), fetch-over-XHR de-duplication, `errors.onUnhandledRejection` for Hermes' single rejection tracker; verified in `examples/sentry-mobile` with `OUO_SDK=1`: 1 rejection in each SDK, 27/27 backend spans parented to ouo, both replays stored, 42/42 forwarded byte-identical; `kb/ouo-next-to-sentry.md`]

State to resume from: isolated stack `ouo-sb` (Grafana 3003, rum-api 8091, Loki 3103, Tempo 3203, collector OTLP 4338, Sentry bridge 4340, backend 8084; env file and override in the session scratchpad `sb/`), collector upstream `http://host.docker.internal:4411`; taps: `sentrytap -listen 127.0.0.1:4411 -dir B -sink` and `-listen 127.0.0.1:4400 -dir A -forward http://127.0.0.1:4340`; app DSN `http://publickey0000000000000000000000@localhost:4400/1`, build `examples/sentry-mobile/scripts/build-ios.sh`, journey `scripts/journey.sh`, checks `sentrytap compare` and `scripts/verify-bridge.py`. ocb must be v0.160.0.

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
