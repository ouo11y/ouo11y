# Web roadmap recommendation: what to build, in which order, and when it is done

Written 2026-10-29 by the web-sdk-research orchestrator, as the web counterpart of [mobile-sdk-research/roadmap.md](../mobile-sdk-research/roadmap.md), answering the founder's two questions: how competitive is ouo on the web today, and what would make it stronger. Built on [comparison.md](comparison.md) and the appendices; facts are cited there.

It is a recommendation, not a decision; the decisions it needs are in §8. It follows the founder's 2026-10-23 focus order, where the web is item 1 ("web SDK robust", N36) and the ouo SDK is the web path (the Sentry browser SDK through the bridge, N39, is studied in a separate session). Work package ids are `WB1`–`WB10` so they do not collide with mobile `W1`–`W10` or the checklist's `B` items.

HTML companion with the lane chart and the matrices: [web-sdk-roadmap.html](../../agents/web-sdk-research/reports/web-sdk-roadmap.html).

## 0. The answers in one page

1. **How competitive is ouo on the web today?** As an SDK, yes: capture, delivery and page safety are at the leaders' level and ahead on offline delivery, page-hide correctness, LoAF events and W3C-first propagation (comparison §1). As a product a web team uses every morning, not yet: four things every APM-born competitor has are missing on the read side: **error issues**, **a performance view of web vitals with attribution**, **shipped alerts**, and **session search** beyond six fields. A team moving from Sentry or Datadog would find its data in ouo but not the screens it works from.
2. **Two steps back.** N36 asked for a robust SDK and most of it is done (N42, N43, N45, delivery, source maps). Continuing to polish the SDK alone has falling returns; the next unit of value per agent-day is on rum-api and the plugin, reading data the SDK already sends. Six of the ten packages below are mostly backend and plugin work.
3. **Order by value per cost** (§2): hygiene and rrweb upstream (WB1), spec + benchmark gate (WB10), issues (WB2), performance view (WB3), replay production-grade (WB5), alerts and dashboards (WB4), search and session index (WB6), capture completeness (WB7), OTel JS 3.0 (WB8), reach (WB9). Heatmaps, paths, feedback, profiling are later.
4. **Four lanes in parallel**, by folder: SDK (`sdk/browser`), rum-api, plugin + deploy provisioning, spec / tests / tooling. They touch disjoint folders; packages that span lanes merge as one PR per lane in a fixed order.
5. **What makes ouo stronger than "parity"** (§6): it is already one of 4 in 25 vendors exporting RUM to the customer's own collector and the only one combining it with replay, a lookback buffer, funnels and self-hosting. Widen that: be the reference implementation of the browser semantic conventions (rename to `browser.web_vital`, propose a replay convention, fix the SIG's session manager), publish and gate overhead the way nobody does, and default to privacy (mask all text).
6. **Afterwards** (§7): ouo would match Sentry on errors, vitals and replay and beat it on funnels, OTLP export and self-host; match Datadog on frustration and vitals attribution; stay behind on profiling, heatmaps, paths and framework breadth.

## 1. Where ouo stands (what the plan builds on)

| Area | Today (O) | The gap that matters |
|---|---|---|
| Capture | sessions, errors (5 sources), 5 vitals, `documentLoad`, fetch / XHR spans with `traceparent` + baggage, click and soft-navigation idle spans, rage / dead clicks, LoAF with scripts | vitals attribution, error clicks, `beforeSend`, feature flags, consent, resource timing after load, cross-subdomain sessions |
| Delivery and safety | gzip, retry with `Retry-After`, IndexedDB offline, keepalive budget, CSP / Trusted Types, SSR, soak | beacons without proxy (N44) |
| Replay | rrweb 2.1.7 + patch, inputs masked, 30–60 s on-error buffer, one recording tab, 2 MB guard | text recorded by default, main-thread serialisation, no mutation breaker, CSS in every checkout, player in the lazy chunk |
| Read side | sessions list (6 filters), session detail with timeline, replay, traces, funnels, health per version | no issues, no vitals aggregates, no alerts, no search, fold ceiling 100,000 events per list query |
| Reach | ESM npm package, React entry | no CDN / loader, no Vue / Angular / Svelte, source-map upload not public (N41) |
| Bundle | core 45,008 B gzip (budget 45,056), rrweb chunk 78,940 B | 48 B headroom: every new feature needs a lazy chunk or a budget decision |
| Bugs found | `SDK_VERSION` reports 0.2.0 in 0.3.0 (`sdk/browser/src/version.ts`, not in release-please `extra-files`) | — |

## 2. The ordered work list

Cost is the orchestrator's estimate in focused agent-days. Each package is one PR per lane it touches, each with its own definition of done (§9).

| # | Work package | Value | Cost | Depends on | Lanes |
|---|---|---|---|---|---|
| WB1 | **Hygiene and rrweb upstream**: `src/version.ts` in release-please `extra-files` (or read the version at build time); README sizes; rrweb 2.2.0; `@rrweb/record` instead of `rrweb` in the lazy import; drop the esbuild iframe patch when #1964 is released; re-run the 60 min soaks; send the `getUntaintedPrototype` fix upstream | high (correctness, smaller chunk) | S (1–2 d) | nothing | A |
| WB10 | **Web SDK spec, conformance and benchmark gate**: `docs/specs/web-sdk.md` with the capability list shared with mobile (C1–C12 of mobile W2, web column), conformance checks in the existing Playwright e2e against rum-api, the Appendix M harness moved into `sdk/browser` and run on PRs touching the SDK (bundle per preset, CPU ms per minute, bytes per minute against `none`), Sentry-style per-preset size budgets | very high (every later package gets a pass / fail) | S–M (4–6 d) | nothing | D |
| WB2 | **Issues**: rum-api fingerprint (exception type + top N in-app symbolicated frames, message template fallback, client `ouo.exception.fingerprint` override), issues list and detail in the plugin (count, sessions, users, first / last seen, versions, sparkline, sample stack, replays of affected sessions), error clicks in the SDK (a click whose interaction span contains an `exception`), client-side dedupe and per-type rate limit with a dropped counter | very high (largest single gap; serves the bridge path too) | M (7–9 d) | WB10 for checks | B, C, A |
| WB3 | **Performance view**: vitals attribution (INP target, phases and LoAF scripts; LCP element and sub-parts; CLS largest shift) in a lazy chunk; semconv names `browser.web_vital` + `browser.web_vital.*` with the old names dual-emitted for one release (N26); per-soft-navigation vitals and a loading duration from an activity window; rum-api p75 by route, version, browser; plugin Performance page; provisioned Grafana dashboard | very high | M (7–9 d) | WB10, budget decision (§8) | A, B, C |
| WB5 | **Replay production-grade**: serialisation and gzip in a worker served as a file (no `blob:` in CSP), fallback on the main thread, one chunk in flight; one `JSON.stringify` per event; mutation breaker (stop the page view's recording above a budget, `ouo.replay.skipped` reason `mutations`); `replay.maskAllText` with `ouo-unmask` allow-list and a default decided in an ADR-0003 revision; stylesheet dedupe in the replay store (content-addressed CSS, restored when served); segment metadata | high | M (8–10 d) | WB1 | A, B |
| WB4 | **Alerts and dashboards shipped**: Grafana alert rules provisioned with the stack (crashed-session rate, new issue and issue spike after WB2, p75 LCP / INP regression per route after WB3, failed-request rate from Tempo span metrics, replay ingest errors), one RUM overview dashboard, docs for contact points | high | S (3–4 d) | WB2, WB3 for two of the rules | C |
| WB6 | **Search and session index**: filters by URL, issue, error text, browser and OS, has-replay, duration, frustration, custom event, `device.id`; a session index in rum-api (summary rows written as sessions end, or Loki structured-metadata queries) so a list no longer folds up to 100,000 events per request | high (scale ceiling for any busy site) | M (6–8 d) | WB2 for the issue filter | B, C |
| WB7 | **Capture completeness**: `beforeSend` / `beforeSendSpan` hooks and default query-string scrubbing of `url.full`; `rum.setAttributes` global context; feature flags as semconv `feature_flag.evaluation` events with an OpenFeature hook; consent API (`start: false`, `rum.setConsent`); `console.warn` / `log` breadcrumbs opt-in; resource timing after load (bounded, sampled); cookie session store for cross-subdomain with Web Locks around read-modify-write and Datadog's no-adoption rule | medium–high | M (6–8 d) | budget decision, WB10 | A |
| WB8 | **OTel JS 3.0**: `sdk-trace-web` → `sdk-trace`, fetch / XHR from `@opentelemetry/browser-instrumentation` once it is stable or kept on contrib with pinned versions, `telemetry.distro.name` / `.version`; conformance suite unchanged as the proof | medium (risk reduction before it is forced) | M (4–6 d) | WB10 | A |
| WB9 | **Reach**: IIFE / CDN build and a loader snippet that buffers calls until load; thin Vue, Angular and Svelte packages (error handler + router → `setRoute`); Next.js and React Router guides; Vite / webpack plugin for debug ids and upload, public upload path through the collector (N41) | medium–high (adoption) | L (8–12 d) | WB10 | A, D |
| later | Heatmaps (element-relative click positions first, aggregation later); paths / journeys Sankey over `navigation`; feedback primitive shared with mobile W6; replay as OTLP logs as an option (Dash0 shape) next to the receiver; network timing and console inside the player; profiling (JS Self-Profiling, Chromium only); canvas recording | low now | — | — | — |

Why this order:

- **WB1 first** because it is a day, fixes a wrong version on every install, and shrinks the replay chunk before anything is measured against it.
- **Replay is the measured gap** ([benchmark.md](benchmark.md) §8): ouo's core is at or ahead of all six SDKs measured, but with replay on it costs +161 ms/min CPU, +1.8 MB heap and +81 KB/min wire more than Datadog, and its replay chunk is 79.5 KB against Datadog's 15.3 KB. WB1 and WB5 target that gap; WB10 keeps it closed.
- **WB10 second, in parallel** because the benchmark and conformance checks turn every later package into a pass / fail, and a published, gated overhead method is something no vendor read has (comparison §5).
- **WB2 and WB3 before replay work** because they are what a web team opens every day, and they serve both paths: errors and vitals from the Sentry bridge (N39) land as the same records.
- **WB5 before WB4** because alert rules for issues and vitals need WB2 and WB3 first; WB4 can start its crash-rate and failed-request rules any time.
- **WB7 after the budget decision** because the core has 48 bytes of headroom.
- **WB8 not first** because 2.x works today; doing it after WB10 means the conformance suite proves nothing changed.
- **WB9 last of the ten** because reach multiplies the value of what exists; it is the first package to pull forward if a user needs Vue or a script tag.

## 3. Datadog, Sentry or PostHog, per part

| Part | Take from | Not from |
|---|---|---|
| Data model and wire | OpenTelemetry semconv, OTLP/JSON (as today) | any vendor envelope or event format |
| Sessions | Datadog: cookie option, Web Locks, no-adoption rule, nested deterministic sampling | Sentry's per-tab replay session, Honeycomb's per-page session |
| Vitals | Datadog: per-view INP / CLS with attribution; Faro / Honeycomb: LoAF in INP attribution; Sentry: `durationThreshold: 0` | PostHog's CLS attribution (detached-node leaks) |
| SPA navigations | Datadog / Faro: activity-window loading time; Sentry: 1.5 s redirect rule | — |
| Frustration | Datadog naming chain and rules; error clicks | Sentry's server-side-only classification |
| Errors | Sentry: debug ids (done), dedupe, breadcrumbs as the last N events; fingerprint from frames like every APM vendor | Sentry's permissive `dataCollection` defaults |
| Replay | upstream rrweb; Sentry's worker, guards and text masking; Datadog's per-view snapshot and segment metadata; Clarity's stylesheet references | a fork; an own recorder |
| Size | Sentry's per-preset budget gate | Datadog's eager inlined worker |
| Product | PostHog / Datadog funnels (done), paths later | surveys, experiments |

## 4. Lanes

| Lane | Folders | Packages |
|---|---|---|
| A SDK | `sdk/browser`, `examples/ouo-web` | WB1, WB2 (error clicks, dedupe), WB3 (attribution, names), WB5 (worker, breaker, masking), WB7, WB8, WB9 (CDN, framework packages) |
| B rum-api | `services/rum-api` | WB2 (fingerprint, issues API), WB3 (p75 API), WB5 (CSS dedupe), WB6 (index, filters) |
| C plugin and provisioning | `plugins/ouo11y-rum-app`, `deploy/` Grafana provisioning | WB2 (issues pages), WB3 (performance page, dashboard), WB4, WB6 (search UI) |
| D spec, tests, tooling | `docs/specs`, `tests/e2e`, `sdk/browser/e2e`, `sdk/sourcemaps` | WB10, WB9 (bundler plugin, upload path) |

Four writers at once, never two in one folder. A package spanning lanes merges as one PR per lane in the order API first, then UI, then SDK where the SDK only adds data the UI already shows.

```
day            0     2     4        8                 17             24       29             37
Lane A SDK     | WB1 | WB2 | WB3 attr | WB5 replay -------| WB7 capture --| WB8 3.0 | WB9 CDN, frameworks |
Lane B rum-api |   | WB2 fingerprint + API | WB3 p75 |   | WB5 CSS dedupe | WB6 index + filters |
Lane C plugin  |              | WB2 issues pages | WB3 perf page |  | WB4 alerts |  | WB6 search UI |
Lane D spec    | WB10 spec + conformance + bench gate |                                  | WB9 bundler plugin, upload |
```

In lane A the SDK parts of WB2 (error clicks, dedupe) and WB3 (attribution, names) come before WB5 because they are small and feed the two read-side packages; WB5 is the lane's longest package.

Milestones (day of the sketch, upper-bound costs, not a date promise): **M1** day 6, WB1 + WB10 (correct, measured, gated); **M2** day 15, WB2 + WB3 (issues and performance view: the read side a Sentry or Datadog user expects); **M3** day 20, WB4 + WB5 (alerts shipped, replay production-grade); **M4** day 27, WB6 + WB7 (search at scale, capture complete); **M5** day 37, WB8 + WB9 (current OTel, framework reach).

## 5. Spec and maturity on the web

The web joins the mobile spec rather than getting its own vocabulary. The mobile roadmap proposes `docs/specs/mobile-sdk.md` with twelve capabilities C1–C12 and an L0–L3 ladder (mobile roadmap §5). Recommendation: one `docs/specs/rum-sdk.md` with a column per platform, where web is the first column at L2 / L3 today and the reference for mobile.

| Capability | Web today | Web after WB10 | After WB1–WB10 |
|---|---|---|---|
| C1 sessions and lifecycle | L2 (e2e exists) | L2 | L2 (+ cross-subdomain) |
| C2 errors | L2 | L2 | L3 (issues, error clicks) |
| C4 vitals | L1 (no attribution) | L1 | L3 |
| C5 network | L2 | L3 | L3 |
| C6 interactions timeline | L2 | L3 | L3 |
| C7 navigation | L2 | L3 | L3 (loading duration) |
| C8 replay | L2 | L3 | L3 (worker, breaker, mask-all-text) |
| C9 span and log API | L2 | L2 | L2 |
| C10 feedback | L0 | L0 | L0 (later, shared with mobile W6) |
| C11 delivery | L2 (fault-injection e2e) | L3 | L3 |
| C12 cost | L1 (size budget only) | L3 | L3 |

L3 needs a benchmark cell, which WB10 provides; C3 (hangs) has no web meaning beyond LoAF and is folded into C4.

## 6. What makes ouo stronger than parity

Engineering differences that already exist and how to widen them. None of this is a claim to publish; it is where to invest so the differences hold.

| Difference | Today | Widen it with |
|---|---|---|
| OTLP to the customer's own collector, with replay | 4 / 25 vendors export OTLP; none with replay, lookback, funnels and self-host together | replay semconv proposal upstream using ouo, Dash0, Splunk and Faro as prior art; replay-as-OTLP-logs option; semconv names everywhere (WB3) |
| One session across browser, backend and mobile | `session.id` in baggage on every request, same sampling hash in RN and rum-api | a bridge-path session that joins the same id (N39); documented backend recipe per language |
| Overhead measured, published and gated | bundle gate; soak and fault suites | WB10: CPU and bytes per minute gated per PR, the harness public in the repo, numbers next to Sentry, Datadog, PostHog on one page |
| Delivery that does not lose data | IndexedDB offline, retry, page-hide flush | conformance check "network refused loses nothing" (C11) in CI; beacons without a proxy (N44) |
| Privacy by default | inputs masked; no IP linking; deletion by user (8b) | mask all text by default (WB5), query-string scrubbing (WB7), consent API (WB7), a data-collection inventory per capability |
| Upstream work | soak found two rrweb leaks (fixed in 2.2.0) | rrweb `getUntaintedPrototype` fix; browser SIG: `crypto.getRandomValues` session ids, `session.start` / `session.end`, page-hide-safe batcher |

## 7. After WB1–WB10: competitive, and what is still missing

| Feature | Sentry | Datadog | PostHog | Faro | ouo today | ouo after WB10 |
|---|---|---|---|---|---|---|
| Errors grouped into issues | yes | yes | yes | partial | no | yes (WB2) |
| Source maps | yes | yes | yes | yes | yes | yes, public upload (WB9) |
| Vitals with attribution and per-route view | yes | yes | partial | yes | no | yes (WB3) |
| Frustration (rage, dead, error) | rage, dead | yes | rage, dead | yes | rage, dead | yes (WB2) |
| Replay text masked by default | yes | no | no | yes | no | option, default by ADR (WB5) |
| Replay on-error lookback | 0–60 s | no | trigger buffer | no | 30–60 s | 30–60 s |
| Console and network in replay | yes | partial | yes | no | partial | partial (later) |
| Session search | yes | yes | yes | Grafana Explore | 6 fields | yes (WB6) |
| Funnels | no | yes | yes | no | yes | yes |
| Alerts shipped | yes | yes | yes | Grafana | no | yes (WB4) |
| Framework packages | 8+ | 4 | 3 | React | React | React, Vue, Angular, Svelte, CDN (WB9) |
| Feature flags, consent, `beforeSend` | yes | yes | yes | partial | no | yes (WB7) |
| OTLP to the customer's collector | no | no | no | via receiver | yes | yes |
| Self-hosted | yes | no | yes | partial | yes | yes |
| Overhead gate in CI | size only | no | no | no | size only | size, CPU, bytes (WB10) |

**Still missing after WB10**, in the order a web team would notice:

1. **Profiling** (Sentry, Datadog: JS Self-Profiling, Chromium only, needs a `Document-Policy` header). Pyroscope is in LGTM, which makes it possible later.
2. **Heatmaps and paths**: analytics features; element-relative click positions in WB7 make heatmaps a plugin job later, paths reuse the funnel query.
3. **Console and network detail inside the player** (bodies on an allow-list, timing waterfall).
4. **Feedback widget**: the primitive is shared with mobile W6.
5. **Issue workflow beyond grouping**: assign, resolve, regress, ownership; needs state in rum-api (a store, which rum-api avoids today).
6. **Canvas and cross-origin iframe replay.**
7. **Release health beyond session health per version**: adoption and crash-free users.

## 8. Decisions needed

| Decision | Recommendation | Blocks |
|---|---|---|
| Bundle budget policy | per-preset budgets (core, +replay chunk, +attribution chunk, `react`) gated like Sentry (growth over N bytes fails); core held at its budget and new capture in lazy chunks unless under 1 KB; raise only with a measured reason | WB3, WB7 |
| Issue grouping (new ADR) | fingerprint computed in rum-api at read time over Loki from symbolicated in-app frames; client override attribute; no issue state store in this round | WB2 |
| Replay privacy and cost (ADR-0003 revision) | worker as a served file; mutation breaker; `maskAllText` with `ouo-unmask`; default text masking for new installs (founder call: it changes what existing users see); CSS dedupe in the store | WB5 |
| Vitals names (closes part of N26) | `browser.web_vital` + `browser.web_vital.*` with lower-case names, dual-emit one release, rum-api and plugin read both | WB3 |
| RUM SDK spec (shared with mobile ADR-0015 proposal) | one spec, column per platform, web as the reference | WB10 |

## 9. Definition of done

Every package: unit tests and the conformance checks of what it touches pass in CI in Chromium, Firefox and WebKit; the WB10 benchmark shows no regression beyond its gate against `main`; README and spec updated; kb entry for anything non-obvious; agent summary; one PR per lane.

| Package | Exit criterion |
|---|---|
| WB1 | an installed 0.x reports its own version in `ouo.sdk.version` (test reads `package.json`); rrweb chunk gzip smaller than 78,940 B by the measured amount; both soaks pass 60 min |
| WB10 | spec merged; e2e prints the web maturity column; PR job fails on bundle-preset growth and reports CPU and bytes per minute against `none` with N ≥ 10 paired runs |
| WB2 | the ouo-web journey's three error kinds show as three issues with correct counts across 20 generated sessions; an issue links to its sessions' replays; error click emitted in the e2e |
| WB3 | INP and LCP events carry target / element and phases; a route's p75 in the plugin matches a hand computation over generated sessions; old and new names both readable |
| WB5 | replay main-thread time per minute in the benchmark lower than before by the measured amount; a 20k-mutation burst stops recording with a reason; masking proof passes with `maskAllText`; stored bytes per checkout drop by the CSS share |
| WB4 | each provisioned rule fires once in an env with injected errors or slow pages, and stays quiet on the clean journey |
| WB6 | a 24 h list on a generated 500k-event day answers without hitting the fold cap; each filter has a test |
| WB7 | `beforeSend` can drop and edit; consent off sends nothing (network log empty); flag evaluations appear as semconv events; two subdomains share one session |
| WB8 | conformance suite and benchmark unchanged after the switch; no `sdk-trace-web` in the lockfile |
| WB9 | a plain HTML page with the snippet reports a session; Vue / Angular / Svelte examples pass the conformance subset; a Vite build uploads maps through the collector and the plugin shows symbolicated frames |

For the whole: M2 (WB2 + WB3 merged) is the point where a web team moving from Sentry or Datadog finds the screens it works from; M3 makes replay safe to turn on by default on a busy site.
