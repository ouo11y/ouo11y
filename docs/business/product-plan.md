# ouo as a product: plan and checklist

Status: proposal, 2026-10-09. Written after the MVP (PRs #1 to #10) proved the technical thesis: one `session.id` joins web, mobile, replay, traces and backend spans on a self-hosted LGTM stack.

## 1. The verdict

Pursue it, as a **services-led company with an open-source platform as the wedge**. The platform alone is not a business yet: Sentry, PostHog, OpenReplay and Datadog already sell the "replay plus errors" checkbox, and open source does not create demand by itself. What nobody sells well is the combination this repo already demonstrates:

- self-hosted, OTel-native RUM for web **and mobile** with replay, correlated into backend traces on the customer's own Grafana, Loki, Tempo, Mimir;
- people who instrument the whole system (servers, backend, frontend, mobile, databases, proxies, queues) and debug the hard cases;
- a migration path that runs the new stack in parallel with the old one, so the customer never bets the company on a cutover.

The first two years are an engineering-services business with product leverage. The product makes the service faster, repeatable and defensible; the service funds the product and tells us what to build.

## 2. Where the value sits

| Value | Why it is real | Evidence in this repo |
|---|---|---|
| Correlation, not collection | The customer's pain is "which backend call broke this user's checkout", not "I need a replay tool" | Session detail: timeline, replay, traces with Explore links; crash flow verified on iOS |
| Data sovereignty on a standard | Replay recordings and user sessions are the most sensitive telemetry a company has; keeping them on-prem on OTel means no lock-in and no vendor egress | Everything runs from one compose file; SDKs are OTel; masking happens on device |
| Mobile replay without a SaaS | Grafana Frontend Observability is SaaS-only and has no mobile replay; Faro has no replay; Sentry's server is source-available with cloud-first pricing | `sdk/ios` screenshot replay with view-hierarchy masking, Grafana frame player |
| Parallel-stack migration | Companies on ELK or Datadog cannot afford a risky cutover; running both and comparing is the sale | Our prior experience; make it a packaged offer |
| Debugging expertise | The thing customers actually pay for is a fixed incident and a team that can repeat the fix | This has to be proven with references, not claims |

Our advantage is **time to first answer**: from install to "here is the trace behind that crashed session" in a day, on their infrastructure, with their data never leaving.

## 3. What is weak, honestly

- **Grafana dependency.** The UI lives in a Grafana plugin. Fine for the LGTM crowd, a non-starter for Elastic or Datadog shops. The standalone UI from the vision stays on the roadmap for year two.
- **No reference customers.** Every claim in the pitch ("extensive debugging experience") is unverifiable until two or three named customers say it.
- **Aggregation at query time.** rum-api folds sessions from Loki on every request. Works at demo scale, will not at ten million sessions a month. ClickHouse (ADR in the vision) is a known, scheduled fix, not a surprise.
- **The AI claim.** "Zero-shot root cause agent that opens PRs with fixes" is not something to promise today. Promise **evidence-backed investigation** (the agent cites sessions, traces and deploys; the engineer decides) and ship PR suggestions as a labelled experiment.
- **Mobile is iOS only** and uses the dev-client path. Android is the next phase; native SDKs for Swift and Kotlin apps that are not React Native need their own session managers.

## 4. The offer

Three products, one platform.

### 4.1 Pilot: "Full Story in 30 days" (fixed price)

Scope: deploy the stack on the customer's cloud or ours, instrument one web app, one mobile app and the backend services behind one critical user flow (checkout, login, onboarding), deliver the session-to-trace workflow and a runbook. Exit criterion: their on-call engineer resolves a real incident with it. Price it as a fixed project, 4 to 6 weeks, half the fee up front.

### 4.2 Embedded engineer ("send one of us")

A forward-deployed engineer on a monthly retainer, half-time or full-time, inside the customer's team: instrumentation, dashboards, SLOs, incident support, database and network debugging, training. Minimum three months. This is the revenue engine for the first two years.

### 4.3 Platform subscription (managed BYOC or our cloud)

We operate the platform on their cloud (preferred, they pay the infrastructure) or on ours. Includes upgrades, backups, security patches, capacity, support SLA. Priced per instrumented application plus session volume, with the open-source edition always available for self-operation.

Training and the parallel-stack migration are packaged as add-ons to 4.1 and 4.2, not as separate products, until there is demand to split them.

## 5. Pricing

The proposed 2,000 to 4,000 EUR per month per forward-deployed engineer is too low for European or North American customers, for three reasons:

1. It does not cover a senior engineer's fully loaded cost plus margin plus the unbilled time (sales, platform work, learning the customer's system).
2. Buyers read price as risk. A platform or SRE lead paying 3,000 EUR a month for someone who will touch production will assume junior quality.
3. It leaves no room to discount for the pilot or for annual commitments.

Suggested starting points, to be validated with the first three conversations:

| Offer | Europe / North America | Regional (MENA, Gulf, Eastern Europe) |
|---|---|---|
| Pilot (4 to 6 weeks, fixed) | 15,000 to 30,000 EUR | 8,000 to 15,000 EUR |
| Embedded engineer, full-time month | 9,000 to 14,000 EUR | 4,000 to 7,000 EUR |
| Embedded engineer, half-time month | 5,000 to 8,000 EUR | 2,500 to 4,000 EUR |
| Platform subscription (managed BYOC) | from 1,500 EUR / month per app, volume tiers | from 800 EUR / month |

"The rest upon delivery" is right for the pilot, as milestone payments against written acceptance criteria. For retainers, bill monthly in advance. Avoid open-ended "upon delivery" on retainers; it turns a service into unpaid risk.

## 6. How to be more competitive

- **Make the demo the sales motion.** The intentionally broken demo shop, installed in one command, that shows a crashed mobile session, its replay and the slow database span behind it. Record it, publish it, run it live in every first call.
- **Publish numbers.** SDK overhead, replay bytes per session, install time, time to first correlated trace. Competitors hide these; we can lead with them.
- **Pick a vertical for the first ten customers.** Fintech, health or public sector in regions with data-residency rules, where SaaS replay is not allowed. Our sovereignty story is strongest there.
- **Ship the migration offer.** "We run LGTM next to your ELK or Datadog for 90 days, you compare, you decide" removes the biggest objection and gives us a foot in accounts that are not shopping for RUM.
- **Turn every engagement into product.** Each customer's instrumentation pattern becomes a documented recipe (Next.js, Expo, Go, Postgres, Kafka). Recipes are the open-source funnel.
- **Keep the SDK Apache-2.0 and the server AGPL** (vision §28) so customers embed freely and competitors cannot resell the server as SaaS.
- **Name the company and the project.** "ouo" needs a trademark and domain check before anything public.

## 7. Checklist

### Validate (next 30 days)

- [ ] Ten discovery calls with platform or SRE leads, five of them in a data-residency vertical; write up objections and willingness to pay
- [ ] Three design-partner offers: pilot at cost in exchange for a reference and a case study
- [ ] Price test: present the table in section 5 verbatim to three prospects and record reactions
- [ ] Decide the first vertical and region

### Product, before the first pilot

- [ ] Android replay (Phase 8) so "mobile" means both platforms
- [ ] Installer: one command on a fresh VM (Docker) and a Helm chart for Kubernetes; TLS and basic auth on rum-api
- [ ] Retention and deletion: TTLs in Loki and Tempo, replay lifecycle, delete-by-session and delete-by-user endpoints
- [ ] Sampling controls in both SDKs (session, replay, error-triggered replay)
- [ ] Source maps for web errors (symbolication worker)
- [ ] Operational dashboards and alerts for the platform itself (ingest rate, rejected chunks, storage per session)
- [ ] Documentation site: quickstart, instrumentation recipes, privacy guide

### Product, before the first paid subscription

- [ ] ClickHouse-backed session store behind the same rum-api contracts, with a migration path from Loki folding
- [ ] Multi-project isolation and API tokens; audit log
- [ ] SBOM, dependency and secret scanning in CI; signed releases
- [ ] Load test at one million sessions per day with published results

### Company

- [ ] Name, trademark, domains, GitHub organisation; LICENSE files per package
- [ ] Legal review of the Apache-2.0 SDK / AGPL server split and a contributor agreement
- [ ] Standard pilot contract, retainer contract, data processing agreement, security questionnaire answers
- [ ] Case-study template and the first recorded demo
- [ ] A support process: issue tracker, SLA tiers, on-call rota for managed customers

### Agent and AI (experiment, not a promise)

- [ ] Investigation agent that answers "why did X regress" with cited sessions, traces and deploys, exposed as MCP tools over rum-api
- [ ] Measure precision on twenty historical incidents before showing it to a customer
- [ ] PR suggestions only after the above, behind a flag, always reviewed by a human

## 8. What would make me stop

- Discovery calls show buyers are happy with Sentry self-hosted plus Grafana and will not pay for correlation.
- No prospect will accept replay data on-prem as a reason to switch, which would remove the sovereignty wedge.
- Grafana Labs ships self-hosted mobile replay in Faro, which would narrow the product gap to pure services.

None of these is true today; check again after the ten calls.
