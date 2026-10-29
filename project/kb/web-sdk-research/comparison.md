# Web SDK research: comparison and what it means for ouo

Written 2026-10-29 by the web-sdk-research orchestrator from Appendices O, A–F and M. Every row points to the appendix that carries the citation; this file adds no new facts, only the side-by-side reading. The ordered work list is [roadmap.md](roadmap.md).

## 0. The answers in one page

1. **The SDK is competitive; the product a web team reads is not yet.** On capture, delivery and page safety `@ouo11y/browser` is at the field's level and ahead of it in three places: an IndexedDB offline store with retry for spans, logs and replay (nobody in Appendix D persists RUM batches; Sentry's is opt-in and capped at 30 envelopes, Datadog and PostHog keep retries in memory), page-hide correctness including INP, and semconv `session.start` / `session.end` events (the only SDK read that emits them). The gaps a Sentry or Datadog user notices on day one are on the read side: errors are not grouped into issues, web vitals are collected but never aggregated and carry no attribution, no RUM alert rules ship, and the session list filters on six fields (O §9).
2. **Where ouo is already rare.** Of 25 vendors (F §6.3), 4 send RUM over OTLP to the customer's own collector (ouo, Splunk, Honeycomb, Embrace), and only ouo pairs that with replay, a true on-error lookback buffer (5 of 25 have one), funnels (Sentry, Faro and Honeycomb have none) and self-hosting. No vendor read gates replay or CPU overhead in CI: Sentry deleted its overhead harness in 2024, Datadog's benchmarks run on a schedule and never block, PostHog's is opt-in (A §7, B §7, C §7).
3. **Table stakes ouo has, with three holes** (F §10.1): errors (not grouped), source maps (yes, ADR-0011), web vitals (no attribution), soft navigations, network tracing with W3C propagation, replay, alerting (generic Grafana only), open-source SDK.
4. **Replay: stay on upstream rrweb, fix the four things the field fixed.** rrweb is GA (2.0.0 2026-06-01, 2.2.0 2026-10-24) and 2.2.0 fixes the two leaks ouo's soak found; every fork is years behind (E §1). The field moved compression off the main thread (Sentry fflate worker, Datadog deflate worker, OpenReplay worker; Sentry and Datadog still serialise on the main thread), added a mutation breaker (Sentry stops at 10,000 mutations per batch), masks all text by default (Sentry, Fullstory private mode), and keeps stylesheets out of every checkout (Clarity, OpenReplay). ouo does none of the four, and its lazy chunk still carries the rrweb player (E §8).
5. **Vitals: attribution is the split.** 8 of 25 send the LCP element and INP target; Datadog, Faro, Honeycomb and Embrace use Long Animation Frames for INP attribution. ouo already observes LoAF (with script attribution) but does not attach it to INP, and imports `web-vitals`, not `web-vitals/attribution` (O §3, F ᵒ³). Semconv v1.44 now names the event `browser.web_vital` with `browser.web_vital.*` attributes; Embrace and the OTel browser SDK already use them, ouo still emits `web_vital` / `ouo.web_vital.*` (D §10).
6. **The OTel JS ground is moving under the SDK.** OTel JS 3.0 removed `sdk-trace-web` and deprecated the fetch / XHR instrumentations in favour of the experimental `opentelemetry-browser` repository (D.2). ouo depends on `@opentelemetry/sdk-trace-web` ^2.11 and the 0.222 instrumentations (`sdk/browser/package.json:74-87`). Staying on 2.x works today; a planned migration is cheaper than a forced one.
7. **The core bundle is at its budget**: 45,008 B gzip against 45,056 B, 48 bytes of headroom (O §2). Every capture feature in the roadmap needs either a lazy chunk or a budget decision. For scale: Sentry errors-only 30.4 kB, +tracing 52.7 kB, +replay 93.0 kB (A §7); Datadog `datadog-rum.js` 67.0 kB eager (B §7); PostHog `array.js` 107 kB (C §7); Faro 41.6 + 27.6 kB tracing; Dash0 27.5 kB (D). Measured on one page ([benchmark.md](benchmark.md), 9 rounds, headless Chromium): ouo's eager bundle is the smallest of six (45.3 KB gzip; Datadog 65.4, Sentry 94.6, Faro 90.1, PostHog 107.5, Splunk 277.5); without replay its main-thread cost over a 60 s journey is in the same band as Sentry and Datadog (+142, +175, +161 ms/min, IQRs overlap), and it sends the second-least telemetry on the wire after PostHog (33.9 KB/min; Datadog 109, Sentry 155). With replay it trails Datadog: a 79.5 KB lazy `rrweb` chunk against Datadog's 15.3 KB recorder (`@rrweb/record` measures 22.4 KB), +495 against +334 ms/min main-thread work (about equal across all threads: Datadog deflates in a worker), 254 against 173 KB/min replay wire and 3.5× Datadog's decoded replay bytes, 90 % of them in rrweb's incremental stream.
8. **Where ouo can lead rather than follow**: a replay semantic convention (three vendors already put replay in OTLP logs with three different attribute sets, and semconv has nothing, D §9), the browser SIG's session manager (no `session.start` / `session.end`, `Math.random` ids), and a public, CI-gated overhead method like B3 on mobile.

## 1. Where ouo stands, capability by capability

Level: **ahead** (better than the leaders read), **par**, **behind**, **absent**. Leaders: Sentry, Datadog, PostHog; OTel peers: Faro, Splunk, Embrace, Dash0.

| Capability | ouo today | Field | Level | Source |
|---|---|---|---|---|
| Page safety (guards, CSP / Trusted Types, SSR, shutdown) | guarded hooks, strict CSP e2e in 3 engines, soak 60 min | Sentry wraps 30 prototypes; nobody else publishes a fault-injection suite | ahead | O §5, §7 |
| Delivery (gzip, retry, offline, page hide) | gzip ≥ 1 KB, 5 attempts with `Retry-After`, IndexedDB 5 MB / 24 h, keepalive budget | Sentry opt-in offline (30), Datadog / PostHog memory only, Splunk no retry | ahead | O §5, A §5, B §5, C §5, D §9 |
| Sessions | localStorage, 30 min / 4 h, cross-tab via `storage`, user rotation, `device.id`, semconv events | Datadog cookie + Web Locks + cross-subdomain; PostHog cookie, window id | par (no cross-subdomain, no Web Locks) | O §3, B §3, C §3 |
| Sampling | deterministic from session id, shared with RN and rum-api | Datadog (Knuth, nested), PostHog (hash) | par | O §3, B §3 |
| Errors capture | uncaught, rejection, `console.error`, resource, React boundary | same set plus Sentry's 100 breadcrumbs, dedupe, rate limit | par (no dedupe or rate limit, no breadcrumbs beyond replay) | O §3, A §3 |
| Issue grouping and workflow | none | every APM vendor groups (F §10.1) | absent | O §9 |
| Source maps | debug ids, rum-api symbolication, V8 / SpiderMonkey / JSC | debug ids (Sentry), release+file (others) | par (upload path internal, N41) | O §6 |
| Web vitals | 5 vitals, value / rating / delta, flushed at hide | attribution at 8 / 25; per-view INP/CLS at Datadog | behind | O §3, B §3, F |
| Vitals aggregates / performance view | none (endpoint and session row are mobile only) | every APM vendor | absent | O §6 |
| Page load and SPA navigations | `documentLoad` span, `soft-navigation` idle span (1 s), `<meta traceparent>` | Datadog / Faro activity-window loading time; Sentry 1.5 s redirect rule | par | O §3, B §3, D.1 |
| Network | fetch / XHR CLIENT spans, W3C `traceparent` + baggage | Datadog multi-propagator; Sentry `sentry-trace` default | ahead on standards | O §3, F Q8 |
| Network timing detail, bodies | no timing breakdown, no resource timing after load, no bodies | Sentry bodies on allow-list, PostHog opt-in | behind | O §9 |
| Long tasks / LoAF | LoAF with script attribution, longtask fallback, standalone events | Datadog, Splunk, Sentry (only under spans) | ahead | O §3, A §3 |
| Frustration | rage, dead | Datadog, Faro, Splunk: rage, dead, error | par minus error clicks | O §3, B §3, D |
| Replay recorder | upstream rrweb 2.1.7, patched | Sentry / PostHog / New Relic forks, Datadog / Clarity own | par | E §1 |
| Replay privacy default | inputs masked, text recorded | Sentry, Faro: text masked; Datadog: inputs; PostHog: inputs | behind the strictest | O §4, A §4, D.1 |
| Replay cost controls | 2 MB snapshot guard, one recording tab | worker compression, mutation breaker, segment caps, idle stop | behind | E §10, A §4 |
| Replay on error | 30–60 s lookback (two checkouts) | Sentry 0–60 s, Rollbar 300 s, LogRocket 10 MB | ahead of Sentry's semantics | F Q9, A §10 |
| Console / network in replay | `console.error` as exception beside the player | Sentry, PostHog, LogRocket inside the replay | behind | F §6.1b |
| Session search | 6 fields | Sentry / Datadog / PostHog: URL, error, browser, duration, frustration, custom | behind | O §6 |
| Funnels | yes (ADR-0012) | Datadog, PostHog, analytics vendors; not Sentry, Faro | ahead of Sentry | F §10.2 |
| Alerts | Grafana Alerting possible, no rules shipped | 17 / 25 ship RUM alerting | behind | F ᵒ⁸ |
| Frameworks | React (`./react`), ESM only | Sentry 8+ framework packages, CDN loader | behind | O §2, A §2 |
| Feature flags, consent, `beforeSend`, global context | none | Sentry, Datadog, PostHog all have them | absent | O §9 |
| Heatmaps, paths, feedback, surveys, profiling | none | analytics vendors; Sentry / Datadog profiling | absent (later) | F §10.4 |
| OTLP to the customer's collector | spans + logs OTLP/JSON, replay on the collector's receiver | 4 / 25 | ahead | F §6.3 |
| Self-host | whole stack | 8 / 25 | ahead | F §6.3 |
| Overhead gate in CI | bundle-size gate only | size gates at Sentry; no CPU gate anywhere | par, can lead | A §7, B §7 |

## 2. Technique matrix (the four leaders and the OTel peers)

| | ouo 0.3 | Sentry 11.10 | Datadog 7.16 | PostHog 1.442 | Faro 2.13 | Dash0 0.28 |
|---|---|---|---|---|---|---|
| Data model | OTel spans + logs | envelopes, span v2 streamed | RUM JSON (views, actions, resources) | `$` events | Faro JSON | OTLP/JSON by hand |
| Session store | localStorage | release health in memory; replay in sessionStorage per tab | cookie `_dd_s_v2`, Web Locks | cookie + localStorage, window id in sessionStorage | sessionStorage per tab (opt-in shared) | localStorage |
| Idle / max | 30 min / 4 h | replay 15 min / 60 min | 15 min / 4 h | 30 min / 24 h | 15 min / 4 h | 3 h / 6 h |
| Vitals library | `web-vitals` 5 metrics, no attribution | `web-vitals` 6 + own attribution, `durationThreshold: 0` | own code, per-view, attribution | `web-vitals` 6.2.1 lazy, INP + LCP attribution | `web-vitals` attribution + LoAF | own, fields in body |
| SPA navigation | history patch, idle span 1 s | history patch, idle span 1 s / 30 s / 15 s heartbeat, 1.5 s redirect | history + hash, activity-based loading time | `history_change` pageview | activity window, duration | `browser.page_view` |
| Propagation | `traceparent` + baggage `session.id` | `sentry-trace` + baggage; `traceparent` opt-in | datadog + tracecontext (64-bit ids) | `X-POSTHOG-*` headers | `traceparent` | `traceparent`, session in trace id |
| Replay recorder | rrweb 2.1.7 upstream | getsentry/rrweb 2.45 fork | own (rrweb-derived), Change encoding | `@posthog/rrweb-record` fork | Grafana rrweb fork | rrweb |
| Replay text masking | no | yes | inputs only (`mask-user-input`) | inputs only | yes (strict) | inputs |
| Compression | `CompressionStream` on the request, serialisation on main | fflate zlib in a Blob worker | pako deflate in a Blob worker | per-field gzip + request gzip, main thread | none per event | gzip per request |
| Segmenting | 5 s or 256 KB | 5–5.5 s | per view, 5 s / 60 KB | 2 s / 0.9 MB | per event | per chunk |
| Replay transport | own receiver `/v1/replay/chunks` | `replay_recording` envelope | intake | `/s/` | Faro event | OTLP log record per chunk |
| Bundle (vendor's own numbers) | core 45.0 + rrweb 78.9 KB | 30.4 errors / 52.7 tracing / 93.0 replay | 67.0 eager + 11.7 recorder | 107 core, 188 typical | 41.6 + 27.6 + 63.9 replay | 27.5 + 22.7 replay |

Bundle numbers are each vendor's shipped form and are not like for like; [benchmark.md](benchmark.md) measures them on one page.

## 3. Replay: what the field does that ouo does not

| Practice | Who | Why it matters | ouo | Cost (E §10) |
|---|---|---|---|---|
| Compress in a worker | Sentry, Datadog, OpenReplay, LaunchDarkly (Sentry and Datadog keep serialisation and `JSON.stringify` on the main thread, A §8, B §4) | moves compression off the main thread; OpenReplay notes main-thread compression broke upload order | `JSON.stringify` twice per event on main, gzip by `CompressionStream` | 2–3 d |
| Mutation breaker | Sentry (750 breadcrumb, 10,000 stop), PostHog per-node throttle | one runaway widget otherwise costs the page and the bucket | snapshot-size guard only | 1–2 d |
| Mask all text by default | Sentry, Faro, Fullstory private mode | the one replay incident that ends trust is readable personal data | inputs only | 1–2 d + masking proof |
| Stylesheets once | Clarity, OpenReplay, Fullstory | every 5 min checkout re-sends CSS | re-sent per checkout | server 3–4 d |
| Record-only import | Sentry build flags, Rollbar `@rrweb/record` | ouo's lazy chunk carries the player | `import("rrweb")` | 0.5 d |
| Upstream fixes | rrweb 2.2.0 (#1971, #1958), #1964 merged | the leaks ouo's soak found | 2.1.7 + esbuild patch | 0.5 d + soak |
| Segment metadata and per-view snapshot | Datadog | indexing, debugging, seeking | `seq`, times | with worker |
| Network timing and console in replay | Sentry, PostHog, LogRocket | the "why" next to the "what" | traces and `console.error` beside the player | 3–4 d SDK + plugin |

## 4. OpenTelemetry: where ouo sits

| Question | Answer | Source |
|---|---|---|
| Who sends RUM as OTLP to any collector | ouo, Splunk (spans; replay format closed), Honeycomb, Embrace, Dash0, OTel browser SDK | D comparison |
| Who sends replay over OTLP | Splunk (protobuf logs, closed recorder), Dash0 (log per chunk), Faro (event per rrweb event, logfmt in Loki), Rollbar (span events, own endpoint) | D §9, F Q4 |
| Semconv for browser in v1.44 | `session.id`, `session.previous_id`, `session.start` / `session.end`, `browser.web_vital` | D §2 |
| What ouo emits differently | `web_vital` / `ouo.web_vital.*`, `url.path` for page, `ouo.*` for frustration and LoAF | D attribute table |
| What ouo could propose upstream | replay / session-recording event, frustration events, SIG session manager fixes, a page-hide-safe batcher | D §10 |

## 5. Performance claims and how they were measured

| Vendor | Claim | Method | Gate |
|---|---|---|---|
| Sentry | replay overhead table (TBT +415 ms, 272 KB upload) | 2023, M1, 50 runs; harness deleted 2024 | per-PR bundle-size growth > 500 B gzip fails (2026-10-21) |
| Datadog | CPU, heap, bytes, vitals for none / rum / rum_replay | scheduled job | size warns at +5 %, never fails |
| PostHog | replay benchmark at ~50k nodes (108 ms snapshot, 190–300 ms bursts) | opt-in Playwright | size diff reported, no limit |
| New Relic, others | none published | — | — |
| ouo | soak 60 min, rrweb cost on 10k / 50k elements, fault injection | Playwright, three engines | gzip budget per file fails CI |

## 6. Recommendations (ranked in roadmap.md)

1. Group errors into issues in rum-api and give them a page (the largest single gap; serves the Sentry-bridge path too, whose errors land as the same `exception` records).
2. Make vitals answer "which page, which element": attribution with LoAF, semconv names, per-route p75 in rum-api and a performance page.
3. Ship RUM alert rules and a dashboard with the stack.
4. Replay production-grade: rrweb 2.2.0 and `@rrweb/record`, worker serialisation, mutation breaker, mask-all-text option with an ADR on the default, stylesheet dedupe.
5. Session search filters and a session index before the 100,000-event fold ceiling bites.
6. Capture completeness behind a budget decision: `beforeSend` and URL scrubbing, global attributes, feature flags (semconv `feature_flag.evaluation`), consent API, cross-subdomain cookie sessions with Web Locks, error clicks, resource timing after load.
7. OTel JS 3.0 migration (`sdk-trace`, browser-instrumentation) on a schedule of ours.
8. Reach: CDN / loader build, Vue / Angular / Svelte thin packages, bundler plugin and public upload path for source maps (N41).
9. A web SDK spec with conformance checks and the benchmark harness of Appendix M in CI, as B3 is on mobile.
10. Later: heatmaps (element-relative clicks first), paths, feedback primitive shared with mobile W6, replay as OTLP logs option, profiling, canvas.

## 7. Limits of this research

- Docs-only and `[recall]` cells in Appendix F are marked; F §9 Q10 lists them for recheck before quoting.
- Bundle sizes in §2 are the vendors' own builds; only [benchmark.md](benchmark.md) compares on one page, headless Chromium, one machine.
- The read-side comparison (issues, search, alerts) is from docs for the closed backends; ouo's side is verified in code (O).
- No customer data and no field measurements; costs in the roadmap are the orchestrator's estimates in focused agent-days.
