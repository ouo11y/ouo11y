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
- [x] Project token for SDK ingest at rum-api: origin allowlist, rate limit, body-size limit, per-project quota; collector no longer exposed to browsers [qa 2026-10-10: `deploy/scripts/e2e.sh` gateway checks 401/403/400 and `ouo.project.id=demo` stamping in Tempo, smoke.sh, 400-request burst 92 x 429 with `Retry-After`, 4.3 MB body 413, collector bound to 127.0.0.1 only, real web and iOS sessions through rum-api; per-project quota only unit-tested; `reports/phase-8a-verification.html`]
- [x] Read token for plugin reads (ADR-0007 section 6; replaces the planned Grafana service account) [qa 2026-10-10: `secureJsonData.readToken` provisioned, proxy injects the Bearer server-side, browser carries no token, direct reads 401, wrong token shows the banner on all three pages and fails Test connection, restore recovers]
- [ ] Publish `@ouo/browser` and `@ouo/react-native` to npm, `OuoReplay` via SwiftPM, plugin signed for private distribution or documented unsigned allowlist; changelog and semantic versioning [release agent 2026-10-10: packages publishable (`npm pack --dry-run` lists LICENSE and CHANGELOG), workflows written and actionlint clean, versioning policy in `docs/releasing.md`, unsigned allowlist documented; nothing published: needs the npm org, GHCR visibility, optional Grafana signing token and the `ouo-ios` mirror repo, listed in `agents/release/summaries/2026-10-10-phase-8a.md`]
- [ ] Upgrade procedure tested from the previous release, replay schema-version check [release agent 2026-10-10: `docs/operations/upgrade.md` written, `helm upgrade` exercised three times on kind; an upgrade from the Phase 7b release on a data directory with existing replays and the schema-version refusal are owed to Phase 8b]

### 8b Data lifecycle

- [ ] Retention per signal from one values entry (Loki, Tempo, Mimir TTLs)
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
- [ ] Exit: demo backend reporting to both stacks with matching trace counts and a generated cost comparison

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
