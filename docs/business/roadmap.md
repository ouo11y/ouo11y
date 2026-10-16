# ouo roadmap: from MVP to a product companies can run

Status: proposal, 2026-10-10. Companion to [product-plan.md](product-plan.md) (why and what to sell). This document is the **what to build, in which order, and what each step buys in a sales conversation**. Phases are tracked in [tracker/roadmap.md](../../tracker/roadmap.md).

## 1. Decisions this roadmap is built on

Recorded from the founder interview on 2026-10-10 so later agents do not relitigate them.

| Question | Decision |
|---|---|
| First buyers, in order | 1. a company we already know (warm intro); 2. startups that want a cheap Sentry-plus-replay on managed hosting; 3. open-source adopters. Enterprise readiness (SLA, HA, data safety) is a requirement from day one because the warm intro is an enterprise-shaped buyer. |
| Operating model, year one | Services-led: pilots and embedded engineers fund the work; the platform is the wedge and runs on the customer's infrastructure. |
| Capacity | One founder full-time with six-plus months of runway, agents for parallel work, hiring one or two engineers from pilot revenue within six months. |
| UI | Grafana app plugin first. rum-api is designed so a standalone UI can sit on it later; the standalone UI is not built in year one. |
| Warm buyer's current stack | Unknown until the first call; could be LGTM, ELK or Datadog, or logs only. The migration kit (Phase 12) is pulled forward if the call reveals ELK or Datadog. |
| Mobile scope | React Native and Expo first (Android parity), then native Swift, then Kotlin, then Flutter. Native SDKs are the first hire's workstream. |
| Enterprise requirements expected before a pilot | HA deployment on Kubernetes; data lifecycle and GDPR; security posture; scale proof; and **measured end-user device impact against competitors**. |
| Reference deployment | Customer's Kubernetes first, customer's VMs with Docker second, our own cloud (managed) later. |
| First eight weeks | Pilot-ready platform only. Mobile breadth, release health, benchmarks and scale wait. |
| Benchmarks | Public benchmark site, reproducible, updated per release, against Sentry, Datadog RUM, Grafana Faro and OpenReplay. |

## 2. Sequencing principle

Each phase must change what we can say in a sales call. A phase that does not produce a sentence we can put in front of a buyer is cut or merged.

The order is: **legal and safe to run on real users** (Phase 8), then **a reason to pick us over the incumbents** (Phase 9), then **breadth** (Phases 10 and 13), then **scale and multi-tenancy** (Phase 11), with the **migration kit** (Phase 12) floating to wherever the first buyer's stack puts it.

Week counts assume one full-time engineer directing agents. They stretch when the founder is embedded at a customer and shrink when the first hire lands.

## 3. Phases

### Phase 8: Pilot-ready platform (weeks 1 to 8)

What it buys: "Install it on your cluster in an afternoon. Your data never leaves. Here is how it is retained, deleted, backed up and upgraded." Without this phase there is no pilot at an enterprise-shaped buyer, however good the demo is.

**8a Install and secure**

- Helm chart for rum-api, the collector, Grafana with the plugin pre-provisioned, and values for an existing LGTM installation versus a bundled one. Loki, Tempo and Mimir via their upstream charts with our values files, replicated mode and object storage.
- One-command VM install for the Docker path: TLS via Caddy or Traefik, systemd units, `.env` with every port and secret documented.
- rum-api behind authentication: public **project token** for SDK ingest (origin allowlist, rate limit, body size limit, per-project quotas), Grafana service account for reads. The collector is no longer exposed directly to browsers.
- Published packages: `@ouo/browser` and `@ouo/react-native` on npm, `OuoReplay` via Swift Package Manager, Grafana plugin signed for private distribution or documented unsigned allowlist with the root URL. Semantic versioning and a changelog.
- Upgrade procedure tested from the previous release, including a schema-version check on replay chunks.

**8b Data lifecycle**

- Retention per signal: Loki, Tempo and Mimir TTLs set from one values entry; replay chunk lifecycle in object storage (S3 or MinIO lifecycle rules plus rum-api sweeper) with the same retention.
- Deletion: delete-by-session already exists; add delete-by-user and delete-by-project, propagated to replay storage and recorded in an audit log.
- Sampling in both SDKs: session sample rate, replay sample rate, error-triggered replay, server-side override per project.
- Masking proof: a documented, repeatable test that shows inputs and text are masked on web and iOS, with screenshots the buyer's privacy officer can read. Data processing agreement template.

**8c Operate**

- The platform observes itself: dashboards for ingest rate, rejected payloads, replay bytes per session, storage per project, rum-api latency; alert rules for ingest stall, storage growth and rejected-chunk rate.
- Backup and restore drill for object storage and the LGTM volumes, documented and rehearsed on a fresh cluster. This is the direct answer to "we lost your data because of a bill" fears: the runbook shows what is backed up, where, and how it comes back.
- Runbook: on-call checklist, common failures, capacity planning table.

**8d Pilot kit**

- Recorded five-minute demo of the broken shop: crashed mobile session, replay, slow database span.
- Security questionnaire answers (the standard SIG-lite and CAIQ style questions), architecture and data-flow diagram, list of what the SDK collects by default.
- Pilot contract template with milestone payments and written acceptance criteria; retainer template.

**Exit criterion:** an engineer who is not the founder, following only the docs, installs ouo on a fresh Kubernetes cluster and on a fresh VM, instruments the demo apps, resolves a staged incident from the Grafana plugin, verifies retention and deletion, and restores from backup. Timed and recorded.

### Phase 9: Release health and public benchmarks (weeks 9 to 13)

What it buys: the headline feature mobile teams ask for and the numbers competitors do not publish. This is the phase that wins a pilot rather than qualifies for one.

- Release health: version-to-version comparison of crash-free and error-free session rates, adoption curve per version, regression alert when a new version's crash-free rate drops below the previous one, Grafana alert rule template. Web gets the same per release.
- Benchmark harness in the repo: bundle size and gzip size, main-thread blocking time, memory, replay bytes per minute, network requests per session for web; CPU, battery, memory and frame drops on iOS. Same scripted user journey across ouo, Sentry, Datadog RUM, Grafana Faro and OpenReplay where licences allow.
- Public benchmark site generated from the harness on every release, with methodology, raw data and reproduction commands. Fairness rule: competitor numbers come from their documented default configuration, and every result links to the script that produced it.

**Exit criterion:** release comparison visible in the plugin for two versions of the demo apps; benchmark site live with at least web results for all five products and iOS results for ouo and two competitors.

### Phase 10: Android replay for React Native and Expo (weeks 14 to 16)

What it buys: "mobile" means both platforms, which is the first question any mobile team asks.

- Kotlin capture module in `sdk/android` using the same frames contract (ADR-0006, `docs/specs/mobile-replay.md`): screenshot capture, view-hierarchy redaction, touch overlay, chunking.
- Expo Android bridge in `sdk/react-native/android` replacing the no-op stub; verified on an emulator with the same crash flow as iOS.
- Benchmarks from Phase 9 extended to Android.

This phase is self-contained and can run in parallel with Phase 8 through agents if the founder's time allows, but it does not gate the first pilot.

**Exit criterion:** Android session with masked replay and a crash appears in the plugin; health percentages by version include Android.

### Phase 11: Scale foundation and multi-project (weeks 17 to 24)

What it buys: a scale answer we can state with numbers, and the isolation a second project or a managed customer needs.

- Session store: ClickHouse behind the existing rum-api contracts (sessions, detail, health, traces), fed by the collector or a small sessionizer, replacing query-time folding from Loki. Loki keeps the raw events; ClickHouse holds sessions, views and aggregates. Migration path documented.
- Multi-project isolation: projects and tokens in Postgres, per-project retention and sampling, Grafana organisation or folder mapping, audit log of configuration changes and deletions.
- Load test at one million sessions per day on a documented cluster size, published with cost per million sessions.
- API versioning and an OpenAPI document for rum-api, so the standalone UI (Phase 14) and the AI investigation tools have a stable contract.

**Exit criterion:** load test report published; two projects on one installation cannot see each other's sessions; rum-api latency at p95 under one second at the tested volume.

### Phase 12: Parallel-stack migration kit (weeks 25 to 28, or earlier)

What it buys: the "run LGTM next to your ELK or Datadog for 90 days" offer from the product plan. **Pull this forward into Phase 8 scope if the first warm buyer is on ELK, Datadog or New Relic.**

- Collector fan-out configurations: OTLP to LGTM plus Elasticsearch, Datadog or New Relic exporters, with the same resource attributes.
- Comparison dashboards: same service, same window, both stacks; coverage report of what each stack sees.
- Cost model: ingest volume to monthly cost on both sides, from real volumes after two weeks.
- Cutover runbook with rollback.
- **Sentry SDK bridge** (ADR-0008, `docs/specs/sentry-bridge.md`): apps on the Sentry mobile SDKs change only their DSN; the `ouosentry` receiver forwards every envelope to Sentry unchanged and translates accepted ones into ouo sessions, errors, traces and `video` replays. Sentry stays the system of record until cutover (`upstream: none`).

**Exit criterion:** one demo backend reporting to both stacks with matching trace counts and a generated cost comparison.

### Phase 13: Native SDKs (weeks 29 onward; first hire's workstream)

What it buys: customers whose apps are not React Native. Order fixed by the interview: Swift, then Kotlin, then Flutter.

- **13.0 Conformance suite first.** A language-agnostic test suite that drives any SDK through the session lifecycle spec cases, error classification, baggage propagation and replay chunk contract, asserting on the OTLP and replay payloads received by a test collector. Every SDK, including the two existing ones, passes it. This is what makes SDK breadth hireable: a new engineer builds against the suite, not against the founder's memory.
- **13a Swift** (`sdk/ios` grows a session manager, URLSession instrumentation, crash reporting, OTLP export, reuses the existing replay capture).
- **13b Kotlin** (same, reusing the Phase 10 capture module).
- **13c Flutter** (Dart SDK wrapping the two native modules for replay).

**Exit criterion per SDK:** conformance suite green, demo app instrumented, benchmark page extended.

### Phase 14: Standalone UI (year two)

What it buys: Elastic and Datadog shops that will not run Grafana. Not built in year one; Phase 11's API versioning is the only preparation. Decision point after the tenth customer.

### Continuous: AI investigation (experiment, never a promise)

- rum-api exposed as MCP tools (sessions, health, traces, replay timeline) so an agent can answer "why did version 2.4.0 regress" with cited sessions, traces and deploys.
- Measured on twenty historical incidents before any customer sees it; fix suggestions only behind a flag with human review, per product-plan section 7.

## 4. Enterprise readiness matrix

What the warm buyer's security, platform and legal teams will ask, where it is answered, and the artifact we hand them.

| Requirement | Phase | Artifact |
|---|---|---|
| Runs on our Kubernetes, HA | 8a | Helm chart, replicated values, install recording |
| TLS everywhere, no open ingest | 8a | Project token design, TLS defaults, threat model page |
| Retention and deletion, GDPR | 8b | Retention values, delete-by-user API, DPA template, masking proof |
| Backup, restore, upgrade | 8c | Rehearsed runbook with timings |
| Security questionnaire | 8d | Answered questionnaire, SBOM, signed releases (CI items from product-plan) |
| SSO and RBAC | 8a via Grafana | Grafana SSO docs, per-project folder or organisation mapping (Phase 11) |
| End-user device impact | 9 | Public benchmark site |
| Release health | 9 | Plugin release comparison, alert template |
| Scale proof | 11 | Published load test, cost per million sessions |
| Audit log | 11 | Configuration and deletion audit log |
| Both mobile platforms | 10, 13 | Android replay, native SDKs |
| Migration without cutover | 12 | Fan-out configs, comparison dashboard, cost model |

## 5. Hiring tie-in

- **First hire (from pilot revenue): SDK engineer.** Owns Phase 13 starting with the conformance suite, then Swift, Kotlin, Flutter. Mobile background, comfortable with OTel. The suite exists so they can start without the founder in the loop.
- **Second hire: platform or SRE engineer.** Owns Helm, backups, the managed BYOC offer and on-call once the operating model reaches stage three (our own cloud). Until then the founder owns operations.
- The founder keeps sales, pilots, the embedded-engineer work and product direction.

## 6. Conditional triggers

| If the first calls show | Then |
|---|---|
| Warm buyer on ELK, Datadog or New Relic | Phase 12 fan-out configs move into Phase 8; comparison dashboards follow in Phase 9 |
| Warm buyer on VMs, not Kubernetes | Phase 8a ships the Docker path first and Helm second; HA story becomes "two VMs plus object storage" |
| Buyer's mobile apps already ship the Sentry SDKs | The Sentry SDK bridge (ADR-0008) moves ahead of Phase 10: it covers iOS and Android at once, with no app release beyond a DSN change |
| Warm buyer's mobile app is native Swift | Phase 13.0 and 13a move ahead of Phase 10; Android via Expo waits |
| Startups ask for hosting before any enterprise signs | Phase 11 multi-project moves ahead of Phase 9; a minimal managed offer on Hetzner with one shared LGTM per customer |
| Nobody asks about device performance | Phase 9 benchmark site shrinks to ouo's own numbers; release health stays |

## 7. What this roadmap deliberately does not do

- No standalone UI, no ClickHouse and no native SDKs before the first pilot. They are real needs with known designs, and none of them is what blocks a signature.
- No "zero-shot root cause agent" in any pitch. Evidence-backed investigation only, after measurement.
- No feature that cannot be demonstrated in the broken shop demo. If the demo cannot show it, a first call cannot sell it.

Revisit after the first three discovery calls and at the end of Phase 8. Stop signals remain those in product-plan section 8.
